import type { MiddlewareHandler } from "hono";
import type { AppEnv, McpJsonRpcRequest } from "../types";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

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
 * - Rejects stateful Mcp-Session-Id headers and `initialize` handshake calls.
 * - Validates `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers against
 *   the JSON-RPC 2.0 body, rejecting any mismatch with 400 Bad Request.
 */
export const mcpHeadersMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("requestStartedAt", Date.now());

  if (c.req.header("Mcp-Session-Id")) {
    return c.json(
      rpcError(null, -32600, "Stateless MCP 2026-07-28 forbids Mcp-Session-Id headers."),
      400
    );
  }

  const rawProtocolVersion = c.req.header("MCP-Protocol-Version");
  if (rawProtocolVersion && rawProtocolVersion !== MCP_PROTOCOL_VERSION) {
    return c.json(
      rpcError(
        null,
        -32600,
        `Invalid MCP-Protocol-Version header. Expected '${MCP_PROTOCOL_VERSION}'.`,
        { expected: MCP_PROTOCOL_VERSION, received: rawProtocolVersion }
      ),
      400
    );
  }
  const protocolVersion = rawProtocolVersion ?? MCP_PROTOCOL_VERSION;

  let body: McpJsonRpcRequest;
  try {
    body = (await c.req.json()) as McpJsonRpcRequest;
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
      body.params?.arguments && typeof body.params.arguments === "object"
        ? body.params.arguments
        : {}
  });

  await next();
};
