import { useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Play,
  RefreshCw,
  ShieldAlert,
  Terminal
} from "lucide-react";

interface SandboxProps {
  onSettled?: () => void;
}

interface SandboxRunResponse {
  ok: boolean;
  tool: string;
  network: string;
  amountUsd: string;
  payer: string;
  payTo: string;
  isPlatformFee: boolean;
  txHash: string;
  basescanUrl: string;
  latencyMs: number;
  step1_402: {
    status: number;
    paymentRequiredHeader: string;
    decoded: Record<string, unknown>;
  };
  step2_signed: {
    scheme: string;
    network: string;
    payer: string;
    payTo: string;
    valueAtomic: string;
    nonce: string;
  };
  step3_200: {
    status: number;
    result: Record<string, unknown>;
  };
}

export function Sandbox({ onSettled }: SandboxProps) {
  const [tool, setTool] = useState<"ping" | "market_quote" | "edge_dns_lookup">("market_quote");
  const [phase, setPhase] = useState<"idle" | "running" | "settled" | "error">("idle");
  const [data, setData] = useState<SandboxRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSandbox = async () => {
    setPhase("running");
    setError(null);
    try {
      const res = await fetch("/api/sandbox/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool })
      });
      const json = (await res.json()) as SandboxRunResponse & { error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `Request failed (${res.status})`);
      }
      setData(json);
      setPhase("settled");
      onSettled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sandbox failed");
      setPhase("error");
    }
  };

  const active = phase === "settled";
  const running = phase === "running";

  return (
    <section className="cf-card rounded-2xl p-4 sm:p-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-zinc-200">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="h-2.5 w-2.5 rounded-full bg-[#F6821F] shrink-0" />
          <span className="font-mono text-xs font-medium uppercase tracking-wider text-zinc-900">
            Interactive Sandbox
          </span>
          <span className="font-mono text-[11px] text-zinc-500 bg-zinc-100 border border-zinc-200 px-2 py-0.5 rounded truncate max-w-full">
            demo.port4.dev/mcp
          </span>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          <select
            aria-label="Sandbox tool"
            value={tool}
            onChange={(e) => setTool(e.target.value as "ping" | "market_quote" | "edge_dns_lookup")}
            className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[36px] text-zinc-800 focus:outline-none focus:border-[#F6821F] w-full sm:w-auto"
          >
            <option value="market_quote">market_quote ($0.001)</option>
            <option value="ping">ping ($0.001)</option>
            <option value="edge_dns_lookup">edge_dns_lookup ($0.002)</option>
          </select>

          <button
            type="button"
            onClick={runSandbox}
            disabled={running}
            className="cf-btn-primary inline-flex items-center justify-center gap-2 rounded-lg px-4 min-h-[44px] sm:min-h-[36px] text-xs cursor-pointer disabled:opacity-60 w-full sm:w-auto"
          >
            {running ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            {running ? "Running..." : "Run 1-Click Test"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-2.5 my-4">
        <Stage icon={<Terminal className="w-3.5 h-3.5" />} label="1. POST /mcp" sub={tool} done={running || active} tone="orange" />
        <Stage icon={<ShieldAlert className="w-3.5 h-3.5" />} label="2. 402 Required" sub={data ? data.amountUsd + " USDC" : "PAYMENT-REQUIRED"} done={active} tone="amber" />
        <Stage icon={<KeyRound className="w-3.5 h-3.5" />} label="3. Sign USDC" sub="Base Sepolia" done={active} tone="orange" />
        <Stage icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="4. 200 OK" sub={data ? `${data.latencyMs}ms settled` : "PAYMENT-RESPONSE"} done={active} tone="green" />
      </div>

      {error && (
        <div className="mb-4 font-mono text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl bg-[#18181B] border border-zinc-800 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[#FBAD41]">
              402 Challenge → Signed Proof
            </span>
          </div>
          <pre className="font-mono text-[11px] leading-relaxed text-zinc-200 overflow-x-auto max-h-52">
            {data
              ? JSON.stringify(
                  {
                    status: data.step1_402.status,
                    accepts: data.step1_402.decoded.accepts,
                    signed: data.step2_signed
                  },
                  null,
                  2
                )
              : JSON.stringify(
                  {
                    endpoint: "POST https://demo.port4.dev/mcp",
                    method: "tools/call",
                    tool
                  },
                  null,
                  2
                )}
          </pre>
        </div>

        <div className="rounded-xl bg-[#18181B] border border-zinc-800 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[#F6821F]">
              200 OK · Tool Result
            </span>
            {data && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                SETTLED
              </span>
            )}
          </div>
          <pre className="font-mono text-[11px] leading-relaxed text-zinc-200 overflow-x-auto max-h-52">
            {data
              ? JSON.stringify(data.step3_200.result, null, 2)
              : "// Click 'Run 1-Click Test' to execute the live payment flow"}
          </pre>
        </div>
      </div>

      {data && (
        <div className="mt-4 pt-3 border-t border-zinc-200 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Tx:</span>
            <code className="text-zinc-800">
              {data.txHash.slice(0, 14)}...{data.txHash.slice(-8)}
            </code>
          </div>
          <a
            href={data.basescanUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#C25906] hover:underline"
          >
            BaseScan <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
    </section>
  );
}

function Stage({
  icon,
  label,
  sub,
  done,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  done: boolean;
  tone: "orange" | "amber" | "green";
}) {
  const palette = {
    orange: done
      ? "border-[#F6821F]/50 bg-[#F6821F]/10 text-[#C25906]"
      : "border-zinc-200 bg-zinc-50 text-zinc-400",
    amber: done
      ? "border-amber-400/60 bg-amber-50 text-amber-800"
      : "border-zinc-200 bg-zinc-50 text-zinc-400",
    green: done
      ? "border-emerald-500/50 bg-emerald-50 text-emerald-800"
      : "border-zinc-200 bg-zinc-50 text-zinc-400"
  };

  return (
    <div className={`rounded-xl border px-3 py-2.5 transition ${palette[tone]}`}>
      <div className="flex items-center gap-1.5 font-mono text-xs font-medium">
        {icon}
        <span>{label}</span>
      </div>
      <div className="font-mono text-[10px] opacity-80 mt-0.5 truncate">{sub}</div>
    </div>
  );
}
