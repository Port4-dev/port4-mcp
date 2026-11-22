#!/usr/bin/env node
/**
 * `port4-mcp` — Official CLI & STDIO-to-HTTP x402 MCP Bridge for Port4 (https://port4.dev)
 *
 * Modes:
 *   1. `port4-mcp bridge --url <mcp_url>` (default when piped via STDIO in Cursor / Claude Desktop / Windsurf)
 *      - Bridges stateful STDIO MCP (`initialize`, `notifications/initialized`, `ping`) to stateless Port4 HTTP `2026-07-28`.
 *      - Enforces client-side spend caps (`--max-per-call-usd`, `--max-session-usd`).
 *      - Automatically signs x402 challenges when `PORT4_PRIVATE_KEY` (with `@x402/evm` + `viem`) is provided.
 *   2. `port4-mcp inspect <mcp_url>`
 *      - Queries `tools/list` and probes the `402 Payment Required` `accepts[]` rails on any Port4 endpoint.
 *   3. `port4-mcp tenants` / `port4-mcp import-openapi <tenant_id> <spec_url>`
 *      - Manages Port4 endpoints from the terminal or CI/CD using `PORT4_API_KEY` (`p4_live_...`).
 *   4. `port4-mcp --self-test`
 *      - Runs built-in lifecycle, budget-guard, and protocol assertions.
 */

import readline from "node:readline";
import assert from "node:assert/strict";

export class Port4BudgetGuard {
  constructor(maxPerCallUsd = 0.1, maxSessionUsd = 2.0) {
    this.maxPerCallUsd = maxPerCallUsd;
    this.maxSessionUsd = maxSessionUsd;
    this.spentUsd = 0;
  }

  checkAndReserve(priceUsdStr) {
    const price = Number(String(priceUsdStr).replace(/^\$/, ""));
    if (!Number.isFinite(price) || price <= 0) {
      return { allowed: false, reason: `Invalid tool price '${priceUsdStr}'.` };
    }
    if (price > this.maxPerCallUsd) {
      return {
        allowed: false,
        reason: `Tool price $${price.toFixed(4)} exceeds per-call cap $${this.maxPerCallUsd.toFixed(4)}.`
      };
    }
    if (this.spentUsd + price > this.maxSessionUsd) {
      return {
        allowed: false,
        reason: `Session spend $${(this.spentUsd + price).toFixed(4)} would exceed session cap $${this.maxSessionUsd.toFixed(4)}.`
      };
    }
    this.spentUsd += price;
    return { allowed: true, reservedUsd: price, totalSpentUsd: this.spentUsd };
  }
}

export function handleLocalMcpLifecycle(msg) {
  if (!msg || typeof msg !== "object") return null;

  if (msg.method === "initialize") {
    const clientVersion = msg.params?.protocolVersion || "2024-11-05";
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        protocolVersion: clientVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "port4-mcp-bridge",
          version: "1.0.0"
        }
      }
    };
  }

  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
    return "IGNORE_NOTIFICATION";
  }

  if (msg.method === "ping") {
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {}
    };
  }

  return null;
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  let command = "bridge";
  const positional = [];
  const opts = {
    url: process.env.PORT4_MCP_URL || "https://port4.dev/mcp/demo",
    apiBase: (process.env.PORT4_API_BASE || "https://port4.dev").replace(/\/$/, ""),
    apiKey: process.env.PORT4_API_KEY || "",
    privateKey: process.env.PORT4_PRIVATE_KEY || "",
    maxPerCallUsd: Number(process.env.PORT4_MAX_PER_CALL_USD || "0.10"),
    maxSessionUsd: Number(process.env.PORT4_MAX_SESSION_USD || "2.00"),
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID || "",
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || "",
    paymentSignature: process.env.PORT4_PAYMENT_SIGNATURE || "",
    selfTest: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--self-test") opts.selfTest = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--url" && args[i + 1]) opts.url = args[++i];
    else if (a === "--api-key" && args[i + 1]) opts.apiKey = args[++i];
    else if (a === "--max-per-call-usd" && args[i + 1]) opts.maxPerCallUsd = Number(args[++i]);
    else if (a === "--max-session-usd" && args[i + 1]) opts.maxSessionUsd = Number(args[++i]);
    else if (!a.startsWith("-")) positional.push(a);
  }

  if (positional.length > 0) {
    const first = positional[0];
    if (["bridge", "inspect", "tenants", "import-openapi", "help"].includes(first)) {
      command = first;
      positional.shift();
    } else if (first.startsWith("https://") || first.startsWith("http://")) {
      opts.url = first;
    }
  }

  return { command, positional, opts };
}

