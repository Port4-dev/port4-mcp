import type { Context, MiddlewareHandler } from "hono";
import type {
  AppBindings,
  AppEnv,
  PaymentExecutionContext,
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
  randomHex,
  sha256Hex,
  timingSafeEqualString,
  usdToAtomicUsdc
} from "../lib/crypto";
import { verifyCloudflareAccessJwt } from "../lib/cloudflare-access";
import {
  EVM_ADDRESS_RE,
  SOLANA_ADDRESS_RE,
  getNetworkFamily,
  normalizePayoutWallets,
  resolveUsdcAssetForNetwork
} from "../lib/networks";

async function verifyEnterpriseOAuthV2(
  c: Context<AppEnv>,
  tenant: TenantRoutingRecord
): Promise<{ ok: true } | { ok: false; status: 401 | 403 | 503; error: string }> {
  if (tenant.auth_mode !== "x402+oauth_v2") {
    return { ok: true };
  }
  if (!tenant.cf_access_team_domain || !tenant.cf_access_aud) {
    return {
      ok: false,
      status: 503,
      error: "Cloudflare Access team domain and AUD tag must be configured for x402+oauth_v2 tenants."
    };
  }

  const cfAssertion = c.req.header("Cf-Access-Jwt-Assertion")?.trim();
  const authHeader = c.req.header("Authorization")?.trim();
  const bearerToken =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
  const token = cfAssertion || bearerToken;

  if (!token) {
    return {
      ok: false,
      status: 401,
      error:
        "Cloudflare Access JWT required (send Cf-Access-Jwt-Assertion via Access Service Token or Authorization: Bearer <jwt>)."
    };
  }

  const verified = await verifyCloudflareAccessJwt({
    token,
    teamDomain: tenant.cf_access_team_domain,
    expectedAud: tenant.cf_access_aud
  });
  if (!verified.ok) {
    return verified;
  }
  return { ok: true };
}

/**
 * Deterministic Non-Custodial Fee Split using the tenant-wide settled call sequence
 * (independent of per-IP discovery requests):
 * - 'free' plan (3%): every 33rd paid call routes payTo to PORT4_TREASURY_WALLET
 * - 'pro' plan (1%): every 100th paid call routes payTo to PORT4_TREASURY_WALLET
 */
export function computeFeeSplit(
  env: AppBindings,
  tenant: TenantRoutingRecord,
  tenantPaidSequence?: number,
  targetNetwork?: string,
  targetWallet?: string
): { payTo: string; isPlatformFee: boolean } {
  const nextCallNumber =
    typeof tenantPaidSequence === "number" && tenantPaidSequence > 0
      ? tenantPaidSequence
      : (tenant.settled_call_sequence ?? tenant.call_count ?? 0) + 1;
  const interval = tenant.owner_plan === "pro" ? 100 : 33;
  const family = getNetworkFamily(targetNetwork || tenant.network);
  const treasury =
    family === "solana"
      ? env.PORT4_TREASURY_SOLANA_WALLET?.trim()
      : env.PORT4_TREASURY_WALLET?.trim();
  const validTreasury =
    family === "solana"
      ? Boolean(treasury && SOLANA_ADDRESS_RE.test(treasury))
      : Boolean(treasury && EVM_ADDRESS_RE.test(treasury));
  const isPlatformFee = validTreasury && nextCallNumber % interval === 0;
  const fallbackWallet = targetWallet || tenant.payout_wallet;

  return {
    payTo: isPlatformFee && treasury ? treasury : fallbackWallet,
    isPlatformFee
  };
}

export function resolveUsdcAsset(network: string, fallback: string): string {
  return resolveUsdcAssetForNetwork(network, fallback);
}

