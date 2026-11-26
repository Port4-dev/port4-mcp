#!/usr/bin/env node
/**
 * `port4-mcp` — Official CLI & STDIO-to-HTTP x402 MCP Bridge for Port4 (https://port4.dev)
 *
 * Modes:
 *   1. `port4-mcp bridge --url <mcp_url>` (default when piped via STDIO in Cursor / Claude Desktop / Windsurf)
 *      - Bridges stateful STDIO MCP (`initialize`, notifications, `ping`) to stateless Port4 HTTP `2026-07-28`.
 *      - Enforces client-side spend caps (`--max-per-call-usd`, `--max-session-usd`) using exact BigInt micro-USD.
 *      - Automatically signs x402 v2 challenges when `PORT4_PRIVATE_KEY` (with `@x402/evm` + `viem`) is provided.
 *   2. `port4-mcp inspect <mcp_url>`
 *      - Queries `tools/list` and probes `402 Payment Required` `accepts[]` & Tempo MPP rails on any Port4 endpoint.
 *   3. `port4-mcp tenants` / `port4-mcp import-openapi <tenant_id> <spec_url_or_file>`
 *      - Manages Port4 endpoints from the terminal or CI/CD using `PORT4_API_KEY` (`p4_live_...`).
 *   4. `port4-mcp --self-test`
 *      - Runs built-in lifecycle, budget-guard, rail-selection, signing, and bridge error-wrapping assertions.
 */

import fs from "node:fs";
import nodeCrypto from "node:crypto";
import readline from "node:readline";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const CLI_VERSION = "1.0.0";
const MICRO_PER_USD = 1_000_000n;
const VALID_MCP_MODES = new Set(["direct", "codemode", "openapi_codemode"]);

