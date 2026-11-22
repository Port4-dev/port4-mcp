import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings, AppEnv } from "./types";
import { resolveTenant } from "./lib/kv-sync";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { mcpHeadersMiddleware } from "./middleware/mcp-headers";
import { x402GateMiddleware } from "./middleware/x402-gate";
import { handleMcpRequest } from "./routes/mcp";
import { apiRoutes } from "./routes/api";
import { sandboxRoutes } from "./routes/sandbox";
import { controlPlaneCsrfMiddleware, isTrustedBrowserOrigin } from "./middleware/security";
import { edgeRateLimitMiddleware } from "./middleware/rate-limit";
import { consumeMeteringEvents } from "./lib/metering";
export { EdgeRateLimiter, PaymentReplayGuard } from "./durable-objects";

const app = new Hono<AppEnv>();

app.use(
  "/api/*",
  cors({
    origin: (origin, c) => (isTrustedBrowserOrigin(origin, c.env.APP_URL) ? origin : "https://port4.dev"),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true
  })
);

app.use(
  "/mcp*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Cf-Access-Jwt-Assertion",
      "CF-Access-Client-Id",
      "CF-Access-Client-Secret",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
      "PAYMENT-SIGNATURE",
      "X-Port4-Tenant"
    ],
    exposeHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-Port4-Tenant",
      "X-Port4-Mcp-Mode",
      "X-Port4-Settlement-Tx",
      "MCP-Protocol-Version"
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: false
  })
);

app.use(
  "/sandbox/*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
      "PAYMENT-SIGNATURE"
    ],
    exposeHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-Port4-Tenant",
      "X-Port4-Settlement-Tx",
      "MCP-Protocol-Version"
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: false
  })
);

function extractTenantSubdomain(c: Context<AppEnv>): string | null {
  let urlHostname = "";
  try {
    urlHostname = new URL(c.req.url).hostname.toLowerCase();
  } catch {
    // ignore
  }

  const hostCandidates = [urlHostname];

  for (const rawHost of hostCandidates) {
    if (!rawHost) continue;
    const host = rawHost.toLowerCase().split(",")[0].trim().split(":")[0];
    if (host.endsWith(".port4.dev")) {
      const sub = host.slice(0, -".port4.dev".length);
      if (sub && sub !== "www") {
        return sub;
      }
    }
    if (host.endsWith(".localhost")) {
      const sub = host.slice(0, -".localhost".length);
      if (sub && sub !== "www") {
        return sub;
      }
    }
  }
  return null;
}

const resolveTenantMiddleware = (forcedSubdomain?: string): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const cfIp = c.req.header("CF-Connecting-IP");
    const isLocalDev = !cfIp || cfIp === "127.0.0.1" || cfIp === "::1";
    const explicitHeader = isLocalDev ? c.req.header("X-Port4-Tenant")?.trim().toLowerCase() : null;
    const subdomain = forcedSubdomain ?? explicitHeader ?? extractTenantSubdomain(c) ?? (isLocalDev ? "demo" : null);
    if (!subdomain) {
      return c.json(
        {
          error: "missing_tenant_subdomain",
          message:
            "Invoke via https://{tenant}.port4.dev/mcp or pass X-Port4-Tenant header in local dev."
        },
        400
      );
    }

    const tenant = await resolveTenant(c.env, subdomain);
    if (!tenant) {
      return c.json(
        {
          error: "tenant_not_found_or_suspended",
          message: `No active Port4 gateway found for '${subdomain}'.`
        },
        404
      );
    }

    c.set("tenantSubdomain", subdomain);
    c.set("tenant", tenant);
    await next();
  };
};

// Health checks (/health and /api/health)
const healthHandler = (c: Context<AppEnv>) =>
  c.json({
    ok: true,
    service: "port4-gateway",
    mcpSpec: "2026-07-28",
    x402Version: 2,
    network: c.env.X402_NETWORK,
    capabilities: {
      codemodeLoader: Boolean(c.env.LOADER),
      r2Archive: Boolean(c.env.LEDGER_ARCHIVE),
      analyticsEngine: Boolean(c.env.GATEWAY_ANALYTICS),
      mainnetFacilitatorConfigured: Boolean(c.env.X402_MAINNET_FACILITATOR_URL)
    }
  });

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Data Plane: Stateless Paid MCP Endpoint (subdomain OR /mcp/:tenant path fallback)
app.post(
  "/mcp",
  resolveTenantMiddleware(),
  edgeRateLimitMiddleware,
  mcpHeadersMiddleware,
  x402GateMiddleware,
  handleMcpRequest
);

app.post(
  "/mcp/:tenant",
  async (c, next) => {
    const slug = c.req.param("tenant").trim().toLowerCase();
    const tenant = await resolveTenant(c.env, slug);
    if (!tenant) {
      return c.json(
        {
          error: "tenant_not_found_or_suspended",
          message: `No active Port4 gateway found for '${slug}'.`
        },
        404
      );
    }
    c.set("tenantSubdomain", slug);
    c.set("tenant", tenant);
    await next();
  },
  edgeRateLimitMiddleware,
  mcpHeadersMiddleware,
  x402GateMiddleware,
  handleMcpRequest
);

app.get("/mcp", (c) =>
  c.json(
    {
      error: "method_not_allowed",
      message: "Stateless MCP 2026-07-28 uses HTTP POST with JSON-RPC 2.0."
    },
    405
  )
);

// Sandbox Data Plane alias
app.post(
  "/sandbox/mcp",
  resolveTenantMiddleware("demo"),
  edgeRateLimitMiddleware,
  mcpHeadersMiddleware,
  x402GateMiddleware,
  handleMcpRequest
);

app.route("/sandbox", sandboxRoutes);
app.route("/api/sandbox", sandboxRoutes);

// Control Plane: Auth, Super-Admin, & Developer API
app.use("/api/*", controlPlaneCsrfMiddleware);
app.route("/auth", authRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api", apiRoutes);

app.all("/api/*", (c) =>
  c.json(
    {
      error: "not_found",
      message: "Lost on Port5 — this API endpoint doesn't exist."
    },
    404
  )
);

// Root Domain Fallback: Workers Static Assets SPA
app.all("*", async (c) => {
  const subdomain = extractTenantSubdomain(c);
  if (subdomain) {
    return c.json(
      {
        service: "port4-gateway",
        tenant: subdomain,
        mcp_endpoint: `https://${subdomain}.port4.dev/mcp`,
        protocol: "MCP 2026-07-28 + x402 v2"
      },
      200
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error(
    JSON.stringify({
      event: "unhandled_worker_error",
      path: new URL(c.req.url).pathname,
      method: c.req.method,
      error: message
    })
  );
  return c.json({ error: "internal_server_error" }, 500);
});

export default {
  fetch(request: Request, env: AppBindings, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  queue(batch: MessageBatch<unknown>, env: AppBindings): Promise<void> {
    return consumeMeteringEvents(batch, env);
  }
} satisfies ExportedHandler<AppBindings>;
