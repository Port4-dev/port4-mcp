import { Hono } from "hono";
import type { AppEnv, TenantRecord, ToolRecord, TransactionRecord } from "../types";
import { requireAuth } from "../middleware/auth";
import { invalidateTenantKv, syncTenantToKv } from "../lib/kv-sync";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  hmacSha256Hex,
  isValidCustomAuthHeaderName,
  randomHex,
  sha256Hex,
  timingSafeEqualString,
  usdToAtomicUsdc
} from "../lib/crypto";
import { normalizeAccessTeamDomain } from "../lib/cloudflare-access";
import { parseOpenApiSpecToTools } from "../lib/openapi-import";
import {
  SUPPORTED_NETWORKS,
  getSupportedNetwork,
  isSupportedNetwork,
  isValidWalletForNetwork,
  normalizePayoutWallets,
  parsePayoutWalletsJson,
  type PayoutWalletEntry
} from "../lib/networks";
import { interpolateUpstreamPath } from "./mcp";
import { executeInternalSandboxTool } from "./sandbox";

const MCP_MODES = new Set(["direct", "codemode", "openapi_codemode"]);
const UPSTREAM_AUTH_TYPES = new Set(["none", "bearer", "api_key_header"]);

const RESERVED_SUBDOMAINS = new Set(["www", "api", "app", "admin", "auth", "status", "docs"]);
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

function validateUpstreamBaseUrl(value: string): string | null {
  if (value === "internal://sandbox") return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".arpa") ||
      hostname.endsWith(".home") ||
      hostname.endsWith(".lan") ||
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80:") ||
      hostname.startsWith("::ffff:") ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[01-7])\./.test(hostname) ||
      /^198\.(1[89])\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function validateToolDefinition(input: {
  name?: string;
  description?: string;
  http_method?: string;
  upstream_path?: string;
  price_usd?: string;
  input_schema_json?: string;
}): { value: Required<typeof input> & { price_atomic: string } } | { error: string } {
  const name = (input.name ?? "").trim();
  const description = (input.description ?? "").trim();
  const upstreamPath = (input.upstream_path ?? "").trim();
  const method = input.http_method ?? "POST";
  const priceUsd = (input.price_usd ?? "0.001").replace(/^\$/, "").trim();
  const schema = input.input_schema_json ?? '{"type":"object","properties":{}}';

  if (!TOOL_NAME_RE.test(name) || description.length > 1_024 || !upstreamPath.startsWith("/") || upstreamPath.startsWith("//") || upstreamPath.length > 512 || !HTTP_METHODS.has(method)) {
    return { error: "invalid_tool_definition" };
  }
  try {
    const parsed = JSON.parse(schema) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || schema.length > 32 * 1024) {
      return { error: "invalid_input_schema" };
    }
    return { value: { name, description, http_method: method, upstream_path: upstreamPath, price_usd: priceUsd, input_schema_json: schema, price_atomic: usdToAtomicUsdc(priceUsd) } };
  } catch {
    return { error: "invalid_price_or_input_schema" };
  }
}

export const apiRoutes = new Hono<AppEnv>();

// Public list of supported x402 v2 settlement networks (EVM + Solana)
apiRoutes.get("/networks", (c) => {
  return c.json({ networks: SUPPORTED_NETWORKS });
});

// Public Featured Registry for homepage directory
apiRoutes.get("/public/featured", async (c) => {
  const tenantsRes = await c.env.DB.prepare(
    `SELECT t.id, t.subdomain AS slug, t.name, t.network, t.call_count, u.login AS owner_login
     FROM tenants t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.is_featured = 1 AND t.status = 'active' AND t.is_active = 1
     ORDER BY t.call_count DESC, t.created_at DESC
     LIMIT 12`
  ).all<{
    id: string;
    slug: string;
    name: string;
    network: string;
    call_count: number;
    owner_login: string | null;
  }>();

  const tenants = tenantsRes.results ?? [];
  if (tenants.length === 0) {
    return c.json({ featured: [] });
  }

  const toolsRes = await c.env.DB.prepare(
    `SELECT tl.id, tl.tenant_id, tl.name, tl.description, tl.price_usd
     FROM tools tl
     INNER JOIN tenants t ON t.id = tl.tenant_id
     WHERE t.is_featured = 1 AND t.status = 'active' AND tl.is_active = 1
     ORDER BY tl.name ASC`
  ).all<{ id: string; tenant_id: string; name: string; description: string; price_usd: string }>();

  const toolsByTenant = new Map<string, Array<{ id: string; name: string; description: string; price_usd: string }>>();
  for (const tool of toolsRes.results ?? []) {
    const list = toolsByTenant.get(tool.tenant_id) ?? [];
    list.push({ id: tool.id, name: tool.name, description: tool.description, price_usd: tool.price_usd });
    toolsByTenant.set(tool.tenant_id, list);
  }

  return c.json({
    featured: tenants.map((t) => ({
      ...t,
      endpoint_url: `https://${t.slug}.port4.dev/mcp`,
      tools: toolsByTenant.get(t.id) ?? []
    }))
  });
});