export function parseUsdToMicro(value, label = "USD amount") {
  if (value === null || value === undefined || typeof value === "boolean") {
    throw new RangeError(`Invalid ${label}: '${value}'.`);
  }
  let raw;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Invalid ${label}: '${value}' must be a finite non-negative number.`);
    }
    raw = value.toFixed(6);
  } else {
    raw = String(value).trim().replace(/^\$/, "");
  }
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) {
    throw new RangeError(
      `Invalid ${label}: '${value}' must be a non-negative decimal with up to 6 fractional digits.`
    );
  }
  const [intPart, fracPart = ""] = raw.split(".");
  return BigInt(intPart) * MICRO_PER_USD + BigInt(fracPart.padEnd(6, "0"));
}

export function atomicUsdcToMicro(amountStr, label = "atomic amount") {
  if (amountStr === null || amountStr === undefined || typeof amountStr === "boolean") {
    throw new RangeError(`Invalid ${label}: '${amountStr}'.`);
  }
  const raw = String(amountStr).trim();
  if (!/^\d+$/.test(raw)) {
    throw new RangeError(`Invalid ${label}: '${amountStr}' must be a non-negative integer.`);
  }
  const val = BigInt(raw);
  if (val <= 0n) {
    throw new RangeError(`Invalid ${label}: '${amountStr}' must be greater than 0.`);
  }
  return val;
}

export function formatMicroUsd(micro) {
  const whole = micro / MICRO_PER_USD;
  const frac = (micro % MICRO_PER_USD).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export class Port4BudgetGuard {
  constructor(maxPerCallUsd = 0.1, maxSessionUsd = 2.0) {
    this.maxPerCallAtomic = parseUsdToMicro(maxPerCallUsd, "maxPerCallUsd");
    this.maxSessionAtomic = parseUsdToMicro(maxSessionUsd, "maxSessionUsd");
    this.committedAtomic = 0n;
    this.reservations = new Map();
    this._seq = 0;
  }

  get maxPerCallUsd() {
    return Number(this.maxPerCallAtomic) / 1_000_000;
  }

  get maxSessionUsd() {
    return Number(this.maxSessionAtomic) / 1_000_000;
  }

  get spentUsd() {
    return Number(this.committedAtomic) / 1_000_000;
  }

  get reservedAtomic() {
    let sum = 0n;
    for (const amt of this.reservations.values()) sum += amt;
    return sum;
  }

  reserve(priceUsdOrAtomic, { isAtomic = false } = {}) {
    let amountAtomic;
    try {
      amountAtomic = isAtomic
        ? atomicUsdcToMicro(priceUsdOrAtomic, "tool price")
        : parseUsdToMicro(priceUsdOrAtomic, "tool price");
      if (amountAtomic <= 0n) {
        return { allowed: false, reason: `Invalid tool price '${priceUsdOrAtomic}' (must be > 0).` };
      }
    } catch (err) {
      return {
        allowed: false,
        reason: err instanceof Error ? err.message : `Invalid tool price '${priceUsdOrAtomic}'.`
      };
    }

    if (amountAtomic > this.maxPerCallAtomic) {
      return {
        allowed: false,
        reason: `Tool price $${formatMicroUsd(amountAtomic)} exceeds per-call cap $${formatMicroUsd(this.maxPerCallAtomic)}.`
      };
    }

    const activeReserved = this.reservedAtomic;
    const projected = this.committedAtomic + activeReserved + amountAtomic;
    if (projected > this.maxSessionAtomic) {
      return {
        allowed: false,
        reason: `Session spend $${formatMicroUsd(projected)} would exceed session cap $${formatMicroUsd(this.maxSessionAtomic)}.`
      };
    }

    const reservationId = `res_${++this._seq}`;
    this.reservations.set(reservationId, amountAtomic);

    return {
      allowed: true,
      reservationId,
      reservedAtomic: amountAtomic.toString(),
      reservedUsd: formatMicroUsd(amountAtomic),
      totalCommittedUsd: formatMicroUsd(this.committedAtomic),
      totalReservedUsd: formatMicroUsd(activeReserved + amountAtomic)
    };
  }

  commit(reservationId) {
    if (!reservationId || !this.reservations.has(reservationId)) return false;
    const amt = this.reservations.get(reservationId);
    this.reservations.delete(reservationId);
    this.committedAtomic += amt;
    return true;
  }

  rollback(reservationId) {
    if (!reservationId) return false;
    return this.reservations.delete(reservationId);
  }

  checkAndReserve(priceUsdStr) {
    const res = this.reserve(priceUsdStr, { isAtomic: false });
    if (!res.allowed) return res;
    this.commit(res.reservationId);
    return {
      ...res,
      totalSpentUsd: this.spentUsd
    };
  }
}

export function handleLocalMcpLifecycle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" }
    };
  }

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || msg.method.length === 0) {
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code: -32600, message: "Invalid Request: expected JSON-RPC 2.0 with method" }
    };
  }

  // JSON-RPC 2.0 §4.1: notifications omit `id` and MUST NOT receive a response
  if (msg.id === undefined) {
    return "IGNORE_NOTIFICATION";
  }

  if (msg.method === "initialize") {
    const clientVersion =
      typeof msg.params?.protocolVersion === "string" && msg.params.protocolVersion.trim()
        ? msg.params.protocolVersion.trim()
        : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: clientVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "port4-mcp-bridge",
          version: CLI_VERSION
        }
      }
    };
  }

  if (msg.method === "ping") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {}
    };
  }

  return null;
}

export function extractPaymentRequired(res, body) {
  const headerVal =
    res?.headers?.get?.("payment-required") ?? res?.headers?.get?.("PAYMENT-REQUIRED");
  if (headerVal && typeof headerVal === "string" && headerVal.trim()) {
    try {
      const decoded = Buffer.from(headerVal.trim(), "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Fall back to body?.x402 below
    }
  }
  return body?.x402 && typeof body.x402 === "object" ? body.x402 : null;
}

export function selectPaymentRequirement(paymentRequired, preferredNetwork = "") {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  const exactReqs = accepts.filter(
    (r) =>
      r &&
      typeof r === "object" &&
      r.scheme === "exact" &&
      typeof r.network === "string" &&
      (r.network.startsWith("eip155:") || r.network.startsWith("solana:"))
  );
  if (exactReqs.length === 0) return null;
  const preferred = typeof preferredNetwork === "string" ? preferredNetwork.trim() : "";
  if (preferred) {
    return exactReqs.find((r) => r.network === preferred) ?? null;
  }
  return exactReqs[0];
}

export function selectEvmPaymentRequirement(paymentRequired, preferredNetwork = "") {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  const evmReqs = accepts.filter(
    (r) =>
      r &&
      typeof r === "object" &&
      r.scheme === "exact" &&
      typeof r.network === "string" &&
      r.network.startsWith("eip155:")
  );
  if (evmReqs.length === 0) return null;
  const preferred = typeof preferredNetwork === "string" ? preferredNetwork.trim() : "";
  if (preferred) {
    return evmReqs.find((r) => r.network === preferred) ?? null;
  }
  return evmReqs[0];
}

export function resolveRequirementMicroUsd(req) {
  if (!req || typeof req !== "object") {
    throw new RangeError("Missing payment requirement.");
  }
  const amountAtomic = atomicUsdcToMicro(req.amount, "requirement.amount");
  const rawExtraPrice = req.extra?.priceUsd;
  if (
    rawExtraPrice !== undefined &&
    rawExtraPrice !== null &&
    String(rawExtraPrice).trim() !== ""
  ) {
    const extraAtomic = parseUsdToMicro(rawExtraPrice, "requirement.extra.priceUsd");
    return extraAtomic > amountAtomic ? extraAtomic : amountAtomic;
  }
  return amountAtomic;
}

function validateHttpUrl(raw, flagName) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${flagName}: '${raw}'.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`URL for ${flagName} must use https:// or http:// (got '${raw}').`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function parseCliArgs(argv) {
  const rawArgs = argv.slice(2);
  const args = [];
  for (const token of rawArgs) {
    if (token.startsWith("--") && token.includes("=")) {
      const idx = token.indexOf("=");
      args.push(token.slice(0, idx), token.slice(idx + 1));
    } else {
      args.push(token);
    }
  }

  let command = "bridge";
  const positional = [];
  const rawMaxPerCall = process.env.PORT4_MAX_PER_CALL_USD || "0.10";
  const rawMaxSession = process.env.PORT4_MAX_SESSION_USD || "2.00";

  // Validate env defaults upfront
  parseUsdToMicro(rawMaxPerCall, "PORT4_MAX_PER_CALL_USD");
  parseUsdToMicro(rawMaxSession, "PORT4_MAX_SESSION_USD");

  const opts = {
    url: process.env.PORT4_MCP_URL || "https://port4.dev/mcp/demo",
    apiBase: (process.env.PORT4_API_BASE || "https://port4.dev").replace(/\/$/, ""),
    apiKey: process.env.PORT4_API_KEY || "",
    privateKey: process.env.PORT4_PRIVATE_KEY || "",
    solanaPrivateKey: process.env.PORT4_SOLANA_PRIVATE_KEY || "",
    mppCredential: process.env.PORT4_MPP_CREDENTIAL || "",
    tapPrivateKey: process.env.PORT4_TAP_PRIVATE_KEY || "",
    tapKeyId: process.env.PORT4_TAP_KEY_ID || "",
    network: process.env.PORT4_NETWORK || "",
    maxPerCallUsd: rawMaxPerCall,
    maxSessionUsd: rawMaxSession,
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID || "",
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || "",
    cfAccessJwt: process.env.CF_ACCESS_JWT || "",
    paymentSignature: process.env.PORT4_PAYMENT_SIGNATURE || "",
    price: "0.005",
    mcpMode: "openapi_codemode",
    mcpPath: "/mcp",
    subdomain: "",
    name: "",
    upstream: "",
    wallet: "",
    method: "POST",
    upstreamPath: "",
    description: "",
    schema: '{"type":"object","properties":{}}',
    limit: "50",
    selfTest: false,
    version: false,
    help: false
  };

  const requireValue = (flag, idx) => {
    const val = args[idx + 1];
    if (val === undefined || val.startsWith("-")) {
      throw new Error(`Flag '${flag}' requires a value.`);
    }
    return val;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--self-test") opts.selfTest = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--url") {
      opts.url = validateHttpUrl(requireValue(a, i), "--url");
      i++;
    } else if (a === "--api-base") {
      opts.apiBase = validateHttpUrl(requireValue(a, i), "--api-base");
      i++;
    } else if (a === "--api-key") {
      opts.apiKey = requireValue(a, i);
      i++;
    } else if (a === "--network") {
      opts.network = requireValue(a, i).trim();
      i++;
    } else if (a === "--max-per-call-usd") {
      const val = requireValue(a, i);
      parseUsdToMicro(val, "--max-per-call-usd");
      opts.maxPerCallUsd = val;
      i++;
    } else if (a === "--max-session-usd") {
      const val = requireValue(a, i);
      parseUsdToMicro(val, "--max-session-usd");
      opts.maxSessionUsd = val;
      i++;
    } else if (a === "--price" || a === "--default-price-usd") {
      const val = requireValue(a, i);
      const micro = parseUsdToMicro(val, a);
      if (micro <= 0n) throw new Error(`${a} must be greater than 0.`);
      opts.price = val.replace(/^\$/, "").trim();
      i++;
    } else if (a === "--mcp-mode") {
      const val = requireValue(a, i).trim();
      if (!VALID_MCP_MODES.has(val)) {
        throw new Error(`Invalid --mcp-mode '${val}'. Expected: direct, codemode, openapi_codemode.`);
      }
      opts.mcpMode = val;
      i++;
    } else if (a === "--mcp-path") {
      opts.mcpPath = requireValue(a, i).trim();
      i++;
    } else if (a === "--subdomain") {
      opts.subdomain = requireValue(a, i).trim().toLowerCase();
      i++;
    } else if (a === "--name") {
      opts.name = requireValue(a, i).trim();
      i++;
    } else if (a === "--upstream") {
      opts.upstream = validateHttpUrl(requireValue(a, i), "--upstream");
      i++;
    } else if (a === "--wallet") {
      opts.wallet = requireValue(a, i).trim();
      i++;
    } else if (a === "--method") {
      opts.method = requireValue(a, i).trim().toUpperCase();
      i++;
    } else if (a === "--path") {
      opts.upstreamPath = requireValue(a, i).trim();
      i++;
    } else if (a === "--description") {
      opts.description = requireValue(a, i).trim();
      i++;
    } else if (a === "--schema") {
      opts.schema = requireValue(a, i);
      i++;
    } else if (a === "--limit") {
      opts.limit = requireValue(a, i).trim();
      i++;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag '${a}'. Run 'port4-mcp --help' for usage.`);
    } else {
      positional.push(a);
    }
  }

  validateHttpUrl(opts.url, "PORT4_MCP_URL");
  validateHttpUrl(opts.apiBase, "PORT4_API_BASE");

  if (positional.length > 0) {
    const first = positional[0];
    if (
      [
        "bridge",
        "inspect",
        "tenants",
        "import-openapi",
        "create",
        "tools",
        "sync-mcp",
        "ledger",
        "help"
      ].includes(first)
    ) {
      command = first;
      positional.shift();
    } else if (first.startsWith("https://") || first.startsWith("http://")) {
      opts.url = validateHttpUrl(first, "url");
      positional.shift();
    } else {
      throw new Error(`Unknown command '${first}'. Run 'port4-mcp --help' for usage.`);
    }
  }

  return { command, positional, opts };
}

export function signTapHeaders({
  method,
  url,
  headers = {},
  rawBody = "",
  privateKeyPem,
  keyId,
  tag = "agent-payer-auth",
  nowSec = Math.floor(Date.now() / 1000),
  nonce = nodeCrypto.randomBytes(32).toString("base64")
}) {
  const parsed = new URL(url);
  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const digestB64 = nodeCrypto.createHash("sha256").update(bodyBuf).digest("base64");
  const contentDigest = `sha-256=:${digestB64}:`;
  const created = nowSec;
  const expires = nowSec + (tag === "agent-payer-auth" ? 300 : 60);
  const components = ["@method", "@scheme", "@authority", "@path", "@query", "content-digest"];
  const compStr = components.map((c) => `"${c}"`).join(" ");
  const sigParams = `(${compStr});created=${created};expires=${expires};keyid="${keyId}";alg="ed25519";nonce="${nonce}";tag="${tag}"`;

  const derived = {
    "@method": method.toUpperCase(),
    "@scheme": parsed.protocol.replace(/:$/, ""),
    "@authority": parsed.host,
    "@path": parsed.pathname || "/",
    "@query": parsed.search || "?",
    "content-digest": contentDigest
  };
  const baseLines = components.map((name) => `"${name}": ${derived[name] ?? headers[name] ?? ""}`);
  baseLines.push(`"@signature-params": ${sigParams}`);
  const base = Buffer.from(baseLines.join("\n"), "utf8");
  const keyObj = nodeCrypto.createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  const sigB64 = nodeCrypto.sign(null, base, keyObj).toString("base64");

  return {
    "Content-Digest": contentDigest,
    "Signature-Input": `sig2=${sigParams}`,
    Signature: `sig2=:${sigB64}:`
  };
}

export async function trySignWithSolanaPrivateKey(
  solanaPrivateKey,
  paymentRequired,
  selectedReq,
  deps = null
) {
  if (!solanaPrivateKey) {
    return {
      ok: false,
      reason: "missing_solana_private_key",
      hint: "Set PORT4_SOLANA_PRIVATE_KEY to enable Solana x402 signing."
    };
  }
  try {
    const x402Svm = deps?.x402Svm ?? (await import("@x402/svm"));
    if (typeof x402Svm.ExactSvmScheme !== "function") {
      return {
        ok: false,
        reason: "unsupported_x402_svm",
        hint: "Install @x402/svm@^2.0.0 to enable Solana SPL USDC signing."
      };
    }
    const signer = deps?.signer ?? solanaPrivateKey;
    const scheme = new x402Svm.ExactSvmScheme(signer);
    const x402Version = Number(paymentRequired?.x402Version ?? 2);
    const partial = await scheme.createPaymentPayload(x402Version, selectedReq);
    if (!partial?.payload) {
      throw new Error("ExactSvmScheme.createPaymentPayload returned empty payload.");
    }
    const paymentPayload = {
      x402Version: partial.x402Version ?? x402Version,
      scheme: selectedReq.scheme,
      network: selectedReq.network,
      accepted: selectedReq,
      ...(paymentRequired?.resource ? { resource: paymentRequired.resource } : {}),
      payload: partial.payload
    };
    return {
      ok: true,
      header: Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64"),
      requirement: selectedReq,
      paymentPayload
    };
  } catch (err) {
    return {
      ok: false,
      reason: "solana_signing_failed",
      hint: err instanceof Error ? err.message : "Install @x402/svm to sign Solana payments."
    };
  }
}

export async function trySignWithEvmPrivateKey(
  privateKey,
  paymentRequired,
  selectedReq,
  deps = null
) {
  if (!privateKey) {
    return {
      ok: false,
      reason: "missing_private_key",
      hint: "Set PORT4_PRIVATE_KEY to enable automatic x402 EIP-3009 signing."
    };
  }
  if (
    !selectedReq ||
    selectedReq.scheme !== "exact" ||
    !String(selectedReq.network || "").startsWith("eip155:") ||
    !/^\d+$/.test(String(selectedReq.amount || ""))
  ) {
    return {
      ok: false,
      reason: "invalid_evm_requirement",
      hint: "Selected payment requirement is not a valid EVM exact rail."
    };
  }

  const normalizedKey = String(privateKey).trim().startsWith("0x")
    ? String(privateKey).trim()
    : `0x${String(privateKey).trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedKey)) {
    const reason = "PORT4_PRIVATE_KEY must be a 32-byte hex private key.";
    process.stderr.write(`[port4-mcp] Signing error: ${reason}\n`);
    return { ok: false, reason: "invalid_private_key", hint: reason };
  }

  try {
    const viemAccounts = deps?.viemAccounts ?? (await import("viem/accounts"));
    const x402Evm = deps?.x402Evm ?? (await import("@x402/evm"));

    const account = viemAccounts.privateKeyToAccount(normalizedKey);
    const signer =
      typeof x402Evm.toClientEvmSigner === "function"
        ? x402Evm.toClientEvmSigner(account)
        : account;
    const scheme = new x402Evm.ExactEvmScheme(signer);
    if (typeof scheme.createPaymentPayload !== "function") {
      const reason = "@x402/evm ExactEvmScheme.createPaymentPayload is unavailable.";
      process.stderr.write(`[port4-mcp] Signing error: ${reason}\n`);
      return {
        ok: false,
        reason: "unsupported_x402_evm_version",
        hint: "Install @x402/evm@^2.0.0 and viem@^2.0.0."
      };
    }

    const x402Version = Number(paymentRequired?.x402Version ?? 2);
    const partial = await scheme.createPaymentPayload(x402Version, selectedReq);
    if (!partial || typeof partial !== "object" || !partial.payload) {
      throw new Error("ExactEvmScheme.createPaymentPayload returned an empty payload.");
    }

    const paymentPayload = {
      x402Version: partial.x402Version ?? x402Version,
      scheme: selectedReq.scheme,
      network: selectedReq.network,
      accepted: selectedReq,
      ...(paymentRequired?.resource ? { resource: paymentRequired.resource } : {}),
      ...(partial.extensions ? { extensions: partial.extensions } : {}),
      payload: partial.payload
    };

    const header = Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64");
    return {
      ok: true,
      header,
      payer: account.address,
      requirement: selectedReq,
      paymentPayload
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[port4-mcp] Signing failed: ${msg}\n`);
    return {
      ok: false,
      reason: "signing_failed",
      hint: `${msg} (ensure @x402/evm and viem are installed and EIP-712 extra.name/version are present).`
    };
  }
}

function safeParseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function wrapJsonRpcResponse(status, parsedBody, rawText, msgId) {
  if (
    parsedBody &&
    typeof parsedBody === "object" &&
    !Array.isArray(parsedBody) &&
    parsedBody.jsonrpc === "2.0" &&
    ("result" in parsedBody || "error" in parsedBody)
  ) {
    return parsedBody;
  }
  const errCode = status === 400 ? -32600 : -32000;
  const errMsg =
    (parsedBody && (parsedBody.message || parsedBody.error)) ||
    (rawText ? rawText.slice(0, 240) : `HTTP ${status}`);
  return {
    jsonrpc: "2.0",
    id: msgId ?? null,
    error: {
      code: errCode,
      message: String(errMsg),
      data: {
        status,
        body: parsedBody ?? rawText ?? null
      }
    }
  };
}

function logSettlementReceipt(res) {
  const txHeader = res?.headers?.get?.("x-port4-settlement-tx");
  const respHeader = res?.headers?.get?.("payment-response");
  let decoded = null;
  if (respHeader) {
    try {
      decoded = JSON.parse(Buffer.from(respHeader, "base64").toString("utf8"));
    } catch {
      decoded = null;
    }
  }
  const tx = txHeader || decoded?.transaction;
  const network = decoded?.network;
  if (tx) {
    process.stderr.write(
      `[port4-mcp] Settled tx=${tx}${network ? ` network=${network}` : ""}\n`
    );
  }
}

export async function forwardToPort4Edge(
  msg,
  opts,
  budget,
  fetchImpl = globalThis.fetch,
  signerImpl = trySignWithEvmPrivateKey
) {
  if (
    !msg ||
    typeof msg !== "object" ||
    Array.isArray(msg) ||
    msg.jsonrpc !== "2.0" ||
    typeof msg.method !== "string" ||
    msg.method.length === 0
  ) {
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code: -32600, message: "Invalid Request" }
    };
  }

  const serializedMsg = JSON.stringify(msg);
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
    if (opts.cfAccessJwt) {
      h["Cf-Access-Jwt-Assertion"] = opts.cfAccessJwt;
    }
    if (opts.mppCredential && msg.method === "tools/call" && !sig) {
      h["Authorization"] = opts.mppCredential.startsWith("Payment ")
        ? opts.mppCredential
        : `Payment ${opts.mppCredential}`;
    }
    if (sig && msg.method === "tools/call") {
      h["PAYMENT-SIGNATURE"] = sig;
    }
    if (opts.tapPrivateKey && opts.tapKeyId) {
      Object.assign(
        h,
        signTapHeaders({
          method: "POST",
          url: opts.url,
          headers: h,
          rawBody: serializedMsg,
          privateKeyPem: opts.tapPrivateKey,
          keyId: opts.tapKeyId,
          tag: msg.method === "tools/call" ? "agent-payer-auth" : "agent-browser-auth"
        })
      );
    }
    return h;
  };

  const res = await fetchImpl(opts.url, {
    method: "POST",
    headers: buildHeaders(opts.paymentSignature),
    body: serializedMsg
  });

  if (res.status === 402) {
    const rawText = await res.text().catch(() => "");
    const body = safeParseJsonText(rawText) ?? {};
    const paymentRequired = extractPaymentRequired(res, body);
    const evmReq = selectEvmPaymentRequirement(paymentRequired, opts.network);
    const selectedReq = selectPaymentRequirement(paymentRequired, opts.network);
    const activeReq = opts.network
      ? selectedReq
      : opts.privateKey && evmReq
        ? evmReq
        : opts.solanaPrivateKey && selectedReq?.network?.startsWith("solana:")
          ? selectedReq
          : (evmReq ?? selectedReq);
    const isSolana = Boolean(activeReq?.network?.startsWith("solana:"));
    const canSign = Boolean(
      activeReq && ((isSolana && opts.solanaPrivateKey) || (!isSolana && opts.privateKey))
    );
    const displayReq = activeReq ?? selectedReq ?? paymentRequired?.accepts?.[0] ?? null;

    if (!canSign || !activeReq) {
      let budgetGuard = { allowed: true, dryRun: true };
      if (displayReq) {
        try {
          const micro = resolveRequirementMicroUsd(displayReq);
          if (micro > budget.maxPerCallAtomic) {
            budgetGuard = {
              allowed: false,
              reason: `Tool price $${formatMicroUsd(micro)} exceeds per-call cap $${formatMicroUsd(budget.maxPerCallAtomic)}.`
            };
          } else {
            const projected = budget.committedAtomic + budget.reservedAtomic + micro;
            if (projected > budget.maxSessionAtomic) {
              budgetGuard = {
                allowed: false,
                reason: `Session spend $${formatMicroUsd(projected)} would exceed session cap $${formatMicroUsd(budget.maxSessionAtomic)}.`
              };
            } else {
              budgetGuard = {
                allowed: true,
                dryRun: true,
                priceUsd: formatMicroUsd(micro)
              };
            }
          }
        } catch {
          // ignore unparseable display rail
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
                  budgetGuard,
                  accepts: paymentRequired?.accepts ?? [],
                  hint: !opts.privateKey
                    ? "Set PORT4_PRIVATE_KEY (with @x402/evm + viem) or pass PAYMENT-SIGNATURE to auto-settle."
                    : opts.network
                      ? `No matching EVM exact rail found for network '${opts.network}'.`
                      : "No EVM exact payment rail found in 402 accepts[]."
                },
                null,
                2
              )
            }
          ],
          isError: Boolean(!budgetGuard.allowed || (opts.privateKey && !evmReq))
        }
      };
    }

    let amountMicro;
    try {
      amountMicro = resolveRequirementMicroUsd(activeReq);
    } catch (err) {
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
                  error: err instanceof Error ? err.message : "Invalid payment requirement amount.",
                  accepts: paymentRequired?.accepts ?? []
                },
                null,
                2
              )
            }
          ],
          isError: true
        }
      };
    }

    const reservation = budget.reserve(amountMicro, { isAtomic: true });
    if (!reservation.allowed) {
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
                  budgetGuard: reservation,
                  accepts: paymentRequired?.accepts ?? []
                },
                null,
                2
              )
            }
          ],
          isError: true
        }
      };
    }

    let committed = false;
    try {
      const signed = isSolana
        ? await trySignWithSolanaPrivateKey(opts.solanaPrivateKey, paymentRequired, activeReq)
        : await signerImpl(opts.privateKey, paymentRequired, activeReq);
      if (!signed?.ok || !signed.header) {
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
                    signingError: signed,
                    accepts: paymentRequired?.accepts ?? [],
                    hint: signed?.hint || "Install @x402/evm and viem to enable automatic EIP-3009 signing."
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          }
        };
      }

      const retryRes = await fetchImpl(opts.url, {
        method: "POST",
        headers: buildHeaders(signed.header),
        body: JSON.stringify(msg)
      });

      const retryText = await retryRes.text().catch(() => "");
      const retryBody = safeParseJsonText(retryText);

      if (retryRes.ok) {
        budget.commit(reservation.reservationId);
        committed = true;
        logSettlementReceipt(retryRes);
        return wrapJsonRpcResponse(retryRes.status, retryBody, retryText, msg.id);
      }

      if (retryRes.status === 409 && retryBody?.error === "payment_settlement_pending") {
        return {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: {
            code: -32000,
            message:
              retryBody.message ||
              "Payment settlement is still pending; retry with the same Idempotency-Key.",
            data: {
              status: 409,
              settlementPending: true,
              body: retryBody
            }
          }
        };
      }

      return wrapJsonRpcResponse(retryRes.status, retryBody, retryText, msg.id);
    } finally {
      if (!committed) {
        budget.rollback(reservation.reservationId);
      }
    }
  }

  const rawText = await res.text().catch(() => "");
  const parsed = safeParseJsonText(rawText);
  return wrapJsonRpcResponse(res.status, parsed, rawText, msg.id);
}

function buildOptionalAccessHeaders(opts) {
  const h = {};
  if (opts.cfAccessClientId && opts.cfAccessClientSecret) {
    h["CF-Access-Client-Id"] = opts.cfAccessClientId;
    h["CF-Access-Client-Secret"] = opts.cfAccessClientSecret;
  }
  if (opts.cfAccessJwt) {
    h["Cf-Access-Jwt-Assertion"] = opts.cfAccessJwt;
  }
  return h;
}

export async function runInspect(targetUrl, opts, fetchImpl = globalThis.fetch) {
  console.log(`Inspecting Port4 MCP Endpoint: ${targetUrl}\n`);
  const listRes = await fetchImpl(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
      ...buildOptionalAccessHeaders(opts)
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });

  const tenant = listRes.headers.get("x-port4-tenant") || "unknown";
  const mcpMode = listRes.headers.get("x-port4-mcp-mode") || "direct";
  const rawText = await listRes.text().catch(() => "");
  const listJson = safeParseJsonText(rawText);

  if (!listRes.ok) {
    console.error(
      `Error: tools/list failed with HTTP ${listRes.status}: ${JSON.stringify(listJson ?? rawText)}`
    );
    process.exit(1);
  }

  const tools = listJson?.result?.tools || [];
  console.log(`Tenant:   ${tenant}`);
  console.log(`MCP Mode: ${mcpMode}`);
  console.log(`Status:   HTTP ${listRes.status}`);
  console.log(`Tools (${tools.length}):`);
  for (const t of tools) {
    const price = t._meta?.x402?.priceUsd || (t._meta?.free ? "FREE" : "paid");
    const net = t._meta?.x402?.network || "";
    console.log(
      `  - ${t.name} [${price}${net ? ` on ${net}` : ""}]: ${t.description?.split("\n")[0] || ""}`
    );
  }

  const probeTool = tools.find((t) => !t._meta?.free);
  if (probeTool) {
    console.log(`\nProbing 402 payment rails using '${probeTool.name}'...`);
    const probeRes = await fetchImpl(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": probeTool.name,
        ...buildOptionalAccessHeaders(opts)
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: probeTool.name, arguments: {} }
      })
    });
    const probeText = await probeRes.text().catch(() => "");
    const probeJson = safeParseJsonText(probeText);
    const wwwAuth = probeRes.headers.get("www-authenticate");
    if (probeRes.status === 402) {
      const paymentReq = extractPaymentRequired(probeRes, probeJson);
      const accepts = paymentReq?.accepts ?? [];
      console.log(`402 Payment Rails (${accepts.length}):`);
      for (const req of accepts) {
        console.log(
          `  - ${req.network} | scheme=${req.scheme} | amount=${req.amount} ($${req.extra?.priceUsd ?? "?"}) | payTo=${req.payTo}`
        );
      }
      if (wwwAuth) {
        console.log(`WWW-Authenticate: ${wwwAuth}`);
      }
    } else if (probeRes.status === 403) {
      console.log(`Probe returned HTTP 403 (Visa TAP or Access policy enforced): ${JSON.stringify(probeJson ?? probeText)}`);
    } else {
      console.log(`Probe returned HTTP ${probeRes.status}`);
    }
  }
}

export async function runTenantsList(opts, fetchImpl = globalThis.fetch) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY (or --api-key p4_live_...) is required for control-plane commands.");
    process.exit(1);
  }
  if (!opts.apiKey.startsWith("p4_")) {
    console.error("Warning: Port4 scoped API keys normally start with 'p4_' (e.g. p4_live_...).");
  }
  const res = await fetchImpl(`${opts.apiBase}/api/tenants`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` }
  });
  const text = await res.text().catch(() => "");
  const json = safeParseJsonText(text) ?? { raw: text };
  if (!res.ok) {
    console.error(`Error: GET /api/tenants failed with HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

export async function runImportOpenApi(tenantId, specSource, opts, fetchImpl = globalThis.fetch) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY (or --api-key p4_live_...) is required.");
    process.exit(1);
  }
  if (!opts.apiKey.startsWith("p4_")) {
    console.error("Warning: Port4 scoped API keys normally start with 'p4_' (e.g. p4_live_...).");
  }
  if (!tenantId || !specSource) {
    console.error(
      "Usage: port4-mcp import-openapi <tenant_id> <https://.../openapi.json | ./openapi.json> [--price 0.005] [--mcp-mode openapi_codemode]"
    );
    process.exit(1);
  }

  let payload;
  if (specSource.startsWith("https://") || specSource.startsWith("http://")) {
    if (!specSource.startsWith("https://")) {
      console.error("Error: Remote OpenAPI spec_url must use https://.");
      process.exit(1);
    }
    payload = {
      spec_url: specSource,
      default_price_usd: opts.price || "0.005",
      mcp_mode: opts.mcpMode || "openapi_codemode"
    };
  } else {
    let rawSpec;
    try {
      rawSpec = fs.readFileSync(specSource, "utf8");
    } catch (err) {
      console.error(`Error: Unable to read OpenAPI file '${specSource}': ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    let parsedSpec;
    try {
      parsedSpec = JSON.parse(rawSpec);
    } catch {
      console.error(`Error: Local OpenAPI file '${specSource}' is not valid JSON.`);
      process.exit(1);
    }
    payload = {
      spec: parsedSpec,
      default_price_usd: opts.price || "0.005",
      mcp_mode: opts.mcpMode || "openapi_codemode"
    };
  }

  const res = await fetchImpl(
    `${opts.apiBase}/api/tenants/${encodeURIComponent(tenantId)}/import-openapi`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );
  const text = await res.text().catch(() => "");
  const json = safeParseJsonText(text) ?? { raw: text };
  if (!res.ok) {
    console.error(
      `Error: POST /api/tenants/${tenantId}/import-openapi failed with HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`
    );
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

export async function runCreateTenant(opts, fetchImpl = globalThis.fetch) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY (or --api-key p4_live_...) is required.");
    process.exit(1);
  }
  if (!opts.subdomain || !opts.upstream || !opts.wallet) {
    console.error(
      "Usage: port4-mcp create --subdomain <slug> --upstream <https://...> --wallet <addr> [--name <name>] [--network eip155:84532] [--mcp-mode direct]"
    );
    process.exit(1);
  }
  const res = await fetchImpl(`${opts.apiBase}/api/tenants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      subdomain: opts.subdomain,
      name: opts.name || opts.subdomain,
      upstream_base_url: opts.upstream,
      payout_wallet: opts.wallet,
      network: opts.network || "eip155:84532",
      mcp_mode: opts.mcpMode || "direct"
    })
  });
  const text = await res.text().catch(() => "");
  const json = safeParseJsonText(text) ?? { raw: text };
  if (!res.ok) {
    console.error(`Error: POST /api/tenants failed with HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

export async function runToolsCommand(subcommand, tenantId, arg3, opts, fetchImpl = globalThis.fetch) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY (or --api-key p4_live_...) is required.");
    process.exit(1);
  }
  if (subcommand === "add") {
    if (!tenantId || !arg3 || !opts.upstreamPath) {
      console.error(
        "Usage: port4-mcp tools add <tenant_id> <tool_name> --path </v1/op> [--method POST] [--price 0.005]"
      );
      process.exit(1);
    }
    const res = await fetchImpl(`${opts.apiBase}/api/tenants/${encodeURIComponent(tenantId)}/tools`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: arg3,
        description: opts.description || `Paid MCP tool ${arg3}`,
        http_method: opts.method || "POST",
        upstream_path: opts.upstreamPath,
        price_usd: opts.price || "0.005",
        input_schema_json: opts.schema || '{"type":"object","properties":{}}'
      })
    });
    const json = safeParseJsonText(await res.text().catch(() => "")) ?? {};
    if (!res.ok) {
      console.error(`Error: HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`);
      process.exit(1);
    }
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  if (subcommand === "delete") {
    if (!tenantId || !arg3) {
      console.error("Usage: port4-mcp tools delete <tenant_id> <tool_id>");
      process.exit(1);
    }
    const res = await fetchImpl(
      `${opts.apiBase}/api/tenants/${encodeURIComponent(tenantId)}/tools/${encodeURIComponent(arg3)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${opts.apiKey}` }
      }
    );
    const json = safeParseJsonText(await res.text().catch(() => "")) ?? {};
    if (!res.ok) {
      console.error(`Error: HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`);
      process.exit(1);
    }
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  console.error("Usage: port4-mcp tools <add|delete> ...");
  process.exit(1);
}