async function trySignWithEvmPrivateKey(privateKey, paymentRequired) {
  if (!privateKey) return null;
  try {
    const viemAccounts = await import("viem/accounts");
    const x402Evm = await import("@x402/evm");
    const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const account = viemAccounts.privateKeyToAccount(normalizedKey);
    const scheme = new x402Evm.ExactEvmScheme(account);
    const evmReq = (paymentRequired.accepts || []).find((r) =>
      String(r.network).startsWith("eip155:")
    );
    if (!evmReq || typeof scheme.createPayment !== "function") return null;
    const payload = await scheme.createPayment(paymentRequired, evmReq);
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  } catch {
    return null;
  }
}

async function forwardToPort4Edge(msg, opts, budget) {
  const buildHeaders = (sig) => {
    const h = {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": msg.method
    };
    if (msg.method === "tools/call" && msg.params?.name) {
      h["Mcp-Name"] = String(msg.params.name);
    }
    if (opts.cfAccessClientId && opts.cfAccessClientSecret) {
      h["CF-Access-Client-Id"] = opts.cfAccessClientId;
      h["CF-Access-Client-Secret"] = opts.cfAccessClientSecret;
    }
    if (sig) {
      h["PAYMENT-SIGNATURE"] = sig;
    }
    return h;
  };

  let res = await fetch(opts.url, {
    method: "POST",
    headers: buildHeaders(opts.paymentSignature),
    body: JSON.stringify(msg)
  });

  if (res.status === 402) {
    const body = await res.json().catch(() => ({}));
    const paymentRequired = body?.x402;
    const req0 = paymentRequired?.accepts?.[0];
    const priceUsd = req0?.extra?.priceUsd || "0.001";
    const budgetCheck = budget.checkAndReserve(priceUsd);

    if (budgetCheck.allowed && opts.privateKey && paymentRequired) {
      const signedHeader = await trySignWithEvmPrivateKey(opts.privateKey, paymentRequired);
      if (signedHeader) {
        res = await fetch(opts.url, {
          method: "POST",
          headers: buildHeaders(signedHeader),
          body: JSON.stringify(msg)
        });
        if (res.ok) {
          return await res.json();
        }
      }
    }

    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: 402,
                paymentRequired: true,
                budgetGuard: budgetCheck,
                accepts: paymentRequired?.accepts ?? [],
                hint: opts.privateKey
                  ? "Install @x402/evm and viem to enable automatic EIP-3009 signing."
                  : "Set PORT4_PRIVATE_KEY (with @x402/evm + viem) or pass PAYMENT-SIGNATURE to auto-settle."
              },
              null,
              2
            )
          }
        ],
        isError: !budgetCheck.allowed
      }
    };
  }

  return await res.json();
}

async function runInspect(targetUrl, opts) {
  console.log(`Inspecting Port4 MCP Endpoint: ${targetUrl}\n`);
  const listRes = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
      ...(opts.cfAccessClientId && opts.cfAccessClientSecret
        ? {
            "CF-Access-Client-Id": opts.cfAccessClientId,
            "CF-Access-Client-Secret": opts.cfAccessClientSecret
          }
        : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });

  const tenant = listRes.headers.get("x-port4-tenant") || "unknown";
  const mcpMode = listRes.headers.get("x-port4-mcp-mode") || "direct";
  const listJson = await listRes.json();
  const tools = listJson?.result?.tools || [];

  console.log(`Tenant:   ${tenant}`);
  console.log(`MCP Mode: ${mcpMode}`);
  console.log(`Status:   HTTP ${listRes.status}`);
  console.log(`Tools (${tools.length}):`);
  for (const t of tools) {
    const price = t._meta?.x402?.priceUsd || (t._meta?.free ? "FREE" : "paid");
    const net = t._meta?.x402?.network || "";
    console.log(`  - ${t.name} [${price}${net ? ` on ${net}` : ""}]: ${t.description?.split("\n")[0] || ""}`);
  }
}

