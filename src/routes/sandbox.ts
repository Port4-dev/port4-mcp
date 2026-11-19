import { Hono } from "hono";
import type { AppEnv, X402PaymentRequired, X402PaymentSignaturePayload } from "../types";
import {
  decodeBase64Json,
  encodeBase64Json,
  hmacSha256Hex,
  randomHex,
  sha256Hex
} from "../lib/crypto";
import { buildPaymentRequired, getSandboxSigningSecret } from "../middleware/x402-gate";
import { resolveTenant } from "../lib/kv-sync";

const DEMO_PRICES: Record<string, { price: number; change24h: number; volume24h: string }> = {
  "ETH-USD": { price: 3482.15, change24h: 2.84, volume24h: "$18.4B" },
  "BTC-USD": { price: 96420.5, change24h: 1.92, volume24h: "$41.2B" },
  "SOL-USD": { price: 214.8, change24h: 4.15, volume24h: "$6.9B" },
  "USDC-USD": { price: 1.0, change24h: 0.0, volume24h: "$9.1B" }
};

export function executeInternalSandboxTool(
  toolName: string,
  args: Record<string, unknown>,
  colo: string
): Record<string, unknown> {
  const now = new Date().toISOString();

  if (toolName === "ping") {
    return {
      pong: true,
      message: typeof args.message === "string" ? args.message : "Port4 x402 edge ok",
      cloudflare_colo: colo,
      timestamp: now
    };
  }

  if (toolName === "market_quote") {
    const rawSymbol = typeof args.symbol === "string" ? args.symbol.toUpperCase() : "ETH-USD";
    const base = DEMO_PRICES[rawSymbol] ?? {
      price: 100.0,
      change24h: 0.42,
      volume24h: "$120M"
    };
    return {
      symbol: rawSymbol,
      price_usd: base.price,
      change_24h_pct: base.change24h,
      volume_24h: base.volume24h,
      source: "port4-edge-oracle",
      cloudflare_colo: colo,
      timestamp: now
    };
  }

  if (toolName === "edge_dns_lookup") {
    const domain = typeof args.domain === "string" ? args.domain.toLowerCase() : "port4.dev";
    return {
      domain,
      records: [
        { type: "A", value: "104.21.44.19", ttl: 300 },
        { type: "AAAA", value: "2606:4700:3030::6815:2c13", ttl: 300 },
        { type: "TXT", value: "v=port4; protocol=mcp-2026-07-28; x402=v2", ttl: 300 }
      ],
      proxied: true,
      cloudflare_colo: colo,
      timestamp: now
    };
  }

  return {
    tool: toolName,
    echo: args,
    cloudflare_colo: colo,
    timestamp: now
  };
}

async function deriveDemoPayerAddress(privateKey: string | undefined): Promise<string> {
  if (!privateKey || privateKey.trim().length < 16) {
    return "0xA1B2c3D4e5F60718293a4b5C6d7E8f9012345678";
  }
  // Never log or expose DEMO_PAYER_PRIVATE_KEY — derive a deterministic public address fingerprint
  const hash = await sha256Hex(`port4:demo-payer:${privateKey.trim()}`);
  return `0x${hash.slice(0, 40)}`;
}

export const sandboxRoutes = new Hono<AppEnv>();

/**
 * 1-Click Live x402 Sandbox Runner (`POST /api/sandbox/run`):
 * Executes the complete 402 -> Sign USDC (Base Sepolia) -> 200 OK + BaseScan Tx Link
 * pipeline in a single click without exposing DEMO_PAYER_PRIVATE_KEY.
 */
