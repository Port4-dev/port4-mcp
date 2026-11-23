/**
 * Machine Payments Protocol (MPP) on Tempo (`chainId: 4217` Mainnet / `42431` Testnet) in OUSD
 * Enables Visa CLI agents (`app.visacli.sh`) to discover Port4 tools via `/openapi.json` (`x-payment-info`),
 * receive dual-rail HTTP 402 challenges (`WWW-Authenticate: Payment` alongside x402 `PAYMENT-REQUIRED`),
 * and settle via `Authorization: Payment <b64url>` with on-chain Tempo JSON-RPC verification and `Payment-Receipt`.
 */

import type {
  AppBindings,
  TenantRoutingRecord,
  ToolRecord,
  X402SettlementReceipt
} from "../types";
import { usdToAtomicUsdc } from "./crypto";
import { EVM_ADDRESS_RE, getNetworkTreasury, getSupportedNetwork } from "./networks";

export const TEMPO_OUSD_ADDRESS = "0x20c0000000000000000000006a37da5c996874be";
export const TEMPO_MAINNET_CHAIN_ID = 4217;
export const TEMPO_TESTNET_CHAIN_ID = 42431;

const ERC20_TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLen));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function encodeBase64UrlJson(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

export function decodeBase64UrlJson<T>(b64url: string): T {
  return JSON.parse(decoder.decode(base64UrlToBytes(b64url))) as T;
}

/**
 * Extracts the Base64URL token from an `Authorization: Payment <token>` header without matching `Bearer`.
 */
export function extractMppAuthorizationToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Payment\s+([A-Za-z0-9+/_-]+={0,2})$/i.exec(authHeader.trim());
  return match ? match[1] : null;
}

/**
 * Resolves an EVM `0x...` payout address for Tempo OUSD settlement on a tenant.
 */
export function resolveTempoRecipient(
  tenant: TenantRoutingRecord,
  defaultPayTo: string
): string | null {
  if (EVM_ADDRESS_RE.test(defaultPayTo)) return defaultPayTo;
  if (EVM_ADDRESS_RE.test(tenant.payout_wallet)) return tenant.payout_wallet;
  const evmEntry = (tenant.payout_wallets ?? []).find((w) => EVM_ADDRESS_RE.test(w.address));
  return evmEntry ? evmEntry.address : null;
}

/**
 * Builds the `WWW-Authenticate: Payment` header for Visa CLI / MPP agents on Tempo OUSD.
 */
export function buildMppAuthenticateHeader(params: {
  challengeId: string;
  realm: string;
  amountAtomic: string;
  recipient: string;
  isTestnet?: boolean;
}): string {
  const chainId = params.isTestnet ? TEMPO_TESTNET_CHAIN_ID : TEMPO_MAINNET_CHAIN_ID;
  const requestPayload = {
    amount: params.amountAtomic,
    currency: TEMPO_OUSD_ADDRESS,
    recipient: params.recipient,
    methodDetails: {
      chainId
    }
  };
  const encodedRequest = encodeBase64UrlJson(requestPayload);
  return `Payment id="${params.challengeId}", realm="${params.realm}", method="tempo", intent="charge", request="${encodedRequest}"`;
}

export interface ParsedMppCredential {
  challengeId: string;
  txHash: string;
  rawTransaction?: string;
  amount: string;
  currency: string;
  recipient: string;
  chainId: number;
  payer: string;
  isPlatformFee: boolean;
}