async function runTenantsList(opts) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY (or --api-key p4_live_...) is required for control-plane commands.");
    process.exit(1);
  }
  const res = await fetch(`${opts.apiBase}/api/tenants`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` }
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

async function runImportOpenApi(tenantId, specUrl, opts) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY (or --api-key p4_live_...) is required.");
    process.exit(1);
  }
  if (!tenantId || !specUrl) {
    console.error("Usage: port4-mcp import-openapi <tenant_id> <https://.../openapi.json>");
    process.exit(1);
  }
  const res = await fetch(`${opts.apiBase}/api/tenants/${encodeURIComponent(tenantId)}/import-openapi`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      spec_url: specUrl,
      default_price_usd: "0.005",
      mcp_mode: "openapi_codemode"
    })
  });
  console.log(JSON.stringify(await res.json(), null, 2));
}

function printHelp() {
  console.log(`port4-mcp v1.0.0 — Port4 Paid MCP & x402 CLI Bridge (https://port4.dev)

Usage:
  port4-mcp bridge --url <https://{tenant}.port4.dev/mcp> [--max-per-call-usd 0.05] [--max-session-usd 1.00]
  port4-mcp inspect <https://{tenant}.port4.dev/mcp>
  port4-mcp tenants [--api-key p4_live_...]
  port4-mcp import-openapi <tenant_id> <https://api.example.com/openapi.json>
  port4-mcp --self-test

Environment Variables:
  PORT4_MCP_URL              Target Port4 MCP endpoint URL
  PORT4_MAX_PER_CALL_USD     Maximum USDC price allowed per tool call (default: 0.10)
  PORT4_MAX_SESSION_USD      Maximum cumulative USDC spend per session (default: 2.00)
  PORT4_PRIVATE_KEY          Optional EVM private key for auto-signing (requires @x402/evm + viem)
  PORT4_API_KEY              Scoped developer API key (p4_live_...) for control-plane commands
  CF_ACCESS_CLIENT_ID        Optional Cloudflare Access Service Token Client ID
  CF_ACCESS_CLIENT_SECRET    Optional Cloudflare Access Service Token Client Secret`);
}

function runSelfTest() {
  const initReply = handleLocalMcpLifecycle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  });
  assert.equal(initReply.result.serverInfo.name, "port4-mcp-bridge");

  const notifReply = handleLocalMcpLifecycle({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  });
  assert.equal(notifReply, "IGNORE_NOTIFICATION");

  const guard = new Port4BudgetGuard(0.05, 0.12);
  assert.equal(guard.checkAndReserve("0.04").allowed, true);
  assert.equal(guard.checkAndReserve("0.06").allowed, false);
  assert.equal(guard.checkAndReserve("0.05").allowed, true);
  assert.equal(guard.checkAndReserve("0.04").allowed, false);
  console.log("   PASS: Port4 STDIO MCP Bridge self-test (initialize + spend caps) passed.");
}

const { command, positional, opts } = parseCliArgs(process.argv);

if (opts.selfTest) {
  runSelfTest();
  process.exit(0);
}

if (opts.help || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "inspect") {
  await runInspect(positional[0] || opts.url, opts);
  process.exit(0);
}

if (command === "tenants") {
  await runTenantsList(opts);
  process.exit(0);
}

if (command === "import-openapi") {
  await runImportOpenApi(positional[0], positional[1], opts);
  process.exit(0);
}

// Default: STDIO-to-HTTP MCP Bridge mode for Cursor / Claude Desktop / Windsurf
const budget = new Port4BudgetGuard(opts.maxPerCallUsd, opts.maxSessionUsd);
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      }) + "\n"
    );
    return;
  }

  const local = handleLocalMcpLifecycle(msg);
  if (local === "IGNORE_NOTIFICATION") return;
  if (local) {
    process.stdout.write(JSON.stringify(local) + "\n");
    return;
  }

  try {
    const remoteReply = await forwardToPort4Edge(msg, opts, budget);
    process.stdout.write(JSON.stringify(remoteReply) + "\n");
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : "Bridge forwarding error"
        }
      }) + "\n"
    );
  }
});