// Public read-only demo ledger for unauthenticated sandbox preview
apiRoutes.get("/public/ledger", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT tx.id, tx.tenant_id, t.subdomain AS tenant_subdomain, tx.tool_name, tx.payer_wallet,
            tx.amount_atomic, tx.amount_usd, tx.network, tx.tx_hash, tx.status, tx.latency_ms, tx.created_at
     FROM transactions tx
     INNER JOIN tenants t ON t.id = tx.tenant_id
     WHERE t.subdomain = 'demo'
     ORDER BY tx.created_at DESC
     LIMIT 25`
  ).all<TransactionRecord>();

  return c.json({ transactions: rows.results ?? [] });
});

// All Control Plane routes below require a valid GitHub OAuth JWT session or Bearer API Key
apiRoutes.use("/tenants/*", requireAuth);
apiRoutes.use("/tenants", requireAuth);
apiRoutes.use("/ledger", requireAuth);
apiRoutes.use("/keys/*", requireAuth);
apiRoutes.use("/keys", requireAuth);

apiRoutes.get("/tenants", async (c) => {
  const user = c.get("user")!;
  const tenantsRes = await c.env.DB.prepare(
    `SELECT id, user_id, subdomain, name, upstream_base_url, payout_wallet, payout_wallets_json,
            network, auth_mode, is_active,
            COALESCE(mcp_mode, 'direct') AS mcp_mode,
            COALESCE(codemode_price_usd, '0.01') AS codemode_price_usd,
            COALESCE(codemode_max_subcalls, 10) AS codemode_max_subcalls,
            COALESCE(upstream_verified, 0) AS upstream_verified,
            COALESCE(require_upstream_verified, 0) AS require_upstream_verified,
            COALESCE(require_visa_tap, 0) AS require_visa_tap,
            COALESCE(allow_tap_simulated, 0) AS allow_tap_simulated,
            COALESCE(upstream_auth_type, 'none') AS upstream_auth_type,
            upstream_auth_header, upstream_auth_secret,
            cf_access_team_domain, cf_access_aud,
            created_at, updated_at
     FROM tenants
     WHERE user_id = ? AND deleted_at IS NULL AND status != 'archived'
     ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all<TenantRecord>();

  const tenants = tenantsRes.results ?? [];
  if (tenants.length === 0) {
    return c.json({ tenants: [] });
  }

  const toolsRes = await c.env.DB.prepare(
    `SELECT tl.id, tl.tenant_id, tl.name, tl.description, tl.http_method, tl.upstream_path,
            tl.input_schema_json, tl.price_usd, tl.price_atomic, tl.is_active, tl.created_at
     FROM tools tl
     INNER JOIN tenants t ON t.id = tl.tenant_id
     WHERE t.user_id = ?
     ORDER BY tl.created_at DESC`
  )
    .bind(user.id)
    .all<ToolRecord>();

  const toolsByTenant = new Map<string, ToolRecord[]>();
  for (const tool of toolsRes.results ?? []) {
    const list = toolsByTenant.get(tool.tenant_id) ?? [];
    list.push(tool);
    toolsByTenant.set(tool.tenant_id, list);
  }

  return c.json({
    tenants: tenants.map((t) => ({
      ...t,
      upstream_auth_secret: undefined,
      has_upstream_auth_secret: Boolean(t.upstream_auth_secret),
      payout_wallets: parsePayoutWalletsJson(t.payout_wallets_json, t.network, t.payout_wallet),
      endpoint_url: `https://${t.subdomain}.port4.dev/mcp`,
      tools: toolsByTenant.get(t.id) ?? []
    }))
  });
});

