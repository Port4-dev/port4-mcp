import { Activity, CheckCircle2, Clock, Coins, ExternalLink } from "lucide-react";

export interface LedgerTransaction {
  id: string;
  tenant_subdomain?: string;
  tool_name: string;
  payer_wallet: string;
  amount_usd: string;
  network: string;
  tx_hash: string;
  status: string;
  latency_ms: number;
  created_at: string;
}

interface RevenueTableProps {
  transactions: LedgerTransaction[];
  summary: {
    total_calls: number;
    total_usd: string;
    avg_latency_ms: number;
  };
}

export function RevenueTable({ transactions, summary }: RevenueTableProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MetricCard
          icon={<Coins className="w-4 h-4 text-[#F6821F]" />}
          label="Settled Revenue"
          value={`$${summary.total_usd} USDC`}
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

      <div className="cf-card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
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
                      <a
                        href={`https://sepolia.basescan.org/tx/${tx.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[#C25906] hover:underline"
                      >
                        {tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-6)}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-3 px-4 text-zinc-500">{tx.latency_ms}ms</td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">
                        <CheckCircle2 className="w-3 h-3" />
                        {tx.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
