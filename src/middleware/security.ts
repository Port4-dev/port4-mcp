import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "[::1]" || lower === "::1";
}

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

/**
 * Validates that a browser `Origin` header is trusted for cookie-authenticated control-plane writes.
 * - Always trusts `https://port4.dev`, `https://www.port4.dev`, and `new URL(appUrl).origin`.
 * - Allows local dev loopback origins (`http://localhost:<port>`, `http://127.0.0.1:<port>`) when
 *   either ` requestUrl` is absent (direct unit check), `requestUrl` is itself a local loopback request,
 *   or `appUrl` is configured to a local loopback origin.
 * - Rejects loopback `Origin` headers when `requestUrl` is a production `https://port4.dev` URL!
 */
export function isTrustedBrowserOrigin(
  origin: string | undefined,
  appUrl: string | undefined,
  requestUrl?: string
): boolean {
  if (!origin) return false;
  if (allowedOrigins(appUrl).has(origin)) return true;

  try {
    const parsedOrigin = new URL(origin);
    if (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
      isLocalHostname(parsedOrigin.hostname)
    ) {
      if (!requestUrl) {
        return true;
      }
      const parsedReq = new URL(requestUrl);
      if (isLocalHostname(parsedReq.hostname)) {
        return true;
      }
      if (appUrl) {
        try {
          if (isLocalHostname(new URL(appUrl).hostname)) {
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return false;
  }

  return false;
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
  if (!isTrustedBrowserOrigin(origin, c.env.APP_URL, c.req.url)) {
    return c.json({ error: "invalid_request_origin" }, 403);
  }
  return next();
};
