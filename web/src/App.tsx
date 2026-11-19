import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Coins,
  Copy,
  Github,
  Globe,
  KeyRound,
  Layers,
  LogOut,
  ReceiptText,
  ShieldCheck,
  TerminalSquare
} from "lucide-react";
import { Sandbox } from "./components/Sandbox";
import { EndpointForm, type TenantItem } from "./components/EndpointForm";
import { RevenueTable, type LedgerTransaction } from "./components/RevenueTable";
import { Docs } from "./components/Docs";
import { AdminDashboard } from "./components/AdminDashboard";

type PageView = "home" | "dashboard" | "docs" | "admin";
type DashboardTab = "endpoints" | "ledger" | "deploy";

interface AuthState {
  authenticated: boolean;
  githubConfigured: boolean;
  user: {
    id: string;
    login: string;
    avatar_url: string | null;
    is_admin: number;
    plan: "free" | "pro";
  } | null;
}

interface FeaturedTenant {
  id: string;
  slug: string;
  name: string;
  network: string;
  call_count: number;
  endpoint_url: string;
  tools: Array<{ id: string; name: string; description: string; price_usd: string }>;
}

function viewFromPath(pathname: string): PageView {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/dashboard" || clean === "/console") return "dashboard";
  if (clean === "/docs") return "docs";
  if (clean === "/admin") return "admin";
  return "home";
}

function pathFromView(view: PageView): string {
  if (view === "dashboard") return "/dashboard";
  if (view === "docs") return "/docs";
  if (view === "admin") return "/admin";
  return "/";
}

