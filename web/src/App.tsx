import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  Copy,
  Github,
  KeyRound,
  Layers,
  LogOut,
  ReceiptText,
  ShieldCheck,
  TerminalSquare
} from "lucide-react";
import { EndpointForm, type TenantItem } from "./components/EndpointForm";
import { RevenueTable, type LedgerTransaction } from "./components/RevenueTable";
import { Docs, type FeaturedTenant } from "./components/Docs";
import { AdminDashboard } from "./components/AdminDashboard";

type PageView = "home" | "docs" | "dashboard" | "admin" | "notfound";
type DashboardTab = "endpoints" | "ledger" | "deploy";

interface AuthState {
  loaded: boolean;
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

function viewFromPath(pathname: string): PageView {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/") return "home";
  if (clean === "/docs" || clean === "/sandbox") return "docs";
  if (clean === "/dashboard" || clean === "/console") return "dashboard";
  if (clean === "/admin") return "admin";
  return "notfound";
}

function pathFromView(view: Exclude<PageView, "notfound">): string {
  if (view === "docs") return "/docs";
  if (view === "dashboard") return "/dashboard";
  if (view === "admin") return "/admin";
  return "/";
}

export default function App() {
  const [view, setView] = useState<PageView>(() => viewFromPath(window.location.pathname));
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname);
  const [tab, setTab] = useState<DashboardTab>("endpoints");
  const [auth, setAuth] = useState<AuthState>({
    loaded: false,
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

  const navigate = useCallback((next: Exclude<PageView, "notfound">) => {
    setView(next);
    const targetPath = pathFromView(next);
    setCurrentPath(targetPath);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setCurrentPath(window.location.pathname);
      setView(viewFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadData = useCallback(async () => {
    const [meRes, featRes] = await Promise.all([
      fetch("/api/auth/me"),
      fetch("/api/public/featured")
    ]);
    const meJson = (await meRes.json()) as Omit<AuthState, "loaded">;
    setAuth({ ...meJson, loaded: true });

    if (featRes.ok) {
      const fJson = (await featRes.json()) as { featured: FeaturedTenant[] };
      setFeatured(fJson.featured);
    }

    if (meJson.authenticated) {
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
    <div className="min-h-screen cf-hero-bg text-[#111827] flex flex-col">
      {/* Clean Cloudflare-style Top Navbar */}
      <header className="border-b border-zinc-200/80 bg-white/85 backdrop-blur-md sticky top-0 z-30">
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
              className="w-8 h-8 rounded-lg object-cover border border-zinc-200 bg-white"
            />
            <span className="font-bold text-base tracking-tight text-zinc-900">Port4</span>
          </a>

          <nav className="flex items-center gap-1 sm:gap-2">
            <NavLink active={view === "home"} href="/" onNavigate={() => navigate("home")} label="Home" />
            <NavLink active={view === "docs"} href="/docs" onNavigate={() => navigate("docs")} label="Docs" />
            <NavLink
              active={view === "dashboard"}
              href="/dashboard"
              onNavigate={() => navigate("dashboard")}
              label="Dashboard"
            />
            {isAdmin && (
              <NavLink
                active={view === "admin"}
                href="/admin"
                onNavigate={() => navigate("admin")}
                label="Admin"
                icon={<ShieldCheck className="w-3.5 h-3.5 text-[#F6821F]" />}
              />
            )}
          </nav>

          <div className="flex items-center gap-2">
            {auth.authenticated && auth.user ? (
              <>
                <span className="hidden sm:inline-flex items-center gap-1.5 font-mono text-[11px] px-2.5 py-1 rounded-lg bg-zinc-100 border border-zinc-200 text-zinc-700">
                  @{auth.user.login}
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      isAdmin
                        ? "bg-[#F6821F]/15 text-[#C25906]"
                        : "bg-zinc-200/80 text-zinc-700"
                    }`}
                  >
                    {isAdmin ? "Admin" : auth.user.plan === "pro" ? "Pro" : "Dev"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-[#F6821F] cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </>
            ) : auth.githubConfigured ? (
              <a
                href="/api/auth/github"
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 text-white px-3.5 py-1.5 text-xs font-medium hover:bg-zinc-800"
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:border-[#F6821F] cursor-pointer"
              >
                Dashboard
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-5 py-12 md:py-16">
        {/* Clean, Unpopulated Landing Page */}
        {view === "home" && (
          <div className="flex flex-col items-center text-center gap-14 py-6">
            <div className="max-w-2xl flex flex-col items-center gap-5">
              <span className="inline-flex items-center gap-2 text-xs font-medium text-[#C25906] bg-[#F6821F]/10 border border-[#F6821F]/25 px-3 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-[#F6821F]" />
                Pay-per-call API monetization
              </span>

              <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-zinc-900 leading-[1.08]">
                Turn any API into <span className="text-[#F6821F]">Paid MCP.</span>
              </h1>

              <p className="text-base sm:text-lg text-zinc-600 max-w-lg">
                Monetize your APIs per call with instant USDC payouts and zero subscriptions.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <a
                  href="/dashboard"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("dashboard");
                  }}
                  className="cf-btn-primary inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm transition"
                >
                  Get Started
                  <ArrowRight className="w-4 h-4" />
                </a>
                <a
                  href="/docs"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("docs");
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-6 py-3 text-sm font-medium text-zinc-800 hover:border-[#F6821F] hover:text-[#C25906] transition"
                >
                  Read Docs
                </a>
              </div>
            </div>

            <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
              <StepCard
                step="01"
                title="Connect your API"
                body="Link any existing API and get your dedicated Port4 link in seconds."
              />
              <StepCard
                step="02"
                title="Set your price"
                body="Choose how much each call costs and where your payouts go."
              />
              <StepCard
                step="03"
                title="Get paid per call"
                body="AI agents pay automatically on every request with zero friction."
              />
            </div>
          </div>
        )}

        {/* Technical Docs, Live Sandbox, Practical MCP Configs */}
        {view === "docs" && <Docs featured={featured} onSettled={loadData} />}

        {/* Developer Dashboard with Clear RBAC Status Bar */}
        {view === "dashboard" && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-3">
              <div className="flex items-center gap-2">
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

              {auth.authenticated && auth.user && (
                <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-600">
                  <span>Role:</span>
                  <span className="px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-900 font-medium">
                    {isAdmin ? "Super Admin" : "Developer"}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#F6821F]/10 border border-[#F6821F]/25 text-[#C25906]">
                    {auth.user.plan === "pro" ? "Pro · 1% fee" : "Free · 3% fee"}
                  </span>
                </div>
              )}
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
                <div className="cf-card rounded-2xl p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-900">Quick Verify</span>
                    <button
                      type="button"
                      onClick={copyCurl}
                      className="inline-flex items-center gap-1.5 font-mono text-xs text-[#C25906] hover:text-[#F6821F] cursor-pointer"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="font-mono text-[11px] leading-relaxed bg-[#18181B] border border-zinc-800 rounded-xl p-3.5 text-zinc-200 overflow-x-auto">
{`curl -i -X POST https://demo.port4.dev/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'`}
                  </pre>
                </div>

                <div className="cf-card rounded-2xl p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-900">API Key</span>
                    <button
                      type="button"
                      onClick={handleCreateApiKey}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#F6821F]/40 bg-[#F6821F]/10 px-3 py-1 text-xs font-medium text-[#C25906] hover:bg-[#F6821F]/20 cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      Generate
                    </button>
                  </div>
                  <div className="font-mono text-xs bg-zinc-50 border border-zinc-200 rounded-xl p-3.5 text-zinc-800 break-all">
                    {newApiKey ?? "p4_live_••••••••••••••••••••••••••••••••"}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Super-Admin RBAC Control Center */}
        {view === "admin" && (
          <AdminDashboard
            authLoaded={auth.loaded}
            authenticated={auth.authenticated}
            githubConfigured={auth.githubConfigured}
            user={auth.user}
            onGoDashboard={() => navigate("dashboard")}
          />
        )}

        {/* Clean 404 Page: "Lost on Port5" */}
        {view === "notfound" && (
          <div className="max-w-lg mx-auto cf-card rounded-2xl p-10 flex flex-col items-center text-center gap-4 my-8">
            <div className="p-3 rounded-xl bg-[#F6821F]/10 border border-[#F6821F]/25">
              <Compass className="w-6 h-6 text-[#F6821F]" />
            </div>
            <span className="font-mono text-xs font-semibold text-[#C25906] bg-[#F6821F]/10 border border-[#F6821F]/25 px-2.5 py-0.5 rounded-full">
              404
            </span>
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Lost on Port5</h1>
            <p className="text-sm text-zinc-600">
              This page doesn&apos;t exist.{" "}
              <code className="font-mono text-xs bg-zinc-100 border border-zinc-200 px-1.5 py-0.5 rounded text-zinc-700">
                {currentPath}
              </code>
            </p>
            <div className="flex items-center gap-3 pt-2">
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("home");
                }}
                className="cf-btn-primary inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Port4
              </a>
              <a
                href="/docs"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("docs");
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-5 py-2.5 text-xs font-medium text-zinc-800 hover:border-[#F6821F]"
              >
                Read Docs
              </a>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-200 py-6 bg-white/60">
        <div className="max-w-5xl mx-auto px-5 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-zinc-500">
          <span>Port4 · port4.dev · info@port4.dev</span>
          <div className="flex items-center gap-4">
            <a
              href="/docs"
              onClick={(e) => {
                e.preventDefault();
                navigate("docs");
              }}
              className="hover:text-[#F6821F]"
            >
              Docs
            </a>
            <a href="/llms.txt" className="hover:text-[#F6821F]">
              llms.txt
            </a>
            <a href="https://github.com/Port4-dev" target="_blank" rel="noreferrer" className="hover:text-[#F6821F]">
              GitHub
            </a>
            <a href="https://x.com/Port4dotDev" target="_blank" rel="noreferrer" className="hover:text-[#F6821F]">
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
          ? "text-[#C25906] bg-[#F6821F]/10"
          : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100"
      }`}
    >
      {icon}
      {label}
    </a>
  );
}

function StepCard({ step, title, body }: { step: string; title: string; body: string }) {
  return (
    <div className="cf-card rounded-2xl p-5 flex flex-col gap-2">
      <span className="font-mono text-xs font-semibold text-[#F6821F]">{step}</span>
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <p className="text-xs leading-relaxed text-zinc-600">{body}</p>
    </div>
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
          ? "bg-[#F6821F]/10 text-[#C25906] border border-[#F6821F]/35"
          : "text-zinc-600 hover:text-zinc-900 border border-transparent"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
