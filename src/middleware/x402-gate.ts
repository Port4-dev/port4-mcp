import type { Context, MiddlewareHandler } from "hono";
import type {
  AppBindings,
  AppEnv,
  TenantRoutingRecord,
  ToolRecord,
  X402PaymentRequired,
  X402PaymentRequirement,
  X402PaymentSignaturePayload,
  X402SettlementReceipt
} from "../types";
import {
  decodeBase64Json,
  encodeBase64Json,
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualString
} from "../lib/crypto";

async function verifyEnterpriseOAuthV2Stub(
  c: Context<AppEnv>,
  tenant: TenantRoutingRecord
): Promise<{ ok: true } | { ok: false; status: 401; error: string }> {
  if (tenant.auth_mode !== "x402+oauth_v2") {
    return { ok: true };
  }
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Enterprise tenant requires OAuth 2.1 Bearer token (CIMD / RFC 9207)."
    };
  }
  return { ok: true };
}

/**
 * Deterministic Non-Custodial Fee Split:
 * - 'free' plan (3%): every 33rd call routes payTo to PORT4_TREASURY_WALLET
 * - 'pro' plan (1%): every 100th call routes payTo to PORT4_TREASURY_WALLET
 */
export function computeFeeSplit(
  env: AppBindings,
  tenant: TenantRoutingRecord
): { payTo: string; isPlatformFee: boolean } {
  const nextCallNumber = (tenant.call_count ?? 0) + 1;
  const interval = tenant.owner_plan === "pro" ? 100 : 33;
  const treasury = env.PORT4_TREASURY_WALLET?.trim();
  const isPlatformFee = Boolean(treasury && /^0x[a-fA-F0-9]{40}$/.test(treasury)) && nextCallNumber % interval === 0;

  return {
    payTo: isPlatformFee && treasury ? treasury : tenant.payout_wallet,
    isPlatformFee
  };
}

export function buildPaymentRequired(
  c: Context<AppEnv>,
  tenant: TenantRoutingRecord,
  tool: ToolRecord
): { paymentRequired: X402PaymentRequired; isPlatformFee: boolean } {
  const { payTo, isPlatformFee } = computeFeeSplit(c.env, tenant);

  const requirement: X402PaymentRequirement = {
    scheme: "exact",
    network: tenant.network || c.env.X402_NETWORK,
    amount: tool.price_atomic,
    asset: c.env.X402_USDC_ASSET,
    payTo,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USD Coin",
      version: "2",
      tenant: tenant.subdomain,
      tool: tool.name,
      priceUsd: tool.price_usd,
      isPlatformFee
    }
  };

  return {
    isPlatformFee,
    paymentRequired: {
      x402Version: 2,
      resource: {
        url: c.req.url,
        description: `${tenant.name} — MCP tool '${tool.name}' ($${tool.price_usd} USDC)`,
        mimeType: "application/json"
      },
      accepts: [requirement]
    }
  };
}

export function getSandboxSigningSecret(env: AppBindings): string {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
    throw new Error("JWT_SECRET binding is required for sandbox signing.");
  }
  return env.JWT_SECRET;
}

async function verifySandboxSignature(
  env: AppBindings,
  decoded: X402PaymentSignaturePayload,
  requirement: X402PaymentRequirement,
  isPlatformFee: boolean
): Promise<X402SettlementReceipt | null> {
  const auth = decoded.payload?.authorization;
  const sig = decoded.payload?.signature;
  if (!auth || typeof sig !== "string") {
    return null;
  }

  if (
    auth.to.toLowerCase() !== requirement.payTo.toLowerCase() ||
    auth.value !== requirement.amount
  ) {
    return null;
  }

  const canonical = `${decoded.network}|${auth.from}|${auth.to}|${auth.value}|${auth.nonce}`;
  const expectedMac = await hmacSha256Hex(getSandboxSigningSecret(env), canonical);
  const expectedSig = `0x${expectedMac}`;

  if (!(await timingSafeEqualString(sig.toLowerCase(), expectedSig.toLowerCase()))) {
    return null;
  }

  const txHash = `0x${await sha256Hex(`port4:base-sepolia:${canonical}:${sig}`)}`;
  return {
    success: true,
    transaction: txHash,
    network: requirement.network,
    payer: auth.from,
    errorReason: null,
    mode: "sandbox",
    isPlatformFee,
    payTo: requirement.payTo
  };
}

