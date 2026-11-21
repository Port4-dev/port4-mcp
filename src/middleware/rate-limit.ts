import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { sha256Hex } from "../lib/crypto";

const WINDOW_SECONDS = 60;
const DEFAULT_REQUESTS_PER_MINUTE = 120;

interface LimitResponse {
  allowed: boolean;
  reason?: "rpm_exceeded" | "daily_quota_exceeded";
  remaining: number;
  resetAt: number;
  sequence: number;
}

export const edgeRateLimitMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tenant = c.get("tenant");
  if (!tenant) return c.json({ error: "gateway_context_missing" }, 500);

  const envFallback = Number(c.env.MCP_RATE_LIMIT_PER_MINUTE ?? DEFAULT_REQUESTS_PER_MINUTE);
  const tenantRpm = tenant.rate_limit_rpm || envFallback;
  const limit =
    Number.isInteger(tenantRpm) && tenantRpm > 0 && tenantRpm <= 100_000
      ? tenantRpm
      : DEFAULT_REQUESTS_PER_MINUTE;

  const dailyQuota =
    tenant.daily_quota && tenant.daily_quota > 0
      ? tenant.daily_quota
      : tenant.owner_plan === "pro"
        ? 1_000_000
        : 10_000;

  const source = c.req.header("CF-Connecting-IP") ?? "local";
  const key = await sha256Hex(`${tenant.id}:${source}`);
  const stub = c.env.EDGE_RATE_LIMITER.get(c.env.EDGE_RATE_LIMITER.idFromName(key));

  let result: LimitResponse;
  try {
    const response = await stub.fetch("https://rate-limit/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, windowSeconds: WINDOW_SECONDS, dailyQuota })
    });
    if (!response.ok) throw new Error("rate_limiter_rejected_request");
    result = (await response.json()) as LimitResponse;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "rate_limiter_unavailable",
        tenant: tenant.subdomain,
        error: error instanceof Error ? error.name : "unknown"
      })
    );
    return c.json({ error: "gateway_temporarily_unavailable" }, 503);
  }

  c.header("RateLimit-Limit", String(limit));
  c.header("RateLimit-Remaining", String(result.remaining));
  c.header("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
    return c.json(
      {
        error: result.reason ?? "rate_limit_exceeded",
        message:
          result.reason === "daily_quota_exceeded"
            ? "Daily tenant quota exceeded."
            : "Rate limit exceeded. Retry after the reset window."
      },
      429
    );
  }

  c.set("rateLimitSequence", result.sequence);
  await next();
};
