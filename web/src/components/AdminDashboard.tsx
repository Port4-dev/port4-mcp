import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Coins,
  ExternalLink,
  Power,
  Search,
  ShieldCheck,
  Star,
  Users
} from "lucide-react";

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
  is_platform_fee: number;
  latency_ms: number;
  tx_hash: string;
  basescan_url: string;
  created_at: string;
}

export function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [transactions, setTransactions] = useState<AdminTx[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "suspended">("");
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter) params.set("status", statusFilter);

    const [sRes, tRes, txRes] = await Promise.all([
      fetch("/api/admin/stats"),
      fetch(`/api/admin/tenants?${params.toString()}`),
      fetch("/api/admin/transactions?limit=100")
    ]);

    if (sRes.status === 401 || sRes.status === 403) {
      setError("Super-admin access required.");
      return;
    }

    if (sRes.ok) setStats((await sRes.json()) as AdminStats);
    if (tRes.ok) {
      const tJson = (await tRes.json()) as { tenants: AdminTenant[] };
      setTenants(tJson.tenants);
    }
    if (txRes.ok) {
      const txJson = (await txRes.json()) as { transactions: AdminTx[] };
      setTransactions(txJson.transactions);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const toggleStatus = async (slug: string, current: "active" | "suspended") => {
    const next = current === "active" ? "suspended" : "active";
    await fetch(`/api/admin/tenants/${slug}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next })
    });
    await loadAll();
  };

  const toggleFeatured = async (slug: string, current: number) => {
    await fetch(`/api/admin/tenants/${slug}/featured`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_featured: current === 1 ? 0 : 1 })
    });
    await loadAll();
  };

  const updateUserPlan = async (userId: string, plan: "free" | "pro") => {
    await fetch(`/api/admin/users/${userId}/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan })
    });
    await loadAll();
  };

  if (error) {
    return (
      <div className="p4-card rounded-2xl p-8 text-center font-mono text-xs text-rose-400">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-[#10B981]" />
          <h1 className="text-2xl font-bold tracking-tight text-white">Super-Admin Control</h1>
        </div>
        <span className="font-mono text-xs text-[#10B981] bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded">
          Live Governance
        </span>
      </div>

      {/* 1. Global Telemetry */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi icon={<Users className="w-4 h-4 text-[#0EA5E9]" />} label="Developers" value={String(stats?.total_users ?? 0)} />
        <Kpi icon={<Activity className="w-4 h-4 text-[#0EA5E9]" />} label="Endpoints" value={`${stats?.active_tenants ?? 0}/${stats?.total_tenants ?? 0}`} />
        <Kpi icon={<Activity className="w-4 h-4 text-[#10B981]" />} label="Settled Calls" value={String(stats?.total_transactions ?? 0)} />
        <Kpi icon={<Coins className="w-4 h-4 text-[#0EA5E9]" />} label="Gross USDC" value={`$${stats?.gross_usdc_volume ?? "0.0000"}`} />
        <Kpi icon={<Coins className="w-4 h-4 text-[#10B981]" />} label="Net Revenue" value={`$${stats?.net_platform_revenue ?? "0.0000"}`} />
      </div>

      {/* 2. Tenant Governance + Kill-Switch + Featured + Plan */}
      <section className="p4-card rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-emerald-500/20 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">Tenant Governance</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search slug or owner..."
                className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg pl-8 pr-3 py-1.5 text-slate-200 focus:outline-none focus:border-[#0EA5E9]"
              />
            </div>
            <select
              aria-label="Filter status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "suspended")}
              className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-2.5 py-1.5 text-slate-200"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-emerald-500/15 text-[11px] uppercase text-slate-400">
                <th className="py-2.5 px-4">Slug</th>
                <th className="py-2.5 px-4">Owner</th>
                <th className="py-2.5 px-4">Plan / Fee</th>
                <th className="py-2.5 px-4">Calls</th>
                <th className="py-2.5 px-4">Volume</th>
                <th className="py-2.5 px-4">Featured</th>
                <th className="py-2.5 px-4">Kill-Switch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {tenants.map((t) => (
                <tr key={t.id} className="hover:bg-[#0EA5E9]/5">
                  <td className="py-2.5 px-4 text-[#0EA5E9]">{t.slug}</td>
                  <td className="py-2.5 px-4 text-slate-300">@{t.owner_login}</td>
                  <td className="py-2.5 px-4">
                    <select
                      aria-label={`Plan for ${t.owner_login}`}
                      value={t.owner_plan}
                      onChange={(e) => updateUserPlan(t.owner_id, e.target.value as "free" | "pro")}
                      className="bg-[#050B14] border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200"
                    >
                      <option value="free">free (3%)</option>
                      <option value="pro">pro (1%)</option>
                    </select>
                  </td>
                  <td className="py-2.5 px-4 text-slate-300">{t.total_calls}</td>
                  <td className="py-2.5 px-4 text-[#10B981]">${t.total_revenue_usd}</td>
                  <td className="py-2.5 px-4">
                    <button
                      type="button"
                      onClick={() => toggleFeatured(t.slug, t.is_featured)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer border ${
                        t.is_featured === 1
                          ? "bg-sky-500/15 text-sky-300 border-sky-500/40"
                          : "bg-[#050B14] text-slate-500 border-slate-700"
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
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-rose-500/15 hover:text-rose-300 hover:border-rose-500/40"
                          : "bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-emerald-500/15 hover:text-emerald-300"
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

      {/* 3. Global Live Audit Ledger */}
      <section className="p4-card rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-emerald-500/20 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Global Audit Ledger (Latest 100)</h2>
          <span className="font-mono text-[11px] text-slate-400">
            {transactions.length} records
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-emerald-500/15 text-[11px] uppercase text-slate-400">
                <th className="py-2.5 px-4">Time</th>
                <th className="py-2.5 px-4">Endpoint</th>
                <th className="py-2.5 px-4">Amount</th>
                <th className="py-2.5 px-4">Fee</th>
                <th className="py-2.5 px-4">Latency</th>
                <th className="py-2.5 px-4">Tx Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {transactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-[#0EA5E9]/5">
                  <td className="py-2.5 px-4 text-slate-400">{tx.created_at}</td>
                  <td className="py-2.5 px-4">
                    <span className="text-[#0EA5E9]">{tx.slug}</span>
                    <span className="text-slate-600">/</span>
                    <span className="text-slate-200">{tx.tool_name}</span>
                  </td>
                  <td className="py-2.5 px-4 text-[#10B981]">${tx.amount_usd}</td>
                  <td className="py-2.5 px-4">
                    {tx.is_platform_fee === 1 ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px]">
                        Platform Fee
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[10px]">Merchant</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-slate-400">{tx.latency_ms}ms</td>
                  <td className="py-2.5 px-4">
                    <a
                      href={tx.basescan_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[#0EA5E9] hover:underline"
                    >
                      {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="p4-card rounded-xl p-4 flex items-center justify-between">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
        <div className="font-mono text-base font-semibold text-white mt-0.5">{value}</div>
      </div>
      <div className="p-2 rounded-lg bg-[#050B14] border border-emerald-500/20">{icon}</div>
    </div>
  );
}