apiRoutes.post("/tenants", async (c) => {
  const user = c.get("user")!;
  let body: {
    subdomain?: string;
    name?: string;
    upstream_base_url?: string;
    payout_wallet?: string;
    payout_wallets?: PayoutWalletEntry[];
    network?: string;
    auth_mode?: "x402" | "x402+oauth_v2";
    mcp_mode?: "direct" | "codemode" | "openapi_codemode";
    codemode_price_usd?: string;
    codemode_max_subcalls?: number;
    upstream_auth_type?: "none" | "bearer" | "api_key_header";
    upstream_auth_header?: string;
    upstream_auth_secret?: string;
    cf_access_team_domain?: string;
    cf_access_aud?: string;
    initial_tool?: {
      name: string;
      description: string;
      http_method?: "GET" | "POST" | "PUT" | "DELETE";
      upstream_path: string;
      price_usd: string;
    };
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const subdomain = (body.subdomain ?? "").trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(subdomain) || RESERVED_SUBDOMAINS.has(subdomain)) {
    return c.json(
      {
        error: "invalid_subdomain",
        message: "Subdomain must be 3–32 lowercase alphanumeric/hyphen chars and not reserved."
      },
      400
    );
  }

  const name = (body.name ?? subdomain).trim();
  if (!name || name.length > 128) {
    return c.json({ error: "invalid_name" }, 400);
  }
  const upstreamBaseUrl = validateUpstreamBaseUrl((body.upstream_base_url ?? "").trim());
  if (!upstreamBaseUrl) {
    return c.json(
      { error: "invalid_upstream_url", message: "Upstream URL must be a public HTTPS origin without credentials." },
      400
    );
  }

  const network = (body.network || c.env.X402_NETWORK).trim();
  if (!isSupportedNetwork(network)) {
    return c.json(
      { error: "invalid_network", message: `Unsupported settlement network '${network}'.` },
      400
    );
  }

  const payoutWallet = (body.payout_wallet ?? "").trim();
  if (!isValidWalletForNetwork(network, payoutWallet)) {
    return c.json(
      {
        error: "invalid_payout_wallet",
        message: network.startsWith("solana:")
          ? "Payout wallet must be a valid Solana Base58 address."
          : "Payout wallet must be a valid 0x EVM address."
      },
      400
    );
  }

  if (body.payout_wallets !== undefined) {
    if (!Array.isArray(body.payout_wallets) || body.payout_wallets.length > 10) {
      return c.json({ error: "invalid_payout_wallets", message: "Up to 10 payout wallets are allowed." }, 400);
    }
    for (const entry of body.payout_wallets) {
      if (!entry || typeof entry.network !== "string" || typeof entry.address !== "string" || !isValidWalletForNetwork(entry.network, entry.address)) {
        return c.json(
          { error: "invalid_payout_wallets", message: `Invalid wallet address for network '${entry?.network ?? "unknown"}'.` },
          400
        );
      }
    }
  }

  const normalizedWallets = normalizePayoutWallets(network, payoutWallet, body.payout_wallets);
  const payoutWalletsJson = JSON.stringify(normalizedWallets);

  const mcpMode = body.mcp_mode && MCP_MODES.has(body.mcp_mode) ? body.mcp_mode : "direct";
  const codemodePriceUsd = (body.codemode_price_usd ?? "0.01").replace(/^\$/, "").trim();
  try {
    usdToAtomicUsdc(codemodePriceUsd);
  } catch {
    return c.json({ error: "invalid_codemode_price", message: "Code Mode price must be a valid USD decimal." }, 400);
  }
  const codemodeMaxSubcalls = Math.min(50, Math.max(1, Math.floor(Number(body.codemode_max_subcalls ?? 10) || 10)));

  let cfAccessTeamDomain: string | null = null;
  let cfAccessAud: string | null = null;
  let authMode: "x402" | "x402+oauth_v2" = "x402";

  if (body.auth_mode === "x402+oauth_v2") {
    const normalizedDomain = body.cf_access_team_domain
      ? normalizeAccessTeamDomain(body.cf_access_team_domain)
      : null;
    const trimmedAud = (body.cf_access_aud ?? "").trim();
    if (!normalizedDomain || trimmedAud.length < 16 || trimmedAud.length > 128) {
      return c.json(
        {
          error: "invalid_cloudflare_access_config",
          message:
            "Cloudflare One Access requires a valid <team>.cloudflareaccess.com domain and AUD tag."
        },
        400
      );
    }
    cfAccessTeamDomain = normalizedDomain;
    cfAccessAud = trimmedAud;
    authMode = "x402+oauth_v2";
  }

  const upstreamAuthType =
    body.upstream_auth_type && UPSTREAM_AUTH_TYPES.has(body.upstream_auth_type)
      ? body.upstream_auth_type
      : "none";
  let upstreamAuthHeader: string | null = null;
  let encryptedUpstreamSecret: string | null = null;

  if (upstreamAuthType === "api_key_header") {
    const rawHeader = (body.upstream_auth_header ?? "").trim();
    if (!isValidCustomAuthHeaderName(rawHeader)) {
      return c.json(
        {
          error: "invalid_upstream_auth_header",
          message: "Custom auth header must be 2-64 alphanumeric/hyphen chars and not a reserved header."
        },
        400
      );
    }
    upstreamAuthHeader = rawHeader;
  }

  if (upstreamAuthType !== "none" && body.upstream_auth_secret && body.upstream_auth_secret.trim()) {
    encryptedUpstreamSecret = await encryptSecretAtRest(
      body.upstream_auth_secret.trim().slice(0, 512),
      c.env.JWT_SECRET
    );
  }

  const tenantId = `ten_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const upstreamSigningSecret = `p4_whsec_${randomHex(24)}`;
  const verificationToken = `port4-verify=${randomHex(16)}`;
  const rateLimitRpm = user.plan === "pro" ? 600 : 120;
  const dailyQuota = user.plan === "pro" ? 1_000_000 : 10_000;

  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants
       (id, user_id, subdomain, name, upstream_base_url, payout_wallet, payout_wallets_json, network, auth_mode, is_active, upstream_signing_secret, verification_token, rate_limit_rpm, daily_quota, mcp_mode, codemode_price_usd, codemode_max_subcalls, upstream_auth_type, upstream_auth_header, upstream_auth_secret, cf_access_team_domain, cf_access_aud)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        tenantId,
        user.id,
        subdomain,
        name,
        upstreamBaseUrl,
        payoutWallet,
        payoutWalletsJson,
        network,
        authMode,
        upstreamSigningSecret,
        verificationToken,
        rateLimitRpm,
        dailyQuota,
        mcpMode,
        codemodePriceUsd,
        codemodeMaxSubcalls,
        upstreamAuthType,
        upstreamAuthHeader,
        encryptedUpstreamSecret,
        cfAccessTeamDomain,
        cfAccessAud
      )
      .run();
  } catch {
    return c.json({ error: "subdomain_taken", message: `Subdomain '${subdomain}' is already registered.` }, 409);
  }

  if (body.initial_tool) {
    const validatedTool = validateToolDefinition(body.initial_tool);
    if ("error" in validatedTool) {
      await c.env.DB.prepare("DELETE FROM tenants WHERE id = ? AND user_id = ?").bind(tenantId, user.id).run();
      return c.json({ error: validatedTool.error }, 400);
    }
    const toolId = `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await c.env.DB.prepare(
      `INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        toolId,
        tenantId,
        validatedTool.value.name,
        validatedTool.value.description || `Paid MCP tool for ${name}`,
        validatedTool.value.http_method,
        validatedTool.value.upstream_path,
        validatedTool.value.input_schema_json,
        validatedTool.value.price_usd,
        validatedTool.value.price_atomic
      )
      .run();
  }

  const synced = await syncTenantToKv(c.env, subdomain);
  return c.json(
    {
      tenant: synced ? { ...synced, upstream_signing_secret: undefined } : null,
      endpoint_url: `https://${subdomain}.port4.dev/mcp`,
      upstream_signing_secret: upstreamSigningSecret,
      verification: {
        token: verificationToken,
        well_known_url: `${upstreamBaseUrl}/.well-known/port4-verification.txt`
      }
    },
    201
  );
});

/**
 * Verify tenant upstream domain ownership via `/.well-known/port4-verification.txt`
 */
apiRoutes.post("/tenants/:id/verify-upstream", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain, upstream_base_url, verification_token FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string; upstream_base_url: string; verification_token: string | null }>();

  if (!tenant) return c.json({ error: "tenant_not_found" }, 404);
  if (!tenant.verification_token || tenant.upstream_base_url === "internal://sandbox") {
    return c.json({ error: "verification_not_applicable" }, 400);
  }

  try {
    const verifyUrl = `${tenant.upstream_base_url}/.well-known/port4-verification.txt`;
    const res = await fetch(verifyUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
    if (!res.ok) {
      return c.json({ verified: false, error: "verification_file_not_found", status: res.status }, 422);
    }
    const text = (await res.text()).trim();
    const matched = await timingSafeEqualString(text, tenant.verification_token);
    if (!matched) {
      return c.json({ verified: false, error: "verification_token_mismatch" }, 422);
    }
    await c.env.DB.prepare("UPDATE tenants SET upstream_verified = 1, updated_at = datetime('now') WHERE id = ?")
      .bind(tenant.id)
      .run();
    await syncTenantToKv(c.env, tenant.subdomain);
    return c.json({ verified: true, subdomain: tenant.subdomain });
  } catch {
    return c.json({ verified: false, error: "upstream_unreachable" }, 502);
  }
});

/**
 * Rotate per-tenant HMAC upstream signing secret
 */