async function verifyAndSettleViaFacilitator(
  env: AppBindings,
  decoded: X402PaymentSignaturePayload,
  requirement: X402PaymentRequirement,
  isPlatformFee: boolean
): Promise<X402SettlementReceipt> {
  const baseUrl = (env.FACILITATOR_URL || env.X402_FACILITATOR_URL).replace(/\/$/, "");
  const payload = {
    x402Version: 2,
    paymentPayload: decoded,
    paymentRequirements: requirement
  };

  const verifyRes = await fetch(`${baseUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!verifyRes.ok) {
    const errText = await verifyRes.text().catch(() => "Facilitator verify failed");
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: decoded.payload?.authorization?.from ?? "unknown",
      errorReason: `facilitator_verify_http_${verifyRes.status}: ${errText.slice(0, 160)}`,
      mode: "facilitator",
      isPlatformFee,
      payTo: requirement.payTo
    };
  }

  const verifyJson = (await verifyRes.json()) as {
    isValid?: boolean;
    invalidReason?: string;
    payer?: string;
  };

  if (!verifyJson.isValid) {
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: verifyJson.payer ?? decoded.payload?.authorization?.from ?? "unknown",
      errorReason: verifyJson.invalidReason ?? "invalid_payment_signature",
      mode: "facilitator",
      isPlatformFee,
      payTo: requirement.payTo
    };
  }

  const settleRes = await fetch(`${baseUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!settleRes.ok) {
    const errText = await settleRes.text().catch(() => "Facilitator settle failed");
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: verifyJson.payer ?? "unknown",
      errorReason: `facilitator_settle_http_${settleRes.status}: ${errText.slice(0, 160)}`,
      mode: "facilitator",
      isPlatformFee,
      payTo: requirement.payTo
    };
  }

  const settleJson = (await settleRes.json()) as {
    success?: boolean;
    transaction?: string;
    txHash?: string;
    network?: string;
    payer?: string;
    errorReason?: string | null;
  };

  return {
    success: Boolean(settleJson.success),
    transaction: settleJson.transaction ?? settleJson.txHash ?? "",
    network: settleJson.network ?? requirement.network,
    payer: settleJson.payer ?? verifyJson.payer ?? decoded.payload?.authorization?.from ?? "unknown",
    errorReason: settleJson.errorReason ?? null,
    mode: "facilitator",
    isPlatformFee,
    payTo: requirement.payTo
  };
}

export const x402GateMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const mcp = c.get("mcp");
  const tenant = c.get("tenant");

  if (!mcp || !tenant) {
    return c.json({ error: "gateway_context_missing" }, 500);
  }

  if (mcp.method !== "tools/call") {
    await next();
    return;
  }

  const enterpriseAuth = await verifyEnterpriseOAuthV2Stub(c, tenant);
  if (!enterpriseAuth.ok) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: mcp.rpcId,
        error: { code: -32001, message: enterpriseAuth.error }
      },
      enterpriseAuth.status
    );
  }

  const tool = tenant.tools.find((t) => t.name === mcp.toolName);
  if (!tool) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: mcp.rpcId,
        error: {
          code: -32602,
          message: `Unknown tool '${mcp.toolName ?? ""}' on tenant '${tenant.subdomain}'.`
        }
      },
      404
    );
  }

  c.set("selectedTool", tool);

  const { paymentRequired, isPlatformFee } = buildPaymentRequired(c, tenant, tool);
  const paymentRequiredHeader = encodeBase64Json(paymentRequired);
  const requirement = paymentRequired.accepts[0];

  const signatureHeader = c.req.header("PAYMENT-SIGNATURE");
  if (!signatureHeader) {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    c.header("X-Port4-Tenant", tenant.subdomain);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        error: "payment_required",
        message: `Payment of $${tool.price_usd} USDC (${tool.price_atomic} atomic units) on ${requirement.network} required for tool '${tool.name}'.`,
        x402: paymentRequired
      },
      402
    );
  }

  let decodedSignature: X402PaymentSignaturePayload;
  try {
    decodedSignature = decodeBase64Json<X402PaymentSignaturePayload>(signatureHeader);
  } catch {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    return c.json(
      {
        error: "invalid_payment_signature_encoding",
        message: "PAYMENT-SIGNATURE must be a valid Base64-encoded x402 v2 JSON payload."
      },
      402
    );
  }

  let receipt: X402SettlementReceipt | null = null;

  if (tenant.subdomain === "demo" && decodedSignature.payload?.mode === "port4-sandbox-demo") {
    receipt = await verifySandboxSignature(c.env, decodedSignature, requirement, isPlatformFee);
  } else {
    receipt = await verifyAndSettleViaFacilitator(c.env, decodedSignature, requirement, isPlatformFee);
  }

  if (!receipt || !receipt.success) {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    return c.json(
      {
        error: "payment_verification_failed",
        reason: receipt?.errorReason ?? "signature_mismatch",
        x402: paymentRequired
      },
      402
    );
  }

  c.set("x402Receipt", receipt);
  await next();

  c.header("PAYMENT-RESPONSE", encodeBase64Json(receipt));
  c.header("X-Port4-Settlement-Tx", receipt.transaction);
  c.header("X-Port4-Tenant", tenant.subdomain);
};
