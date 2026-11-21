import { Hono } from "hono";
import type { AppEnv, TenantRecord, ToolRecord, TransactionRecord } from "../types";
import { requireAuth } from "../middleware/auth";
import { invalidateTenantKv, syncTenantToKv } from "../lib/kv-sync";
import { randomHex, sha256Hex, usdToAtomicUsdc } from "../lib/crypto";

const RESERVED_SUBDOMAINS = new Set(["www", "api", "app", "admin", "auth", "status", "docs"]);
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
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
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname) ||
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
    `SELECT id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, auth_mode, is_active, created_at, updated_at
     FROM tenants
     WHERE user_id = ?
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
    network?: string;
    auth_mode?: "x402" | "x402+oauth_v2";
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

  const payoutWallet = (body.payout_wallet ?? "").trim();
  if (!WALLET_RE.test(payoutWallet)) {
    return c.json(
      { error: "invalid_payout_wallet", message: "Payout wallet must be a valid 0x EVM address." },
      400
    );
  }

  const network = body.network || c.env.X402_NETWORK;
  const authMode = body.auth_mode === "x402+oauth_v2" ? "x402+oauth_v2" : "x402";
  const tenantId = `ten_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, auth_mode, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(tenantId, user.id, subdomain, name, upstreamBaseUrl, payoutWallet, network, authMode)
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
      tenant: synced,
      endpoint_url: `https://${subdomain}.port4.dev/mcp`
    },
    201
  );
});

apiRoutes.delete("/tenants/:id", async (c) => {
  const user = c.get("user")!;
  const tenantId = c.req.param("id");

  const existing = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(tenantId, user.id)
    .first<{ id: string; subdomain: string }>();

  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }
  if (existing.subdomain === "demo") {
    return c.json({ error: "cannot_delete_demo_tenant" }, 400);
  }

  await c.env.DB.prepare("DELETE FROM tenants WHERE id = ? AND user_id = ?")
    .bind(tenantId, user.id)
    .run();

  await invalidateTenantKv(c.env, existing.subdomain);
  return c.json({ ok: true });
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
  const txRes = await c.env.DB.prepare(
    `SELECT tx.id, tx.tenant_id, t.subdomain AS tenant_subdomain, tx.tool_name, tx.payer_wallet,
            tx.amount_atomic, tx.amount_usd, tx.network, tx.tx_hash, tx.status, tx.latency_ms, tx.created_at
     FROM transactions tx
     INNER JOIN tenants t ON t.id = tx.tenant_id
     WHERE t.user_id = ?
     ORDER BY tx.created_at DESC
     LIMIT 100`
  )
    .bind(user.id)
    .all<TransactionRecord>();

  const transactions = txRes.results ?? [];
  const totalAtomic = transactions.reduce((sum, tx) => sum + Number(tx.amount_atomic || 0), 0);
  const avgLatencyMs =
    transactions.length > 0
      ? Math.round(transactions.reduce((sum, tx) => sum + tx.latency_ms, 0) / transactions.length)
      : 0;

  return c.json({
    summary: {
      total_calls: transactions.length,
      total_usd: (totalAtomic / 1_000_000).toFixed(4),
      avg_latency_ms: avgLatencyMs
    },
    transactions
  });
});

apiRoutes.get("/keys", async (c) => {
  const user = c.get("user")!;
  const res = await c.env.DB.prepare(
    "SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all();

  return c.json({ keys: res.results ?? [] });
});

apiRoutes.post("/keys", async (c) => {
  const user = c.get("user")!;
  let name = "CLI Deploy Key";
  try {
    const body = (await c.req.json()) as { name?: string };
    if (body.name && body.name.trim()) {
      name = body.name.trim().slice(0, 64);
    }
  } catch {
    // Use default name
  }

  const rawSecret = `p4_live_${randomHex(24)}`;
  const keyPrefix = rawSecret.slice(0, 14);
  const keyHash = await sha256Hex(rawSecret);
  const id = `key_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  await c.env.DB.prepare(
    "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, name, keyPrefix, keyHash)
    .run();

  return c.json(
    {
      id,
      name,
      key_prefix: keyPrefix,
      secret: rawSecret // Returned once at creation
    },
    201
  );
});

apiRoutes.delete("/keys/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .run();
  return c.json({ ok: true });
});
