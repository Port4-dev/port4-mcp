import type { Context } from "hono";
import type { AppEnv, MeteringEvent } from "../types";
import { executeInternalSandboxTool } from "./sandbox";
import { hmacSha256Hex, sha256Hex } from "../lib/crypto";
import { writeGatewayAnalytics } from "../lib/metering";
import { resolveUsdcAsset } from "../middleware/x402-gate";

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

export async function handleMcpRequest(c: Context<AppEnv>): Promise<Response> {
  const mcp = c.get("mcp");
  const tenant = c.get("tenant");

  if (!mcp || !tenant) {
    return c.json({ error: "gateway_context_missing" }, 500);
  }

  // 1. Edge-cached stateless tool discovery
  if (mcp.method === "tools/list") {
    const tools = tenant.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: safeParseSchema(tool.input_schema_json),
      _meta: {
        x402: {
          scheme: "exact",
          network: tenant.network,
          asset: resolveUsdcAsset(tenant.network, c.env.X402_USDC_ASSET),
          priceUsd: `$${tool.price_usd}`,
          amountAtomic: tool.price_atomic,
          payTo: tenant.payout_wallet
        }
      }
    }));

    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Port4-Tenant", tenant.subdomain);
    c.header("MCP-Protocol-Version", mcp.protocolVersion);

    return c.json({
      jsonrpc: "2.0",
      id: mcp.rpcId,
      result: { tools }
    });
  }

  // 2. Paid tool invocation (x402GateMiddleware already verified & settled payment)
  if (mcp.method === "tools/call") {
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

    const colo = (c.req.raw.cf as { colo?: string } | undefined)?.colo ?? "LOCAL";
    const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const idempotencyKey = c.get("paymentFingerprint") ?? receipt.transaction;
    let upstreamResult: unknown;

    if (tenant.upstream_base_url === "internal://sandbox") {
      upstreamResult = executeInternalSandboxTool(tool.name, mcp.arguments, colo);
    } else {
      const { resolvedPath, remainingArgs } = interpolateUpstreamPath(
        tool.upstream_path,
        mcp.arguments
      );
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

      let serializedBody = "";
      if (tool.http_method === "GET" || tool.http_method === "DELETE") {
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
        method: tool.http_method,
        headers: upstreamHeaders,
        ...(tool.http_method === "GET" || tool.http_method === "DELETE"
          ? {}
          : { body: serializedBody })
      };

      try {
        const upstreamRes = await fetch(targetUrl.toString(), {
          ...fetchInit,
          redirect: "error",
          signal: AbortSignal.timeout(15_000)
        });
        const contentType = upstreamRes.headers.get("content-type") ?? "";
        const rawText = await readBoundedText(upstreamRes);
        if (!upstreamRes.ok) {
          console.error(JSON.stringify({ event: "upstream_non_success", tenant: tenant.subdomain, tool: tool.name, status: upstreamRes.status }));
          return c.json(
            { jsonrpc: "2.0", id: mcp.rpcId, error: { code: -32000, message: "Upstream service returned an error." } },
            502
          );
        }
        if (contentType.includes("application/json")) {
          try {
            upstreamResult = JSON.parse(rawText) as unknown;
          } catch {
            upstreamResult = { status: upstreamRes.status, body: rawText.slice(0, 4096) };
          }
        } else {
          upstreamResult = {
            status: upstreamRes.status,
            body: rawText.slice(0, 4096)
          };
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "upstream_fetch_failed",
            tenant: tenant.subdomain,
            tool: tool.name,
            error: err instanceof Error ? err.name : "unknown"
          })
        );
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

    const latencyMs = Math.max(1, Date.now() - startedAt);
    const txId = `tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
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
        isError: false,
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

    // 1. Zero-D1 hot path: write to Analytics Engine + enqueue batched rollup/R2 archival
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
      occurredAt: new Date().toISOString()
    };

    writeGatewayAnalytics(c.env, meteringEvent);

    const backgroundTasks: Promise<unknown>[] = [];
    if (c.env.METERING_EVENTS) {
      backgroundTasks.push(c.env.METERING_EVENTS.send(meteringEvent));
    }

    // 2. Durably cache completed response in PaymentReplayGuard DO for idempotent retries
    const paymentFingerprint = c.get("paymentFingerprint");
    if (paymentFingerprint) {
      const replayStub = c.env.PAYMENT_REPLAY_GUARD.get(
        c.env.PAYMENT_REPLAY_GUARD.idFromName(paymentFingerprint)
      );
      backgroundTasks.push(
        replayStub.fetch("https://payment-replay/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "complete",
            receipt,
            responseBody: serializedResponse
          })
        })
      );
    }

    if (backgroundTasks.length > 0) {
      c.executionCtx.waitUntil(Promise.allSettled(backgroundTasks));
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
