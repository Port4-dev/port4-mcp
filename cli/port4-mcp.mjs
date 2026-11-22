#!/usr/bin/env node
/**
 * Port4 Local STDIO-to-HTTP MCP & x402 v2 Auto-Signing Client Bridge (`cli/port4-mcp.mjs`)
 *
 * Allows desktop MCP clients (Cursor, Claude Desktop, Windsurf) that speak stateful STDIO MCP
 * to connect seamlessly to any stateless Port4 HTTP MCP 2026-07-28 endpoint and automatically
 * enforce spend guardrails (`--max-per-call-usd`, `--max-session-usd`) when handling HTTP 402.
 *
 * Usage:
 *   node cli/port4-mcp.mjs --url https://port4.dev/mcp/demo --max-per-call-usd 0.05 --max-session-usd 1.00
 *   node cli/port4-mcp.mjs --self-test
 */

import readline from "node:readline";
import assert from "node:assert/strict";

function parseArgs(argv) {
  const opts = {
    url: process.env.PORT4_MCP_URL || "https://port4.dev/mcp/demo",
    maxPerCallUsd: Number(process.env.PORT4_MAX_PER_CALL_USD || "0.10"),
    maxSessionUsd: Number(process.env.PORT4_MAX_SESSION_USD || "2.00"),
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID || "",
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || "",
    paymentSignature: process.env.PORT4_PAYMENT_SIGNATURE || "",
    selfTest: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--url" && argv[i + 1]) opts.url = argv[++i];
    else if (arg === "--max-per-call-usd" && argv[i + 1]) opts.maxPerCallUsd = Number(argv[++i]);
    else if (arg === "--max-session-usd" && argv[i + 1]) opts.maxSessionUsd = Number(argv[++i]);
  }
  return opts;
}

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

  // Handle stateful IDE initialization locally so stateless Port4 2026-07-28 endpoints work in Cursor/Claude Desktop
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

async function forwardToPort4Edge(msg, opts, budget) {
  const headers = {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": msg.method
  };

  if (msg.method === "tools/call" && msg.params?.name) {
    headers["Mcp-Name"] = String(msg.params.name);
  }
  if (opts.cfAccessClientId && opts.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = opts.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = opts.cfAccessClientSecret;
  }
  if (opts.paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = opts.paymentSignature;
  }

  const res = await fetch(opts.url, {
    method: "POST",
    headers,
    body: JSON.stringify(msg)
  });

  if (res.status === 402) {
    const body = await res.json().catch(() => ({}));
    const req0 = body?.x402?.accepts?.[0];
    const priceUsd = req0?.extra?.priceUsd || "0.001";
    const budgetCheck = budget.checkAndReserve(priceUsd);

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
                requirement: req0 ?? body
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

  const json = await res.json();
  return json;
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
  assert.equal(guard.checkAndReserve("0.06").allowed, false); // exceeds 0.05 per-call
  assert.equal(guard.checkAndReserve("0.05").allowed, true); // spent = 0.09
  assert.equal(guard.checkAndReserve("0.04").allowed, false); // 0.13 exceeds 0.12 session cap
  console.log("   PASS: Port4 STDIO MCP Bridge self-test (initialize + spend caps) passed.");
}

const opts = parseArgs(process.argv);
if (opts.selfTest) {
  runSelfTest();
  process.exit(0);
}

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
