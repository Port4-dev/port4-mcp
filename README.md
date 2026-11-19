# Port4 (`port4.dev`)

**Turn any API into Paid MCP.**

A $0-cost, multi-tenant **Paid MCP (`2026-07-28`) & x402 v2 API Monetization Gateway** built on the Cloudflare Developer Platform.

- **Website / Control Plane:** `https://port4.dev`
- **Wildcard Tenant Data Plane:** `https://{tenant}.port4.dev/mcp`
- **GitHub:** `https://github.com/Port4-dev`
- **X:** `https://x.com/Port4dotDev`
- **Contact:** `info@port4.dev`

## Architecture ($0/mo Cloudflare Free Tier)
- **Compute & Routing:** Single Hono TypeScript Worker (`wrangler.jsonc`) with `assets.run_worker_first: true` and `not_found_handling: "single-page-application"`.
- **Database:** Cloudflare D1 (`port4-db`) storing `users`, `api_keys`, `tenants`, `tools`, and `transactions`.
- **Edge Cache:** Cloudflare KV (`TENANT_ROUTING`) for sub-5ms tenant lookup.
- **Stateless MCP `2026-07-28`:** Rejects stateful `initialize` / `Mcp-Session-Id`, validates `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`, and edge-caches `tools/list`.
- **x402 v2 Payment Gating:** Returns `HTTP 402 Payment Required` with Base64 `PAYMENT-REQUIRED` (`eip155:84532` Base Sepolia USDC `exact` scheme), verifies & settles via `https://x402.org/facilitator`, logs to D1, and returns `PAYMENT-RESPONSE`.

## Quickstart (Local)
```bash
npm install
npm --prefix web install
npm run build:web
npx wrangler types --env-interface CloudflareBindings
npm run typecheck
npx wrangler d1 migrations apply port4-db --local
npx wrangler dev
```

## Verify `402 Payment Required` -> `200 OK`
```bash
# 1. Edge-cached tools/list
curl -i -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "X-Port4-Tenant: demo" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2. Unpaid tools/call -> 402 Payment Required + PAYMENT-REQUIRED header
curl -i -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "X-Port4-Tenant: demo" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: market_quote" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"market_quote","arguments":{"symbol":"ETH-USD"}}}'
```

## Production Deployment (Cloudflare Workers Free Plan)
1. Create D1 database & KV namespace:
   ```bash
   npx wrangler d1 create port4-db
   npx wrangler kv namespace create TENANT_ROUTING
   ```
2. Put the generated IDs into `wrangler.jsonc` and uncomment `routes` for `port4.dev/*` and `*.port4.dev/*`.
3. Apply remote migration and set secrets:
   ```bash
   npx wrangler d1 migrations apply port4-db --remote
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
4. Build and deploy:
   ```bash
   npm run deploy
   ```