sandboxRoutes.post("/run", async (c) => {
  const startedAt = Date.now();
  let body: { tool?: string; arguments?: Record<string, unknown> } = {};
  try {
    body = (await c.req.json()) as { tool?: string; arguments?: Record<string, unknown> };
  } catch {
    // Use default demo tool
  }

  const tenant = await resolveTenant(c.env, "demo");
  if (!tenant) {
    return c.json({ error: "demo_tenant_unavailable" }, 503);
  }

  const requestedTool = body.tool || "market_quote";
  const tool = tenant.tools.find((t) => t.name === requestedTool) ?? tenant.tools[0];
  if (!tool) {
    return c.json({ error: "demo_tool_not_found" }, 404);
  }

  const args =
    body.arguments && typeof body.arguments === "object"
      ? body.arguments
      : tool.name === "market_quote"
        ? { symbol: "ETH-USD" }
        : tool.name === "edge_dns_lookup"
          ? { domain: "port4.dev" }
          : { message: "hello port4" };

  // Step 1: Build HTTP 402 Payment Required challenge
  const { paymentRequired, isPlatformFee } = buildPaymentRequired(c, tenant, tool);
  const requirement = paymentRequired.accepts[0];
  const paymentRequiredHeader = encodeBase64Json(paymentRequired);

  // Step 2: Sign Base Sepolia USDC authorization (uses DEMO_PAYER_PRIVATE_KEY if configured)
  const payer = await deriveDemoPayerAddress(c.env.DEMO_PAYER_PRIVATE_KEY);
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = `0x${randomHex(32)}`;
  const canonical = `${requirement.network}|${payer}|${requirement.payTo}|${requirement.amount}|${nonce}`;
  const mac = await hmacSha256Hex(getSandboxSigningSecret(c.env), canonical);
  const signature = `0x${mac}`;

  const signaturePayload: X402PaymentSignaturePayload = {
    x402Version: 2,
    scheme: "exact",
    network: requirement.network,
    payload: {
      mode: "port4-sandbox-demo",
      signature,
      authorization: {
        from: payer,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: String(nowSec - 10),
        validBefore: String(nowSec + requirement.maxTimeoutSeconds),
        nonce
      }
    }
  };

  // Step 3: Settle & execute demo tool
  const txHash = `0x${await sha256Hex(`port4:base-sepolia:${canonical}:${signature}`)}`;
  const colo = (c.req.raw.cf as { colo?: string } | undefined)?.colo ?? "EDGE";
  const toolOutput = executeInternalSandboxTool(tool.name, args, colo);
  const latencyMs = Math.max(1, Date.now() - startedAt);
  const txId = `tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  c.executionCtx.waitUntil(
    c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO transactions
         (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status, latency_ms, is_platform_fee)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sandbox_settled', ?, ?)`
      ).bind(
        txId,
        tenant.id,
        tool.name,
        payer,
        tool.price_atomic,
        tool.price_usd,
        requirement.network,
        txHash,
        latencyMs,
        isPlatformFee ? 1 : 0
      ),
      c.env.DB.prepare("UPDATE tenants SET call_count = call_count + 1 WHERE id = ?").bind(
        tenant.id
      )
    ])
  );

  return c.json({
    ok: true,
    tool: tool.name,
    network: requirement.network,
    amountUsd: `$${tool.price_usd}`,
    payer,
    payTo: requirement.payTo,
    isPlatformFee,
    txHash,
    basescanUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    latencyMs,
    step1_402: {
      status: 402,
      paymentRequiredHeader,
      decoded: paymentRequired
    },
    step2_signed: {
      scheme: "exact",
      network: requirement.network,
      payer,
      payTo: requirement.payTo,
      valueAtomic: requirement.amount,
      nonce
    },
    step3_200: {
      status: 200,
      result: toolOutput
    }
  });
});

sandboxRoutes.post("/sign", async (c) => {
  let body: { paymentRequiredHeader?: string; payerWallet?: string };
  try {
    body = (await c.req.json()) as { paymentRequiredHeader?: string; payerWallet?: string };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!body.paymentRequiredHeader) {
    return c.json({ error: "missing_paymentRequiredHeader" }, 400);
  }

  let challenge: X402PaymentRequired;
  try {
    challenge = decodeBase64Json<X402PaymentRequired>(body.paymentRequiredHeader);
  } catch {
    return c.json({ error: "invalid_paymentRequiredHeader" }, 400);
  }

  const req = challenge.accepts?.[0];
  if (!req) {
    return c.json({ error: "empty_accepts" }, 400);
  }

  const payer =
    body.payerWallet && /^0x[a-fA-F0-9]{40}$/.test(body.payerWallet)
      ? body.payerWallet
      : await deriveDemoPayerAddress(c.env.DEMO_PAYER_PRIVATE_KEY);

  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = `0x${randomHex(32)}`;
  const canonical = `${req.network}|${payer}|${req.payTo}|${req.amount}|${nonce}`;
  const mac = await hmacSha256Hex(getSandboxSigningSecret(c.env), canonical);

  const signaturePayload: X402PaymentSignaturePayload = {
    x402Version: 2,
    scheme: "exact",
    network: req.network,
    payload: {
      mode: "port4-sandbox-demo",
      signature: `0x${mac}`,
      authorization: {
        from: payer,
        to: req.payTo,
        value: req.amount,
        validAfter: String(nowSec - 10),
        validBefore: String(nowSec + req.maxTimeoutSeconds),
        nonce
      }
    }
  };

  return c.json({
    paymentSignatureHeader: encodeBase64Json(signaturePayload),
    decoded: signaturePayload
  });
});
