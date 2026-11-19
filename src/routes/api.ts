import { Hono } from "hono";
import type { AppEnv, TenantRecord, ToolRecord, TransactionRecord } from "../types";
import { requireAuth } from "../middleware/auth";
import { invalidateTenantKv, syncTenantToKv } from "../lib/kv-sync";
import { randomHex, sha256Hex, usdToAtomicUsdc } from "../lib/crypto";

const RESERVED_SUBDOMAINS = new Set(["www", "api", "app", "admin", "auth", "status", "docs"]);
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

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
  const upstreamBaseUrl = (body.upstream_base_url ?? "").trim();
  if (
    upstreamBaseUrl !== "internal://sandbox" &&
    !/^https?:\/\/.+/.test(upstreamBaseUrl)
  ) {
    return c.json(
      { error: "invalid_upstream_url", message: "Upstream URL must start with https:// or http://." },
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

  if (body.initial_tool && body.initial_tool.name && body.initial_tool.upstream_path) {
    const toolId = `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const priceUsd = body.initial_tool.price_usd.replace(/^\$/, "").trim() || "0.001";
    const priceAtomic = usdToAtomicUsdc(priceUsd);
    await c.env.DB.prepare(
      `INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, price_usd, price_atomic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        toolId,
        tenantId,
        body.initial_tool.name.trim(),
        body.initial_tool.description.trim() || `Paid MCP tool for ${name}`,
        body.initial_tool.http_method ?? "POST",
        body.initial_tool.upstream_path.trim(),
        priceUsd,
        priceAtomic
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

  const toolName = (body.name ?? "").trim();
  const upstreamPath = (body.upstream_path ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(toolName) || !upstreamPath) {
    return c.json({ error: "invalid_tool_definition" }, 400);
  }

  const priceUsd = (body.price_usd ?? "0.001").replace(/^\$/, "").trim();
  const priceAtomic = usdToAtomicUsdc(priceUsd);
  const toolId = `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  await c.env.DB.prepare(
    `INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      toolId,
      tenantId,
      toolName,
      (body.description ?? `Paid MCP tool ${toolName}`).trim(),
      body.http_method ?? "POST",
      upstreamPath,
      body.input_schema_json ?? '{"type":"object","properties":{}}',
      priceUsd,
      priceAtomic
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