export function parseAndValidateMppCredential(params: {
  token: string;
  env: AppBindings;
  tenant: TenantRoutingRecord;
  tool: ToolRecord;
  expectedRecipient: string | null;
  expectedChainId: number;
}):
  | { ok: true; credential: ParsedMppCredential }
  | { ok: false; status: 402; error: string; message: string } {
  const { token, env, tool, expectedRecipient, expectedChainId } = params;
  if (!expectedRecipient) {
    return {
      ok: false,
      status: 402,
      error: "tempo_recipient_not_configured",
      message: "This tenant does not have an EVM payout address configured for Tempo OUSD."
    };
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = decodeBase64UrlJson<unknown>(token);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not_object");
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      status: 402,
      error: "invalid_mpp_credential_encoding",
      message: "Authorization: Payment must be a valid Base64URL-encoded JSON credential."
    };
  }

  const nestedPayload =
    raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : null;
  const nestedChallenge =
    raw.challenge && typeof raw.challenge === "object" && !Array.isArray(raw.challenge)
      ? (raw.challenge as Record<string, unknown>)
      : null;
  const nestedReq =
    nestedChallenge?.request &&
    typeof nestedChallenge.request === "object" &&
    !Array.isArray(nestedChallenge.request)
      ? (nestedChallenge.request as Record<string, unknown>)
      : null;
  const nestedMethodDetails =
    nestedReq?.methodDetails &&
    typeof nestedReq.methodDetails === "object" &&
    !Array.isArray(nestedReq.methodDetails)
      ? (nestedReq.methodDetails as Record<string, unknown>)
      : raw.methodDetails &&
          typeof raw.methodDetails === "object" &&
          !Array.isArray(raw.methodDetails)
        ? (raw.methodDetails as Record<string, unknown>)
        : null;

  const challengeId = String(raw.challengeId ?? nestedChallenge?.id ?? "ch_tempo").trim();
  const txHash = String(
    raw.txHash ?? raw.hash ?? nestedPayload?.txHash ?? nestedPayload?.hash ?? ""
  ).trim();
  const rawTransaction =
    typeof (raw.rawTransaction ?? nestedPayload?.rawTransaction) === "string"
      ? String(raw.rawTransaction ?? nestedPayload?.rawTransaction).trim()
      : undefined;
  const amount = String(raw.amount ?? nestedReq?.amount ?? "").trim();
  const currency = String(raw.currency ?? nestedReq?.currency ?? "").trim();
  const recipient = String(raw.recipient ?? nestedReq?.recipient ?? "").trim();
  const chainId = Number(raw.chainId ?? nestedMethodDetails?.chainId ?? NaN);
  const payer = String(
    raw.payer ?? nestedPayload?.payer ?? "0x0000000000000000000000000000000000000000"
  ).trim();

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return {
      ok: false,
      status: 402,
      error: "invalid_mpp_tx_hash",
      message: "Tempo MPP credential requires a valid 32-byte 0x transaction hash."
    };
  }

  if (currency.toLowerCase() !== TEMPO_OUSD_ADDRESS.toLowerCase()) {
    return {
      ok: false,
      status: 402,
      error: "invalid_mpp_currency",
      message: `Tempo MPP credential currency must be OUSD (${TEMPO_OUSD_ADDRESS}).`
    };
  }

  if (!Number.isInteger(chainId) || chainId !== expectedChainId) {
    return {
      ok: false,
      status: 402,
      error: "invalid_mpp_chain_id",
      message: `Tempo MPP credential chainId must match expected chain ${expectedChainId}.`
    };
  }

  if (!/^\d+$/.test(amount) || BigInt(amount) < BigInt(tool.price_atomic)) {
    return {
      ok: false,
      status: 402,
      error: "invalid_mpp_amount",
      message: `Tempo MPP credential amount (${amount}) is less than required ${tool.price_atomic} atomic OUSD.`
    };
  }

  const treasury = getNetworkTreasury(env, `eip155:${expectedChainId}`);
  const matchesPrimary = recipient.toLowerCase() === expectedRecipient.toLowerCase();
  const matchesTreasury = Boolean(treasury && recipient.toLowerCase() === treasury.toLowerCase());

  if (!matchesPrimary && !matchesTreasury) {
    return {
      ok: false,
      status: 402,
      error: "invalid_mpp_recipient",
      message: "Tempo MPP credential recipient does not match this tenant's payout wallet."
    };
  }

  return {
    ok: true,
    credential: {
      challengeId,
      txHash,
      rawTransaction,
      amount: tool.price_atomic,
      currency: TEMPO_OUSD_ADDRESS,
      recipient,
      chainId,
      payer: EVM_ADDRESS_RE.test(payer) ? payer : "0x0000000000000000000000000000000000000000",
      isPlatformFee: matchesTreasury && !matchesPrimary
    }
  };
}

export function resolveTempoRpcUrl(env: AppBindings, chainId: number): string | null {
  if (chainId === TEMPO_MAINNET_CHAIN_ID) {
    return env.TEMPO_MAINNET_RPC_URL?.trim() || env.TEMPO_RPC_URL?.trim() || null;
  }
  if (chainId === TEMPO_TESTNET_CHAIN_ID) {
    return env.TEMPO_TESTNET_RPC_URL?.trim() || env.TEMPO_RPC_URL?.trim() || null;
  }
  return env.TEMPO_RPC_URL?.trim() || null;
}