apiRoutes.post("/tenants/:id/rotate-secret", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!tenant) return c.json({ error: "tenant_not_found" }, 404);

  const newSecret = `p4_whsec_${randomHex(24)}`;
  await c.env.DB.prepare(
    "UPDATE tenants SET upstream_signing_secret = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(newSecret, tenant.id)
    .run();
  await syncTenantToKv(c.env, tenant.subdomain);
  return c.json({ ok: true, upstream_signing_secret: newSecret });
});

/**
 * In-place endpoint update (name, upstream_base_url, payout_wallet, network)
 */
apiRoutes.patch("/tenants/:id", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const existing = await c.env.DB.prepare(
    `SELECT id, subdomain, name, upstream_base_url, payout_wallet, payout_wallets_json, network,
            auth_mode, COALESCE(mcp_mode, 'direct') AS mcp_mode,
            COALESCE(codemode_price_usd, '0.01') AS codemode_price_usd,
            COALESCE(codemode_max_subcalls, 10) AS codemode_max_subcalls,
            COALESCE(require_upstream_verified, 0) AS require_upstream_verified,
            COALESCE(require_visa_tap, 0) AS require_visa_tap,
            COALESCE(allow_tap_simulated, 0) AS allow_tap_simulated,
            COALESCE(upstream_auth_type, 'none') AS upstream_auth_type,
            upstream_auth_header, upstream_auth_secret,
            cf_access_team_domain, cf_access_aud
     FROM tenants WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`
  )
    .bind(tenantId, user.id)
    .first<{
      id: string;
      subdomain: string;
      name: string;
      upstream_base_url: string;
      payout_wallet: string;
      payout_wallets_json: string | null;
      network: string;
      auth_mode: "x402" | "x402+oauth_v2";
      mcp_mode: "direct" | "codemode" | "openapi_codemode";
      codemode_price_usd: string;
      codemode_max_subcalls: number;
      require_upstream_verified: number;
      require_visa_tap: number;
      allow_tap_simulated: number;
      upstream_auth_type: "none" | "bearer" | "api_key_header";
      upstream_auth_header: string | null;
      upstream_auth_secret: string | null;
      cf_access_team_domain: string | null;
      cf_access_aud: string | null;
    }>();

  if (!existing) return c.json({ error: "tenant_not_found" }, 404);

  let body: {
    name?: string;
    upstream_base_url?: string;
    payout_wallet?: string;
    payout_wallets?: PayoutWalletEntry[];
    network?: string;
    auth_mode?: "x402" | "x402+oauth_v2";
    mcp_mode?: "direct" | "codemode" | "openapi_codemode";
    codemode_price_usd?: string;
    codemode_max_subcalls?: number;
    require_upstream_verified?: boolean | number;
    require_visa_tap?: boolean | number;
    allow_tap_simulated?: boolean | number;
    upstream_auth_type?: "none" | "bearer" | "api_key_header";
    upstream_auth_header?: string | null;
    upstream_auth_secret?: string | null;
    cf_access_team_domain?: string | null;
    cf_access_aud?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const nextName = body.name !== undefined ? body.name.trim() : existing.name;
  if (!nextName || nextName.length > 128) return c.json({ error: "invalid_name" }, 400);

  let nextUpstream = existing.upstream_base_url;
  if (body.upstream_base_url !== undefined) {
    const validated = validateUpstreamBaseUrl(body.upstream_base_url.trim());
    if (!validated) {
      return c.json(
        { error: "invalid_upstream_url", message: "Upstream URL must be a public HTTPS origin." },
        400
      );
    }
    nextUpstream = validated;
  }

  let nextNetwork = existing.network;
  if (body.network !== undefined) {
    if (!isSupportedNetwork(body.network.trim())) {
      return c.json(
        { error: "invalid_network", message: `Unsupported settlement network '${body.network}'.` },
        400
      );
    }
    nextNetwork = body.network.trim();
  }

  let nextWallet = existing.payout_wallet;
  if (body.payout_wallet !== undefined) {
    nextWallet = body.payout_wallet.trim();
  }
  if (!isValidWalletForNetwork(nextNetwork, nextWallet)) {
    return c.json(
      {
        error: "invalid_payout_wallet",
        message: nextNetwork.startsWith("solana:")
          ? "Payout wallet must be a valid Solana Base58 address."
          : "Payout wallet must be a valid 0x EVM address."
      },
      400
    );
  }

  let nextPayoutWallets: PayoutWalletEntry[];
  if (body.payout_wallets !== undefined) {
    if (!Array.isArray(body.payout_wallets) || body.payout_wallets.length > 10) {
      return c.json({ error: "invalid_payout_wallets", message: "Up to 10 payout wallets are allowed." }, 400);
    }
    for (const entry of body.payout_wallets) {
      if (!entry || typeof entry.network !== "string" || typeof entry.address !== "string" || !isValidWalletForNetwork(entry.network, entry.address)) {
        return c.json(
          { error: "invalid_payout_wallets", message: `Invalid wallet address for network '${entry?.network ?? "unknown"}'.` },
          400
        );
      }
    }
    nextPayoutWallets = normalizePayoutWallets(nextNetwork, nextWallet, body.payout_wallets);
  } else {
    const existingExtras = parsePayoutWalletsJson(
      existing.payout_wallets_json,
      existing.network,
      existing.payout_wallet
    ).filter((w) => w.network !== existing.network && w.network !== nextNetwork);
    nextPayoutWallets = normalizePayoutWallets(nextNetwork, nextWallet, existingExtras);
  }

  let nextMcpMode = existing.mcp_mode;
  if (body.mcp_mode !== undefined) {
    if (!MCP_MODES.has(body.mcp_mode)) {
      return c.json({ error: "invalid_mcp_mode", message: "Supported modes: direct, codemode, openapi_codemode." }, 400);
    }
    nextMcpMode = body.mcp_mode;
  }

  let nextCodePrice = existing.codemode_price_usd;
  if (body.codemode_price_usd !== undefined) {
    const cleaned = body.codemode_price_usd.replace(/^\$/, "").trim();
    try {
      usdToAtomicUsdc(cleaned);
    } catch {
      return c.json({ error: "invalid_codemode_price" }, 400);
    }
    nextCodePrice = cleaned;
  }

  const nextMaxSubcalls =
    body.codemode_max_subcalls !== undefined
      ? Math.min(50, Math.max(1, Math.floor(Number(body.codemode_max_subcalls) || 10)))
      : existing.codemode_max_subcalls;

  let nextAuthMode = existing.auth_mode;
  let nextAccessDomain = existing.cf_access_team_domain;
  let nextAccessAud = existing.cf_access_aud;

  if (body.auth_mode !== undefined) {
    nextAuthMode = body.auth_mode === "x402+oauth_v2" ? "x402+oauth_v2" : "x402";
  }
  if (body.cf_access_team_domain !== undefined) {
    nextAccessDomain = body.cf_access_team_domain
      ? normalizeAccessTeamDomain(body.cf_access_team_domain)
      : null;
    if (body.cf_access_team_domain && !nextAccessDomain) {
      return c.json({ error: "invalid_cf_access_team_domain", message: "Use <team>.cloudflareaccess.com" }, 400);
    }
  }
  if (body.cf_access_aud !== undefined) {
    nextAccessAud = body.cf_access_aud ? body.cf_access_aud.trim() : null;
  }
  if (nextAuthMode === "x402+oauth_v2" && (!nextAccessDomain || !nextAccessAud || nextAccessAud.length < 16)) {
    return c.json(
      {
        error: "invalid_cloudflare_access_config",
        message: "Cloudflare Access requires both <team>.cloudflareaccess.com and an AUD tag."
      },
      400
    );
  }

  let nextUpstreamAuthType = existing.upstream_auth_type;
  if (body.upstream_auth_type !== undefined) {
    if (!UPSTREAM_AUTH_TYPES.has(body.upstream_auth_type)) {
      return c.json({ error: "invalid_upstream_auth_type" }, 400);
    }
    nextUpstreamAuthType = body.upstream_auth_type;
  }

  let nextUpstreamAuthHeader =
    body.upstream_auth_header !== undefined
      ? body.upstream_auth_header
        ? body.upstream_auth_header.trim()
        : null
      : existing.upstream_auth_header;

  if (nextUpstreamAuthType === "api_key_header") {
    if (!nextUpstreamAuthHeader || !isValidCustomAuthHeaderName(nextUpstreamAuthHeader)) {
      return c.json(
        {
          error: "invalid_upstream_auth_header",
          message: "Custom auth header must be 2-64 alphanumeric/hyphen chars and not a reserved header."
        },
        400
      );
    }
  } else if (nextUpstreamAuthType === "none") {
    nextUpstreamAuthHeader = null;
  }

  let nextUpstreamAuthSecret = existing.upstream_auth_secret;
  if (nextUpstreamAuthType === "none") {
    nextUpstreamAuthSecret = null;
  } else if (body.upstream_auth_secret !== undefined) {
    const trimmedSecret = body.upstream_auth_secret ? body.upstream_auth_secret.trim() : "";
    if (trimmedSecret.length > 0) {
      nextUpstreamAuthSecret = await encryptSecretAtRest(
        trimmedSecret.slice(0, 512),
        c.env.JWT_SECRET
      );
    }
  }

  const nextRequireVerified =
    body.require_upstream_verified !== undefined
      ? body.require_upstream_verified === true || body.require_upstream_verified === 1
        ? 1
        : 0
      : existing.require_upstream_verified;

  const nextRequireVisaTap =
    body.require_visa_tap !== undefined
      ? body.require_visa_tap === true || body.require_visa_tap === 1
        ? 1
        : 0
      : existing.require_visa_tap;

  const nextAllowTapSimulated =
    body.allow_tap_simulated !== undefined
      ? body.allow_tap_simulated === true || body.allow_tap_simulated === 1
        ? 1
        : 0
      : existing.allow_tap_simulated;

  await c.env.DB.prepare(
    `UPDATE tenants
     SET name = ?, upstream_base_url = ?, payout_wallet = ?, payout_wallets_json = ?, network = ?,
         auth_mode = ?, mcp_mode = ?, codemode_price_usd = ?, codemode_max_subcalls = ?,
         require_upstream_verified = ?, require_visa_tap = ?, allow_tap_simulated = ?,
         upstream_auth_type = ?, upstream_auth_header = ?, upstream_auth_secret = ?,
         cf_access_team_domain = ?, cf_access_aud = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      nextName,
      nextUpstream,
      nextWallet,
      JSON.stringify(nextPayoutWallets),
      nextNetwork,
      nextAuthMode,
      nextMcpMode,
      nextCodePrice,
      nextMaxSubcalls,
      nextRequireVerified,
      nextRequireVisaTap,
      nextAllowTapSimulated,
      nextUpstreamAuthType,
      nextUpstreamAuthHeader,
      nextUpstreamAuthSecret,
      nextAccessDomain,
      nextAccessAud,
      existing.id
    )
    .run();

  const synced = await syncTenantToKv(c.env, existing.subdomain);
  return c.json({
    ok: true,
    tenant: synced
      ? { ...synced, upstream_signing_secret: undefined, upstream_auth_secret: undefined }
      : null
  });
});

/**
 * Import an OpenAPI 3.x JSON spec (inline `spec` or public HTTPS `spec_url`) into Port4 tools,
 * and optionally enable Code Mode (`codemode` or `openapi_codemode`) in one click.
 */
apiRoutes.post("/tenants/:id/import-openapi", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!tenant) return c.json({ error: "tenant_not_found" }, 404);

  let body: {
    spec?: unknown;
    spec_url?: string;
    default_price_usd?: string;
    mcp_mode?: "direct" | "codemode" | "openapi_codemode";
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  let rawSpec: unknown = body.spec;
  if (!rawSpec && body.spec_url) {
    const validatedUrl = validateUpstreamBaseUrl(body.spec_url.trim());
    if (!validatedUrl || validatedUrl === "internal://sandbox") {
      return c.json({ error: "invalid_spec_url", message: "OpenAPI spec URL must be a public HTTPS URL." }, 400);
    }
    try {
      const res = await fetch(validatedUrl, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) {
        return c.json({ error: "spec_fetch_failed", status: res.status }, 502);
      }
      rawSpec = await res.json();
    } catch {
      return c.json({ error: "spec_fetch_failed", message: "Unable to fetch OpenAPI JSON from URL." }, 502);
    }
  }

  let imported;
  try {
    imported = parseOpenApiSpecToTools(rawSpec, 100);
  } catch (err) {
    return c.json(
      { error: "invalid_openapi_spec", message: err instanceof Error ? err.message : "Invalid OpenAPI JSON." },
      400
    );
  }

  if (imported.length === 0) {
    return c.json({ error: "no_operations_found", message: "No GET/POST/PUT/DELETE paths found in OpenAPI spec." }, 400);
  }

  const defaultPrice = (body.default_price_usd ?? "0.005").replace(/^\$/, "").trim();
  let priceAtomic: string;
  try {
    priceAtomic = usdToAtomicUsdc(defaultPrice);
  } catch {
    return c.json({ error: "invalid_price" }, 400);
  }

  const existingTools = await c.env.DB.prepare("SELECT name FROM tools WHERE tenant_id = ?")
    .bind(tenant.id)
    .all<{ name: string }>();
  const existingNames = new Set((existingTools.results ?? []).map((t) => t.name));

  let added = 0;
  const statements: D1PreparedStatement[] = [];
  for (const item of imported) {
    if (existingNames.has(item.name)) continue;
    existingNames.add(item.name);
    const toolId = `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        toolId,
        tenant.id,
        item.name,
        item.description,
        item.http_method,
        item.upstream_path,
        item.input_schema_json,
        defaultPrice,
        priceAtomic
      )
    );
    added += 1;
  }

  if (body.mcp_mode && MCP_MODES.has(body.mcp_mode)) {
    statements.push(
      c.env.DB.prepare("UPDATE tenants SET mcp_mode = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(body.mcp_mode, tenant.id)
    );
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  await syncTenantToKv(c.env, tenant.subdomain);
  return c.json({
    ok: true,
    imported_count: added,
    total_spec_operations: imported.length,
    mcp_mode: body.mcp_mode ?? undefined
  });
});

