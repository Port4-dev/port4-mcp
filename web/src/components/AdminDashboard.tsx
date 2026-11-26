import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Coins,
  ExternalLink,
  Github,
  Lock,
  Power,
  Search,
  ShieldCheck,
  Star,
  Users
} from "lucide-react";
import { isSafeHttpsUrl } from "../lib/wallets";

interface AdminUserProp {
  id: string;
  login: string;
  is_admin: number;
  plan: "free" | "pro";
}

interface AdminDashboardProps {
  authLoaded: boolean;
  authenticated: boolean;
  githubConfigured: boolean;
  user: AdminUserProp | null;
  onGoDashboard: () => void;
}

interface AdminStats {
  total_users: number;
  total_tenants: number;
  active_tenants: number;
  suspended_tenants: number;
  featured_tenants: number;
  total_transactions: number;
  gross_usdc_volume: string;
  net_platform_revenue: string;
  platform_fee_calls: number;
}

interface AdminTenant {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  owner_login: string;
  owner_plan: "free" | "pro";
  network: string;
  status: "active" | "suspended";
  is_featured: number;
  total_calls: number;
  total_revenue_usd: string;
}

interface AdminTx {
  id: string;
  slug: string;
  tool_name: string;
  amount_usd: string;
  status?: string;
  is_platform_fee: number;
  latency_ms: number;
  tx_hash: string;
  basescan_url: string | null;
  explorer_url?: string | null;
  tap_agent_id?: string | null;
  created_at: string;
}

interface AdminRegisteredUser {
  id: string;
  github_id: string;
  login: string;
  email: string | null;
  is_admin: number;
  plan: "free" | "pro";
  tenant_count: number;
  created_at: string;
}

interface AdminTrafficHour {
  hour_utc: string;
  total_calls: number;
  verified_calls: number;
  sandbox_calls: number;
  volume_usd: string;
  avg_latency_ms: number;
}

interface AdminAuditLogEntry {
  id: string;
  actor_user_id: string | null;
  actor_login: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string | null;
  created_at: string;
}

