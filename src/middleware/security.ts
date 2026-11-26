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

/**
 * Applies defensive HTTP security headers to all API, MCP, and SPA responses.
 */
export const securityHeadersMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  try {
    if (new URL(c.req.url).protocol === "https:") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  } catch {
    // ignore malformed url
  }

  const path = c.req.path;
  const isApiOrProtocol =
    path.startsWith("/api/") ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path === "/openapi.json" ||
    path === "/health" ||
    path.startsWith("/sandbox/");

  if (isApiOrProtocol) {
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  } else {
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
  }
};

/** Protect cookie-authenticated control-plane writes from cross-site form and fetch requests. */
export const controlPlaneCsrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!UNSAFE_METHODS.has(c.req.method)) {
    return next();
  }

  if (c.req.path === "/api/webhooks/stripe" && c.req.header("Stripe-Signature")) {
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