export async function verifyMppPaymentCredential(params: {
  env: AppBindings;
  credential: ParsedMppCredential;
}): Promise<
  | {
      ok: true;
      receipt: X402SettlementReceipt;
      receiptHeader: string;
    }
  | {
      ok: false;
      status: 402 | 409 | 503;
      settlementPending?: boolean;
      error: string;
      message: string;
    }
> {
  const { env, credential } = params;
  const rpcUrl = resolveTempoRpcUrl(env, credential.chainId);
  if (!rpcUrl) {
    return {
      ok: false,
      status: 503,
      error: "tempo_rpc_not_configured",
      message: "TEMPO_RPC_URL is not configured on this gateway."
    };
  }

  let parsedRpc: URL;
  try {
    parsedRpc = new URL(rpcUrl);
  } catch {
    return {
      ok: false,
      status: 503,
      error: "invalid_tempo_rpc_url",
      message: "TEMPO_RPC_URL is invalid."
    };
  }
  const isLocalHttp =
    parsedRpc.protocol === "http:" &&
    (parsedRpc.hostname === "localhost" ||
      parsedRpc.hostname === "127.0.0.1" ||
      parsedRpc.hostname === "[::1]");
  if (parsedRpc.protocol !== "https:" && !isLocalHttp) {
    return {
      ok: false,
      status: 503,
      error: "invalid_tempo_rpc_url",
      message: "TEMPO_RPC_URL must use https://."
    };
  }

  let rpcRes: Response;
  try {
    rpcRes = await fetch(parsedRpc.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [credential.txHash]
      })
    });
  } catch {
    return {
      ok: false,
      status: 503,
      error: "tempo_rpc_unreachable",
      message: "Unable to reach Tempo RPC endpoint to verify transaction receipt."
    };
  }

  if (!rpcRes.ok) {
    return {
      ok: false,
      status: 503,
      error: "tempo_rpc_error",
      message: `Tempo RPC returned HTTP ${rpcRes.status}.`
    };
  }

  let rpcJson: {
    result?: {
      status?: string;
      transactionHash?: string;
      from?: string;
      logs?: Array<{
        address?: string;
        topics?: string[];
        data?: string;
      }>;
    } | null;
    error?: { message?: string };
  };
  try {
    rpcJson = (await rpcRes.json()) as typeof rpcJson;
  } catch {
    return {
      ok: false,
      status: 503,
      error: "tempo_rpc_invalid_json",
      message: "Tempo RPC returned malformed JSON."
    };
  }

  if (rpcJson.error) {
    return {
      ok: false,
      status: 402,
      error: "tempo_rpc_rejected",
      message: rpcJson.error.message || "Tempo RPC rejected transaction lookup."
    };
  }

  const txReceipt = rpcJson.result;
  if (!txReceipt) {
    return {
      ok: false,
      status: 409,
      settlementPending: true,
      error: "payment_settlement_pending",
      message: "Tempo transaction receipt is not yet mined. Retry shortly with the same Authorization: Payment header."
    };
  }

  if (txReceipt.status !== "0x1") {
    return {
      ok: false,
      status: 402,
      error: "tempo_transaction_reverted",
      message: "Tempo OUSD payment transaction reverted on-chain."
    };
  }

  if (
    txReceipt.transactionHash &&
    txReceipt.transactionHash.toLowerCase() !== credential.txHash.toLowerCase()
  ) {
    return {
      ok: false,
      status: 402,
      error: "tempo_tx_hash_mismatch",
      message: "Tempo RPC receipt transactionHash does not match credential txHash."
    };
  }

  if (Array.isArray(txReceipt.logs) && txReceipt.logs.length > 0) {
    const expectedRecipientTopic = `0x000000000000000000000000${credential.recipient.slice(2).toLowerCase()}`;
    const requiredAmount = BigInt(credential.amount);
    const hasMatchingTransfer = txReceipt.logs.some((log) => {
      if (!log || typeof log.address !== "string" || !Array.isArray(log.topics)) return false;
      if (log.address.toLowerCase() !== TEMPO_OUSD_ADDRESS.toLowerCase()) return false;
      if ((log.topics[0] ?? "").toLowerCase() !== ERC20_TRANSFER_TOPIC0) return false;
      if ((log.topics[2] ?? "").toLowerCase() !== expectedRecipientTopic) return false;
      try {
        const transferred = BigInt(log.data && log.data !== "0x" ? log.data : "0x0");
        return transferred >= requiredAmount;
      } catch {
        return false;
      }
    });
    if (!hasMatchingTransfer) {
      return {
        ok: false,
        status: 402,
        error: "tempo_ousd_transfer_log_missing",
        message: "Tempo transaction receipt does not contain a matching OUSD Transfer log to recipient."
      };
    }
  }

  const network = `eip155:${credential.chainId}`;
  const resolvedPayer =
    txReceipt.from && EVM_ADDRESS_RE.test(txReceipt.from) ? txReceipt.from : credential.payer;

  const receipt: X402SettlementReceipt = {
    success: true,
    transaction: credential.txHash,
    network,
    payer: resolvedPayer,
    errorReason: null,
    mode: "facilitator",
    isPlatformFee: credential.isPlatformFee,
    payTo: credential.recipient
  };

  const receiptHeader = encodeBase64UrlJson({
    status: "success",
    method: "tempo",
    challengeId: credential.challengeId,
    reference: credential.txHash,
    chainId: credential.chainId,
    currency: TEMPO_OUSD_ADDRESS,
    amount: credential.amount,
    recipient: credential.recipient,
    timestamp: new Date().toISOString()
  });

  return {
    ok: true,
    receipt,
    receiptHeader
  };
}

