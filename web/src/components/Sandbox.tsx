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
    <section className="p4-card rounded-2xl p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-emerald-500/20">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#10B981] shadow-[0_0_10px_#10B981]" />
          <span className="font-mono text-xs uppercase tracking-wider text-[#0EA5E9]">
            Live x402 Sandbox
          </span>
          <span className="font-mono text-xs text-slate-400 bg-[#050B14] border border-emerald-500/20 px-2 py-0.5 rounded">
            demo.port4.dev/mcp
          </span>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Sandbox tool"
            value={tool}
            onChange={(e) => setTool(e.target.value as "ping" | "market_quote" | "edge_dns_lookup")}
            className="font-mono text-xs bg-[#050B14] border border-emerald-500/25 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-[#0EA5E9]"
          >
            <option value="market_quote">market_quote ($0.001)</option>
            <option value="ping">ping ($0.001)</option>
            <option value="edge_dns_lookup">edge_dns_lookup ($0.002)</option>
          </select>

          <button
            type="button"
            onClick={runSandbox}
            disabled={running}
            className="p4-btn-primary inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-xs cursor-pointer disabled:opacity-60"
          >
            {running ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            {running ? "Settling..." : "Run 1-Click x402"}
          </button>
        </div>
      </div>

      {/* 4-Stage Pipeline */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 my-4">
        <Stage
          icon={<Terminal className="w-3.5 h-3.5" />}
          label="1. POST /mcp"
          sub={tool}
          done={running || active}
          tone="blue"
        />
        <Stage
          icon={<ShieldAlert className="w-3.5 h-3.5" />}
          label="2. 402 Required"
          sub={data ? data.amountUsd + " USDC" : "PAYMENT-REQUIRED"}
          done={active}
          tone="amber"
        />
        <Stage
          icon={<KeyRound className="w-3.5 h-3.5" />}
          label="3. Sign USDC"
          sub="Base Sepolia"
          done={active}
          tone="blue"
        />
        <Stage
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          label="4. 200 OK"
          sub={data ? `${data.latencyMs}ms settled` : "PAYMENT-RESPONSE"}
          done={active}
          tone="green"
        />
      </div>

      {error && (
        <div className="mb-4 font-mono text-xs text-rose-400 bg-rose-950/30 border border-rose-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Trace Panes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl bg-[#050B14] border border-emerald-500/20 p-3.5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[#0EA5E9]">
              402 Challenge → Signed Proof
            </span>
            {data?.isPlatformFee && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                Platform Fee Split
              </span>
            )}
          </div>
          <pre className="font-mono text-[11px] leading-relaxed text-slate-300 overflow-x-auto max-h-52">
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
                    tool,
                    network: "eip155:84532"
                  },
                  null,
                  2
                )}
          </pre>
        </div>

        <div className="rounded-xl bg-[#050B14] border border-emerald-500/20 p-3.5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[#10B981]">
              200 OK · Tool Result
            </span>
            {data && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                SETTLED
              </span>
            )}
          </div>
          <pre className="font-mono text-[11px] leading-relaxed text-emerald-100/90 overflow-x-auto max-h-52">
            {data
              ? JSON.stringify(data.step3_200.result, null, 2)
              : "// Click 'Run 1-Click x402' to settle on Base Sepolia"}
          </pre>
        </div>
      </div>

      {data && (
        <div className="mt-4 pt-3 border-t border-emerald-500/20 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
          <div className="flex items-center gap-2 text-[#10B981]">
            <CheckCircle2 className="w-4 h-4" />
            <span>Tx:</span>
            <code className="text-slate-200">
              {data.txHash.slice(0, 14)}...{data.txHash.slice(-8)}
            </code>
          </div>
          <a
            href={data.basescanUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#0EA5E9] hover:underline"
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
  tone: "blue" | "amber" | "green";
}) {
  const palette = {
    blue: done
      ? "border-[#0EA5E9]/50 bg-[#0EA5E9]/10 text-[#0EA5E9]"
      : "border-slate-800 bg-[#050B14] text-slate-500",
    amber: done
      ? "border-amber-400/50 bg-amber-400/10 text-amber-300"
      : "border-slate-800 bg-[#050B14] text-slate-500",
    green: done
      ? "border-[#10B981]/50 bg-[#10B981]/10 text-[#10B981]"
      : "border-slate-800 bg-[#050B14] text-slate-500"
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
