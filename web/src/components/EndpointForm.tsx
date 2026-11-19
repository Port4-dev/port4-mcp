import { useState } from "react";
import { Plus, Trash2, Globe, Coins } from "lucide-react";

export interface ToolItem {
  id: string;
  name: string;
  description: string;
  http_method: string;
  upstream_path: string;
  price_usd: string;
}

export interface TenantItem {
  id: string;
  subdomain: string;
  name: string;
  upstream_base_url: string;
  payout_wallet: string;
  network: string;
  endpoint_url: string;
  tools: ToolItem[];
}

interface EndpointFormProps {
  tenants: TenantItem[];
  authenticated: boolean;
  onRequireDemoLogin: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function EndpointForm({
  tenants,
  authenticated,
  onRequireDemoLogin,
  onRefresh
}: EndpointFormProps) {
  const [subdomain, setSubdomain] = useState("");
  const [name, setName] = useState("");
  const [upstreamUrl, setUpstreamUrl] = useState("https://api.example.com");
  const [payoutWallet, setPayoutWallet] = useState(
    "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
  );
  const [toolName, setToolName] = useState("query_data");
  const [toolPath, setToolPath] = useState("/v1/query");
  const [priceUsd, setPriceUsd] = useState("0.005");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!authenticated) {
        await onRequireDemoLogin();
      }
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subdomain,
          name: name || subdomain,
          upstream_base_url: upstreamUrl,
          payout_wallet: payoutWallet,
          initial_tool: {
            name: toolName,
            description: `Paid MCP tool for ${name || subdomain}`,
            http_method: "POST",
            upstream_path: toolPath,
            price_usd: priceUsd
          }
        })
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to create endpoint");
      }
      setSubdomain("");
      setName("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/tenants/${id}`, { method: "DELETE" });
    await onRefresh();
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <form
        onSubmit={handleCreate}
        className="lg:col-span-5 p4-card rounded-2xl p-5 flex flex-col gap-3.5"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">New Paid Endpoint</h3>
          <span className="font-mono text-[11px] text-[#10B981]">Instant Publish</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Subdomain</span>
            <input
              required
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
              placeholder="weather"
              className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#0EA5E9]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weather API"
              className="text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#0EA5E9]"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">Upstream Base URL</span>
          <input
            required
            value={upstreamUrl}
            onChange={(e) => setUpstreamUrl(e.target.value)}
            className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#0EA5E9]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">Payout Wallet (USDC)</span>
          <input
            required
            value={payoutWallet}
            onChange={(e) => setPayoutWallet(e.target.value)}
            className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#0EA5E9]"
          />
        </label>

        <div className="grid grid-cols-3 gap-2.5 pt-2 border-t border-emerald-500/15">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Tool</span>
            <input
              required
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-2.5 py-2 text-white focus:outline-none focus:border-[#10B981]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Path</span>
            <input
              required
              value={toolPath}
              onChange={(e) => setToolPath(e.target.value)}
              className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-2.5 py-2 text-white focus:outline-none focus:border-[#10B981]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Price ($)</span>
            <input
              required
              value={priceUsd}
              onChange={(e) => setPriceUsd(e.target.value)}
              className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-lg px-2.5 py-2 text-[#10B981] focus:outline-none focus:border-[#10B981]"
            />
          </label>
        </div>

        {error && (
          <div className="font-mono text-xs text-rose-400 bg-rose-950/30 border border-rose-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="p4-btn-primary mt-1 inline-flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs cursor-pointer disabled:opacity-60"
        >
          <Plus className="w-4 h-4" />
          {submitting ? "Publishing..." : "Create Paid Endpoint"}
        </button>
      </form>

      <div className="lg:col-span-7 flex flex-col gap-3">
        {tenants.length === 0 ? (
          <div className="p4-card rounded-2xl p-8 text-center font-mono text-xs text-slate-400">
            No endpoints yet. Create one to start monetizing calls.
          </div>
        ) : (
          tenants.map((tenant) => (
            <div key={tenant.id} className="p4-card rounded-2xl p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-[#0EA5E9]" />
                    <span className="text-sm font-semibold text-white">{tenant.name}</span>
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-[#10B981] border border-emerald-500/30">
                      {tenant.network}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-[#0EA5E9] mt-1">{tenant.endpoint_url}</div>
                </div>

                {tenant.subdomain !== "demo" && (
                  <button
                    type="button"
                    onClick={() => handleDelete(tenant.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                    title="Delete endpoint"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {tenant.tools.map((tool) => (
                  <div
                    key={tool.id}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#050B14] border border-emerald-500/20 px-2.5 py-1.5 font-mono text-[11px]"
                  >
                    <span className="text-slate-200">{tool.name}</span>
                    <span className="text-slate-500">{tool.http_method}</span>
                    <span className="inline-flex items-center gap-1 text-[#10B981]">
                      <Coins className="w-3 h-3" />${tool.price_usd}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