export default function App() {
  const [view, setView] = useState<PageView>(() => viewFromPath(window.location.pathname));
  const [tab, setTab] = useState<DashboardTab>("endpoints");
  const [auth, setAuth] = useState<AuthState>({
    authenticated: false,
    githubConfigured: false,
    user: null
  });
  const [featured, setFeatured] = useState<FeaturedTenant[]>([]);
  const [tenants, setTenants] = useState<TenantItem[]>([]);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [summary, setSummary] = useState({ total_calls: 0, total_usd: "0.0000", avg_latency_ms: 0 });
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const navigate = useCallback((next: PageView) => {
    setView(next);
    const targetPath = pathFromView(next);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadData = useCallback(async () => {
    const [meRes, featRes] = await Promise.all([
      fetch("/api/auth/me"),
      fetch("/api/public/featured")
    ]);
    const meData = (await meRes.json()) as AuthState;
    setAuth(meData);

    if (featRes.ok) {
      const fJson = (await featRes.json()) as { featured: FeaturedTenant[] };
      setFeatured(fJson.featured);
    }

    if (meData.authenticated) {
      const [tRes, lRes] = await Promise.all([fetch("/api/tenants"), fetch("/api/ledger")]);
      if (tRes.ok) {
        const tJson = (await tRes.json()) as { tenants: TenantItem[] };
        setTenants(tJson.tenants);
      }
      if (lRes.ok) {
        const lJson = (await lRes.json()) as {
          transactions: LedgerTransaction[];
          summary: { total_calls: number; total_usd: string; avg_latency_ms: number };
        };
        setTransactions(lJson.transactions);
        setSummary(lJson.summary);
      }
    } else {
      const pubRes = await fetch("/api/public/ledger");
      if (pubRes.ok) {
        const pubJson = (await pubRes.json()) as { transactions: LedgerTransaction[] };
        const txs = pubJson.transactions;
        const totalUsd = txs.reduce((acc, t) => acc + Number(t.amount_usd || 0), 0).toFixed(4);
        const avgLat =
          txs.length > 0
            ? Math.round(txs.reduce((acc, t) => acc + t.latency_ms, 0) / txs.length)
            : 0;
        setTransactions(txs);
        setSummary({ total_calls: txs.length, total_usd: totalUsd, avg_latency_ms: avgLat });
      }
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleDemoLogin = async () => {
    await fetch("/api/auth/demo", { method: "POST" });
    await loadData();
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setTenants([]);
    if (view === "admin") navigate("home");
    await loadData();
  };

  const handleCreateApiKey = async () => {
    if (!auth.authenticated) {
      await handleDemoLogin();
    }
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CLI Deploy Key" })
    });
    if (res.ok) {
      const data = (await res.json()) as { secret: string };
      setNewApiKey(data.secret);
    }
  };

  const copyCurl = () => {
    const snippet = `curl -i -X POST https://demo.port4.dev/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'`;
    void navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const isAdmin = auth.user?.is_admin === 1;

  return (
    <div className="min-h-screen p4-bg text-slate-100 flex flex-col">
      {/* Minimal Top Navbar */}
      <header className="border-b border-emerald-500/20 bg-[#050B14]/85 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-5 h-16 flex items-center justify-between">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("home");
            }}
            className="flex items-center gap-2.5"
          >
            <img
              src="/port4-logo.png"
              alt="Port4"
              className="w-8 h-8 rounded-lg object-cover border border-emerald-500/25 bg-white"
            />
            <span className="font-bold text-base tracking-tight text-white">Port4</span>
          </a>

          <nav className="flex items-center gap-1 sm:gap-2">
            <NavLink active={view === "home"} href="/" onNavigate={() => navigate("home")} label="Home" />
            <NavLink
              active={view === "dashboard"}
              href="/dashboard"
              onNavigate={() => navigate("dashboard")}
              label="Dashboard"
            />
            <NavLink active={view === "docs"} href="/docs" onNavigate={() => navigate("docs")} label="Docs" />
            {isAdmin && (
              <NavLink
                active={view === "admin"}
                href="/admin"
                onNavigate={() => navigate("admin")}
                label="Admin"
                icon={<ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />}
              />
            )}
          </nav>

          <div className="flex items-center gap-2">
            {auth.authenticated && auth.user ? (
              <>
                <span className="hidden sm:inline font-mono text-xs text-slate-300">
                  @{auth.user.login}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/25 px-3 py-1.5 text-xs text-slate-300 hover:border-[#0EA5E9] cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </>
            ) : auth.githubConfigured ? (
              <a
                href="/api/auth/github"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 text-[#050B14] px-3.5 py-1.5 text-xs font-semibold hover:bg-white"
              >
                <Github className="w-3.5 h-3.5" />
                Sign in
              </a>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await handleDemoLogin();
                  navigate("dashboard");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#0EA5E9]/40 bg-[#0EA5E9]/10 px-3 py-1.5 text-xs font-medium text-[#0EA5E9] hover:bg-[#0EA5E9]/20 cursor-pointer"
              >
                Dashboard
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-5 py-10 md:py-12">
        {view === "home" && (
          <div className="flex flex-col gap-10">
            {/* Minimalist Hero */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div>
                <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-white">
                  Turn any API into{" "}
                  <span className="bg-gradient-to-r from-[#0EA5E9] to-[#10B981] bg-clip-text text-transparent">
                    Paid MCP.
                  </span>
                </h1>
                <p className="font-mono text-xs text-slate-400 mt-2">
                  https://{"{tenant}"}.port4.dev/mcp · Base Sepolia USDC
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="/dashboard"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("dashboard");
                  }}
                  className="p4-btn-primary rounded-lg px-4 py-2 text-xs"
                >
                  Open Dashboard
                </a>
                <a
                  href="/docs"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("docs");
                  }}
                  className="rounded-lg border border-emerald-500/25 px-4 py-2 text-xs text-slate-200 hover:border-[#0EA5E9]"
                >
                  Docs
                </a>
              </div>
            </div>

            {/* Live 1-Click x402 Sandbox */}
            <Sandbox onSettled={loadData} />

            {/* Featured Registry */}
            <section className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                  Featured Registry
                </h2>
                <span className="font-mono text-[11px] text-[#10B981]">
                  {featured.length} verified
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {featured.map((item) => (
                  <div key={item.id} className="p4-card rounded-2xl p-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-[#0EA5E9]" />
                        <span className="text-sm font-semibold text-white">{item.name}</span>
                      </div>
                      <span className="font-mono text-[10px] text-[#10B981] bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 rounded">
                        {item.call_count} calls
                      </span>
                    </div>
                    <div className="font-mono text-xs text-[#0EA5E9]">{item.endpoint_url}</div>
                    <div className="flex flex-wrap gap-2">
                      {item.tools.map((tl) => (
                        <span
                          key={tl.id}
                          className="inline-flex items-center gap-1.5 font-mono text-[11px] bg-[#050B14] border border-emerald-500/20 px-2.5 py-1 rounded-lg text-slate-300"
                        >
                          {tl.name}
                          <span className="inline-flex items-center gap-0.5 text-[#10B981]">
                            <Coins className="w-3 h-3" />${tl.price_usd}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === "dashboard" && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2 border-b border-emerald-500/20 pb-3">
              <TabButton
                active={tab === "endpoints"}
                onClick={() => setTab("endpoints")}
                icon={<Layers className="w-3.5 h-3.5" />}
                label="Endpoints"
              />
              <TabButton
                active={tab === "ledger"}
                onClick={() => setTab("ledger")}
                icon={<ReceiptText className="w-3.5 h-3.5" />}
                label="Ledger"
              />
              <TabButton
                active={tab === "deploy"}
                onClick={() => setTab("deploy")}
                icon={<TerminalSquare className="w-3.5 h-3.5" />}
                label="Deploy"
              />
            </div>

            {tab === "endpoints" && (
              <EndpointForm
                tenants={tenants}
                authenticated={auth.authenticated}
                onRequireDemoLogin={handleDemoLogin}
                onRefresh={loadData}
              />
            )}

            {tab === "ledger" && <RevenueTable transactions={transactions} summary={summary} />}

            {tab === "deploy" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="p4-card rounded-2xl p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">Verify with cURL</span>
                    <button
                      type="button"
                      onClick={copyCurl}
                      className="inline-flex items-center gap-1.5 font-mono text-xs text-[#0EA5E9] cursor-pointer"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="font-mono text-[11px] leading-relaxed bg-[#050B14] border border-emerald-500/20 rounded-xl p-3.5 text-slate-300 overflow-x-auto">
{`curl -i -X POST https://demo.port4.dev/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'`}
                  </pre>
                </div>

                <div className="p4-card rounded-2xl p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">API Key</span>
                    <button
                      type="button"
                      onClick={handleCreateApiKey}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-[#10B981] cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      Generate
                    </button>
                  </div>
                  <div className="font-mono text-xs bg-[#050B14] border border-emerald-500/20 rounded-xl p-3.5 text-slate-300 break-all">
                    {newApiKey ?? "p4_live_••••••••••••••••••••••••••••••••"}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {view === "docs" && <Docs />}
        {view === "admin" && <AdminDashboard />}
      </main>

      <footer className="border-t border-emerald-500/15 py-6">
        <div className="max-w-5xl mx-auto px-5 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-slate-500">
          <span>Port4 · port4.dev · info@port4.dev</span>
          <div className="flex items-center gap-4">
            <a href="/llms.txt" className="hover:text-[#0EA5E9]">
              llms.txt
            </a>
            <a href="https://github.com/Port4-dev" target="_blank" rel="noreferrer" className="hover:text-[#0EA5E9]">
              GitHub
            </a>
            <a href="https://x.com/Port4dotDev" target="_blank" rel="noreferrer" className="hover:text-[#0EA5E9]">
              X
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function NavLink({
  active,
  href,
  onNavigate,
  label,
  icon
}: {
  active: boolean;
  href: string;
  onNavigate: () => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onNavigate();
      }}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
        active
          ? "text-[#0EA5E9] bg-[#0EA5E9]/10 border border-[#0EA5E9]/30"
          : "text-slate-400 hover:text-white border border-transparent"
      }`}
    >
      {icon}
      {label}
    </a>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
        active
          ? "bg-[#0EA5E9]/15 text-[#0EA5E9] border border-[#0EA5E9]/35"
          : "text-slate-400 hover:text-white border border-transparent"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