export function AdminDashboard({
  authLoaded,
  authenticated,
  githubConfigured,
  user,
  onGoDashboard
}: AdminDashboardProps) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [users, setUsers] = useState<AdminRegisteredUser[]>([]);
  const [trafficHours, setTrafficHours] = useState<AdminTrafficHour[]>([]);
  const [transactions, setTransactions] = useState<AdminTx[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);
  const [txOffset, setTxOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "suspended">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = Boolean(authenticated && user && user.is_admin === 1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadAll = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      if (statusFilter) params.set("status", statusFilter);

      const [sRes, tRes, uRes, trRes, txRes, alRes] = await Promise.all([
        fetch("/api/admin/stats"),
        fetch(`/api/admin/tenants?${params.toString()}`),
        fetch("/api/admin/users"),
        fetch("/api/admin/traffic"),
        fetch(`/api/admin/transactions?limit=50&offset=${txOffset}`),
        fetch("/api/admin/audit-logs?limit=30")
      ]);

      if (!sRes.ok || !tRes.ok || !uRes.ok || !trRes.ok || !txRes.ok || !alRes.ok) {
        const failed = [sRes, tRes, uRes, trRes, txRes, alRes].find((r) => !r.ok);
        const errBody = failed ? ((await failed.json().catch(() => ({}))) as { message?: string; error?: string }) : {};
        throw new Error(errBody.message || errBody.error || `Admin sync failed (${failed?.status ?? 500})`);
      }

      setStats((await sRes.json()) as AdminStats);
      const tJson = (await tRes.json()) as { tenants: AdminTenant[] };
      setTenants(tJson.tenants);
      const uJson = (await uRes.json()) as { users: AdminRegisteredUser[] };
      setUsers(uJson.users);
      const trJson = (await trRes.json()) as { hours: AdminTrafficHour[] };
      setTrafficHours(trJson.hours);
      const txJson = (await txRes.json()) as { transactions: AdminTx[] };
      setTransactions(txJson.transactions);
      const alJson = (await alRes.json()) as { audit_logs: AdminAuditLogEntry[] };
      setAuditLogs(alJson.audit_logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin telemetry.");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, debouncedSearch, statusFilter, txOffset]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const toggleStatus = async (slug: string, current: "active" | "suspended") => {
    setError(null);
    try {
      const next = current === "active" ? "suspended" : "active";
      const res = await fetch(`/api/admin/tenants/${slug}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(err.message || err.error || `Failed to update status (${res.status})`);
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update tenant status.");
    }
  };

  const toggleFeatured = async (slug: string, current: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/tenants/${slug}/featured`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_featured: current === 1 ? 0 : 1 })
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(err.message || err.error || `Failed to update featured flag (${res.status})`);
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update featured status.");
    }
  };

  const updateUserPlan = async (userId: string, plan: "free" | "pro") => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/plan`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan })
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(err.message || err.error || `Failed to update user plan (${res.status})`);
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update developer plan.");
    }
  };

  if (!authLoaded) {
    return (
      <div className="cf-card rounded-2xl p-8 text-center font-mono text-xs text-zinc-500">
        Verifying session permissions...
      </div>
    );
  }

  // Clean, honest RBAC gate for unauthenticated visitors
  if (!authenticated || !user) {
    return (
      <div className="max-w-lg mx-auto cf-card rounded-2xl p-8 flex flex-col items-center text-center gap-4">
        <div className="p-3 rounded-xl bg-[#F6821F]/10 border border-[#F6821F]/25">
          <Lock className="w-5 h-5 text-[#F6821F]" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Admin Sign-In Required</h1>
          <p className="text-sm text-zinc-600 mt-1">
            Role-based access control restricts <code className="font-mono text-xs">/admin</code> to
            verified Super-Admin accounts.
          </p>
        </div>
        <div className="flex items-center gap-3 pt-1">
          {githubConfigured && (
            <a
              href="/api/auth/github"
              className="cf-btn-primary inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs"
            >
              <Github className="w-4 h-4" />
              Sign in with GitHub
            </a>
          )}
          <button
            type="button"
            onClick={onGoDashboard}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-xs font-medium text-zinc-700 hover:border-[#F6821F] cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Clean, honest RBAC view for signed-in Developer (non-admin)
  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto cf-card rounded-2xl p-8 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-zinc-100 border border-zinc-200">
            <Lock className="w-5 h-5 text-zinc-700" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-zinc-900">Role-Based Access Control</h1>
            <p className="text-xs text-zinc-500">Your current account permissions</p>
          </div>
        </div>

        <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4 flex flex-col gap-2 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-zinc-500">Account</span>
            <span className="text-zinc-900 font-medium">@{user.login}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Role</span>
            <span className="px-2 py-0.5 rounded bg-zinc-200/80 text-zinc-800">Developer</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Plan</span>
            <span className="text-zinc-900">
              {user.plan === "pro" ? "Pro (1% fee)" : "Free (3% fee)"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Admin Scope</span>
            <span className="text-zinc-500">Not granted</span>
          </div>
        </div>

        <p className="text-xs text-zinc-600 leading-relaxed">
          You have full access to create endpoints, manage tools, and inspect your revenue ledger in
          the Developer Dashboard. Platform-wide governance requires the{" "}
          <span className="font-mono font-medium text-zinc-900">Super-Admin</span> role.
        </p>

        <button
          type="button"
          onClick={onGoDashboard}
          className="cf-btn-primary inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-xs cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Go to Developer Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-[#F6821F]" />
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Super-Admin Control</h1>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded">
            RBAC: Super Admin (@{user.login})
          </span>
          {loading && <span className="text-zinc-400">Syncing...</span>}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="font-mono text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi icon={<Users className="w-4 h-4 text-[#F6821F]" />} label="Developers" value={String(stats?.total_users ?? 0)} />
        <Kpi icon={<Activity className="w-4 h-4 text-[#F6821F]" />} label="Endpoints" value={`${stats?.active_tenants ?? 0}/${stats?.total_tenants ?? 0}`} />
        <Kpi icon={<Activity className="w-4 h-4 text-emerald-600" />} label="Settled Calls" value={String(stats?.total_transactions ?? 0)} />
        <Kpi icon={<Coins className="w-4 h-4 text-[#F6821F]" />} label="Gross USDC" value={`$${stats?.gross_usdc_volume ?? "0.0000"}`} />
        <Kpi icon={<Coins className="w-4 h-4 text-emerald-600" />} label="Net Revenue" value={`$${stats?.net_platform_revenue ?? "0.0000"}`} />
      </div>

      <section className="cf-card rounded-2xl overflow-hidden min-w-0">
        <div className="p-4 border-b border-zinc-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-900">Tenant Governance</h2>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:flex-initial">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-3.5 sm:top-2.5" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search slug or owner..."
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg pl-8 pr-3 min-h-[44px] sm:min-h-[34px] w-full text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              />
            </div>
            <select
              aria-label="Filter status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "suspended")}
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[34px] text-zinc-800"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase text-zinc-500">
                <th className="py-2.5 px-4">Slug</th>
                <th className="py-2.5 px-4">Owner</th>
                <th className="py-2.5 px-4">Plan / Fee</th>
                <th className="py-2.5 px-4">Calls</th>
                <th className="py-2.5 px-4">Volume</th>
                <th className="py-2.5 px-4">Featured</th>
                <th className="py-2.5 px-4">Kill-Switch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {tenants.map((t) => (
                <tr key={t.id} className="hover:bg-orange-50/40">
                  <td className="py-2.5 px-4 text-[#C25906] font-medium">{t.slug}</td>
                  <td className="py-2.5 px-4 text-zinc-700">@{t.owner_login}</td>
                  <td className="py-2.5 px-4">
                    <select
                      aria-label={`Plan for ${t.owner_login}`}
                      value={t.owner_plan}
                      onChange={(e) => updateUserPlan(t.owner_id, e.target.value as "free" | "pro")}
                      className="bg-white border border-zinc-300 rounded px-2 py-1 text-[11px] text-zinc-800"
                    >
                      <option value="free">free (3%)</option>
                      <option value="pro">pro (1%)</option>
                    </select>
                  </td>
                  <td className="py-2.5 px-4 text-zinc-700">{t.total_calls}</td>
                  <td className="py-2.5 px-4 text-emerald-700 font-medium">${t.total_revenue_usd}</td>
                  <td className="py-2.5 px-4">
                    <button
                      type="button"
                      onClick={() => toggleFeatured(t.slug, t.is_featured)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer border ${
                        t.is_featured === 1
                          ? "bg-[#F6821F]/10 text-[#C25906] border-[#F6821F]/35"
                          : "bg-zinc-50 text-zinc-500 border-zinc-200"
                      }`}
                    >
                      <Star className="w-3 h-3" />
                      {t.is_featured === 1 ? "Featured" : "Standard"}
                    </button>
                  </td>
                  <td className="py-2.5 px-4">
                    <button
                      type="button"
                      onClick={() => toggleStatus(t.slug, t.status)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] cursor-pointer border ${
                        t.status === "active"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200"
                          : "bg-rose-50 text-rose-700 border-rose-200 hover:bg-emerald-50 hover:text-emerald-700"
                      }`}
                    >
                      <Power className="w-3 h-3" />
                      {t.status}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cf-card rounded-2xl overflow-hidden min-w-0">
        <div className="p-4 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Registered Developers</h2>
          <span className="font-mono text-[11px] text-zinc-500">{users.length} signups</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase text-zinc-500">
                <th className="py-2.5 px-4">GitHub</th>
                <th className="py-2.5 px-4">Role</th>
                <th className="py-2.5 px-4">Plan / Fee</th>
                <th className="py-2.5 px-4">Endpoints</th>
                <th className="py-2.5 px-4">Signed Up (UTC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 px-4 text-center text-zinc-400">
                    No registered developers yet.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-orange-50/40">
                    <td className="py-2.5 px-4">
                      <span className="text-zinc-900 font-medium">@{u.login}</span>
                      {u.email && <span className="text-zinc-400 ml-2 text-[11px]">{u.email}</span>}
                    </td>
                    <td className="py-2.5 px-4">
                      {u.is_admin === 1 ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">
                          Super-Admin
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-700 border border-zinc-200 text-[10px]">
                          Developer
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <select
                        aria-label={`Developer plan for ${u.login}`}
                        value={u.plan}
                        onChange={(e) => updateUserPlan(u.id, e.target.value as "free" | "pro")}
                        className="bg-white border border-zinc-300 rounded px-2 py-1 text-[11px] text-zinc-800"
                      >
                        <option value="free">free (3%)</option>
                        <option value="pro">pro (1%)</option>
                      </select>
                    </td>
                    <td className="py-2.5 px-4 text-zinc-700">{u.tenant_count}</td>
                    <td className="py-2.5 px-4 text-zinc-500">{u.created_at}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cf-card rounded-2xl overflow-hidden min-w-0">
        <div className="p-4 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Hourly Gateway Traffic (Last 48h UTC)</h2>
          <span className="font-mono text-[11px] text-zinc-500">{trafficHours.length} active hours</span>
        </div>
        {trafficHours.length > 0 && (() => {
          const ordered = trafficHours.slice(0, 24).reverse();
          const maxCalls = Math.max(1, ...ordered.map((x) => x.total_calls));
          return (
            <div className="px-4 pt-3 pb-1 border-b border-zinc-200 bg-zinc-50/50">
              <svg
                viewBox={`0 0 ${Math.max(240, ordered.length * 18)} 52`}
                className="w-full h-14 overflow-visible"
                role="img"
                aria-label="Hourly gateway traffic chart"
              >
                {ordered.map((h, idx) => {
                  const barH = Math.max(3, Math.round((h.total_calls / maxCalls) * 40));
                  const x = idx * 18 + 2;
                  return (
                    <rect
                      key={h.hour_utc}
                      x={x}
                      y={44 - barH}
                      width={12}
                      height={barH}
                      rx={2}
                      fill="#F6821F"
                      fillOpacity={0.85}
                    >
                      <title>{`${h.hour_utc}: ${h.total_calls} calls ($${h.volume_usd})`}</title>
                    </rect>
                  );
                })}
              </svg>
            </div>
          );
        })()}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase text-zinc-500">
                <th className="py-2.5 px-4">Hour (UTC)</th>
                <th className="py-2.5 px-4">Total Calls</th>
                <th className="py-2.5 px-4">Verified</th>
                <th className="py-2.5 px-4">Sandbox</th>
                <th className="py-2.5 px-4">Volume</th>
                <th className="py-2.5 px-4">Avg Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {trafficHours.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 px-4 text-center text-zinc-400">
                    No settled traffic recorded yet.
                  </td>
                </tr>
              ) : (
                trafficHours.map((h) => (
                  <tr key={h.hour_utc} className="hover:bg-orange-50/40">
                    <td className="py-2.5 px-4 text-zinc-700">{h.hour_utc}</td>
                    <td className="py-2.5 px-4 text-zinc-900 font-semibold">{h.total_calls}</td>
                    <td className="py-2.5 px-4 text-emerald-700">{h.verified_calls}</td>
                    <td className="py-2.5 px-4 text-zinc-500">{h.sandbox_calls}</td>
                    <td className="py-2.5 px-4 text-[#C25906] font-medium">${h.volume_usd}</td>
                    <td className="py-2.5 px-4 text-zinc-500">{h.avg_latency_ms}ms</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cf-card rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Global Audit Ledger</h2>
          <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
            <span>
              Offset {txOffset} · {transactions.length} rows
            </span>
            <button
              type="button"
              disabled={txOffset <= 0}
              onClick={() => setTxOffset((o) => Math.max(0, o - 50))}
              className="px-2 py-0.5 rounded border border-zinc-300 bg-white text-zinc-700 disabled:opacity-40 cursor-pointer"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={transactions.length < 50}
              onClick={() => setTxOffset((o) => o + 50)}
              className="px-2 py-0.5 rounded border border-zinc-300 bg-white text-zinc-700 disabled:opacity-40 cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase text-zinc-500">
                <th className="py-2.5 px-4">Time</th>
                <th className="py-2.5 px-4">Endpoint</th>
                <th className="py-2.5 px-4">Amount</th>
                <th className="py-2.5 px-4">Fee</th>
                <th className="py-2.5 px-4">Latency</th>
                <th className="py-2.5 px-4">Tx Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {transactions.map((tx) => {
                const explorerUrl = tx.explorer_url ?? tx.basescan_url;
                return (
                <tr key={tx.id} className="hover:bg-orange-50/40">
                  <td className="py-2.5 px-4 text-zinc-500">{tx.created_at}</td>
                  <td className="py-2.5 px-4">
                    <span className="text-[#C25906]">{tx.slug}</span>
                    <span className="text-zinc-400">/</span>
                    <span className="text-zinc-900">{tx.tool_name}</span>
                    {tx.tap_agent_id && (
                      <span
                        title={`Visa TAP Agent: ${tx.tap_agent_id}`}
                        className="ml-2 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px]"
                      >
                        TAP
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-emerald-700 font-medium">${tx.amount_usd}</td>
                  <td className="py-2.5 px-4">
                    {tx.is_platform_fee === 1 ? (
                      <span className="px-2 py-0.5 rounded bg-[#F6821F]/10 text-[#C25906] border border-[#F6821F]/25 text-[10px]">
                        Platform Fee
                      </span>
                    ) : (
                      <span className="text-zinc-400 text-[10px]">Merchant</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-zinc-500">{tx.latency_ms}ms</td>
                  <td className="py-2.5 px-4">
                    {tx.status !== "sandbox_settled" && isSafeHttpsUrl(explorerUrl) ? (
                      <a
                        href={explorerUrl!}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[#C25906] hover:underline"
                      >
                        {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-zinc-500">
                        {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)} (simulated)
                      </span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cf-card rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Admin &amp; Security Audit Trail</h2>
          <span className="font-mono text-[11px] text-zinc-500">{auditLogs.length} events</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase text-zinc-500">
                <th className="py-2.5 px-4">Time (UTC)</th>
                <th className="py-2.5 px-4">Actor</th>
                <th className="py-2.5 px-4">Action</th>
                <th className="py-2.5 px-4">Target</th>
                <th className="py-2.5 px-4">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 px-4 text-center text-zinc-400">
                    No audit events recorded yet.
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-orange-50/40">
                    <td className="py-2.5 px-4 text-zinc-500">{log.created_at}</td>
                    <td className="py-2.5 px-4 text-zinc-800">
                      {log.actor_login ? `@${log.actor_login}` : log.actor_user_id ?? "system"}
                    </td>
                    <td className="py-2.5 px-4 text-[#C25906]">{log.action}</td>
                    <td className="py-2.5 px-4 text-zinc-600">
                      {log.target_type}:{log.target_id}
                    </td>
                    <td className="py-2.5 px-4 text-zinc-500 max-w-xs truncate">
                      {log.metadata_json ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="cf-card rounded-xl p-4 flex items-center justify-between">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="font-mono text-base font-semibold text-zinc-900 mt-0.5">{value}</div>
      </div>
      <div className="p-2 rounded-lg bg-[#F6821F]/10 border border-[#F6821F]/20">{icon}</div>
    </div>
  );
}
