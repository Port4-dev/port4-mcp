import { useEffect, useState } from "react";
import {
  Check,
  Coins,
  Copy,
  Globe,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X
} from "lucide-react";

export interface ToolItem {
  id: string;
  name: string;
  description: string;
  http_method: "GET" | "POST" | "PUT" | "DELETE";
  upstream_path: string;
  input_schema_json: string;
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

const DRAFT_KEY = "port4_endpoint_draft_v1";
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

interface DraftState {
  subdomain: string;
  name: string;
  upstreamUrl: string;
  payoutWallet: string;
  network: "eip155:84532" | "eip155:8453";
  toolName: string;
  toolDescription: string;
  toolMethod: "GET" | "POST" | "PUT" | "DELETE";
  toolPath: string;
  priceUsd: string;
  inputSchemaJson: string;
}

const EMPTY_DRAFT: DraftState = {
  subdomain: "",
  name: "",
  upstreamUrl: "",
  payoutWallet: "",
  network: "eip155:84532",
  toolName: "",
  toolDescription: "",
  toolMethod: "POST",
  toolPath: "/v1/query",
  priceUsd: "0.005",
  inputSchemaJson: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}'
};

function loadDraft(): DraftState {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      return { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<DraftState>) };
    }
  } catch {
    // ignore storage errors
  }
  return EMPTY_DRAFT;
}

