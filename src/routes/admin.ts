import { Hono } from "hono";
import type { AppEnv, TenantStatus, UserPlan } from "../types";
import { requireAdmin } from "./auth";
import { invalidateTenantKv, syncTenantToKv, syncUserTenantsToKv } from "../lib/kv-sync";
import { getSupportedNetwork } from "../lib/networks";

export const adminRoutes = new Hono<AppEnv>();

// Every /api/admin/* endpoint re-verifies JWT + D1 is_admin === 1 (and blocks non-admin API keys)
adminRoutes.use("*", requireAdmin);

/**
 * 1. Global Platform Telemetry (Integer Atomic-Unit Financial Accounting)
 */
adminRoutes.get("/stats", async (c) => {
  const [usersRow, tenantsRow, txRow] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS total_users FROM users WHERE id != 'usr_port4_sandbox'").first<{ total_users: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_tenants,
              SUM(CASE WHEN status = 'active' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS active_tenants,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended_tenants,
              SUM(CASE WHEN is_featured = 1 AND status = 'active' THEN 1 ELSE 0 END) AS featured_tenants
       FROM tenants
       WHERE status != 'archived' AND deleted_at IS NULL`
    ).first<{
      total_tenants: number;
      active_tenants: number | null;
      suspended_tenants: number | null;
      featured_tenants: number | null;
    }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_transactions,
              SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS verified_settled_transactions,
              SUM(CASE WHEN status = 'sandbox_settled' THEN 1 ELSE 0 END) AS simulated_sandbox_transactions,
              COALESCE(SUM(CAST(amount_atomic AS INTEGER)), 0) AS gross_atomic_volume,
              COALESCE(SUM(CASE WHEN status = 'settled' THEN CAST(amount_atomic AS INTEGER) ELSE 0 END), 0) AS verified_atomic_volume,
              COALESCE(SUM(CASE WHEN is_platform_fee = 1 THEN CAST(amount_atomic AS INTEGER) ELSE 0 END), 0) AS net_platform_atomic,
              COALESCE(SUM(CASE WHEN is_platform_fee = 1 THEN 1 ELSE 0 END), 0) AS platform_fee_calls
       FROM transactions`
    ).first<{
      total_transactions: number;
      verified_settled_transactions: number | null;
      simulated_sandbox_transactions: number | null;
      gross_atomic_volume: number;
      verified_atomic_volume: number;
      net_platform_atomic: number;
      platform_fee_calls: number;
    }>()
  ]);

  const grossAtomic = Number(txRow?.gross_atomic_volume ?? 0);
  const netAtomic = Number(txRow?.net_platform_atomic ?? 0);
  const verifiedAtomic = Number(txRow?.verified_atomic_volume ?? 0);

  return c.json({
    total_users: usersRow?.total_users ?? 0,
    total_tenants: tenantsRow?.total_tenants ?? 0,
    active_tenants: tenantsRow?.active_tenants ?? 0,
    suspended_tenants: tenantsRow?.suspended_tenants ?? 0,
    featured_tenants: tenantsRow?.featured_tenants ?? 0,
    total_transactions: txRow?.total_transactions ?? 0,
    verified_settled_transactions: txRow?.verified_settled_transactions ?? 0,
    simulated_sandbox_transactions: txRow?.simulated_sandbox_transactions ?? 0,
    gross_usdc_volume: (grossAtomic / 1_000_000).toFixed(4),
    verified_usdc_volume: (verifiedAtomic / 1_000_000).toFixed(4),
    net_platform_revenue: (netAtomic / 1_000_000).toFixed(4),
    platform_fee_calls: txRow?.platform_fee_calls ?? 0,
    capabilities: {
      codemodeLoader: Boolean(c.env.LOADER),
      visaTap: true,
      tempoMpp: Boolean(c.env.TEMPO_RPC_URL),
      r2Archive: Boolean(c.env.LEDGER_ARCHIVE),
      analyticsEngine: Boolean(c.env.GATEWAY_ANALYTICS),
      mainnetFacilitatorConfigured: Boolean(c.env.X402_MAINNET_FACILITATOR_URL)
    }
  });
});

/**
 * 2. Tenant Governance Table (searchable & filterable, integer atomic-unit volume)
 */