export function buildPaymentRequired(
  c: Context<AppEnv>,
  tenant: TenantRoutingRecord,
  tool: ToolRecord,
  paidSequence?: number
): { paymentRequired: X402PaymentRequired; isPlatformFee: boolean } {
  const primaryNetwork = tenant.network || c.env.X402_NETWORK;
  const configuredWallets =
    Array.isArray(tenant.payout_wallets) && tenant.payout_wallets.length > 0
      ? tenant.payout_wallets
      : normalizePayoutWallets(primaryNetwork, tenant.payout_wallet);

  const wallets =
    configuredWallets.length > 0
      ? configuredWallets
      : [{ network: primaryNetwork, address: tenant.payout_wallet }];

  const sequence = paidSequence ?? (tenant.settled_call_sequence ?? tenant.call_count ?? 0) + 1;
  let anyPlatformFee = false;

  const accepts: X402PaymentRequirement[] = wallets.map((entry) => {
    const { payTo, isPlatformFee } = computeFeeSplit(
      c.env,
      tenant,
      sequence,
      entry.network,
      entry.address
    );
    if (isPlatformFee) anyPlatformFee = true;
    return {
      scheme: "exact",
      network: entry.network,
      amount: tool.price_atomic,
      asset: resolveUsdcAsset(entry.network, c.env.X402_USDC_ASSET),
      payTo,
      maxTimeoutSeconds: 60,
      extra: {
        name: "USD Coin",
        version: "2",
        paymentFlow: "upfront",
        tenant: tenant.subdomain,
        tool: tool.name,
        priceUsd: tool.price_usd,
        isPlatformFee
      }
    };
  });

  return {
    isPlatformFee: anyPlatformFee,
    paymentRequired: {
      x402Version: 2,
      resource: {
        url: c.req.url,
        description: `${tenant.name} — MCP tool '${tool.name}' ($${tool.price_usd} USDC)`,
        mimeType: "application/json"
      },
      accepts
    }
  };
}

export function getSandboxSigningSecret(env: AppBindings): string {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
    throw new Error("JWT_SECRET binding is required for sandbox signing.");
  }
  return env.JWT_SECRET;
}

/**
 * Derives a canonical, manipulation-resistant payment authorization identity
 * independent of Base64 JSON whitespace or key ordering.
 */
