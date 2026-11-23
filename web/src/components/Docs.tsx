import { useState } from "react";
import { Check, Coins, Copy, Globe } from "lucide-react";
import { Sandbox } from "./Sandbox";

export interface FeaturedTenant {
  id: string;
  slug: string;
  name: string;
  network: string;
  call_count: number;
  endpoint_url: string;
  tools: Array<{ id: string; name: string; description: string; price_usd: string }>;
}

function CodeBlock({ id, title, code }: { id: string; title: string; code: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1600);
  };

  return (
    <div className="rounded-xl bg-[#18181B] border border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <span className="font-mono text-[11px] text-zinc-400">{title}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-[#FBAD41] hover:text-[#F6821F] cursor-pointer"
        >
          {copiedId === id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copiedId === id ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-4 font-mono text-xs leading-relaxed text-zinc-200 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}

export function Docs({
  featured,
  onSettled
}: {
  featured: FeaturedTenant[];
  onSettled?: () => void;
}) {
  return (
    <div className="flex flex-col gap-10">
      <div className="max-w-3xl">
        <span className="font-mono text-xs font-medium text-[#C25906] bg-[#F6821F]/10 border border-[#F6821F]/25 px-2.5 py-1 rounded-full">
          Developer Docs
        </span>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 mt-3">
          Practical Guide to Paid MCP
        </h1>
        <p className="text-sm text-zinc-600 mt-2">
          Connect any existing REST API, publish a live MCP endpoint, and call it from Cursor,
          Claude Desktop, or any autonomous TypeScript agent.
        </p>
      </div>

      {/* Live 1-Click Sandbox */}
      <div className="flex flex-col gap-2">
        <Sandbox onSettled={onSettled} />
        <p className="font-mono text-[11px] text-zinc-500">
          Note: The 1-Click Sandbox tests the live HTTP 402 → Sign → 200 OK wire flow using the
          built-in demo tenant without requiring a funded wallet. Production tenants settle real
          USDC authorizations via <code className="text-zinc-700">https://x402.org/facilitator</code>.
        </p>
      </div>

      <div className="flex flex-col gap-8 max-w-3xl">
        {/* 1. Practical: Connect to Cursor / Claude Desktop */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">
            1. Connect to Cursor, Windsurf, or Claude Desktop
          </h2>
          <p className="text-sm text-zinc-600">
            Add any Port4 endpoint to your MCP client config (or click{" "}
            <code className="font-mono text-xs bg-zinc-100 border border-zinc-200 px-1.5 py-0.5 rounded">
              MCP JSON
            </code>{" "}
            on any endpoint in your Dashboard):
          </p>
          <CodeBlock
            id="mcp-config"
            title="mcp.json — Cursor / Claude Desktop (Stateless HTTP or Local Budget-Guarded STDIO Bridge)"
            code={`{
  "mcpServers": {
    "port4-demo-http": {
      "url": "https://port4.dev/mcp/demo",
      "headers": {
        "MCP-Protocol-Version": "2026-07-28"
      }
    },
    "port4-demo-stdio-bridge": {
      "command": "npx",
      "args": [
        "-y",
        "port4-mcp",
        "bridge",
        "--url",
        "https://port4.dev/mcp/demo",
        "--max-per-call-usd",
        "0.05",
        "--max-session-usd",
        "1.00"
      ]
    }
  }
}`}
          />
        </section>

        {/* 2. Discover Tools */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">2. Discover Available Tools (Free)</h2>
          <CodeBlock
            id="list"
            title="cURL — tools/list"
            code={`curl -X POST https://port4.dev/mcp/demo \\
  -H "Content-Type: application/json" \\
  -H "MCP-Protocol-Version: 2026-07-28" \\
  -H "Mcp-Method: tools/list" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
          />
        </section>

        {/* 3. Call Paid Tool from an Agent */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">
            3. Pay &amp; Call from an AI Agent (Multi-Chain EVM, Tempo OUSD &amp; Solana USDC)
          </h2>
          <p className="text-sm text-zinc-600">
            Port4 supports x402 v2 multi-rail <code className="font-mono text-xs">accepts[]</code>{" "}
            across <strong>Base, Arbitrum, Optimism, Polygon, Ethereum, Avalanche</strong> (EVM{" "}
            <code className="font-mono text-xs">0x...</code> USDC), <strong>Tempo OUSD</strong> (
            <code className="font-mono text-xs">eip155:4217</code> Mainnet &amp;{" "}
            <code className="font-mono text-xs">eip155:42431</code> Testnet), and{" "}
            <strong>Solana</strong> (SVM Base58 SPL USDC). Install{" "}
            <code className="font-mono text-xs">@x402/fetch</code> +{" "}
            <code className="font-mono text-xs">@x402/evm</code> (or{" "}
            <code className="font-mono text-xs">@x402/svm</code> for Solana) — the wrapper handles
            the <code className="font-mono text-xs">402 Payment Required</code> challenge, signs the
            authorization, and retries automatically:
          </p>
          <CodeBlock
            id="ts-client"
            title="TypeScript — Real Paid MCP Call"
            code={`import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }]
});

const res = await fetchWithPayment("https://port4.dev/mcp/demo", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": "market_quote"
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "market_quote", arguments: { symbol: "ETH-USD" } }
  })
});

