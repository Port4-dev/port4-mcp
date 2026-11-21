import type { AppBindings, TenantRecord, TenantRoutingRecord, ToolRecord, UserPlan } from "../types";
import { parsePayoutWalletsJson } from "./networks";

const KV_PREFIX = "tenant:";

export function tenantKvKey(subdomain: string): string {
  return `${KV_PREFIX}${subdomain.toLowerCase()}`;
}

export async function loadTenantFromD1(
  env: AppBindings,
  subdomain: string
): Promise<TenantRoutingRecord | null> {
  const normalized = subdomain.toLowerCase();
  const tenant = await env.DB.prepare(
    `SELECT t.id, t.user_id, t.subdomain, t.name, t.upstream_base_url, t.payout_wallet,
            t.payout_wallets_json, t.network, t.auth_mode, t.is_active, t.status, t.is_featured, t.call_count,
            t.upstream_signing_secret, COALESCE(t.upstream_verified, 0) AS upstream_verified,
            COALESCE(t.rate_limit_rpm, 120) AS rate_limit_rpm,
            COALESCE(t.daily_quota, 10000) AS daily_quota,
            COALESCE(u.plan, 'free') AS owner_plan
     FROM tenants t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.subdomain = ? AND t.is_active = 1 AND t.status = 'active'
     LIMIT 1`
  )
    .bind(normalized)
    .first<TenantRecord & { owner_plan: UserPlan }>();

  if (!tenant) {
    return null;
  }

  const toolsResult = await env.DB.prepare(
    `SELECT id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, is_active
     FROM tools
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY name ASC`
  )
    .bind(tenant.id)
    .all<ToolRecord>();

  return {
    id: tenant.id,
    user_id: tenant.user_id,
    subdomain: tenant.subdomain,
    name: tenant.name,
    upstream_base_url: tenant.upstream_base_url,
    payout_wallet: tenant.payout_wallet,
    payout_wallets: parsePayoutWalletsJson(
      tenant.payout_wallets_json,
      tenant.network,
      tenant.payout_wallet
    ),
    network: tenant.network,
    auth_mode: tenant.auth_mode,
    status: tenant.status,
    is_featured: tenant.is_featured,
    call_count: tenant.call_count ?? 0,
    owner_plan: tenant.owner_plan === "pro" ? "pro" : "free",
    upstream_signing_secret: tenant.upstream_signing_secret ?? null,
    upstream_verified: Number(tenant.upstream_verified ?? 0),
    rate_limit_rpm: Number(tenant.rate_limit_rpm ?? 120),
    daily_quota: Number(tenant.daily_quota ?? 10000),
    tools: toolsResult.results ?? [],
    cached_at: new Date().toISOString()
  };
}

export async function syncTenantToKv(
  env: AppBindings,
  subdomain: string
): Promise<TenantRoutingRecord | null> {
  const record = await loadTenantFromD1(env, subdomain);
  const key = tenantKvKey(subdomain);
  if (!record) {
    await invalidateTenantKv(env, subdomain);
    return null;
  }
  await env.TENANT_ROUTING.put(key, JSON.stringify(record), {
    expirationTtl: 3600
  });
  return record;
}

export async function invalidateTenantKv(env: AppBindings, subdomain: string): Promise<void> {
  const slug = subdomain.toLowerCase();
  await Promise.all([
    env.TENANT_ROUTING.delete(tenantKvKey(slug)),
    env.TENANT_ROUTING.delete(slug)
  ]);
}

export async function syncUserTenantsToKv(env: AppBindings, userId: string): Promise<void> {
  const res = await env.DB.prepare("SELECT subdomain FROM tenants WHERE user_id = ?")
    .bind(userId)
    .all<{ subdomain: string }>();

  const subs = res.results ?? [];
  await Promise.all(subs.map((row) => syncTenantToKv(env, row.subdomain)));
}

export async function resolveTenant(
  env: AppBindings,
  subdomain: string
): Promise<TenantRoutingRecord | null> {
  const key = tenantKvKey(subdomain);
  const cached = await env.TENANT_ROUTING.get<TenantRoutingRecord>(key, "json");
  if (cached && cached.status === "active") {
    return cached;
  }
  const fromDb = await loadTenantFromD1(env, subdomain);
  if (fromDb) {
    await env.TENANT_ROUTING.put(key, JSON.stringify(fromDb), {
      expirationTtl: 3600
    });
  }
  return fromDb;
}
