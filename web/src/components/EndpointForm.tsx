import { useState } from "react";
import { Check, Coins, Copy, Globe, Play, Plus, Trash2 } from "lucide-react";

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

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [addingToolFor, setAddingToolFor] = useState<string | null>(null);
  const [newToolName, setNewToolName] = useState("");
  const [newToolPath, setNewToolPath] = useState("/v1/action");
  const [newToolPrice, setNewToolPrice] = useState("0.002");
  const [liveProbe, setLiveProbe] = useState<{ tenantId: string; output: string } | null>(null);

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

  const handleAddTool = async (tenantId: string) => {
    if (!newToolName.trim() || !newToolPath.trim()) return;
    await fetch(`/api/tenants/${tenantId}/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newToolName.trim(),
        description: `Paid MCP tool ${newToolName.trim()}`,
        http_method: "POST",
        upstream_path: newToolPath.trim(),
        price_usd: newToolPrice.trim() || "0.001"
      })
    });
    setNewToolName("");
    setAddingToolFor(null);
    await onRefresh();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/tenants/${id}`, { method: "DELETE" });
    await onRefresh();
  };

  const copyMcpConfig = (tenant: TenantItem) => {
    const config = JSON.stringify(
      {
        mcpServers: {
          [tenant.subdomain]: {
            url: tenant.endpoint_url,
            headers: {
              "MCP-Protocol-Version": "2026-07-28"
            }
          }
        }
      },
      null,
      2
    );
    void navigator.clipboard.writeText(config);
    setCopiedId(tenant.id);
    setTimeout(() => setCopiedId(null), 1600);
  };

  const testToolsListLive = async (tenant: TenantItem) => {
    setLiveProbe({ tenantId: tenant.id, output: `Calling POST /mcp/${tenant.subdomain} (tools/list)...` });
    try {
      const res = await fetch(`/mcp/${encodeURIComponent(tenant.subdomain)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      const json = (await res.json()) as unknown;
      setLiveProbe({
        tenantId: tenant.id,
        output: JSON.stringify(json, null, 2)
      });
    } catch (err) {
      setLiveProbe({
        tenantId: tenant.id,
        output: err instanceof Error ? err.message : "Probe failed"
      });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-w-0">
      <form
        onSubmit={handleCreate}
        className="lg:col-span-5 cf-card rounded-2xl p-4 sm:p-5 flex flex-col gap-3.5 h-fit min-w-0"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-900">New Paid Endpoint</h3>
          <span className="font-mono text-[11px] text-[#E06D0C]">Instant Publish</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-600">Subdomain</span>
            <input
              required
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
              placeholder="weather"
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-600">Display Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weather API"
              className="text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-zinc-600">Upstream Base URL</span>
          <input
            required
            value={upstreamUrl}
            onChange={(e) => setUpstreamUrl(e.target.value)}
            className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-zinc-600">Payout Wallet (USDC)</span>
          <input
            required
            value={payoutWallet}
            onChange={(e) => setPayoutWallet(e.target.value)}
            className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-zinc-200">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-600">Tool</span>
            <input
              required
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-600">Path</span>
            <input
              required
              value={toolPath}
              onChange={(e) => setToolPath(e.target.value)}
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-600">Price ($)</span>
            <input
              required
              value={priceUsd}
              onChange={(e) => setPriceUsd(e.target.value)}
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[38px] text-[#C25906] font-medium focus:outline-none focus:border-[#F6821F]"
            />
          </label>
        </div>

        {error && (
          <div className="font-mono text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="cf-btn-primary mt-1 inline-flex items-center justify-center gap-2 rounded-lg min-h-[44px] text-xs cursor-pointer disabled:opacity-60"
        >
          <Plus className="w-4 h-4" />
          {submitting ? "Publishing..." : "Create Paid Endpoint"}
        </button>
      </form>

      <div className="lg:col-span-7 flex flex-col gap-3 min-w-0">
        {tenants.length === 0 ? (
          <div className="cf-card rounded-2xl p-8 text-center font-mono text-xs text-zinc-500">
            No endpoints yet. Create one to get your live MCP URL and client config.
          </div>
        ) : (
          tenants.map((tenant) => (
            <div key={tenant.id} className="cf-card rounded-2xl p-4 flex flex-col gap-3 min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Globe className="w-4 h-4 text-[#F6821F] shrink-0" />
                    <span className="text-sm font-semibold text-zinc-900">{tenant.name}</span>
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-[#F6821F]/10 text-[#C25906] border border-[#F6821F]/25">
                      {tenant.network}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-zinc-600 mt-1 break-all">
                    {tenant.endpoint_url}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => testToolsListLive(tenant)}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 min-h-[40px] sm:min-h-[32px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                  >
                    <Play className="w-3 h-3 text-[#F6821F]" />
                    Test MCP
                  </button>
                  <button
                    type="button"
                    onClick={() => copyMcpConfig(tenant)}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 min-h-[40px] sm:min-h-[32px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                  >
                    {copiedId === tenant.id ? (
                      <Check className="w-3 h-3 text-emerald-600" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {copiedId === tenant.id ? "Copied" : "MCP JSON"}
                  </button>
                  {tenant.subdomain !== "demo" && (
                    <button
                      type="button"
                      onClick={() => handleDelete(tenant.id)}
                      className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] sm:min-w-[32px] sm:min-h-[32px] rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                      title="Delete endpoint"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {tenant.tools.map((tool) => (
                  <div
                    key={tool.id}
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-50 border border-zinc-200 px-2.5 py-1.5 font-mono text-[11px]"
                  >
                    <span className="text-zinc-900 font-medium">{tool.name}</span>
                    <span className="text-zinc-400">{tool.http_method}</span>
                    <span className="inline-flex items-center gap-1 text-[#C25906] font-medium">
                      <Coins className="w-3 h-3 text-[#F6821F]" />${tool.price_usd}
                    </span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setAddingToolFor(addingToolFor === tenant.id ? null : tenant.id)
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 font-mono text-[11px] text-zinc-600 hover:border-[#F6821F] hover:text-[#C25906] cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  Add Tool
                </button>
              </div>

              {addingToolFor === tenant.id && (
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-2 border-t border-zinc-200">
                  <input
                    value={newToolName}
                    onChange={(e) => setNewToolName(e.target.value)}
                    placeholder="tool_name"
                    className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5"
                  />
                  <input
                    value={newToolPath}
                    onChange={(e) => setNewToolPath(e.target.value)}
                    placeholder="/v1/path"
                    className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5"
                  />
                  <input
                    value={newToolPrice}
                    onChange={(e) => setNewToolPrice(e.target.value)}
                    placeholder="0.002"
                    className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 py-1.5"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddTool(tenant.id)}
                    className="cf-btn-primary rounded-lg text-xs py-1.5 cursor-pointer"
                  >
                    Save Tool
                  </button>
                </div>
              )}

              {liveProbe && liveProbe.tenantId === tenant.id && (
                <pre className="font-mono text-[11px] bg-[#18181B] text-zinc-200 rounded-xl p-3 overflow-x-auto max-h-48">
                  {liveProbe.output}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
