import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedOrigins(appUrl: string | undefined): Set<string> {
  const origins = new Set(["https://port4.dev", "https://www.port4.dev"]);
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // Invalid deployment configuration must not widen the allow-list.
    }
  }
  return origins;
}

export function isTrustedBrowserOrigin(origin: string | undefined, appUrl: string | undefined): boolean {
  return Boolean(origin && allowedOrigins(appUrl).has(origin));
}

/** Protect cookie-authenticated control-plane writes from cross-site form and fetch requests. */
export const controlPlaneCsrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!UNSAFE_METHODS.has(c.req.method)) {
    return next();
  }

  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Bearer p4_")) {
    return next();
  }

  const origin = c.req.header("Origin");
  if (!isTrustedBrowserOrigin(origin, c.env.APP_URL)) {
    return c.json({ error: "invalid_request_origin" }, 403);
  }
  return next();
};
