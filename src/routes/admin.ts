import { Hono } from "hono";
import type { AppEnv, TenantStatus, UserPlan } from "../types";
import { requireAdmin } from "./auth";
import { invalidateTenantKv, syncTenantToKv, syncUserTenantsToKv } from "../lib/kv-sync";

export const adminRoutes = new Hono<AppEnv>();

// Every /api/admin/* endpoint re-verifies JWT + D1 is_admin === 1
adminRoutes.use("*", requireAdmin);

/**
 * 1. Global Platform Telemetry
 */
adminRoutes.get("/stats", async (c) => {
  const [usersRow, tenantsRow, txRow] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS total_users FROM users").first<{ total_users: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_tenants,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_tenants,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended_tenants,
              SUM(CASE WHEN is_featured = 1 THEN 1 ELSE 0 END) AS featured_tenants
       FROM tenants`
    ).first<{
      total_tenants: number;
      active_tenants: number | null;
      suspended_tenants: number | null;
      featured_tenants: number | null;
    }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_transactions,
              COALESCE(SUM(CAST(amount_usd AS REAL)), 0) AS gross_usdc_volume,
              COALESCE(SUM(CASE WHEN is_platform_fee = 1 THEN CAST(amount_usd AS REAL) ELSE 0 END), 0) AS net_platform_revenue,
              COALESCE(SUM(CASE WHEN is_platform_fee = 1 THEN 1 ELSE 0 END), 0) AS platform_fee_calls
       FROM transactions`
    ).first<{
      total_transactions: number;
      gross_usdc_volume: number;
      net_platform_revenue: number;
      platform_fee_calls: number;
    }>()
  ]);

  return c.json({
    total_users: usersRow?.total_users ?? 0,
    total_tenants: tenantsRow?.total_tenants ?? 0,
    active_tenants: tenantsRow?.active_tenants ?? 0,
    suspended_tenants: tenantsRow?.suspended_tenants ?? 0,
    featured_tenants: tenantsRow?.featured_tenants ?? 0,
    total_transactions: txRow?.total_transactions ?? 0,
    gross_usdc_volume: Number(txRow?.gross_usdc_volume ?? 0).toFixed(4),
    net_platform_revenue: Number(txRow?.net_platform_revenue ?? 0).toFixed(4),
    platform_fee_calls: txRow?.platform_fee_calls ?? 0
  });
});

/**
 * 2. Tenant Governance Table (searchable & filterable)
 */
adminRoutes.get("/tenants", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const statusFilter = (c.req.query("status") ?? "").trim().toLowerCase();

  const res = await c.env.DB.prepare(
    `SELECT t.id, t.subdomain AS slug, t.name, t.upstream_base_url, t.payout_wallet,
            t.network, t.status, t.is_featured, t.call_count, t.created_at,
            u.id AS owner_id, u.login AS owner_login, COALESCE(u.plan, 'free') AS owner_plan,
            COUNT(tx.id) AS total_calls,
            COALESCE(SUM(CAST(tx.amount_usd AS REAL)), 0) AS total_revenue_usd
     FROM tenants t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN transactions tx ON tx.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC`
  ).all<{
    id: string;
    slug: string;
    name: string;
    upstream_base_url: string;
    payout_wallet: string;
    network: string;
    status: TenantStatus;
    is_featured: number;
    call_count: number;
    created_at: string;
    owner_id: string;
    owner_login: string;
    owner_plan: UserPlan;
    total_calls: number;
    total_revenue_usd: number;
  }>();

  let tenants = (res.results ?? []).map((row) => ({
    ...row,
    total_revenue_usd: Number(row.total_revenue_usd ?? 0).toFixed(4)
  }));

  if (q) {
    tenants = tenants.filter(
      (t) =>
        t.slug.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.owner_login ?? "").toLowerCase().includes(q)
    );
  }
  if (statusFilter === "active" || statusFilter === "suspended") {
    tenants = tenants.filter((t) => t.status === statusFilter);
  }

  return c.json({ tenants });
});

/**
 * 2b. Instant Edge Kill-Switch
 */