/**
 * In-place tool editor (name, description, http_method, upstream_path, price_usd, input_schema_json)
 */
apiRoutes.patch("/tenants/:id/tools/:toolId", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const toolId = c.req.param("toolId");

  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!tenant) return c.json({ error: "tenant_not_found" }, 404);

  const existingTool = await c.env.DB.prepare(
    "SELECT id, name, description, http_method, upstream_path, input_schema_json, price_usd FROM tools WHERE id = ? AND tenant_id = ? LIMIT 1"
  )
    .bind(toolId, tenantId)
    .first<ToolRecord>();

  if (!existingTool) return c.json({ error: "tool_not_found" }, 404);

  let body: {
    name?: string;
    description?: string;
    http_method?: string;
    upstream_path?: string;
    price_usd?: string;
    input_schema_json?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const validated = validateToolDefinition({
    name: body.name ?? existingTool.name,
    description: body.description ?? existingTool.description,
    http_method: body.http_method ?? existingTool.http_method,
    upstream_path: body.upstream_path ?? existingTool.upstream_path,
    price_usd: body.price_usd ?? existingTool.price_usd,
    input_schema_json: body.input_schema_json ?? existingTool.input_schema_json
  });
  if ("error" in validated) return c.json({ error: validated.error }, 400);

  await c.env.DB.prepare(
    `UPDATE tools
     SET name = ?, description = ?, http_method = ?, upstream_path = ?, input_schema_json = ?, price_usd = ?, price_atomic = ?
     WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      validated.value.name,
      validated.value.description,
      validated.value.http_method,
      validated.value.upstream_path,
      validated.value.input_schema_json,
      validated.value.price_usd,
      validated.value.price_atomic,
      toolId,
      tenantId
    )
    .run();

  const synced = await syncTenantToKv(c.env, tenant.subdomain);
  return c.json({
    ok: true,
    tenant: synced ? { ...synced, upstream_signing_secret: undefined } : null
  });
});

/**
 * Authenticated Owner Live `tools/call` Sandbox:
 * Fires a signed test call to the tenant's upstream and returns HTTP status, latency, and JSON response.
 */
apiRoutes.post("/tenants/:id/test-call", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const tenant = await c.env.DB.prepare(
    `SELECT id, subdomain, upstream_base_url, upstream_signing_secret,
            COALESCE(upstream_auth_type, 'none') AS upstream_auth_type,
            upstream_auth_header, upstream_auth_secret
     FROM tenants WHERE id = ? AND user_id = ? LIMIT 1`
  )
    .bind(tenantId, user.id)
    .first<{
      id: string;
      subdomain: string;
      upstream_base_url: string;
      upstream_signing_secret: string | null;
      upstream_auth_type: "none" | "bearer" | "api_key_header";
      upstream_auth_header: string | null;
      upstream_auth_secret: string | null;
    }>();

  if (!tenant) return c.json({ error: "tenant_not_found" }, 404);

  let body: { tool_name?: string; arguments?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const tool = await c.env.DB.prepare(
    "SELECT id, name, http_method, upstream_path FROM tools WHERE tenant_id = ? AND name = ? AND is_active = 1 LIMIT 1"
  )
    .bind(tenant.id, (body.tool_name ?? "").trim())
    .first<Pick<ToolRecord, "id" | "name" | "http_method" | "upstream_path">>();

  if (!tool) return c.json({ error: "tool_not_found" }, 404);

  const startedAt = Date.now();
  const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};

  if ( tenant.upstream_base_url === "internal://sandbox") {
    const colo = (c.req.raw.cf as { colo?: string } | undefined)?.colo ?? "EDGE";
    return c.json({
      ok: true,
      status: 200,
      latency_ms: Math.max(1, Date.now() - startedAt),
      url: `internal://sandbox${tool.upstream_path}`,
      response: executeInternalSandboxTool(tool.name, args, colo)
    });
  }

  const { resolvedPath, remainingArgs } = interpolateUpstreamPath(tool.upstream_path, args);
  const targetUrl = new URL(resolvedPath, `${tenant.upstream_base_url}/`);
  const requestId = `test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Port4-Tenant": tenant.subdomain,
    "X-Port4-Tool": tool.name,
    "X-Port4-Payer": "owner-test-sandbox",
    "X-Port4-Request-Id": requestId,
    "Idempotency-Key": requestId,
    "X-Port4-Test": "true"
  };

  if (tenant.upstream_auth_secret && tenant.upstream_auth_type !== "none") {
    const decryptedSecret = await decryptSecretAtRest(tenant.upstream_auth_secret, c.env.JWT_SECRET);
    if (tenant.upstream_auth_type === "bearer") {
      headers["Authorization"] = `Bearer ${decryptedSecret}`;
    } else if (
      tenant.upstream_auth_type === "api_key_header" &&
      tenant.upstream_auth_header &&
      isValidCustomAuthHeaderName(tenant.upstream_auth_header)
    ) {
      headers[tenant.upstream_auth_header.trim()] = decryptedSecret;
    }
  }

  let serializedBody = "";
  if (tool.http_method === "GET" || tool.http_method === "DELETE") {
    for (const [k, v] of Object.entries(remainingArgs)) {
      if (v !== undefined && v !== null) targetUrl.searchParams.set(k, String(v));
    }
  } else {
    serializedBody = JSON.stringify(remainingArgs);
  }

  if (tenant.upstream_signing_secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = await sha256Hex(serializedBody);
    const sig = await hmacSha256Hex(
      tenant.upstream_signing_secret,
      `${timestamp}.${tenant.subdomain}.${tool.name}.${requestId}.${bodyHash}`
    );
    headers["X-Port4-Timestamp"] = timestamp;
    headers["X-Port4-Signature"] = `v1=${sig}`;
  }

  try {
    const res = await fetch(targetUrl.toString(), {
      method: tool.http_method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      ...(tool.http_method === "GET" || tool.http_method === "DELETE" ? {} : { body: serializedBody })
    });
    const text = (await res.text()).slice(0, 16_384);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }
    return c.json({
      ok: res.ok,
      status: res.status,
      latency_ms: Math.max(1, Date.now() - startedAt),
      url: targetUrl.toString(),
      method: tool.http_method,
      response: parsed
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        status: 502,
        latency_ms: Math.max(1, Date.now() - startedAt),
        url: targetUrl.toString(),
        error: err instanceof Error ? err.message : "Upstream unreachable"
      },
      502
    );
  }
});

/**
 * Native MCP-to-MCP Sync: imports tools/list (name, description, inputSchema) from an existing MCP server
 */
apiRoutes.post("/tenants/:id/sync-mcp", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain, upstream_base_url FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string; upstream_base_url: string }>();

  if (!tenant) return c.json({ error: "tenant_not_found" }, 404);
  if (tenant.upstream_base_url === "internal://sandbox") {
    return c.json({ error: "not_applicable_to_sandbox" }, 400);
  }

  let defaultPriceUsd = "0.005";
  let mcpPath = "/mcp";
  try {
    const body = (await c.req.json()) as { default_price_usd?: string; mcp_path?: string };
    if (body.default_price_usd) defaultPriceUsd = body.default_price_usd.replace(/^\$/, "").trim();
    if (body.mcp_path && body.mcp_path.startsWith("/")) mcpPath = body.mcp_path;
  } catch {
    // defaults
  }

  const targetUrl = new URL(mcpPath, `${tenant.upstream_base_url}/`);
  try {
    const res = await fetch(targetUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      return c.json({ error: "upstream_mcp_error", status: res.status }, 502);
    }
    const json = (await res.json()) as {
      result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> };
    };
    const tools = json.result?.tools ?? [];
    let imported = 0;
    const priceAtomic = usdToAtomicUsdc(defaultPriceUsd);

    const existingToolsRes = await c.env.DB.prepare(
      "SELECT id, name FROM tools WHERE tenant_id = ?"
    )
      .bind(tenant.id)
      .all<{ id: string; name: string }>();
    const existingByName = new Map<string, string>(
      (existingToolsRes.results ?? []).map((row) => [row.name, row.id])
    );

    for (const t of tools.slice(0, 50)) {
      if (!t.name || !TOOL_NAME_RE.test(t.name)) continue;
      const schemaStr = JSON.stringify(t.inputSchema ?? { type: "object", properties: {} });
      const desc = (t.description ?? `MCP tool ${t.name}`).slice(0, 1024);
      const existingId = existingByName.get(t.name);

      if (existingId) {
        // Update description, schema, and remote MCP adapter binding while preserving custom tool price
        await c.env.DB.prepare(
          `UPDATE tools
           SET description = ?, upstream_path = ?, input_schema_json = ?, source_type = 'mcp', remote_tool_name = ?
           WHERE id = ? AND tenant_id = ?`
        )
          .bind(desc, mcpPath, schemaStr, t.name, existingId, tenant.id)
          .run();
      } else {
        const toolId = `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await c.env.DB.prepare(
          `INSERT INTO tools
           (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, source_type, remote_tool_name)
           VALUES (?, ?, ?, ?, 'POST', ?, ?, ?, ?, 'mcp', ?)`
        )
          .bind(toolId, tenant.id, t.name, desc, mcpPath, schemaStr, defaultPriceUsd, priceAtomic, t.name)
          .run();
      }
      imported += 1;
    }
    await syncTenantToKv(c.env, tenant.subdomain);
    return c.json({ ok: true, imported, source_type: "mcp" });
  } catch {
    return c.json({ error: "upstream_mcp_unreachable" }, 502);
  }
});

