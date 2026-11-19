import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { AppEnv, AuthUser } from "../types";
import { randomHex, sha256Hex, timingSafeEqualString } from "../lib/crypto";

const SESSION_COOKIE = "port4_session";
const OAUTH_STATE_COOKIE = "port4_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getJwtSecret(c: Context<AppEnv>): string {
  const secret = c.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET binding is required and must be at least 16 characters.");
  }
  return secret;
}

function isSecureRequest(c: Context<AppEnv>): boolean {
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

async function issueSessionCookie(c: Context<AppEnv>, user: AuthUser): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      sub: user.id,
      github_id: user.github_id,
      login: user.login,
      avatar_url: user.avatar_url,
      email: user.email,
      is_admin: user.is_admin,
      plan: user.plan,
      iat: now,
      exp: now + SESSION_TTL_SECONDS
    },
    getJwtSecret(c),
    "HS256"
  );

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

async function fetchUserById(c: Context<AppEnv>, userId: string): Promise<AuthUser | null> {
  const row = await c.env.DB.prepare(
    "SELECT id, github_id, login, avatar_url, email, is_admin, plan FROM users WHERE id = ? LIMIT 1"
  )
    .bind(userId)
    .first<AuthUser>();

  if (!row) {
    return null;
  }
  return {
    ...row,
    is_admin: Number(row.is_admin) === 1 ? 1 : 0,
    plan: row.plan === "pro" ? "pro" : "free"
  };
}

