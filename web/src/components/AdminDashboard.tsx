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
      <div className="cf-card rounded-2xl p-8 text-center font-mono text-xs text-rose-700">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-[#F6821F]" />
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Super-Admin Control</h1>
        </div>
        <span className="font-mono text-xs text-[#C25906] bg-[#F6821F]/10 border border-[#F6821F]/25 px-2.5 py-1 rounded">
          Live Governance
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi icon={<Users className="w-4 h-4 text-[#F6821F]" />} label="Developers" value={String(stats?.total_users ?? 0)} />
        <Kpi icon={<Activity className="w-4 h-4 text-[#F6821F]" />} label="Endpoints" value={`${stats?.active_tenants ?? 0}/${stats?.total_tenants ?? 0}`} />
        <Kpi icon={<Activity className="w-4 h-4 text-emerald-600" />} label="Settled Calls" value={String(stats?.total_transactions ?? 0)} />
        <Kpi icon={<Coins className="w-4 h-4 text-[#F6821F]" />} label="Gross USDC" value={`$${stats?.gross_usdc_volume ?? "0.0000"}`} />
        <Kpi icon={<Coins className="w-4 h-4 text-emerald-600" />} label="Net Revenue" value={`$${stats?.net_platform_revenue ?? "0.0000"}`} />
      </div>

      <section className="cf-card rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-zinc-200 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-900">Tenant Governance</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search slug or owner..."
                className="font-mono text-xs bg-white border border-zinc-300 rounded-lg pl-8 pr-3 py-1.5 text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              />
            </div>
            <select
              aria-label="Filter status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "suspended")}
              className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5 text-zinc-800"
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

      <section className="cf-card rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Global Audit Ledger (Latest 100)</h2>
          <span className="font-mono text-[11px] text-zinc-500">{transactions.length} records</span>
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
              {transactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-orange-50/40">
                  <td className="py-2.5 px-4 text-zinc-500">{tx.created_at}</td>
                  <td className="py-2.5 px-4">
                    <span className="text-[#C25906]">{tx.slug}</span>
                    <span className="text-zinc-400">/</span>
                    <span className="text-zinc-900">{tx.tool_name}</span>
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
                    <a
                      href={tx.basescan_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[#C25906] hover:underline"
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
    <div className="cf-card rounded-xl p-4 flex items-center justify-between">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="font-mono text-base font-semibold text-zinc-900 mt-0.5">{value}</div>
      </div>
      <div className="p-2 rounded-lg bg-[#F6821F]/10 border border-[#F6821F]/20">{icon}</div>
    </div>
  );
}
