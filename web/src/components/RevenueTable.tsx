import { Activity, CheckCircle2, Clock, Coins, Download, ExternalLink, Search } from "lucide-react";
import { isSafeHttpsUrl } from "../lib/wallets";

export interface LedgerTransaction {
  id: string;
  tenant_subdomain?: string;
  tool_name: string;
  payer_wallet: string;
  amount_usd: string;
  network: string;
  tx_hash: string;
  explorer_url?: string | null;
  tap_agent_id?: string | null;
  status: string;
  latency_ms: number;
  created_at: string;
}

export interface DailyLedgerPoint {
  day_utc: string;
  calls: number;
  usd: string;
}

export interface LedgerFilters {
  tool: string;
  status: string;
  offset: number;
  limit: number;
}

interface RevenueTableProps {
  transactions: LedgerTransaction[];
  summary: {
    total_calls: number;
    total_usd: string;
    avg_latency_ms: number;
  };
  authenticated?: boolean;
  dailySeries?: DailyLedgerPoint[];
  pagination?: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
  filters?: LedgerFilters;
  onFiltersChange?: (next: LedgerFilters) => void;
}

export function RevenueTable({
  transactions,
  summary,
  authenticated = false,
  dailySeries = [],
  pagination,
  filters,
  onFiltersChange
}: RevenueTableProps) {
  const activeFilters: LedgerFilters = filters ?? {
    tool: "",
    status: "",
    offset: 0,
    limit: 50
  };

  const maxDailyCalls = Math.max(1, ...dailySeries.map((d) => d.calls));

  const buildExportUrl = (format: "csv" | "json") => {
    const params = new URLSearchParams({ format });
    if (activeFilters.tool.trim()) params.set("tool", activeFilters.tool.trim());
    if (activeFilters.status) params.set("status", activeFilters.status);
    return `/api/ledger/export?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MetricCard
          icon={<Coins className="w-4 h-4 text-[#F6821F]" />}
          label="Settled Revenue"
          value={`$${summary.total_usd} USDC/OUSD`}
        />
        <MetricCard
          icon={<Activity className="w-4 h-4 text-[#F6821F]" />}
          label="Paid Calls"
          value={String(summary.total_calls)}
        />
        <MetricCard
          icon={<Clock className="w-4 h-4 text-[#F6821F]" />}
          label="Avg Latency"
          value={`${summary.avg_latency_ms} ms`}
        />
      </div>

      {dailySeries.length > 0 && (
        <div className="cf-card rounded-2xl p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-900">Daily Call Volume (UTC)</span>
            <span className="font-mono text-[10px] text-zinc-500">
              Last {dailySeries.length} active days
            </span>
          </div>
          <svg
            viewBox={`0 0 ${Math.max(140, dailySeries.length * 28)} 64`}
            className="w-full h-16 overflow-visible"
            role="img"
            aria-label="Daily call volume bar chart"
          >
            {dailySeries.map((pt, idx) => {
              const barHeight = Math.max(4, Math.round((pt.calls / maxDailyCalls) * 44));
              const x = idx * 28 + 4;
              const y = 52 - barHeight;
              return (
                <g key={pt.day_utc}>
                  <title>{`${pt.day_utc}: ${pt.calls} calls ($${pt.usd})`}</title>
                  <rect
                    x={x}
                    y={y}
                    width={18}
                    height={barHeight}
                    rx={3}
                    fill="#F6821F"
                    fillOpacity={0.85}
                  />
                  <text
                    x={x + 9}
                    y={62}
                    textAnchor="middle"
                    fontSize="7"
                    fill="#71717A"
                    fontFamily="monospace"
                  >
                    {pt.day_utc.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {authenticated && onFiltersChange && (
        <div className="cf-card rounded-2xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5" />
              <input
                aria-label="Filter ledger by tool"
                value={activeFilters.tool}
                onChange={(e) =>
                  onFiltersChange({ ...activeFilters, tool: e.target.value, offset: 0 })
                }
                placeholder="Filter tool..."
                className="font-mono text-xs bg-white border border-zinc-300 rounded-lg pl-8 pr-3 min-h-[34px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              />
            </div>
            <select
              aria-label="Filter ledger by status"
              value={activeFilters.status}
              onChange={(e) =>
                onFiltersChange({ ...activeFilters, status: e.target.value, offset: 0 })
              }
              className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[34px] text-zinc-800"
            >
              <option value="">All Statuses</option>
              <option value="settled">Settled (On-Chain)</option>
              <option value="sandbox_settled">Sandbox Simulated</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={buildExportUrl("csv")}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 min-h-[34px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F]"
            >
              <Download className="w-3 h-3" />
              Export CSV
            </a>
            <a
              href={buildExportUrl("json")}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 min-h-[34px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F]"
            >
              <Download className="w-3 h-3" />
              JSON
            </a>
          </div>
        </div>
      )}

      <div className="cf-card rounded-2xl overflow-hidden min-w-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse whitespace-nowrap">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="py-3 px-4">Tool</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Tx Hash</th>
                <th className="py-3 px-4">Latency</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 font-mono text-xs">
              {transactions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-zinc-500">
                    No settled calls yet.
                  </td>
                </tr>
              ) : (
                transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-orange-50/40">
                    <td className="py-3 px-4">
                      <span className="text-[#C25906]">{tx.tenant_subdomain ?? "demo"}</span>
                      <span className="text-zinc-400">/</span>
                      <span className="text-zinc-900 font-medium">{tx.tool_name}</span>
                    </td>
                    <td className="py-3 px-4 text-emerald-700 font-medium">${tx.amount_usd}</td>
                    <td className="py-3 px-4">
                      {tx.status !== "sandbox_settled" && isSafeHttpsUrl(tx.explorer_url) && tx.explorer_url ? (
                        <a
                          href={tx.explorer_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[#C25906] hover:underline"
                        >
                          {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-zinc-500" title="Simulated off-chain sandbox receipt">
                          {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)} (sim)
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-zinc-500">{tx.latency_ms}ms</td>
                    <td className="py-3 px-4">
                      <div className="inline-flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">
                          <CheckCircle2 className="w-3 h-3" />
                          {tx.status}
                        </span>
                        {tx.tap_agent_id && (
                          <span
                            title={`Visa TAP Agent: ${tx.tap_agent_id}`}
                            className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px]"
                          >
                            TAP
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pagination && onFiltersChange && (pagination.offset > 0 || pagination.has_more) && (
          <div className="px-4 py-2.5 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between font-mono text-[11px] text-zinc-600">
            <span>
              Showing {pagination.offset + 1}–{pagination.offset + transactions.length} of{" "}
              {pagination.total}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pagination.offset <= 0}
                onClick={() =>
                  onFiltersChange({
                    ...activeFilters,
                    offset: Math.max(0, activeFilters.offset - activeFilters.limit)
                  })
                }
                className="px-2.5 py-1 rounded border border-zinc-300 bg-white disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={!pagination.has_more}
                onClick={() =>
                  onFiltersChange({
                    ...activeFilters,
                    offset: activeFilters.offset + activeFilters.limit
                  })
                }
                className="px-2.5 py-1 rounded border border-zinc-300 bg-white disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="cf-card rounded-xl p-4 flex items-center justify-between">
      <div>
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="font-mono text-lg font-semibold text-zinc-900 mt-0.5">{value}</div>
      </div>
      <div className="p-2.5 rounded-lg bg-[#F6821F]/10 border border-[#F6821F]/20">{icon}</div>
    </div>
  );
}
