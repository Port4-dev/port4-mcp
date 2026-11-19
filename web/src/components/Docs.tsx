import { useState } from "react";
import { Check, Copy } from "lucide-react";

function CodeBlock({ id, title, code }: { id: string; title: string; code: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1600);
  };

  return (
    <div className="rounded-xl bg-[#050B14] border border-emerald-500/20 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-emerald-500/15">
        <span className="font-mono text-[11px] text-[#0EA5E9]">{title}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-[#10B981] hover:underline cursor-pointer"
        >
          {copiedId === id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copiedId === id ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-4 font-mono text-xs leading-relaxed text-slate-200 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}

export function Docs() {
  return (
    <div className="flex flex-col gap-8 max-w-3xl">
      <div>
        <span className="font-mono text-xs text-[#10B981] bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-full">
          Developer Docs
        </span>
        <h1 className="text-3xl font-bold tracking-tight text-white mt-3">
          Call & Monetize MCP Tools.
        </h1>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-white">1. Discover Tools</h2>
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

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-white">2. Call a Paid Tool (@x402/fetch)</h2>
        <CodeBlock
          id="client"
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

      <section className="pt-2 border-t border-emerald-500/15 flex items-center justify-between text-xs font-mono text-slate-400">
        <span>Agent spec:</span>
        <a href="/llms.txt" className="text-[#0EA5E9] hover:underline">
          https://port4.dev/llms.txt
        </a>
      </section>
    </div>
  );
}