export function EndpointForm({
  tenants,
  authenticated,
  onRequireDemoLogin,
  onRefresh
}: EndpointFormProps) {
  const [draft, setDraft] = useState<DraftState>(loadDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<{
    subdomain: string;
    secret: string;
    verifyUrl?: string;
    verifyToken?: string;
  } | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingTenantId, setEditingTenantId] = useState<string | null>(null);
  const [tenantEdit, setTenantEdit] = useState({
    name: "",
    upstream_base_url: "",
    payout_wallet: "",
    network: "eip155:84532"
  });

  const [editingTool, setEditingTool] = useState<{
    tenantId: string;
    toolId: string;
    name: string;
    description: string;
    http_method: "GET" | "POST" | "PUT" | "DELETE";
    upstream_path: string;
    price_usd: string;
    input_schema_json: string;
  } | null>(null);

  const [addingToolFor, setAddingToolFor] = useState<string | null>(null);
  const [newTool, setNewTool] = useState({
    name: "",
    description: "",
    http_method: "POST" as "GET" | "POST" | "PUT" | "DELETE",
    upstream_path: "/v1/action",
    price_usd: "0.002",
    input_schema_json: '{"type":"object","properties":{}}'
  });

  const [liveProbe, setLiveProbe] = useState<{ tenantId: string; output: string } | null>(null);
  const [testCallFor, setTestCallFor] = useState<{
    tenantId: string;
    toolName: string;
    argsJson: string;
    running: boolean;
    output: string | null;
  } | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // ignore
    }
  }, [draft]);

  const updateDraft = <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!WALLET_RE.test(draft.payoutWallet.trim())) {
      setError("Enter your own valid 0x EVM payout wallet address.");
      return;
    }
    try {
      JSON.parse(draft.inputSchemaJson || "{}");
    } catch {
      setError("Tool Input JSON Schema must be valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      if (!authenticated) {
        await onRequireDemoLogin();
      }
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subdomain: draft.subdomain.trim().toLowerCase(),
          name: draft.name.trim() || draft.subdomain.trim(),
          upstream_base_url: draft.upstreamUrl.trim(),
          payout_wallet: draft.payoutWallet.trim(),
          network: draft.network,
          initial_tool: draft.toolName.trim()
            ? {
                name: draft.toolName.trim(),
                description:
                  draft.toolDescription.trim() || `Paid MCP tool ${draft.toolName.trim()}`,
                http_method: draft.toolMethod,
                upstream_path: draft.toolPath.trim(),
                price_usd: draft.priceUsd.trim() || "0.005",
                input_schema_json: draft.inputSchemaJson.trim() || '{"type":"object","properties":{}}'
              }
            : undefined
        })
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        upstream_signing_secret?: string;
        verification?: { token?: string; well_known_url?: string };
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to create endpoint");
      }
      if (data.upstream_signing_secret) {
        setCreatedSecret({
          subdomain: draft.subdomain.trim().toLowerCase(),
          secret: data.upstream_signing_secret,
          verifyUrl: data.verification?.well_known_url,
          verifyToken: data.verification?.token
        });
      }
      setDraft(EMPTY_DRAFT);
      sessionStorage.removeItem(DRAFT_KEY);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint");
    } finally {
      setSubmitting(false);
    }
  };

  const startEditTenant = (t: TenantItem) => {
    setEditingTenantId(t.id);
    setTenantEdit({
      name: t.name,
      upstream_base_url: t.upstream_base_url,
      payout_wallet: t.payout_wallet,
      network: t.network
    });
  };

  const saveEditTenant = async (tenantId: string) => {
    const res = await fetch(`/api/tenants/${tenantId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tenantEdit)
    });
    if (!res.ok) {
      const err = (await res.json()) as { message?: string; error?: string };
      setError(err.message || err.error || "Failed to update endpoint");
      return;
    }
    setEditingTenantId(null);
    await onRefresh();
  };

  const rotateSecret = async (tenant: TenantItem) => {
    const res = await fetch(`/api/tenants/${tenant.id}/rotate-secret`, { method: "POST" });
    if (res.ok) {
      const data = (await res.json()) as { upstream_signing_secret: string };
      setCreatedSecret({ subdomain: tenant.subdomain, secret: data.upstream_signing_secret });
    }
  };

  const syncMcpTools = async (tenant: TenantItem) => {
    setLiveProbe({ tenantId: tenant.id, output: "Syncing tools/list from upstream MCP server..." });
    const res = await fetch(`/api/tenants/${tenant.id}/sync-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_price_usd: "0.005" })
    });
    const data = await res.json();
    setLiveProbe({ tenantId: tenant.id, output: JSON.stringify(data, null, 2) });
    if (res.ok) await onRefresh();
  };

  const saveEditTool = async () => {
    if (!editingTool) return;
    try {
      JSON.parse(editingTool.input_schema_json || "{}");
    } catch {
      setError("Tool Input JSON Schema must be valid JSON.");
      return;
    }
    const res = await fetch(`/api/tenants/${editingTool.tenantId}/tools/${editingTool.toolId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editingTool.name,
        description: editingTool.description,
        http_method: editingTool.http_method,
        upstream_path: editingTool.upstream_path,
        price_usd: editingTool.price_usd,
        input_schema_json: editingTool.input_schema_json
      })
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setError(err.error || "Failed to update tool");
      return;
    }
    setEditingTool(null);
    await onRefresh();
  };

  const handleAddTool = async (tenantId: string) => {
    if (!newTool.name.trim() || !newTool.upstream_path.trim()) return;
    const res = await fetch(`/api/tenants/${tenantId}/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newTool.name.trim(),
        description: newTool.description.trim() || `Paid MCP tool ${newTool.name.trim()}`,
        http_method: newTool.http_method,
        upstream_path: newTool.upstream_path.trim(),
        price_usd: newTool.price_usd.trim() || "0.002",
        input_schema_json: newTool.input_schema_json.trim() || '{"type":"object","properties":{}}'
      })
    });
    if (res.ok) {
      setNewTool({
        name: "",
        description: "",
        http_method: "POST",
        upstream_path: "/v1/action",
        price_usd: "0.002",
        input_schema_json: '{"type":"object","properties":{}}'
      });
      setAddingToolFor(null);
      await onRefresh();
    }
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
            headers: { "MCP-Protocol-Version": "2026-07-28" }
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
    setLiveProbe({
      tenantId: tenant.id,
      output: `Calling POST /mcp/${tenant.subdomain} (tools/list)...`
    });
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
      setLiveProbe({ tenantId: tenant.id, output: JSON.stringify(json, null, 2) });
    } catch (err) {
      setLiveProbe({
        tenantId: tenant.id,
        output: err instanceof Error ? err.message : "Probe failed"
      });
    }
  };

  const runOwnerTestCall = async () => {
    if (!testCallFor) return;
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(testCallFor.argsJson || "{}") as Record<string, unknown>;
    } catch {
      setTestCallFor((prev) => (prev ? { ...prev, output: "Invalid JSON arguments." } : null));
      return;
    }

    setTestCallFor((prev) => (prev ? { ...prev, running: true, output: "Calling upstream..." } : null));
    try {
      const res = await fetch(`/api/tenants/${testCallFor.tenantId}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_name: testCallFor.toolName, arguments: parsedArgs })
      });
      const json = (await res.json()) as unknown;
      setTestCallFor((prev) =>
        prev ? { ...prev, running: false, output: JSON.stringify(json, null, 2) } : null
      );
    } catch (err) {
      setTestCallFor((prev) =>
        prev
          ? { ...prev, running: false, output: err instanceof Error ? err.message : "Test failed" }
          : null
      );
    }
  };

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {/* One-time HMAC Signing Secret Banner */}
      {createdSecret && (
        <div className="cf-card rounded-2xl p-4 border-[#F6821F]/40 bg-orange-50/40 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-900">
              Upstream HMAC Signing Secret for <code className="font-mono">{createdSecret.subdomain}</code> (shown once)
            </span>
            <button
              type="button"
              onClick={() => setCreatedSecret(null)}
              className="p-1 text-zinc-500 hover:text-zinc-900 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <code className="font-mono text-xs bg-white border border-zinc-200 rounded-lg px-3 py-2 break-all text-zinc-900">
            {createdSecret.secret}
          </code>
          <p className="text-[11px] text-zinc-600">
            Verify <code className="font-mono">X-Port4-Signature: v1=&lt;hmac_sha256&gt;</code> &amp;{" "}
            <code className="font-mono">X-Port4-Timestamp</code> on your origin so unauthenticated traffic cannot bypass x402.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-w-0">
        {/* Create Form (Draft Preserved Across Tab Switches) */}
        <form
          onSubmit={handleCreate}
          className="lg:col-span-5 cf-card rounded-2xl p-4 sm:p-5 flex flex-col gap-3.5 h-fit min-w-0"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-900">New Paid Endpoint</h3>
            <span className="font-mono text-[11px] text-[#E06D0C]">Draft Auto-Saved</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-600">Subdomain</span>
              <input
                required
                value={draft.subdomain}
                onChange={(e) => updateDraft("subdomain", e.target.value.toLowerCase())}
                placeholder="weather"
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-600">Display Name</span>
              <input
                value={draft.name}
                onChange={(e) => updateDraft("name", e.target.value)}
                placeholder="Weather API"
                className="text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-600">Upstream Base URL (HTTPS)</span>
            <input
              required
              value={draft.upstreamUrl}
              onChange={(e) => updateDraft("upstreamUrl", e.target.value)}
              placeholder="https://api.example.com"
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-600">Payout Wallet (0x USDC)</span>
              <input
                required
                value={draft.payoutWallet}
                onChange={(e) => updateDraft("payoutWallet", e.target.value)}
                placeholder="0xYourWalletAddress..."
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-600">Settlement Network</span>
              <select
                value={draft.network}
                onChange={(e) =>
                  updateDraft("network", e.target.value as "eip155:84532" | "eip155:8453")
                }
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[38px] text-zinc-900 focus:outline-none focus:border-[#F6821F]"
              >
                <option value="eip155:84532">Base Sepolia (Testnet)</option>
                <option value="eip155:8453">Base Mainnet (Real USDC)</option>
              </select>
            </label>
          </div>

          <div className="pt-2 border-t border-zinc-200 flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Initial Tool Definition
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                required
                value={draft.toolName}
                onChange={(e) => updateDraft("toolName", e.target.value)}
                placeholder="search_rooms"
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[36px]"
              />
              <select
                value={draft.toolMethod}
                onChange={(e) =>
                  updateDraft("toolMethod", e.target.value as "GET" | "POST" | "PUT" | "DELETE")
                }
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[36px]"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
              <input
                required
                value={draft.priceUsd}
                onChange={(e) => updateDraft("priceUsd", e.target.value)}
                placeholder="0.005"
                className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[44px] sm:min-h-[36px] text-[#C25906] font-medium"
              />
            </div>

            <input
              required
              value={draft.toolPath}
              onChange={(e) => updateDraft("toolPath", e.target.value)}
              placeholder="/api/v1/properties/{id}"
              className="font-mono text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[36px]"
            />

            <input
              value={draft.toolDescription}
              onChange={(e) => updateDraft("toolDescription", e.target.value)}
              placeholder="Describe what this tool does for AI agents..."
              className="text-sm sm:text-xs bg-white border border-zinc-300 rounded-lg px-3 min-h-[44px] sm:min-h-[36px]"
            />

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-600">
                inputSchema (JSON Schema for AI agents)
              </span>
              <textarea
                rows={4}
                value={draft.inputSchemaJson}
                onChange={(e) => updateDraft("inputSchemaJson", e.target.value)}
                className="font-mono text-xs bg-zinc-50 border border-zinc-300 rounded-lg p-2.5 text-zinc-900 focus:outline-none focus:border-[#F6821F]"
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

        {/* Active Endpoints List */}
        <div className="lg:col-span-7 flex flex-col gap-3 min-w-0">
          {tenants.length === 0 ? (
            <div className="cf-card rounded-2xl p-8 text-center font-mono text-xs text-zinc-500">
              No endpoints yet. Create one to get your live MCP URL, HMAC signing secret, and client config.
            </div>
          ) : (
            tenants.map((tenant) => {
              const isMainnet = tenant.network === "eip155:8453";
              return (
                <div key={tenant.id} className="cf-card rounded-2xl p-4 flex flex-col gap-3 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Globe className="w-4 h-4 text-[#F6821F] shrink-0" />
                        <span className="text-sm font-semibold text-zinc-900">{tenant.name}</span>
                        <span
                          className={`font-mono text-[10px] px-2 py-0.5 rounded border ${
                            isMainnet
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-[#F6821F]/10 text-[#C25906] border-[#F6821F]/25"
                          }`}
                        >
                          {isMainnet ? "Base Mainnet · Real USDC" : "Base Sepolia · Testnet"}
                        </span>
                      </div>
                      <div className="font-mono text-xs text-zinc-600 mt-1 break-all">
                        {tenant.endpoint_url}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => testToolsListLive(tenant)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 min-h-[38px] sm:min-h-[30px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                      >
                        <Play className="w-3 h-3 text-[#F6821F]" />
                        tools/list
                      </button>
                      {tenant.tools.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setTestCallFor(
                              testCallFor?.tenantId === tenant.id
                                ? null
                                : {
                                    tenantId: tenant.id,
                                    toolName: tenant.tools[0].name,
                                    argsJson: "{}",
                                    running: false,
                                    output: null
                                  }
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 min-h-[38px] sm:min-h-[30px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                        >
                          <Send className="w-3 h-3 text-[#F6821F]" />
                          Test Call
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => copyMcpConfig(tenant)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 min-h-[38px] sm:min-h-[30px] font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                      >
                        {copiedId === tenant.id ? (
                          <Check className="w-3 h-3 text-emerald-600" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {copiedId === tenant.id ? "Copied" : "MCP JSON"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          editingTenantId === tenant.id
                            ? setEditingTenantId(null)
                            : startEditTenant(tenant)
                        }
                        className="inline-flex items-center justify-center min-w-[38px] min-h-[38px] sm:min-w-[30px] sm:min-h-[30px] rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-600 hover:border-[#F6821F] cursor-pointer"
                        title="Edit endpoint"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {tenant.subdomain !== "demo" && (
                        <button
                          type="button"
                          onClick={() => handleDelete(tenant.id)}
                          className="inline-flex items-center justify-center min-w-[38px] min-h-[38px] sm:min-w-[30px] sm:min-h-[30px] rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                          title="Delete endpoint"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* In-Place Endpoint Editor */}
                  {editingTenantId === tenant.id && (
                    <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-3 flex flex-col gap-2.5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          value={tenantEdit.name}
                          onChange={(e) => setTenantEdit((p) => ({ ...p, name: e.target.value }))}
                          placeholder="Display Name"
                          className="text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[38px]"
                        />
                        <select
                          value={tenantEdit.network}
                          onChange={(e) =>
                            setTenantEdit((p) => ({ ...p, network: e.target.value }))
                          }
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[38px]"
                        >
                          <option value="eip155:84532">Base Sepolia (Testnet)</option>
                          <option value="eip155:8453">Base Mainnet (Real USDC)</option>
                        </select>
                      </div>
                      <input
                        value={tenantEdit.upstream_base_url}
                        onChange={(e) =>
                          setTenantEdit((p) => ({ ...p, upstream_base_url: e.target.value }))
                        }
                        placeholder="https://api.example.com"
                        className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[38px]"
                      />
                      <input
                        value={tenantEdit.payout_wallet}
                        onChange={(e) =>
                          setTenantEdit((p) => ({ ...p, payout_wallet: e.target.value }))
                        }
                        placeholder="0xPayoutWallet"
                        className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[38px]"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => rotateSecret(tenant)}
                            className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                          >
                            <KeyRound className="w-3 h-3" />
                            Rotate HMAC Secret
                          </button>
                          <button
                            type="button"
                            onClick={() => syncMcpTools(tenant)}
                            className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-[11px] text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Sync MCP
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => saveEditTenant(tenant.id)}
                          className="cf-btn-primary rounded-lg px-4 py-1.5 text-xs cursor-pointer"
                        >
                          Save Changes
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Tools List with In-Place Edit */}
                  <div className="flex flex-wrap items-center gap-2">
                    {tenant.tools.map((tool) => (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() =>
                          setEditingTool({
                            tenantId: tenant.id,
                            toolId: tool.id,
                            name: tool.name,
                            description: tool.description,
                            http_method: tool.http_method,
                            upstream_path: tool.upstream_path,
                            price_usd: tool.price_usd,
                            input_schema_json: tool.input_schema_json
                          })
                        }
                        className="inline-flex items-center gap-2 rounded-lg bg-zinc-50 border border-zinc-200 hover:border-[#F6821F] px-2.5 py-1.5 font-mono text-[11px] cursor-pointer"
                        title="Click to edit tool schema, method, description & price"
                      >
                        <span className="text-zinc-900 font-medium">{tool.name}</span>
                        <span className="text-zinc-400">{tool.http_method}</span>
                        <span className="inline-flex items-center gap-1 text-[#C25906] font-medium">
                          <Coins className="w-3 h-3 text-[#F6821F]" />${tool.price_usd}
                        </span>
                        <Pencil className="w-2.5 h-2.5 text-zinc-400" />
                      </button>
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

                  {/* In-Place Tool Editor */}
                  {editingTool && editingTool.tenantId === tenant.id && (
                    <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-900">
                          Edit Tool: <code className="font-mono">{editingTool.name}</code>
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditingTool(null)}
                          className="text-zinc-400 hover:text-zinc-700 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select
                          value={editingTool.http_method}
                          onChange={(e) =>
                            setEditingTool((p) =>
                              p ? { ...p, http_method: e.target.value as "GET" | "POST" | "PUT" | "DELETE" } : null
                            )
                          }
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                        <input
                          value={editingTool.upstream_path}
                          onChange={(e) =>
                            setEditingTool((p) => (p ? { ...p, upstream_path: e.target.value } : null))
                          }
                          placeholder="/api/v1/items/{id}"
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        />
                        <input
                          value={editingTool.price_usd}
                          onChange={(e) =>
                            setEditingTool((p) => (p ? { ...p, price_usd: e.target.value } : null))
                          }
                          placeholder="0.005"
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        />
                      </div>
                      <input
                        value={editingTool.description}
                        onChange={(e) =>
                          setEditingTool((p) => (p ? { ...p, description: e.target.value } : null))
                        }
                        placeholder="Rich description for AI agents"
                        className="text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                      />
                      <textarea
                        rows={4}
                        value={editingTool.input_schema_json}
                        onChange={(e) =>
                          setEditingTool((p) =>
                            p ? { ...p, input_schema_json: e.target.value } : null
                          )
                        }
                        className="font-mono text-xs bg-white border border-zinc-300 rounded-lg p-2.5"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={saveEditTool}
                          className="cf-btn-primary rounded-lg px-4 py-1.5 text-xs cursor-pointer"
                        >
                          Save Tool
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Add Tool Inline Form */}
                  {addingToolFor === tenant.id && (
                    <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-3 flex flex-col gap-2">
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                        <input
                          value={newTool.name}
                          onChange={(e) => setNewTool((p) => ({ ...p, name: e.target.value }))}
                          placeholder="tool_name"
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        />
                        <select
                          value={newTool.http_method}
                          onChange={(e) =>
                            setNewTool((p) => ({
                              ...p,
                              http_method: e.target.value as "GET" | "POST" | "PUT" | "DELETE"
                            }))
                          }
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                        <input
                          value={newTool.upstream_path}
                          onChange={(e) =>
                            setNewTool((p) => ({ ...p, upstream_path: e.target.value }))
                          }
                          placeholder="/v1/path/{id}"
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        />
                        <input
                          value={newTool.price_usd}
                          onChange={(e) => setNewTool((p) => ({ ...p, price_usd: e.target.value }))}
                          placeholder="0.002"
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                        />
                      </div>
                      <input
                        value={newTool.description}
                        onChange={(e) => setNewTool((p) => ({ ...p, description: e.target.value }))}
                        placeholder="Tool description for AI agents"
                        className="text-xs bg-white border border-zinc-300 rounded-lg px-2.5 min-h-[36px]"
                      />
                      <textarea
                        rows={3}
                        value={newTool.input_schema_json}
                        onChange={(e) =>
                          setNewTool((p) => ({ ...p, input_schema_json: e.target.value }))
                        }
                        className="font-mono text-xs bg-white border border-zinc-300 rounded-lg p-2"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleAddTool(tenant.id)}
                          className="cf-btn-primary rounded-lg px-4 py-1.5 text-xs cursor-pointer"
                        >
                          Save Tool
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Owner Live `tools/call` Sandbox */}
                  {testCallFor && testCallFor.tenantId === tenant.id && (
                    <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-3 flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-zinc-900">
                          Live Upstream Test Call (HMAC Signed)
                        </span>
                        <select
                          value={testCallFor.toolName}
                          onChange={(e) =>
                            setTestCallFor((p) => (p ? { ...p, toolName: e.target.value } : null))
                          }
                          className="font-mono text-xs bg-white border border-zinc-300 rounded-lg px-2.5 py-1"
                        >
                          {tenant.tools.map((tl) => (
                            <option key={tl.id} value={tl.name}>
                              {tl.http_method} {tl.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        rows={3}
                        value={testCallFor.argsJson}
                        onChange={(e) =>
                          setTestCallFor((p) => (p ? { ...p, argsJson: e.target.value } : null))
                        }
                        placeholder='{"id": "123"}'
                        className="font-mono text-xs bg-white border border-zinc-300 rounded-lg p-2"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={testCallFor.running}
                          onClick={runOwnerTestCall}
                          className="cf-btn-primary rounded-lg px-4 py-1.5 text-xs cursor-pointer disabled:opacity-60"
                        >
                          {testCallFor.running ? "Calling..." : "Fire Test Call"}
                        </button>
                      </div>
                      {testCallFor.output && (
                        <pre className="font-mono text-[11px] bg-[#18181B] text-zinc-200 rounded-xl p-3 overflow-x-auto max-h-56">
                          {testCallFor.output}
                        </pre>
                      )}
                    </div>
                  )}

                  {liveProbe && liveProbe.tenantId === tenant.id && (
                    <pre className="font-mono text-[11px] bg-[#18181B] text-zinc-200 rounded-xl p-3 overflow-x-auto max-h-48">
                      {liveProbe.output}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