/**
 * Generates an OpenAPI 3.1.0 specification for a Port4 tenant with Visa CLI's `x-payment-info`
 * extension on every tool so `discover` in Visa CLI can price endpoints without calling them.
 * - Zero `#` fragments in Path Item keys (strict OpenAPI 3.1.0 compliance).
 * - Respects `tenant.mcp_mode` (`direct` | `codemode` | `openapi_codemode`).
 */
export function buildTenantOpenApiDocument(
  tenant: TenantRoutingRecord,
  publicOrigin: string
): Record<string, unknown> {
  const isTestnet = getSupportedNetwork(tenant.network)?.isMainnet === false;
  const chainId = isTestnet ? TEMPO_TESTNET_CHAIN_ID : TEMPO_MAINNET_CHAIN_ID;
  const tempoRecipient = resolveTempoRecipient(tenant, tenant.payout_wallet);

  let hostname = "";
  try {
    hostname = new URL(publicOrigin).hostname.toLowerCase();
  } catch {
    hostname = "";
  }
  const isTenantSubdomain =
    hostname === `${tenant.subdomain}.port4.dev` ||
    hostname === `${tenant.subdomain}.localhost`;
  const mcpPath = isTenantSubdomain ? "/mcp" : `/mcp/${tenant.subdomain}`;

  const paths: Record<string, unknown> = {};

  const buildPaymentInfo = (amountAtomic: string) => ({
    intent: "charge",
    method: "tempo",
    amount: amountAtomic,
    currency: TEMPO_OUSD_ADDRESS,
    chainId,
    ...(tempoRecipient ? { recipient: tempoRecipient } : {})
  });

  if (tenant.mcp_mode === "codemode") {
    const cmPrice = tenant.codemode_price_usd || "0.01";
    let cmAtomic = "10000";
    try {
      cmAtomic = usdToAtomicUsdc(cmPrice);
    } catch {
      cmAtomic = "10000";
    }
    paths[`${mcpPath}/tools/code`] = {
      post: {
        operationId: "code",
        summary: `Execute Code Mode Dynamic Worker script on ${tenant.name}`,
        description: `Execute an async JavaScript arrow function inside an isolated Cloudflare Dynamic Worker sandbox against ${tenant.name} tools ($${cmPrice} OUSD/USDC).`,
        "x-payment-info": buildPaymentInfo(cmAtomic),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["jsonrpc", "method", "params"],
                properties: {
                  jsonrpc: { type: "string", const: "2.0" },
                  id: { type: ["string", "number"] },
                  method: { type: "string", const: "tools/call" },
                  params: {
                    type: "object",
                    required: ["name", "arguments"],
                    properties: {
                      name: { type: "string", const: "code" },
                      arguments: {
                        type: "object",
                        required: ["code"],
                        properties: {
                          code: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "MCP JSON-RPC 2.0 Code Mode execution result" },
          "402": {
            description:
              "Payment Required (x402 PAYMENT-REQUIRED + Visa MPP WWW-Authenticate: Payment)"
          }
        }
      }
    };
  } else if (tenant.mcp_mode === "openapi_codemode") {
    const cmPrice = tenant.codemode_price_usd || "0.01";
    let cmAtomic = "10000";
    try {
      cmAtomic = usdToAtomicUsdc(cmPrice);
    } catch {
      cmAtomic = "10000";
    }
    paths[`${mcpPath}/tools/search`] = {
      post: {
        operationId: "search",
        summary: `Free progressive tool discovery on ${tenant.name}`,
        description: `Search ${tenant.tools.length} tools and generate TypeScript declarations for use in 'execute'.`,
        "x-port4-free": true,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["jsonrpc", "method", "params"],
                properties: {
                  jsonrpc: { type: "string", const: "2.0" },
                  id: { type: ["string", "number"] },
                  method: { type: "string", const: "tools/call" },
                  params: {
                    type: "object",
                    required: ["name", "arguments"],
                    properties: {
                      name: { type: "string", const: "search" },
                      arguments: {
                        type: "object",
                        properties: {
                          query: { type: "string" },
                          limit: { type: "number" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "MCP JSON-RPC 2.0 progressive search result" }
        }
      }
    };

    paths[`${mcpPath}/tools/execute`] = {
      post: {
        operationId: "execute",
        summary: `Execute progressive Code Mode Dynamic Worker script on ${tenant.name}`,
        description: `Execute an async JavaScript arrow function inside an isolated Cloudflare Dynamic Worker sandbox ($${cmPrice} OUSD/USDC).`,
        "x-payment-info": buildPaymentInfo(cmAtomic),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["jsonrpc", "method", "params"],
                properties: {
                  jsonrpc: { type: "string", const: "2.0" },
                  id: { type: ["string", "number"] },
                  method: { type: "string", const: "tools/call" },
                  params: {
                    type: "object",
                    required: ["name", "arguments"],
                    properties: {
                      name: { type: "string", const: "execute" },
                      arguments: {
                        type: "object",
                        required: ["code"],
                        properties: {
                          code: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "MCP JSON-RPC 2.0 Code Mode execution result" },
          "402": {
            description:
              "Payment Required (x402 PAYMENT-REQUIRED + Visa MPP WWW-Authenticate: Payment)"
          }
        }
      }
    };
  } else {
    for (const tool of tenant.tools) {
      let parsedSchema: Record<string, unknown> = { type: "object", properties: {} };
      try {
        const s = JSON.parse(tool.input_schema_json) as unknown;
        if (s && typeof s === "object" && !Array.isArray(s)) {
          parsedSchema = s as Record<string, unknown>;
        }
      } catch {
        // keep default
      }

      paths[`${mcpPath}/tools/${encodeURIComponent(tool.name)}`] = {
        post: {
          operationId: tool.name,
          summary: tool.description || `Paid MCP tool ${tool.name}`,
          description: `${tool.description} (Stateless MCP 2026-07-28 tools/call '${tool.name}', $${tool.price_usd} OUSD/USDC)`,
          "x-payment-info": buildPaymentInfo(tool.price_atomic),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "method", "params"],
                  properties: {
                    jsonrpc: { type: "string", const: "2.0" },
                    id: { type: ["string", "number"] },
                    method: { type: "string", const: "tools/call" },
                    params: {
                      type: "object",
                      required: ["name", "arguments"],
                      properties: {
                        name: { type: "string", const: tool.name },
                        arguments: parsedSchema
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "MCP JSON-RPC 2.0 tool execution result" },
            "402": {
              description:
                "Payment Required (x402 PAYMENT-REQUIRED + Visa MPP WWW-Authenticate: Payment)"
            }
          }
        }
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${tenant.name} — Port4 Paid MCP & Visa TAP Gateway`,
      version: "1.0.0",
      description: `Stateless MCP 2026-07-28 gateway for ${tenant.name}. Supports Visa Trusted Agent Protocol (TAP RFC 9421), Tempo OUSD (MPP), and multi-chain USDC (x402 v2).`
    },
    servers: [{ url: publicOrigin }],
    "x-port4-tenant": {
      subdomain: tenant.subdomain,
      mcp_endpoint: `${publicOrigin}${mcpPath}`,
      mcp_mode: tenant.mcp_mode,
      require_visa_tap: tenant.require_visa_tap === 1
    },
    paths
  };
}
