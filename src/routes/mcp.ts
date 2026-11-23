import type { Context } from "hono";
import type {
  AppEnv,
  MeteringEvent,
  TenantRoutingRecord,
  ToolRecord,
  X402SettlementReceipt
} from "../types";
import { executeInternalSandboxTool } from "./sandbox";
import {
  decryptSecretAtRest,
  hmacSha256Hex,
  isValidCustomAuthHeaderName,
  sha256Hex
} from "../lib/crypto";
import { writeGatewayAnalytics } from "../lib/metering";
import { resolveUsdcAsset } from "../middleware/x402-gate";
import {
  buildCodeModeMcpTools,
  executeCodeModePlan,
  searchTenantTools
} from "../lib/codemode";
import { validateToolArguments } from "../lib/schema-validator";

export class UpstreamHttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Upstream service returned HTTP ${status}.`);
    this.name = "UpstreamHttpError";
    this.status = status;
  }
}

export function interpolateUpstreamPath(
  pathTemplate: string,
  args: Record<string, unknown>
): { resolvedPath: string; remainingArgs: Record<string, unknown> } {
  const usedKeys = new Set<string>();
  const resolvedPath = pathTemplate
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
      if (args[key] !== undefined && args[key] !== null) {
        usedKeys.add(key);
        return encodeURIComponent(String(args[key]));
      }
      return match;
    })
    .replace(/:([a-zA-Z0-9_]+)/g, (match, key: string) => {
      if (args[key] !== undefined && args[key] !== null) {
        usedKeys.add(key);
        return encodeURIComponent(String(args[key]));
      }
      return match;
    });

  const remainingArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!usedKeys.has(k)) {
      remainingArgs[k] = v;
    }
  }
  return { resolvedPath, remainingArgs };
}

const MAX_UPSTREAM_BYTES = 256 * 1024; // 256 KB safety cap to protect 128 MB isolate memory

async function readBoundedText(response: Response, maxBytes = MAX_UPSTREAM_BYTES): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const allowed = value.byteLength - (total - maxBytes);
        if (allowed > 0) {
          result += decoder.decode(value.subarray(0, allowed), { stream: false });
        }
        await reader.cancel();
        break;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return result;
}

function safeParseSchema(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fallback to open object schema
  }
  return { type: "object", properties: {} };
}

/**
 * Multi-Protocol Upstream Execution Adapter:
 * - `internal`: Port4 internal edge oracle / demo tools
 * - `mcp`: Remote MCP 2026-07-28 JSON-RPC 2.0 `tools/call` adapter
 * - `rest` / `openapi`: HTTP REST path/query/body interpolation adapter
 * Injects configurable upstream authentication headers + Port4 HMAC-SHA256 signature.
 */
async function dispatchUpstreamTool(params: {
  jwtSecret: string;
  tenant: TenantRoutingRecord;
  tool: ToolRecord;
  args: Record<string, unknown>;
  receipt: X402SettlementReceipt;
  colo: string;
  requestId: string;
  idempotencyKey: string;
  tapVerified?: {
    keyId: string;
    jkt: string;
    agentId: string | null;
    agentName: string;
  };
}): Promise<unknown> {
  const { jwtSecret, tenant, tool, args, receipt, colo, requestId, idempotencyKey, tapVerified } =
    params;

  if (tenant.upstream_base_url === "internal://sandbox" || tool.source_type === "internal") {
    return executeInternalSandboxTool(tool.name, args, colo);
  }

  if (tenant.require_upstream_verified === 1 && tenant.upstream_verified !== 1) {
    throw new UpstreamHttpError(403, "Upstream domain ownership is not verified for this tenant.");
  }

  const isRemoteMcp = tool.source_type === "mcp";
  const remoteToolName = tool.remote_tool_name || tool.name;

  const { resolvedPath, remainingArgs } = isRemoteMcp
    ? { resolvedPath: tool.upstream_path, remainingArgs: args }
    : interpolateUpstreamPath(tool.upstream_path, args);

  const targetUrl = new URL(resolvedPath, `${tenant.upstream_base_url}/`);

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Port4-Tenant": tenant.subdomain,
    "X-Port4-Tool": tool.name,
    "X-Port4-Payer": receipt.payer,
    "X-Port4-Tx": receipt.transaction,
    "X-Port4-Request-Id": requestId,
    "Idempotency-Key": idempotencyKey
  };

  if (tapVerified) {
    upstreamHeaders["X-Port4-Tap-Verified"] = "true";
    upstreamHeaders["X-Port4-Tap-Key-Id"] = tapVerified.keyId;
    if (tapVerified.agentId) {
      upstreamHeaders["X-Port4-Tap-Agent-Id"] = tapVerified.agentId;
    }
  }

  // Decrypt and inject upstream credentials if configured by the tenant owner
  if (tenant.upstream_auth_secret && tenant.upstream_auth_type !== "none") {
    const decryptedSecret = await decryptSecretAtRest(tenant.upstream_auth_secret, jwtSecret);
    if (tenant.upstream_auth_type === "bearer") {
      upstreamHeaders["Authorization"] = `Bearer ${decryptedSecret}`;
    } else if (
      tenant.upstream_auth_type === "api_key_header" &&
      tenant.upstream_auth_header &&
      isValidCustomAuthHeaderName(tenant.upstream_auth_header)
    ) {
      upstreamHeaders[tenant.upstream_auth_header.trim()] = decryptedSecret;
    }
  }

  let serializedBody = "";
  let httpMethod: "GET" | "POST" | "PUT" | "DELETE" = tool.http_method;

  if (isRemoteMcp) {
    httpMethod = "POST";
    upstreamHeaders["MCP-Protocol-Version"] = "2026-07-28";
    upstreamHeaders["Mcp-Method"] = "tools/call";
    upstreamHeaders["Mcp-Name"] = remoteToolName;
    serializedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: remoteToolName,
        arguments: remainingArgs
      }
    });
  } else if (httpMethod === "GET" || httpMethod === "DELETE") {
    for (const [k, v] of Object.entries(remainingArgs)) {
      if (v !== undefined && v !== null) {
        targetUrl.searchParams.set(k, String(v));
      }
    }
  } else {
    serializedBody = JSON.stringify(remainingArgs);
  }

  // Cryptographically sign outgoing upstream request so tenant origins can verify Port4 authenticity
  if (tenant.upstream_signing_secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = await sha256Hex(serializedBody);
    const signatureInput = `${timestamp}.${tenant.subdomain}.${tool.name}.${receipt.transaction}.${bodyHash}`;
    const sig = await hmacSha256Hex(tenant.upstream_signing_secret, signatureInput);
    upstreamHeaders["X-Port4-Timestamp"] = timestamp;
    upstreamHeaders["X-Port4-Signature"] = `v1=${sig}`;
  }

  const fetchInit: RequestInit = {
    method: httpMethod,
    headers: upstreamHeaders,
    ...(httpMethod === "GET" || httpMethod === "DELETE" ? {} : { body: serializedBody })
  };

  const upstreamRes = await fetch(targetUrl.toString(), {
    ...fetchInit,
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  const contentType = upstreamRes.headers.get("content-type") ?? "";
  const rawText = await readBoundedText(upstreamRes);
  if (!upstreamRes.ok) {
    console.error(
      JSON.stringify({
        event: "upstream_non_success",
        tenant: tenant.subdomain,
        tool: tool.name,
        status: upstreamRes.status
      })
    );
    throw new UpstreamHttpError(upstreamRes.status);
  }
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      // Unwrap remote MCP JSON-RPC result if source_type === 'mcp'
      if (isRemoteMcp && parsed && parsed.jsonrpc === "2.0" && parsed.result !== undefined) {
        return parsed.result;
      }
      return parsed;
    } catch {
      return { status: upstreamRes.status, body: rawText.slice(0, 4096) };
    }
  }
  return {
    status: upstreamRes.status,
    body: rawText.slice(0, 4096)
  };
}

export async function handleMcpRequest(c: Context<AppEnv>): Promise<Response> {
  const mcp = c.get("mcp");
  const tenant = c.get("tenant");

  if (!mcp || !tenant) {
    return c.json({ error: "gateway_context_missing" }, 500);
  }

  // 1. Edge-cached stateless tool discovery (Direct MCP or Code Mode)
  if (mcp.method === "tools/list") {
    const resolvedAsset = resolveUsdcAsset(tenant.network, c.env.X402_USDC_ASSET);
    const tools =
      tenant.mcp_mode !== "direct"
        ? buildCodeModeMcpTools(tenant, resolvedAsset)
        : tenant.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: safeParseSchema(tool.input_schema_json),
            _meta: {
              x402: {
                scheme: "exact",
                network: tenant.network,
                asset: resolvedAsset,
                priceUsd: `$${tool.price_usd}`,
                amountAtomic: tool.price_atomic,
                payTo: tenant.payout_wallet
              }
            }
          }));

    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Port4-Tenant", tenant.subdomain);
    c.header("X-Port4-Mcp-Mode", tenant.mcp_mode);
    c.header("MCP-Protocol-Version", mcp.protocolVersion);

    return c.json({
      jsonrpc: "2.0",
      id: mcp.rpcId,
      result: { tools }
    });
  }

  // 2. Tool invocation (free `search` in openapi_codemode, or x402-settled `code`/`execute`/direct)
  if (mcp.method === "tools/call") {
    // 2a. Free progressive discovery (`search`) in OpenAPI Code Mode
    if (tenant.mcp_mode === "openapi_codemode" && mcp.toolName === "search") {
      const query = typeof mcp.arguments.query === "string" ? mcp.arguments.query : "";
      const limit = typeof mcp.arguments.limit === "number" ? mcp.arguments.limit : 12;
      const searchResult = searchTenantTools(tenant, query, limit);
      c.header("Cache-Control", "public, max-age=60");
      c.header("X-Port4-Tenant", tenant.subdomain);
      c.header("X-Port4-Mcp-Mode", tenant.mcp_mode);
      c.header("MCP-Protocol-Version", mcp.protocolVersion);
      return c.json({
        jsonrpc: "2.0",
        id: mcp.rpcId,
        result: {
          content: [{ type: "text", text: JSON.stringify(searchResult, null, 2) }],
          isError: false
        }
      });
    }

    const tool = c.get("selectedTool");
    const receipt = c.get("x402Receipt");
    const startedAt = c.get("requestStartedAt") ?? Date.now();

    if (!tool || !receipt) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: mcp.rpcId,
          error: { code: -32603, message: "Missing settled tool context." }
        },
        500
      );
    }

    const paymentFingerprint = c.get("paymentFingerprint");
    const leaseToken = c.get("paymentLeaseToken") ?? "";
    const tapVerified = c.get("tapVerified");

    // Validate tool arguments against JSON Schema BEFORE upstream execution
    const argCheck = validateToolArguments(tool.input_schema_json, mcp.arguments);
    if (!argCheck.ok) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: mcp.rpcId,
          error: { code: -32602, message: `Invalid tool arguments: ${argCheck.error}` }
        },
        400
      );
    }

    const colo = (c.req.raw.cf as { colo?: string } | undefined)?.colo ?? "LOCAL";
    const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const idempotencyKey = paymentFingerprint ?? receipt.transaction;
    let upstreamResult: unknown;
    let isToolError = false;

    const isCodeModeExec =
      (tenant.mcp_mode === "codemode" && mcp.toolName === "code") ||
      (tenant.mcp_mode === "openapi_codemode" && mcp.toolName === "execute");

    if (isCodeModeExec) {
      const code = typeof mcp.arguments.code === "string" ? mcp.arguments.code : "";
      const execOutcome = await executeCodeModePlan({
        env: c.env,
        tenant,
        code,
        authorizedAtomicBudget: tool.price_atomic,
        dispatchTool: async (subTool, subArgs, subcallIndex) =>
          dispatchUpstreamTool({
            jwtSecret: c.env.JWT_SECRET,
            tenant,
            tool: subTool,
            args: subArgs,
            receipt,
            colo,
            requestId: `${requestId}_s${subcallIndex}`,
            idempotencyKey: `${idempotencyKey}:${subTool.name}:${subcallIndex}`,
            tapVerified
          })
      });

      if (!execOutcome.ok) {
        isToolError = true;
        upstreamResult = {
          error: execOutcome.error,
          logs: execOutcome.logs ?? [],
          subcalls: execOutcome.subcalls,
          consumedAtomic: execOutcome.consumedAtomic
        };
      } else {
        upstreamResult = {
          result: execOutcome.result,
          ...(execOutcome.logs && execOutcome.logs.length > 0 ? { logs: execOutcome.logs } : {}),
          _codemode: {
            subcalls: execOutcome.subcalls,
            consumedAtomic: execOutcome.consumedAtomic,
            authorizedAtomic: tool.price_atomic,
            mode: tenant.mcp_mode
          }
        };
      }
    } else {
      try {
        upstreamResult = await dispatchUpstreamTool({
          jwtSecret: c.env.JWT_SECRET,
          tenant,
          tool,
          args: mcp.arguments,
          receipt,
          colo,
          requestId,
          idempotencyKey,
          tapVerified
        });
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "upstream_fetch_failed",
            tenant: tenant.subdomain,
            tool: tool.name,
            error: err instanceof Error ? err.message : "unknown"
          })
        );

        const isDeterministic4xx =
          err instanceof UpstreamHttpError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 408 &&
          err.status !== 429;

        if (isDeterministic4xx) {
          isToolError = true;
          upstreamResult = {
            error: "upstream_client_error",
            status: err.status,
            message: err.message
          };
        } else {
          // Transient 5xx / 429 / 408 / network timeout: clear in-flight lease age so caller can immediately retry upstream without re-settling
          if (paymentFingerprint && leaseToken) {
            const replayStub = c.env.PAYMENT_REPLAY_GUARD.get(
              c.env.PAYMENT_REPLAY_GUARD.idFromName(paymentFingerprint)
            );
            await replayStub
              .fetch("https://payment-replay/mark_upstream_failed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  operation: "mark_upstream_failed",
                  leaseToken
                })
              })
              .catch(() => {});
          }
          return c.json(
            {
              jsonrpc: "2.0",
              id: mcp.rpcId,
              error: { code: -32000, message: "Upstream service is unavailable." }
            },
            502
          );
        }
      }
    }

    const latencyMs = Math.max(1, Date.now() - startedAt);
    // Deterministic event ID per payment authorization prevents duplicate financial rows across retries
    const txId = paymentFingerprint
      ? `tx_${paymentFingerprint.slice(0, 24)}`
      : `tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const status = receipt.mode === "sandbox" ? "sandbox_settled" : "settled";

    const responsePayload = {
      jsonrpc: "2.0" as const,
      id: mcp.rpcId,
      result: {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(upstreamResult, null, 2)
          }
        ],
        isError: isToolError,
        _meta: {
          x402: {
            txHash: receipt.transaction,
            network: receipt.network,
            payer: receipt.payer,
            amountUsd: `$${tool.price_usd}`,
            latencyMs,
            mode: receipt.mode
          }
        }
      }
    };

    const serializedResponse = JSON.stringify(responsePayload);

    // 1. Synchronously persist completed state in PaymentReplayGuard DO BEFORE returning 200 OK
    //    so a concurrent/immediate retry never re-executes a side-effecting upstream call.
    if (paymentFingerprint && leaseToken) {
      const replayStub = c.env.PAYMENT_REPLAY_GUARD.get(
        c.env.PAYMENT_REPLAY_GUARD.idFromName(paymentFingerprint)
      );
      await replayStub.fetch("https://payment-replay/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "complete",
          leaseToken,
          receipt,
          responseBody: serializedResponse
        })
      });
    }

    // 2. Enqueue authoritative idempotent metering event (including Visa TAP agentId if present)
    const meteringEvent: MeteringEvent = {
      id: txId,
      tenantId: tenant.id,
      tenantSubdomain: tenant.subdomain,
      toolName: tool.name,
      payerWallet: receipt.payer,
      amountAtomic: tool.price_atomic,
      amountUsd: tool.price_usd,
      network: receipt.network,
      txHash: receipt.transaction,
      latencyMs,
      status,
      isPlatformFee: receipt.isPlatformFee,
      tapAgentId: tapVerified?.agentId ?? null,
      occurredAt: new Date().toISOString()
    };

    writeGatewayAnalytics(c.env, meteringEvent);

    if (c.env.METERING_EVENTS) {
      c.executionCtx.waitUntil(c.env.METERING_EVENTS.send(meteringEvent));
    }

    console.log(
      JSON.stringify({
        event: "x402_mcp_settled",
        tenant: tenant.subdomain,
        tool: tool.name,
        amountUsd: tool.price_usd,
        network: receipt.network,
        txHash: receipt.transaction,
        latencyMs,
        isPlatformFee: receipt.isPlatformFee,
        mode: receipt.mode
      })
    );

    c.header("Cache-Control", "no-store");
    c.header("MCP-Protocol-Version", mcp.protocolVersion);
    c.header("Content-Type", "application/json");

    return c.body(serializedResponse, 200);
  }

  return c.json(
    {
      jsonrpc: "2.0",
      id: mcp.rpcId,
      error: {
        code: -32601,
        message: `Method '${mcp.method}' not supported. Supported stateless methods: tools/list, tools/call.`
      }
    },
    400
  );
}