apiRoutes.delete("/tenants/:id", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");

  const existing = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }
  if (existing.subdomain === "demo") {
    return c.json({ error: "cannot_delete_demo_tenant" }, 400);
  }

  // Soft-archive tenant so immutable financial history in `transactions` and `usage_rollups` is NEVER cascade-deleted
  const archivedSlug = `${existing.subdomain}__archived_${existing.id.slice(-6)}`;
  const auditId = `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenants
       SET status = 'archived', is_active = 0, deleted_at = datetime('now'), subdomain = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).bind(archivedSlug, tenantId, user.id),
    c.env.DB.prepare("UPDATE tools SET is_active = 0 WHERE tenant_id = ?").bind(tenantId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json)
       VALUES (?, ?, 'tenant.archived', 'tenant', ?, ?)`
    ).bind(auditId, user.id, tenantId, JSON.stringify({ original_subdomain: existing.subdomain }))
  ]);

  await invalidateTenantKv(c.env, existing.subdomain);
  return c.json({ ok: true, archived: true });
});

apiRoutes.post("/tenants/:id/tools", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");

  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!tenant) {
    return c.json({ error: "tenant_not_found" }, 404);
  }

  let body: {
    name?: string;
    description?: string;
    http_method?: "GET" | "POST" | "PUT" | "DELETE";
    upstream_path?: string;
    price_usd?: string;
    input_schema_json?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const validatedTool = validateToolDefinition(body);
  if ("error" in validatedTool) return c.json({ error: validatedTool.error }, 400);
  const toolId = `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  await c.env.DB.prepare(
    `INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      toolId,
      tenantId,
      validatedTool.value.name,
      validatedTool.value.description || `Paid MCP tool ${validatedTool.value.name}`,
      validatedTool.value.http_method,
      validatedTool.value.upstream_path,
      validatedTool.value.input_schema_json,
      validatedTool.value.price_usd,
      validatedTool.value.price_atomic
    )
    .run();

  const synced = await syncTenantToKv(c.env, tenant.subdomain);
  return c.json({ tool_id: toolId, tenant: synced }, 201);
});