async function computeCanonicalPaymentFingerprint(
  decoded: X402PaymentSignaturePayload
): Promise<string> {
  const family = getNetworkFamily(decoded.network);
  if (family === "solana" && typeof decoded.payload?.transaction === "string") {
    return sha256Hex(`x402:svm:${decoded.network}:${decoded.payload.transaction.trim()}`);
  }
  const auth = decoded.payload?.authorization;
  if (auth) {
    return sha256Hex(
      `x402:evm:${decoded.network}:${(auth.from || "").toLowerCase()}:${(auth.to || "").toLowerCase()}:${auth.value || ""}:${(auth.nonce || "").toLowerCase()}`
    );
  }
  return sha256Hex(JSON.stringify(decoded));
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
    decoded.x402Version !== 2 ||
    decoded.scheme !== "exact" ||
    decoded.network !== requirement.network ||
    !/^0x[a-fA-F0-9]{40}$/.test(auth.from) ||
    !/^0x[a-fA-F0-9]{64}$/.test(auth.nonce) ||
    !/^\d+$/.test(auth.validAfter) ||
    !/^\d+$/.test(auth.validBefore) ||
    Number(auth.validAfter) > Math.floor(Date.now() / 1000) ||
    Number(auth.validBefore) < Math.floor(Date.now() / 1000) ||
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
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
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
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });

  if (!settleRes.ok) {
    const errText = await settleRes.text().catch(() => "Facilitator settle failed");
    // HTTP 202 or 504 during settlement may indicate a broadcast transaction still pending on-chain
    const mayBePending = settleRes.status === 202 || settleRes.status === 504;
    return {
      success: false,
      settlementPending: mayBePending,
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
    status?: string;
    settlementPending?: boolean;
    transaction?: string;
    txHash?: string;
    network?: string;
    payer?: string;
    errorReason?: string | null;
  };

  const txHash = (settleJson.transaction ?? settleJson.txHash ?? "").trim();
  const isPending =
    settleJson.status === "settlement_pending" ||
    settleJson.settlementPending === true ||
    settleRes.status === 202;

  if (isPending) {
    return {
      success: false,
      settlementPending: true,
      transaction: txHash,
      network: settleJson.network ?? requirement.network,
      payer: settleJson.payer ?? verifyJson.payer ?? decoded.payload?.authorization?.from ?? "unknown",
      errorReason: "settlement_pending",
      mode: "facilitator",
      isPlatformFee,
      payTo: requirement.payTo
    };
  }

  const validSettlement =
    Boolean(settleJson.success) &&
    txHash.length >= 16 &&
    (!settleJson.network || settleJson.network === requirement.network);

  return {
    success: validSettlement,
    transaction: txHash,
    network: settleJson.network ?? requirement.network,
    payer: settleJson.payer ?? verifyJson.payer ?? decoded.payload?.authorization?.from ?? "unknown",
    errorReason: validSettlement
      ? null
      : (settleJson.errorReason ?? "invalid_facilitator_settlement_receipt"),
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

  const enterpriseAuth = await verifyEnterpriseOAuthV2(c, tenant);
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

  // Free progressive discovery tool in OpenAPI Code Mode (`search`)
  if (tenant.mcp_mode === "openapi_codemode" && mcp.toolName === "search") {
    await next();
    return;
  }

  let tool: ToolRecord | undefined;
  const isCodeModeExec =
    (tenant.mcp_mode === "codemode" && mcp.toolName === "code") ||
    (tenant.mcp_mode === "openapi_codemode" && mcp.toolName === "execute");

  if (isCodeModeExec) {
    const cmPrice = tenant.codemode_price_usd || "0.01";
    let cmAtomic = "10000";
    try {
      cmAtomic = usdToAtomicUsdc(cmPrice);
    } catch {
      cmAtomic = "10000";
    }
    tool = {
      id: `codemode_${tenant.id}`,
      tenant_id: tenant.id,
      name: mcp.toolName!,
      description: `Code Mode sandbox execution on ${tenant.name}`,
      http_method: "POST",
      upstream_path: "/_codemode",
      input_schema_json: '{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}',
      price_usd: cmPrice,
      price_atomic: cmAtomic,
      is_active: 1
    };
  } else {
    tool = tenant.tools.find((t) => t.name === mcp.toolName);
  }

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

  const { paymentRequired } = buildPaymentRequired(c, tenant, tool);
  const paymentRequiredHeader = encodeBase64Json(paymentRequired);
  const primaryRequirement = paymentRequired.accepts[0];

  const signatureHeader = c.req.header("PAYMENT-SIGNATURE");
  if (!signatureHeader) {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    c.header("X-Port4-Tenant", tenant.subdomain);
    c.header("Cache-Control", "no-store");
    const networkSummary = paymentRequired.accepts.map((a) => a.network).join(", ");
    return c.json(
      {
        error: "payment_required",
        message: `Payment of $${tool.price_usd} USDC (${tool.price_atomic} atomic units) on ${networkSummary} required for tool '${tool.name}'.`,
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

  const matchedRequirement = paymentRequired.accepts.find(
    (req) => req.network === decodedSignature.network && req.scheme === decodedSignature.scheme
  );
  const family = matchedRequirement ? getNetworkFamily(matchedRequirement.network) : "evm";
  const hasValidPayload =
    family === "solana"
      ? typeof decodedSignature.payload?.transaction === "string" &&
        decodedSignature.payload.transaction.length > 16
      : Boolean(decodedSignature.payload?.authorization);

  if (decodedSignature.x402Version !== 2 || !matchedRequirement || !hasValidPayload) {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    return c.json(
      {
        error: "invalid_payment_signature",
        message: `Payment does not match any accepted x402 network (${paymentRequired.accepts.map((a) => a.network).join(", ")}).`
      },
      402
    );
  }

  const requirement = matchedRequirement ?? primaryRequirement;
  const isPlatformFee = Boolean(requirement.extra.isPlatformFee);

  // Verify EVM authorization target & amount BEFORE checking replay cache so mismatched context never hits cache
  if (family === "evm" && decodedSignature.payload?.authorization) {
    const auth = decodedSignature.payload.authorization;
    if (
      auth.to.toLowerCase() !== requirement.payTo.toLowerCase() ||
      auth.value !== requirement.amount
    ) {
      c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
      return c.json(
        {
          error: "invalid_payment_authorization_target",
          message: "Payment authorization recipient or amount does not match this tool's requirement."
        },
        402
      );
    }
  }

  const paymentFingerprint = await computeCanonicalPaymentFingerprint(decodedSignature);
  const leaseToken = `lease_${randomHex(16)}`;
  const paymentContext: PaymentExecutionContext = {
    tenantId: tenant.id,
    toolName: tool.name,
    resourceUrl: c.req.url,
    network: requirement.network,
    asset: requirement.asset,
    amountAtomic: requirement.amount,
    payTo: requirement.payTo
  };

  const replayStub = c.env.PAYMENT_REPLAY_GUARD.get(
    c.env.PAYMENT_REPLAY_GUARD.idFromName(paymentFingerprint)
  );
  const replayClaim = await replayStub.fetch("https://payment-replay/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "claim", context: paymentContext, leaseToken })
  });

  if (!replayClaim.ok) {
    return c.json({ error: "payment_coordination_unavailable" }, 503);
  }

  const replayResult = (await replayClaim.json()) as {
    status?:
      | "claimed"
      | "retry_upstream"
      | "completed"
      | "in_flight"
      | "settlement_pending"
      | "context_mismatch";
    claimed?: boolean;
    leaseToken?: string;
    receipt?: X402SettlementReceipt;
    responseBody?: string;
  };

  // 1. Cross-tenant or cross-tool replay attempt -> reject immediately
  if (replayResult.status === "context_mismatch") {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    return c.json(
      {
        error: "payment_context_mismatch",
        message: "This payment authorization is bound to a different tenant, tool, or resource."
      },
      409
    );
  }

  // 2. Same tenant+tool+payment already completed -> return cached paid response idempotently
  if (replayResult.status === "completed" && replayResult.receipt && replayResult.responseBody) {
    c.header("PAYMENT-RESPONSE", encodeBase64Json(replayResult.receipt));
    c.header("X-Port4-Settlement-Tx", replayResult.receipt.transaction);
    c.header("X-Port4-Tenant", tenant.subdomain);
    c.header("X-Port4-Idempotent-Replay", "true");
    c.header("Content-Type", "application/json");
    return c.body(replayResult.responseBody, 200);
  }

  // 3. On-chain settlement is still pending confirmation -> never release or double-settle
  if (replayResult.status === "settlement_pending") {
    return c.json(
      {
        error: "payment_settlement_pending",
        message: "Payment transaction was broadcast and is awaiting on-chain confirmation. Retry shortly with the same PAYMENT-SIGNATURE."
      },
      409
    );
  }

  // 4. Concurrent duplicate in-flight
  if (!replayResult.claimed) {
    c.header("PAYMENT-REQUIRED", paymentRequiredHeader);
    return c.json(
      {
        error: "payment_already_used",
        message: "This payment authorization is already being processed or was already redeemed."
      },
      409
    );
  }

  c.set("paymentFingerprint", paymentFingerprint);
  c.set("paymentLeaseToken", leaseToken);
  c.set("paymentContext", paymentContext);

  let receipt: X402SettlementReceipt | null = null;

  // 5. Previously settled on-chain, upstream had failed -> retry upstream WITHOUT re-settling
  if (replayResult.status === "retry_upstream" && replayResult.receipt) {
    receipt = replayResult.receipt;
  } else {
    if (tenant.subdomain === "demo" && decodedSignature.payload?.mode === "port4-sandbox-demo") {
      receipt = await verifySandboxSignature(c.env, decodedSignature, requirement, isPlatformFee);
    } else {
      receipt = await verifyAndSettleViaFacilitator(c.env, decodedSignature, requirement, isPlatformFee);
    }

    if (receipt?.settlementPending) {
      await replayStub.fetch("https://payment-replay/mark_settlement_pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "mark_settlement_pending",
          leaseToken,
          receipt
        })
      });
      return c.json(
        {
          error: "payment_settlement_pending",
          message: "Payment settlement is pending on-chain confirmation. Retry with the same PAYMENT-SIGNATURE."
        },
        409
      );
    }

    if (!receipt || !receipt.success) {
      await replayStub.fetch("https://payment-replay/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "release", leaseToken })
      });
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

    // Durably persist settled receipt and verify DO response BEFORE calling upstream
    const markSettledRes = await replayStub.fetch("https://payment-replay/mark_settled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "mark_settled", leaseToken, receipt })
    });
    if (!markSettledRes.ok) {
      return c.json(
        {
          error: "payment_state_persistence_failed",
          message: "Payment settled but durable state persistence failed. Retry with the same PAYMENT-SIGNATURE."
        },
        503
      );
    }
  }

  c.set("x402Receipt", receipt);
  await next();

  c.header("PAYMENT-RESPONSE", encodeBase64Json(receipt));
  c.header("X-Port4-Settlement-Tx", receipt.transaction);
  c.header("X-Port4-Tenant", tenant.subdomain);
};