adminRoutes.patch("/tenants/:slug/status", async (c) => {
  const slug = c.req.param("slug").trim().toLowerCase();
  let body: { status?: TenantStatus };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (body.status !== "active" && body.status !== "suspended") {
    return c.json({ error: "invalid_status", message: "Status must be 'active' or 'suspended'." }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE subdomain = ? LIMIT 1"
  )
    .bind(slug)
    .first<{ id: string; subdomain: string }>();

  if (!existing) {
    return c.json({ error: "tenant_not_found" }, 404);
  }

  await c.env.DB.prepare(
    "UPDATE tenants SET status = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(body.status, existing.id)
    .run();

  if (body.status === "suspended") {
    // Instant edge cutoff
    await invalidateTenantKv(c.env, slug);
  } else {
    await syncTenantToKv(c.env, slug);
  }

  console.log(
    JSON.stringify({
      event: "admin_tenant_status_changed",
      admin: c.get("user")?.login,
      slug,
      status: body.status
    })
  );

  return c.json({ ok: true, slug, status: body.status });
});

/**
 * 3. Public Registry Curation (Featured toggle)
 */
adminRoutes.patch("/tenants/:slug/featured", async (c) => {
  const slug = c.req.param("slug").trim().toLowerCase();
  let body: { is_featured?: number | boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const featured = body.is_featured === true || body.is_featured === 1 ? 1 : 0;

  const existing = await c.env.DB.prepare(
    "SELECT id, subdomain FROM tenants WHERE subdomain = ? LIMIT 1"
  )
    .bind(slug)
    .first<{ id: string; subdomain: string }>();

  if (!existing) {
    return c.json({ error: "tenant_not_found" }, 404);
  }

  await c.env.DB.prepare(
    "UPDATE tenants SET is_featured = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(featured, existing.id)
    .run();

  await syncTenantToKv(c.env, slug);

  return c.json({ ok: true, slug, is_featured: featured });
});

/**
 * 4. User Plan & Fee-Tier Management
 */
adminRoutes.get("/users", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT u.id, u.github_id, u.login, u.email, u.is_admin, COALESCE(u.plan, 'free') AS plan, u.created_at,
            COUNT(t.id) AS tenant_count
     FROM users u
     LEFT JOIN tenants t ON t.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC`
  ).all();

  return c.json({ users: res.results ?? [] });
});

adminRoutes.patch("/users/:id/plan", async (c) => {
  const userId = c.req.param("id");
  let body: { plan?: UserPlan };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (body.plan !== "free" && body.plan !== "pro") {
    return c.json({ error: "invalid_plan", message: "Plan must be 'free' or 'pro'." }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id, login FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string; login: string }>();

  if (!existing) {
    return c.json({ error: "user_not_found" }, 404);
  }

  await c.env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(body.plan, userId).run();
  await syncUserTenantsToKv(c.env, userId);

  return c.json({
    ok: true,
    user_id: userId,
    plan: body.plan,
    fee_rate_pct: body.plan === "pro" ? 1 : 3
  });
});

/**
 * 5. Global Live Audit Ledger (latest 100 settled x402 calls across all tenants)
 */
adminRoutes.get("/transactions", async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "100") || 100));
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);

  const res = await c.env.DB.prepare(
    `SELECT tx.id, tx.tenant_id, t.subdomain AS slug, tx.tool_name, tx.payer_wallet,
            tx.amount_atomic, tx.amount_usd, tx.network, tx.tx_hash, tx.status,
            tx.latency_ms, COALESCE(tx.is_platform_fee, 0) AS is_platform_fee, tx.created_at
     FROM transactions tx
     INNER JOIN tenants t ON t.id = tx.tenant_id
     ORDER BY tx.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<{
      id: string;
      tenant_id: string;
      slug: string;
      tool_name: string;
      payer_wallet: string;
      amount_atomic: string;
      amount_usd: string;
      network: string;
      tx_hash: string;
      status: string;
      latency_ms: number;
      is_platform_fee: number;
      created_at: string;
    }>();

  const transactions = (res.results ?? []).map((tx) => ({
    ...tx,
    basescan_url: `https://sepolia.basescan.org/tx/${tx.tx_hash}`
  }));

  return c.json({
    limit,
    offset,
    transactions
  });
});