apiRoutes.delete("/tenants/:id/tools/:toolId", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");
  const toolId = c.req.param("toolId");

  const tenant = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!tenant) {
    return c.json({ error: "tenant_not_found" }, 404);
  }

  await c.env.DB.prepare("DELETE FROM tools WHERE id = ? AND tenant_id = ?")
    .bind(toolId, tenantId)
    .run();

  await syncTenantToKv(c.env, tenant.subdomain);
  return c.json({ ok: true });
});

apiRoutes.get("/ledger", async (c) => {
  const user = c.get("user")!;
  const [rollupSummary, txRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(r.call_count), 0) AS total_calls,
              COALESCE(SUM(r.gross_atomic), 0) AS total_atomic,
              COALESCE(SUM(r.gross_usd), 0) AS total_usd,
              COALESCE(SUM(r.total_latency_ms), 0) AS total_latency_ms
       FROM usage_rollups r
       INNER JOIN tenants t ON t.id = r.tenant_id
       WHERE t.user_id = ?`
    )
      .bind(user.id)
      .first<{ total_calls: number; total_atomic: number; total_usd: number; total_latency_ms: number }>(),
    c.env.DB.prepare(
      `SELECT tx.id, tx.tenant_id, t.subdomain AS tenant_subdomain, tx.tool_name, tx.payer_wallet,
              tx.amount_atomic, tx.amount_usd, tx.network, tx.tx_hash, tx.status, tx.latency_ms, tx.created_at
       FROM transactions tx
       INNER JOIN tenants t ON t.id = tx.tenant_id
       WHERE t.user_id = ?
       ORDER BY tx.created_at DESC
       LIMIT 100`
    )
      .bind(user.id)
      .all<TransactionRecord>()
  ]);

  const rawTransactions = txRes.results ?? [];
  const transactions = rawTransactions.map((tx) => {
    const net = getSupportedNetwork(tx.network);
    const explorerUrl =
      tx.status === "sandbox_settled" || !net
        ? null
        : `${net.explorerTxPrefix}${tx.tx_hash}`;
    return {
      ...tx,
      explorer_url: explorerUrl
    };
  });

  const rollupCalls = Number(rollupSummary?.total_calls ?? 0);
  const rollupAtomic = Number(rollupSummary?.total_atomic ?? 0);
  const txAtomic = rawTransactions.reduce((sum, tx) => sum + Number(tx.amount_atomic || 0), 0);
  const totalCalls = Math.max(rollupCalls, transactions.length);
  const resolvedAtomic = rollupAtomic > 0 ? rollupAtomic : txAtomic;
  const totalUsd = (resolvedAtomic / 1_000_000).toFixed(4);
  const avgLatencyMs =
    rollupCalls > 0
      ? Math.round(Number(rollupSummary?.total_latency_ms ?? 0) / rollupCalls)
      : transactions.length > 0
        ? Math.round(transactions.reduce((sum, tx) => sum + tx.latency_ms, 0) / transactions.length)
        : 0;

  return c.json({
    summary: {
      total_calls: totalCalls,
      total_atomic: String(resolvedAtomic),
      total_usd: totalUsd,
      avg_latency_ms: avgLatencyMs
    },
    transactions
  });
});

apiRoutes.get("/keys", async (c) => {
  const user = c.get("user")!;
  const res = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, COALESCE(scopes, 'tenant:read,tenant:write') AS scopes,
            expires_at, created_at, last_used_at
     FROM api_keys
     WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all();

  return c.json({ keys: res.results ?? [] });
});

apiRoutes.post("/keys", async (c) => {
  const user = c.get("user")!;
  let name = "CLI Deploy Key";
  let scopes = "tenant:read,tenant:write";
  let expiresAt: string | null = null;
  try {
    const body = (await c.req.json()) as {
      name?: string;
      scopes?: string[];
      expires_in_days?: number;
    };
    if (body.name && body.name.trim()) {
      name = body.name.trim().slice(0, 64);
    }
    if (Array.isArray(body.scopes) && body.scopes.length > 0) {
      const allowedScopes = new Set(["tenant:read", "tenant:write", "ledger:read"]);
      const filtered = body.scopes.filter((s) => allowedScopes.has(s));
      if (filtered.length > 0) scopes = filtered.join(",");
    }
    if (typeof body.expires_in_days === "number" && body.expires_in_days >= 1 && body.expires_in_days <= 365) {
      expiresAt = new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString();
    }
  } catch {
    // Use default name
  }

  const rawSecret = `p4_live_${randomHex(24)}`;
  const keyPrefix = rawSecret.slice(0, 14);
  const keyHash = await sha256Hex(rawSecret);
  const id = `key_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  await c.env.DB.prepare(
    "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, name, keyPrefix, keyHash, scopes, expiresAt)
    .run();

  return c.json(
    {
      id,
      name,
      key_prefix: keyPrefix,
      scopes,
      expires_at: expiresAt,
      secret: rawSecret // Returned once at creation
    },
    201
  );
});

apiRoutes.delete("/keys/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .run();
  return c.json({ ok: true, revoked: true });
});