export async function runSyncMcp(tenantId, opts, fetchImpl = globalThis.fetch) {
  if (!opts.apiKey || !tenantId) {
    console.error("Usage: PORT4_API_KEY=... port4-mcp sync-mcp <tenant_id> [--mcp-path /mcp] [--price 0.005]");
    process.exit(1);
  }
  const res = await fetchImpl(`${opts.apiBase}/api/tenants/${encodeURIComponent(tenantId)}/sync-mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      mcp_path: opts.mcpPath || "/mcp",
      default_price_usd: opts.price || "0.005"
    })
  });
  const json = safeParseJsonText(await res.text().catch(() => "")) ?? {};
  if (!res.ok) {
    console.error(`Error: HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

export async function runLedger(opts, fetchImpl = globalThis.fetch) {
  if (!opts.apiKey) {
    console.error("Error: PORT4_API_KEY is required.");
    process.exit(1);
  }
  const res = await fetchImpl(
    `${opts.apiBase}/api/ledger?limit=${encodeURIComponent(opts.limit || "50")}`,
    {
      headers: { Authorization: `Bearer ${opts.apiKey}` }
    }
  );
  const json = safeParseJsonText(await res.text().catch(() => "")) ?? {};
  if (!res.ok) {
    console.error(`Error: HTTP ${res.status}:\n${JSON.stringify(json, null, 2)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

export function printHelp() {
  console.log(`port4-mcp v${CLI_VERSION} — Port4 Paid MCP & x402 CLI Bridge (https://port4.dev)

Usage:
  port4-mcp bridge --url <https://{tenant}.port4.dev/mcp> [--max-per-call-usd 0.05] [--max-session-usd 1.00] [--network eip155:8453]
  port4-mcp inspect <https://{tenant}.port4.dev/mcp>
  port4-mcp tenants [--api-key p4_live_...] [--api-base https://port4.dev]
  port4-mcp create --subdomain <slug> --upstream <https://...> --wallet <addr> [--network eip155:84532]
  port4-mcp tools add <tenant_id> <tool_name> --path </v1/op> [--method POST] [--price 0.005]
  port4-mcp tools delete <tenant_id> <tool_id>
  port4-mcp sync-mcp <tenant_id> [--mcp-path /mcp] [--price 0.005]
  port4-mcp import-openapi <tenant_id> <https://api.example.com/openapi.json | ./spec.json> [--price 0.005] [--mcp-mode openapi_codemode]
  port4-mcp ledger [--limit 50]
  port4-mcp --self-test
  port4-mcp --version

Note: Automatic EIP-3009 signing requires optional peer dependencies \`@x402/evm\` and \`viem\`:
  npx -y -p port4-mcp -p @x402/evm -p viem port4-mcp bridge --url https://port4.dev/mcp/demo

Environment Variables:
  PORT4_MCP_URL              Target Port4 MCP endpoint URL
  PORT4_API_BASE             Control-plane API base URL (default: https://port4.dev)
  PORT4_NETWORK              Preferred EVM/Solana settlement network (e.g. eip155:8453, solana:...)
  PORT4_MAX_PER_CALL_USD     Maximum USDC/OUSD price allowed per tool call (default: 0.10)
  PORT4_MAX_SESSION_USD      Maximum cumulative USDC/OUSD spend per session (default: 2.00)
  PORT4_PRIVATE_KEY          Optional EVM private key for auto-signing (requires @x402/evm + viem)
  PORT4_SOLANA_PRIVATE_KEY   Optional Solana private key for auto-signing (requires @x402/svm)
  PORT4_MPP_CREDENTIAL       Optional Tempo OUSD MPP Base64URL credential (Authorization: Payment)
  PORT4_TAP_PRIVATE_KEY      Optional Ed25519 PEM private key for Visa TAP RFC 9421 signing
  PORT4_TAP_KEY_ID           Optional Visa TAP keyid / JKT paired with PORT4_TAP_PRIVATE_KEY
  PORT4_API_KEY              Scoped developer API key (p4_live_...) for control-plane commands
  CF_ACCESS_CLIENT_ID        Optional Cloudflare Access Service Token Client ID
  CF_ACCESS_CLIENT_SECRET    Optional Cloudflare Access Service Token Client Secret
  CF_ACCESS_JWT              Optional Cloudflare Access JWT (Cf-Access-Jwt-Assertion)`);
}

export async function runSelfTest() {
  // 1. Lifecycle: initialize, ping, notifications, invalid JSON-RPC
  const initReply = handleLocalMcpLifecycle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2026-07-28" }
  });
  assert.equal(initReply.result.serverInfo.name, "port4-mcp-bridge");
  assert.equal(initReply.result.protocolVersion, "2026-07-28");

  const pingReply = handleLocalMcpLifecycle({
    jsonrpc: "2.0",
    id: 2,
    method: "ping"
  });
  assert.deepEqual(pingReply, { jsonrpc: "2.0", id: 2, result: {} });

  assert.equal(
    handleLocalMcpLifecycle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "IGNORE_NOTIFICATION"
  );
  assert.equal(
    handleLocalMcpLifecycle({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }),
    "IGNORE_NOTIFICATION"
  );

  const invalidReq = handleLocalMcpLifecycle({ id: 9, method: "tools/list" });
  assert.equal(invalidReq.error.code, -32600);

  // 2. Port4BudgetGuard: NaN/negative/Infinity rejection, IEEE-754 precision, reserve + commit + rollback
  assert.throws(() => new Port4BudgetGuard(NaN, 1), RangeError);
  assert.throws(() => new Port4BudgetGuard(0.1, -1), RangeError);
  assert.throws(() => new Port4BudgetGuard(Infinity, 1), RangeError);
  assert.throws(() => new Port4BudgetGuard("not-a-number", 1), RangeError);

  const precisionGuard = new Port4BudgetGuard("0.10", "0.30");
  assert.equal(precisionGuard.checkAndReserve("0.10").allowed, true);
  assert.equal(precisionGuard.checkAndReserve("0.10").allowed, true);
  assert.equal(precisionGuard.checkAndReserve("0.10").allowed, true);
  assert.equal(precisionGuard.checkAndReserve("0.01").allowed, false);

  const guard = new Port4BudgetGuard(0.05, 0.12);
  const r1 = guard.reserve("0.05");
  assert.equal(r1.allowed, true);
  assert.equal(guard.rollback(r1.reservationId), true);
  assert.equal(guard.spentUsd, 0);
  const r2 = guard.reserve("0.05");
  const r3 = guard.reserve("0.05");
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
  assert.equal(guard.reserve("0.03").allowed, false);
  assert.equal(guard.rollback(r2.reservationId), true);
  assert.equal(guard.commit(r3.reservationId), true);
  assert.equal(guard.spentUsd, 0.05);

  // 3. extractPaymentRequired, selectEvmPaymentRequirement, resolveRequirementMicroUsd
  const multiRailPayload = {
    x402Version: 2,
    resource: { url: "https://port4.dev/mcp/demo" },
    accepts: [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "1000",
        payTo: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        extra: { priceUsd: "0.001" }
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "80000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1111111111111111111111111111111111111111",
        extra: { name: "USD Coin", version: "2", priceUsd: "0.08" }
      }
    ]
  };
  const headerB64 = Buffer.from(JSON.stringify(multiRailPayload), "utf8").toString("base64");
  const extractedFromHeader = extractPaymentRequired(
    { headers: new Headers({ "PAYMENT-REQUIRED": headerB64 }) },
    {}
  );
  assert.equal(extractedFromHeader.accepts.length, 2);
  const evmSelected = selectEvmPaymentRequirement(extractedFromHeader);
  assert.equal(evmSelected.network, "eip155:8453");
  assert.equal(resolveRequirementMicroUsd(evmSelected), 80_000n);

  // Spoofed lower extra.priceUsd must NOT defeat authoritative atomic amount
  const spoofedReq = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "900000",
    extra: { priceUsd: "0.001" }
  };
  assert.equal(resolveRequirementMicroUsd(spoofedReq), 900_000n);
  assert.equal(new Port4BudgetGuard("0.10", "1.00").reserve(resolveRequirementMicroUsd(spoofedReq), { isAtomic: true }).allowed, false);

  // 4. Mocked @x402/evm v2 ExactEvmScheme.createPaymentPayload envelope smoke test
  const fakeKey = "0x" + "11".repeat(32);
  let capturedSchemeArgs = null;
  const mockSigned = await trySignWithEvmPrivateKey(fakeKey, multiRailPayload, evmSelected, {
    viemAccounts: {
      privateKeyToAccount: (k) => ({ address: "0x2222222222222222222222222222222222222222", key: k })
    },
    x402Evm: {
      toClientEvmSigner: (acc) => ({ wrapped: true, ...acc }),
      ExactEvmScheme: class {
        constructor(signer) {
          this.signer = signer;
        }
        async createPaymentPayload(x402Version, req) {
          capturedSchemeArgs = { x402Version, req, wrapped: this.signer.wrapped };
          return {
            x402Version,
            payload: { authorization: { from: this.signer.address }, signature: "0xsig" }
          };
        }
      }
    }
  });
  assert.equal(mockSigned.ok, true);
  assert.equal(capturedSchemeArgs.x402Version, 2);
  assert.equal(capturedSchemeArgs.wrapped, true);
  const decodedEnvelope = JSON.parse(Buffer.from(mockSigned.header, "base64").toString("utf8"));
  assert.equal(decodedEnvelope.scheme, "exact");
  assert.equal(decodedEnvelope.network, "eip155:8453");
  assert.equal(decodedEnvelope.accepted.amount, "80000");
  assert.equal(decodedEnvelope.payload.signature, "0xsig");

  // 5. forwardToPort4Edge rollback/commit & non-JSON-RPC error wrapping
  const bridgeGuard = new Port4BudgetGuard("0.10", "0.20");
  const challengeRes = () =>
    new Response(JSON.stringify({ x402: multiRailPayload }), {
      status: 402,
      headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": headerB64 }
    });
  const okSigner = async () => ({ ok: true, header: mockSigned.header });
  const baseOpts = {
    url: "https://port4.dev/mcp/demo",
    privateKey: fakeKey,
    network: "eip155:8453",
    paymentSignature: ""
  };
  const sampleCall = {
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "market_quote", arguments: {} }
  };

  // 5a. Retry 409 payment_settlement_pending must rollback and preserve error
  let attempt = 0;
  const reply409 = await forwardToPort4Edge(
    sampleCall,
    baseOpts,
    bridgeGuard,
    async () => {
      attempt++;
      if (attempt === 1) return challengeRes();
      return new Response(JSON.stringify({ error: "payment_settlement_pending", message: "wait" }), {
        status: 409,
        headers: { "Content-Type": "application/json" }
      });
    },
    okSigner
  );
  assert.equal(reply409.id, 42);
  assert.equal(reply409.error.data.settlementPending, true);
  assert.equal(bridgeGuard.spentUsd, 0);
  assert.equal(bridgeGuard.reservedAtomic, 0n);

  // 5b. Retry throw must rollback
  attempt = 0;
  await assert.rejects(() =>
    forwardToPort4Edge(
      sampleCall,
      baseOpts,
      bridgeGuard,
      async () => {
        attempt++;
        if (attempt === 1) return challengeRes();
        throw new Error("network down");
      },
      okSigner
    )
  );
  assert.equal(bridgeGuard.spentUsd, 0);
  assert.equal(bridgeGuard.reservedAtomic, 0n);

  // 5c. Retry 200 commits exact $0.08
  attempt = 0;
  const reply200 = await forwardToPort4Edge(
    sampleCall,
    baseOpts,
    bridgeGuard,
    async () => {
      attempt++;
      if (attempt === 1) return challengeRes();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 42, result: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    okSigner
  );
  assert.equal(reply200.result.ok, true);
  assert.equal(bridgeGuard.committedAtomic, 80_000n);

  // 5d. Non-JSON-RPC 403/404 from edge is wrapped into JSON-RPC 2.0 error
  const reply403 = await forwardToPort4Edge(
    sampleCall,
    baseOpts,
    bridgeGuard,
    async () =>
      new Response(JSON.stringify({ error: "visa_tap_required", message: "TAP required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      }),
    okSigner
  );
  assert.equal(reply403.jsonrpc, "2.0");
  assert.equal(reply403.id, 42);
  assert.equal(reply403.error.code, -32000);
  assert.equal(reply403.error.data.status, 403);

  // 6. Multi-rail Solana selection + Visa TAP Ed25519 signing + new CLI arg parsing
  const solSelected = selectPaymentRequirement(multiRailPayload, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(solSelected?.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");

  const { privateKey: tapPrivPem } = nodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const tapHeaders = signTapHeaders({
    method: "POST",
    url: "https://port4.dev/mcp/demo",
    rawBody: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    privateKeyPem: tapPrivPem,
    keyId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });
  assert.match(tapHeaders["Content-Digest"], /^sha-256=:/);
  assert.match(tapHeaders["Signature-Input"], /^sig2=\("@method" "@scheme" "@authority" "@path" "@query" "content-digest"\)/);
  assert.match(tapHeaders.Signature, /^sig2=:/);

  const parsedCreate = parseCliArgs([
    "node",
    "port4-mcp",
    "create",
    "--subdomain",
    "myapi",
    "--upstream",
    "https://api.example.com",
    "--wallet",
    "0x1111111111111111111111111111111111111111"
  ]);
  assert.equal(parsedCreate.command, "create");
  assert.equal(parsedCreate.opts.subdomain, "myapi");

  console.log("   PASS: Port4 STDIO MCP Bridge self-test (lifecycle + BigInt budget + multi-rail + TAP + x402 v2 envelope + rollback) passed.");
}

export async function runCli(argv = process.argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const { command, positional, opts } = parsed;

  if (opts.version) {
    console.log(`port4-mcp v${CLI_VERSION}`);
    process.exit(0);
  }

  if (opts.selfTest) {
    await runSelfTest();
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

  if (command === "create") {
    await runCreateTenant(opts);
    process.exit(0);
  }

  if (command === "tools") {
    await runToolsCommand(positional[0], positional[1], positional[2], opts);
    process.exit(0);
  }

  if (command === "sync-mcp") {
    await runSyncMcp(positional[0], opts);
    process.exit(0);
  }

  if (command === "ledger") {
    await runLedger(opts);
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
}

function isExecutedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedAsMain()) {
  await runCli(process.argv);
}