console.log(await res.json());`}
          />
        </section>

        {/* 4. Code Mode, Visa TAP, Tempo MPP & Cloudflare One Zero Trust */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">
            4. Code Mode, Visa TAP, Tempo OUSD MPP &amp; Cloudflare One Zero Trust
          </h2>
          <p className="text-sm text-zinc-600">
            Switch any endpoint in <code className="font-mono text-xs">/dashboard</code> to{" "}
            <strong>Code Mode</strong> (<code className="font-mono text-xs">code</code>) or{" "}
            <strong>OpenAPI Code Mode</strong> (<code className="font-mono text-xs">search</code> +{" "}
            <code className="font-mono text-xs">execute</code>). Enable{" "}
            <strong>Visa TAP Verified Agent</strong> (<code className="font-mono text-xs">require_visa_tap</code>
            {" "}with optional <code className="font-mono text-xs">allow_tap_simulated</code> for sandbox keys)
            to verify RFC 9421 Ed25519 signatures (<code className="font-mono text-xs">Signature-Input</code>,{" "}
            <code className="font-mono text-xs">Signature</code>,{" "}
            <code className="font-mono text-xs">Content-Digest</code>,{" "}
            <code className="font-mono text-xs">Signature-Agent</code>) against{" "}
            <code className="font-mono text-xs">auth.visacli.sh</code> and forward{" "}
            <code className="font-mono text-xs">X-Port4-Tap-Agent</code> upstream. Every endpoint serves{" "}
            <code className="font-mono text-xs">GET /openapi.json</code> and{" "}
            <code className="font-mono text-xs">GET /mcp/&#123;tenant&#125;/openapi.json</code> with{" "}
            <code className="font-mono text-xs">x-payment-info</code>, emitting dual{" "}
            <code className="font-mono text-xs">PAYMENT-REQUIRED</code> (x402 USDC) +{" "}
            <code className="font-mono text-xs">WWW-Authenticate: Payment</code> (Tempo OUSD MPP) challenges
            and returning <code className="font-mono text-xs">Payment-Receipt</code> on settlement. For
            private enterprise APIs, enable <strong>Cloudflare One Access</strong> (
            <code className="font-mono text-xs">auth_mode: &quot;x402+oauth_v2&quot;</code>) and pass{" "}
            <code className="font-mono text-xs">Cf-Access-Jwt-Assertion</code> or{" "}
            <code className="font-mono text-xs">CF-Access-Client-Id</code> /{" "}
            <code className="font-mono text-xs">CF-Access-Client-Secret</code>.
          </p>
          <CodeBlock
            id="codemode-call"
            title="Code Mode — Multi-Step Plan in 1 Paid Turn"
            code={`{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "code",
    "arguments": {
      "code": "async () => { const q = await codemode.market_quote({ symbol: 'ETH-USD' }); const d = await codemode.edge_dns_lookup({ domain: 'port4.dev' }); return { eth: q.price_usd, colo: d.cloudflare_colo }; }"
    }
  }
}`}
          />
        </section>

        {/* 5. Publish Your Own API */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">
            5. Publish Your Own REST API Programmatically
          </h2>
          <CodeBlock
            id="api-create"
            title="cURL — POST /api/tenants"
            code={`curl -X POST https://port4.dev/api/tenants \\
  -H "Authorization: Bearer p4_live_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "subdomain": "weather",
    "name": "Weather API",
    "upstream_base_url": "https://api.weather.example",
    "payout_wallet": "0xYourWalletAddress",
    "initial_tool": {
      "name": "forecast",
      "description": "7-day forecast",
      "http_method": "POST",
      "upstream_path": "/v1/forecast",
      "price_usd": "0.005"
    }
  }'`}
          />
        </section>

        {/* 6. Featured Endpoints */}
        {featured.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-zinc-900">6. Featured Public Endpoints</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {featured.map((item) => (
                <div key={item.id} className="cf-card rounded-2xl p-4 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-[#F6821F]" />
                      <span className="text-sm font-semibold text-zinc-900">{item.name}</span>
                    </div>
                    <span className="font-mono text-[10px] text-[#C25906] bg-[#F6821F]/10 border border-[#F6821F]/25 px-2 py-0.5 rounded">
                      {item.call_count} calls
                    </span>
                  </div>
                  <div className="font-mono text-xs text-zinc-600">{item.endpoint_url}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.tools.map((tl) => (
                      <span
                        key={tl.id}
                        className="inline-flex items-center gap-1 font-mono text-[11px] bg-zinc-50 border border-zinc-200 px-2 py-1 rounded text-zinc-800"
                      >
                        {tl.name}
                        <span className="inline-flex items-center gap-0.5 text-[#C25906]">
                          <Coins className="w-3 h-3 text-[#F6821F]" />${tl.price_usd}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="pt-3 border-t border-zinc-200 flex items-center justify-between text-xs font-mono text-zinc-500">
          <span>Machine-readable agent spec:</span>
          <a href="/llms.txt" className="text-[#C25906] hover:underline">
            https://port4.dev/llms.txt
          </a>
        </section>
      </div>
    </div>
  );
}
