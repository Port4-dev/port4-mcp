import type { MiddlewareHandler } from "hono";
import type { AppEnv, McpJsonRpcRequest } from "../types";
import { isAllowedMcpOrigin } from "../lib/schema-validator";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const MAX_BODY_BYTES = 64 * 1024; // 64 KiB enforced on actual read bytes

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  };
}

/**
 * Enforces Stateless MCP 2026-07-28 specification:
 * - Validates Origin header against DNS rebinding attacks.
 * - Enforces 64 KiB body limit on actual payload bytes (not trusting Content-Length alone).
 * - Ignores Mcp-Session-Id headers per MCP 2026-07-28 stateless rules (never creates/echoes sessions).
 * - Validates MCP-Protocol-Version, Mcp-Method, Mcp-Name, and params._meta consistency.
 */
export const mcpHeadersMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("requestStartedAt", Date.now());

  const originHeader = c.req.header("Origin");
  if (!isAllowedMcpOrigin(originHeader)) {
    return c.json(
      rpcError(null, -32600, "Forbidden Origin header for MCP transport."),
      403
    );
  }

  const contentLength = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return c.json(rpcError(null, -32600, "Request body exceeds the 64 KiB limit."), 413);
  }

  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json(rpcError(null, -32600, "Content-Type must be application/json."), 415);
  }

  const rawProtocolVersion = c.req.header("MCP-Protocol-Version");
  if (rawProtocolVersion && rawProtocolVersion !== MCP_PROTOCOL_VERSION) {
    return c.json(
      rpcError(
        null,
        -32600,
        `Unsupported MCP-Protocol-Version header. Expected '${MCP_PROTOCOL_VERSION}'.`,
        { expected: MCP_PROTOCOL_VERSION, received: rawProtocolVersion }
      ),
      400
    );
  }
  const protocolVersion = rawProtocolVersion ?? MCP_PROTOCOL_VERSION;

  let rawText: string;
  try {
    rawText = await c.req.text();
  } catch {
    return c.json(rpcError(null, -32700, "Unable to read request body."), 400);
  }

  const actualBytes = new TextEncoder().encode(rawText).byteLength;
  if (actualBytes > MAX_BODY_BYTES) {
    return c.json(rpcError(null, -32600, "Request body exceeds the 64 KiB limit."), 413);
  }

  let body: McpJsonRpcRequest;
  try {
    body = JSON.parse(rawText) as McpJsonRpcRequest;
  } catch {
    return c.json(rpcError(null, -32700, "Parse error: invalid JSON-RPC 2.0 body."), 400);
  }

  const rpcId = body.id ?? null;

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || body.method.length === 0) {
    return c.json(
      rpcError(rpcId, -32600, "Invalid Request: expected JSON-RPC 2.0 payload with method."),
      400
    );
  }

  if (body.method === "initialize" || body.method === "notifications/initialized") {
    return c.json(
      rpcError(
        rpcId,
        -32600,
        "Stateless MCP 2026-07-28 does not use initialize handshakes. Call tools/list or tools/call directly."
      ),
      400
    );
  }

  if (
    body.params?._meta !== undefined &&
    (!body.params._meta || typeof body.params._meta !== "object" || Array.isArray(body.params._meta))
  ) {
    return c.json(
      rpcError(rpcId, -32602, "Invalid params: _meta must be a JSON object when provided."),
      400
    );
  }

  const headerMethod = c.req.header("Mcp-Method");
  if (headerMethod && headerMethod !== body.method) {
    return c.json(
      rpcError(rpcId, -32600, "Header mismatch: Mcp-Method header must match JSON-RPC method.", {
        headerMethod,
        bodyMethod: body.method
      }),
      400
    );
  }

  const headerName = c.req.header("Mcp-Name") ?? null;
  const bodyToolName = typeof body.params?.name === "string" ? body.params.name : null;

  if (body.method === "tools/call") {
    if (!bodyToolName) {
      return c.json(
        rpcError(rpcId, -32602, "Invalid params: tools/call requires params.name."),
        400
      );
    }
    if (headerName && headerName !== bodyToolName) {
      return c.json(
        rpcError(
          rpcId,
          -32600,
          "Header mismatch: Mcp-Name header must match JSON-RPC params.name.",
          { headerName, bodyToolName }
        ),
        400
      );
    }
  } else if (headerName && bodyToolName && headerName !== bodyToolName) {
    return c.json(
      rpcError(rpcId, -32600, "Header mismatch: Mcp-Name header does not match params.name."),
      400
    );
  }

  c.set("mcp", {
    protocolVersion,
    method: body.method,
    toolName: bodyToolName,
    rpcId,
    arguments:
      body.params?.arguments &&
      typeof body.params.arguments === "object" &&
      !Array.isArray(body.params.arguments)
        ? body.params.arguments
        : {}
  });

  await next();
};
