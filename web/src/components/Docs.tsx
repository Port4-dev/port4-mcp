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
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 mt-3">Using Port4</h1>
        <p className="text-sm text-zinc-600 mt-2">
          Everything you need to test, integrate, and publish pay-per-call MCP endpoints.
        </p>
      </div>

      {/* Live 1-Click Sandbox (moved here from Landing) */}
      <Sandbox onSettled={onSettled} />

      <div className="flex flex-col gap-8 max-w-3xl">
        {/* 1. Endpoint & Headers */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">1. Endpoint & Required Headers</h2>
          <p className="text-sm text-zinc-600">
            Send stateless JSON-RPC 2.0 <code className="font-mono text-xs">POST</code> requests to{" "}
            <code className="font-mono text-xs bg-zinc-100 border border-zinc-200 px-1.5 py-0.5 rounded text-zinc-800">
              https://{"{tenant}"}.port4.dev/mcp
            </code>
            :
          </p>
          <div className="cf-card rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 font-mono text-[11px] text-zinc-500">
                  <th className="py-2.5 px-4">Header</th>
                  <th className="py-2.5 px-4">Value</th>
                  <th className="py-2.5 px-4">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 font-mono">
                <tr>
                  <td className="py-2.5 px-4 text-zinc-900">MCP-Protocol-Version</td>
                  <td className="py-2.5 px-4 text-[#C25906]">2026-07-28</td>
                  <td className="py-2.5 px-4 text-zinc-600 font-sans">Always</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-zinc-900">Mcp-Method</td>
                  <td className="py-2.5 px-4 text-[#C25906]">tools/list | tools/call</td>
                  <td className="py-2.5 px-4 text-zinc-600 font-sans">Matches JSON-RPC method</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-zinc-900">Mcp-Name</td>
                  <td className="py-2.5 px-4 text-[#C25906]">&lt;tool_name&gt;</td>
                  <td className="py-2.5 px-4 text-zinc-600 font-sans">On tools/call</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-zinc-900">PAYMENT-SIGNATURE</td>
                  <td className="py-2.5 px-4 text-[#C25906]">Base64 x402 payload</td>
                  <td className="py-2.5 px-4 text-zinc-600 font-sans">On paid tools/call</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 2. Discover Tools */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">2. Discover Tools (Free)</h2>
          <CodeBlock
            id="list"
            title="cURL — tools/list"
            code={`curl -X POST https://demo.port4.dev/mcp \\
  -H "Content-Type: application/json" \\
  -H "MCP-Protocol-Version: 2026-07-28" \\
  -H "Mcp-Method: tools/list" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
          />
        </section>

        {/* 3. Call Paid Tool */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">3. Call a Paid Tool (@x402/fetch)</h2>
          <CodeBlock
            id="ts-client"
            title="TypeScript"
            code={`import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }]
});

const res = await fetchWithPayment("https://demo.port4.dev/mcp", {
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

        {/* 4. Create Endpoints via API */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">4. Create Endpoints via API</h2>
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

        {/* 5. Featured Endpoints */}
        {featured.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-zinc-900">5. Featured Public Endpoints</h2>
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
