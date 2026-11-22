/**
 * Machine Payments Protocol (MPP) on Tempo (`chainId: 4217` Mainnet / `42431` Testnet) in OUSD
 * Enables Visa CLI agents (`app.visacli.sh`) to discover Port4 tools via `/openapi.json` (`x-payment-info`)
 * and receive dual-rail HTTP 402 challenges (`WWW-Authenticate: Payment` alongside x402 `PAYMENT-REQUIRED`).
 */

import type { TenantRoutingRecord } from "../types";
import { EVM_ADDRESS_RE } from "./networks";

export const TEMPO_OUSD_ADDRESS = "0x20c0000000000000000000006a37da5c996874be";
export const TEMPO_MAINNET_CHAIN_ID = 4217;
export const TEMPO_TESTNET_CHAIN_ID = 42431;

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

function encodeBase64UrlJson(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

export function decodeBase64UrlJson<T>(b64url: string): T {
  return JSON.parse(decoder.decode(base64UrlToBytes(b64url))) as T;
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

/**
 * Generates an OpenAPI 3.1.0 specification for a Port4 tenant with Visa CLI's `x-payment-info`
 * extension on every tool so `discover` in Visa CLI can price endpoints without calling them.
 */
export function buildTenantOpenApiDocument(
  tenant: TenantRoutingRecord,
  publicOrigin: string
): Record<string, unknown> {
  const isTestnet =
    tenant.network === "eip155:84532" ||
    tenant.network === "eip155:421614" ||
    tenant.network === "eip155:42431" ||
    tenant.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

  const paths: Record<string, unknown> = {};
  const mcpPath = publicOrigin.includes(`${tenant.subdomain}.port4.dev`)
    ? "/mcp"
    : `/mcp/${tenant.subdomain}`;

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

    paths[`${mcpPath}#${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description || `Paid MCP tool ${tool.name}`,
        description: `${tool.description} (Stateless MCP 2026-07-28 tools/call '${tool.name}', $${tool.price_usd} OUSD/USDC)`,
        "x-payment-info": {
          intent: "charge",
          method: "tempo",
          amount: tool.price_atomic,
          currency: TEMPO_OUSD_ADDRESS,
          chainId: isTestnet ? TEMPO_TESTNET_CHAIN_ID : TEMPO_MAINNET_CHAIN_ID
        },
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