adminRoutes.get("/tenants", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const statusFilter = (c.req.query("status") ?? "").trim().toLowerCase();

  const res = await c.env.DB.prepare(
    `SELECT t.id, t.subdomain AS slug, t.name, t.upstream_base_url, t.payout_wallet,
            t.network, t.status, t.is_featured, t.call_count, t.created_at,
            u.id AS owner_id, u.login AS owner_login, COALESCE(u.plan, 'free') AS owner_plan,
            COUNT(tx.id) AS total_calls,
            COALESCE(SUM(CAST(tx.amount_atomic AS INTEGER)), 0) AS total_revenue_atomic
     FROM tenants t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN transactions tx ON tx.tenant_id = t.id
     WHERE t.deleted_at IS NULL AND t.status != 'archived'
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
    total_revenue_atomic: number;
  }>();

  let tenants = (res.results ?? []).map((row) => ({
    ...row,
    total_calls: Math.max(Number(row.call_count ?? 0), Number(row.total_calls ?? 0)),
    total_revenue_usd: (Number(row.total_revenue_atomic ?? 0) / 1_000_000).toFixed(4)
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
 * 2b. Instant Edge Kill-Switch + Audit Trail
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

  const auditId = `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE tenants SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.status, existing.id),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json)
       VALUES (?, ?, 'admin.tenant_status', 'tenant', ?, ?)`
    ).bind(auditId, c.get("user")?.id ?? null, existing.id, JSON.stringify({ slug, status: body.status }))
  ]);

  if (body.status === "suspended") {
    await invalidateTenantKv(c.env, slug);
  } else {
    await syncTenantToKv(c.env, slug);
  }

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

  const auditId = `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE tenants SET is_featured = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(featured, existing.id),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json)
       VALUES (?, ?, 'admin.tenant_featured', 'tenant', ?, ?)`
    ).bind(auditId, c.get("user")?.id ?? null, existing.id, JSON.stringify({ slug, is_featured: featured }))
  ]);

  await syncTenantToKv(c.env, slug);

  return c.json({ ok: true, slug, is_featured: featured });
});

/**
 * 4. User Plan & Fee-Tier Management (excludes seeded sandbox account)
 */
adminRoutes.get("/users", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT u.id, u.github_id, u.login, u.email, u.is_admin, COALESCE(u.plan, 'free') AS plan, u.created_at,
            COUNT(t.id) AS tenant_count
     FROM users u
     LEFT JOIN tenants t ON t.user_id = u.id AND t.deleted_at IS NULL
     WHERE u.id != 'usr_port4_sandbox'
     GROUP BY u.id
     ORDER BY u.created_at DESC`
  ).all();

  return c.json({ users: res.results ?? [] });
});

/**
 * 4b. Hourly Platform Traffic & Volume Breakdown (UTC)
 */
adminRoutes.get("/traffic", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%d %H:00', created_at) AS hour_utc,
            COUNT(*) AS total_calls,
            SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS verified_calls,
            SUM(CASE WHEN status = 'sandbox_settled' THEN 1 ELSE 0 END) AS sandbox_calls,
            COALESCE(SUM(CAST(amount_atomic AS INTEGER)), 0) AS volume_atomic,
            COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms
     FROM transactions
     GROUP BY hour_utc
     ORDER BY hour_utc DESC
     LIMIT 48`
  ).all<{
    hour_utc: string;
    total_calls: number;
    verified_calls: number;
    sandbox_calls: number;
    volume_atomic: number;
    avg_latency_ms: number;
  }>();

  const hours = (res.results ?? []).map((row) => ({
    hour_utc: row.hour_utc,
    total_calls: Number(row.total_calls ?? 0),
    verified_calls: Number(row.verified_calls ?? 0),
    sandbox_calls: Number(row.sandbox_calls ?? 0),
    volume_usd: (Number(row.volume_atomic ?? 0) / 1_000_000).toFixed(4),
    avg_latency_ms: Number(row.avg_latency_ms ?? 0)
  }));

  return c.json({ hours });
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

  const auditId = `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(body.plan, userId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json)
       VALUES (?, ?, 'admin.user_plan', 'user', ?, ?)`
    ).bind(auditId, c.get("user")?.id ?? null, userId, JSON.stringify({ plan: body.plan }))
  ]);

  await syncUserTenantsToKv(c.env, userId);

  return c.json({
    ok: true,
    user_id: userId,
    plan: body.plan,
    fee_rate_pct: body.plan === "pro" ? 1 : 3
  });
});

/**
 * 5. Global Live Audit Ledger (chain-aware explorer URLs; simulated sandbox receipts flagged honestly)
 */
adminRoutes.get("/transactions", async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "100") || 100));
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);

  const res = await c.env.DB.prepare(
    `SELECT tx.id, tx.tenant_id, t.subdomain AS slug, tx.tool_name, tx.payer_wallet,
            tx.amount_atomic, tx.amount_usd, tx.network, tx.tx_hash, tx.status,
            tx.latency_ms, COALESCE(tx.is_platform_fee, 0) AS is_platform_fee, tx.tap_agent_id, tx.created_at
     FROM transactions tx
     LEFT JOIN tenants t ON t.id = tx.tenant_id
     ORDER BY tx.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<{
      id: string;
      tenant_id: string;
      slug: string | null;
      tool_name: string;
      payer_wallet: string;
      amount_atomic: string;
      amount_usd: string;
      network: string;
      tx_hash: string;
      status: string;
      latency_ms: number;
      is_platform_fee: number;
      tap_agent_id: string | null;
      created_at: string;
    }>();

  const transactions = (res.results ?? []).map((tx) => {
    const net = getSupportedNetwork(tx.network);
    const explorerUrl =
      tx.status === "sandbox_settled" || !net
        ? null
        : `${net.explorerTxPrefix}${tx.tx_hash}`;
    return {
      ...tx,
      slug: tx.slug ?? "archived",
      basescan_url: explorerUrl,
      explorer_url: explorerUrl
    };
  });

  return c.json({
    limit,
    offset,
    transactions
  });
});