export async function getAuthenticatedUser(c: Context<AppEnv>): Promise<AuthUser | null> {
  // 1. Check Bearer API Key for CLI/CI deployments
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer p4_")) {
    const rawKey = authHeader.slice("Bearer ".length).trim();
    const keyHash = await sha256Hex(rawKey);
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.github_id, u.login, u.avatar_url, u.email, u.is_admin, u.plan, k.id AS api_key_id
       FROM api_keys k
       INNER JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?
       LIMIT 1`
    )
      .bind(keyHash)
      .first<AuthUser & { api_key_id: string }>();

    if (row) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
          .bind(row.api_key_id)
          .run()
      );
      return {
        id: row.id,
        github_id: row.github_id,
        login: row.login,
        avatar_url: row.avatar_url,
        email: row.email,
        is_admin: Number(row.is_admin) === 1 ? 1 : 0,
        plan: row.plan === "pro" ? "pro" : "free"
      };
    }
  }

  // 2. Check stateless HTTP-only JWT session cookie
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return null;
  }

  try {
    const payload = await verify(token, getJwtSecret(c), "HS256");
    if (typeof payload.sub !== "string" || typeof payload.login !== "string") {
      return null;
    }
    return {
      id: payload.sub,
      github_id: typeof payload.github_id === "string" ? payload.github_id : "0",
      login: payload.login,
      avatar_url: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
      email: typeof payload.email === "string" ? payload.email : null,
      is_admin: payload.is_admin === 1 ? 1 : 0,
      plan: payload.plan === "pro" ? "pro" : "free"
    };
  } catch {
    return null;
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getAuthenticatedUser(c);
  if (!user) {
    return c.json(
      {
        error: "unauthorized",
        message: "Valid GitHub OAuth session cookie or Bearer API key required."
      },
      401
    );
  }
  c.set("user", user);
  await next();
};

/**
 * Super-Admin Guard Middleware:
 * Verifies the JWT session AND re-checks `is_admin === 1` directly against D1 on every request.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sessionUser = await getAuthenticatedUser(c);
  if (!sessionUser) {
    return c.json({ error: "unauthorized", message: "Admin authentication required." }, 401);
  }

  const freshUser = await fetchUserById(c, sessionUser.id);
  if (!freshUser || freshUser.is_admin !== 1) {
    return c.json({ error: "forbidden", message: "Super-admin privileges required." }, 403);
  }

  c.set("user", freshUser);
  await next();
};

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/github", (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return c.json(
      {
        error: "github_oauth_not_configured",
        message: "GitHub OAuth is not configured on this environment."
      },
      501
    );
  }

  const state = randomHex(16);
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 600
  });

  const redirectUri = `${c.env.APP_URL.replace(/\/$/, "")}/api/auth/github/callback`;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);

  return c.redirect(url.toString(), 302);
});

authRoutes.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });

  if (!code || !state || !expectedState || !(await timingSafeEqualString(state, expectedState))) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  const clientId = c.env.GITHUB_CLIENT_ID;
  const clientSecret = c.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: "github_oauth_not_configured" }, 501);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code
    })
  });

  if (!tokenRes.ok) {
    return c.json({ error: "github_token_exchange_failed" }, 502);
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    return c.json({ error: "missing_access_token" }, 401);
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "Port4-Gateway/1.0",
      Accept: "application/vnd.github+json"
    }
  });

  if (!userRes.ok) {
    return c.json({ error: "github_profile_fetch_failed" }, 502);
  }

  const gh = (await userRes.json()) as {
    id: number;
    login: string;
    avatar_url?: string;
    email?: string | null;
  };

  const githubId = String(gh.id);
  const adminLogin = (c.env.ADMIN_GITHUB_LOGIN || "Ishabarundo").toLowerCase();
  const autoPromoteAdmin = gh.login.toLowerCase() === adminLogin ? 1 : 0;

  const existing = await c.env.DB.prepare(
    "SELECT id, github_id, login, avatar_url, email, is_admin, plan FROM users WHERE github_id = ? LIMIT 1"
  )
    .bind(githubId)
    .first<AuthUser>();

  let user: AuthUser;
  if (existing) {
    const resolvedAdmin = existing.is_admin === 1 || autoPromoteAdmin === 1 ? 1 : 0;
    await c.env.DB.prepare(
      "UPDATE users SET login = ?, avatar_url = ?, email = ?, is_admin = ? WHERE id = ?"
    )
      .bind(gh.login, gh.avatar_url ?? null, gh.email ?? null, resolvedAdmin, existing.id)
      .run();
    user = {
      id: existing.id,
      github_id: githubId,
      login: gh.login,
      avatar_url: gh.avatar_url ?? null,
      email: gh.email ?? null,
      is_admin: resolvedAdmin,
      plan: existing.plan === "pro" ? "pro" : "free"
    };
  } else {
    const newId = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await c.env.DB.prepare(
      "INSERT INTO users (id, github_id, login, avatar_url, email, is_admin, plan) VALUES (?, ?, ?, ?, ?, ?, 'free')"
    )
      .bind(newId, githubId, gh.login, gh.avatar_url ?? null, gh.email ?? null, autoPromoteAdmin)
      .run();
    user = {
      id: newId,
      github_id: githubId,
      login: gh.login,
      avatar_url: gh.avatar_url ?? null,
      email: gh.email ?? null,
      is_admin: autoPromoteAdmin,
      plan: "free"
    };
  }

  await issueSessionCookie(c, user);
  return c.redirect(user.is_admin === 1 ? "/admin" : "/dashboard", 302);
});

authRoutes.post("/demo", async (c) => {
  const existing = await fetchUserById(c, "usr_port4_sandbox");

  const user: AuthUser = existing ?? {
    id: "usr_port4_sandbox",
    github_id: "0",
    login: "port4-demo",
    avatar_url: "https://avatars.githubusercontent.com/u/9919?v=4",
    email: "info@port4.dev",
    is_admin: 0,
    plan: "free"
  };

  if (!existing) {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, github_id, login, avatar_url, email, is_admin, plan) VALUES (?, ?, ?, ?, ?, 0, 'free')"
    )
      .bind(user.id, user.github_id, user.login, user.avatar_url, user.email)
      .run();
  }

  await issueSessionCookie(c, user);
  return c.json({ ok: true, user });
});

authRoutes.get("/me", async (c) => {
  const sessionUser = await getAuthenticatedUser(c);
  const freshUser = sessionUser ? await fetchUserById(c, sessionUser.id) : null;
  return c.json({
    authenticated: Boolean(freshUser),
    githubConfigured: Boolean(c.env.GITHUB_CLIENT_ID),
    user: freshUser
  });
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
