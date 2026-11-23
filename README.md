# Port4 (`port4.dev`)

**Turn any REST API, OpenAPI spec, or MCP server into a Paid, Code-Mode MCP Gateway at the Cloudflare Edge.**

Port4 is a multi-tenant **Stateless MCP (`2026-07-28`), x402 v2, Visa TAP & Tempo OUSD MPP API Monetization Gateway** built on Cloudflare Workers Paid, Durable Objects, Queues, D1, KV, and **Cloudflare Dynamic Workers (`@cloudflare/codemode`)**.

- **Control Plane & Dashboard:** `https://port4.dev` (`/dashboard`, `/docs`, `/admin`)
- **Tenant Data Plane (Wildcard & Path):** `https://{tenant}.port4.dev/mcp` and `https://port4.dev/mcp/{tenant}`
- **OpenAPI Discovery (`x-payment-info`):** `https://{tenant}.port4.dev/openapi.json` and `https://port4.dev/mcp/{tenant}/openapi.json`
- **Machine-Readable Spec:** `https://port4.dev/llms.txt`
- **CLI & Desktop IDE Bridge:** `npx port4-mcp` ([`packages/port4-mcp`](./packages/port4-mcp))

---

## Production Architecture

```text
AI Agent / IDE (Cursor, Claude Desktop, Windsurf, @x402/fetch, Visa CLI)
  │
  ▼  POST /mcp or /mcp/:tenant (MCP 2026-07-28 JSON-RPC 2.0)
[Cloudflare Edge Worker (src/index.ts)]
  ├─► 1. Tenant Resolution (KV `TENANT_ROUTING` sub-5ms cache, D1 fallback)
  ├─► 2. Per-Tenant/IP Rate Limit & Daily Quota (`EdgeRateLimiter` Durable Object)
  ├─► 3. MCP 2026-07-28 Transport Validator (64 KiB byte cap, DNS-rebinding Origin check)
  ├─► 4. Optional Cloudflare One Access Zero Trust (RS256 JWKS + AUD verification)
  ├─► 5. Optional Visa Trusted Agent Protocol (TAP RFC 9421 Ed25519 + Visa Agent Directory JKT + DO nonce guard)
  ├─► 6. Dual Payment Gate + `PaymentReplayGuard` Durable Object
  │      ├─ x402 v2 multi-rail `accepts[]` (8 EVM USDC chains, 2 Tempo OUSD chains, 2 Solana SPL USDC chains)
  │      ├─ Tempo OUSD MPP (`WWW-Authenticate: Payment`, `Authorization: Payment`, `Payment-Receipt`)
  │      ├─ Canonical payment fingerprint + strict (tenant, tool, asset, amount, payTo) context binding
  │      ├─ 4-state atomic machine: `in_flight` → `settlement_pending` → `settled_pending_upstream` → `completed`
  │      └─ Synchronous completion persistence before returning 200 OK (zero duplicate upstream execution)
  ├─► 7. Multi-Protocol Execution Engine (`src/routes/mcp.ts` + `src/lib/codemode.ts`)
  │      ├─ `direct` mode: REST / OpenAPI / Remote MCP JSON-RPC 2.0 adapter
  │      ├─ `codemode` (`code`) & `openapi_codemode` (`search` + `execute`):
  │      │   Runs agent JS inside an isolated Cloudflare Dynamic Worker (`LOADER`, `globalOutbound: null`)
  │      │   with JSON Schema argument validation, max sub-call caps, and atomic USDC budget enforcement
  │      └─ Outbound Security: decrypts AES-256-GCM upstream credentials + signs `X-Port4-Signature` (HMAC-SHA256)
  └─► 8. Authoritative Async Metering (`METERING_EVENTS` Queue → `processed_metering_events` + `transactions` + `usage_rollups` + optional R2 NDJSON archive / Analytics Engine)
```

### Cloudflare Bindings (`wrangler.jsonc`)
| Binding | Resource | Purpose |
| :--- | :--- | :--- |
| `DB` | D1 (`port4-db`) | Control plane metadata, users, scoped API keys, tenants, tools, `processed_metering_events`, `transactions`, `usage_rollups`, `audit_logs` |
| `TENANT_ROUTING` | KV Namespace | Edge cache for tenant routing, multi-chain payout wallets, Code Mode config, Visa TAP flags, and instant admin kill-switch |
| `EDGE_RATE_LIMITER` | Durable Object (`SQLite`) | Per-tenant/IP RPM, daily abuse quota, Visa TAP nonce replay guard, and tenant-wide paid-call fee sequence |
| `PAYMENT_REPLAY_GUARD` | Durable Object (`SQLite`) | Cross-context payment isolation, fencing lease tokens, `settlement_pending` hold, and idempotent response cache |
| `LOADER` | Worker Loader (`worker_loaders`) | Ephemeral V8 isolates (`globalOutbound: null`) for `@cloudflare/codemode` execution |
| `METERING_EVENTS` | Cloudflare Queue (`port4-metering`) | Idempotent batched financial ledger consumer (`src/lib/metering.ts`) |
| `ASSETS` | Workers Static Assets (`./dist`) | Code-split React 19 + Tailwind v4 SPA |
| `GATEWAY_ANALYTICS` *(optional)* | Workers Analytics Engine | High-cardinality per-call edge telemetry (`port4_gateway_events`) |
| `LEDGER_ARCHIVE` *(optional)* | R2 Bucket | Immutable NDJSON audit trail for settled metering events |

---

## Environment Variables & Secrets

Configure non-secret vars in `wrangler.jsonc` and sensitive secrets via `wrangler secret put` (or `.dev.vars` locally):

| Name | Type | Purpose |
| :--- | :--- | :--- |
| `APP_URL` | Var | Canonical public origin (`https://port4.dev`) |
| `X402_NETWORK` | Var | Default settlement network (`eip155:84532`) |
| `X402_USDC_ASSET` | Var | Default USDC token contract address |
| `X402_FACILITATOR_URL` / `FACILITATOR_URL` | Var | Default x402 testnet facilitator URL |
| `X402_MAINNET_FACILITATOR_URL` | Var / Secret | Optional mainnet facilitator URL for production EVM/Solana settlement |
| `X402_FACILITATOR_API_KEY` | Secret | Optional Bearer API key for mainnet facilitator authentication |
| `SANDBOX_PAYOUT_WALLET` | Var | Built-in demo tenant payout wallet |
| `ADMIN_GITHUB_LOGIN` / `ADMIN_GITHUB_ID` | Var / Secret | Super-Admin GitHub handle or numeric ID for `/admin` RBAC |
| `DEMO_AUTH_ENABLED` | Var | Optional local-dev demo login toggle (`"true"` only in local dev) |
| `JWT_SECRET` | Secret | HMAC/AES-256-GCM master key for session JWTs, sandbox proofs, and encrypted upstream secrets |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Secret | GitHub OAuth app credentials for developer sign-in |
| `PORT4_TREASURY_WALLET` | Var / Secret | Platform fee recipient address (EVM `0x...`) |
| `PORT4_TREASURY_SOLANA_WALLET` | Var / Secret | Platform fee recipient address (Solana Base58) |
| `VISA_TAP_REGISTRY_URL` | Var | Visa Trusted Agent Protocol JWKS directory URL (default `https://auth.visacli.sh`) |
| `TEMPO_RPC_URL` | Var / Secret | Tempo JSON-RPC endpoint for Tempo OUSD MPP verification/settlement |

---

## Supported Settlement Networks (`GET /api/networks`)

Tenants can configure a primary payout wallet plus up to 10 additional chain wallets (`accepts[]`):
- **EVM (`0x...` Circle USDC):** Base Mainnet (`eip155:8453`), Base Sepolia (`eip155:84532`), Arbitrum One (`eip155:42161`), Arbitrum Sepolia (`eip155:421614`), Optimism (`eip155:10`), Polygon PoS (`eip155:137`), Ethereum Mainnet (`eip155:1`), Avalanche C-Chain (`eip155:43114`)
- **Tempo (`0x...` Visa CLI OUSD):** Tempo Mainnet (`eip155:4217`), Tempo Testnet (`eip155:42431`)
- **Solana (`Base58` SPL USDC):** Solana Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)

---

## Local Development & Testing

```bash
# 1. Install dependencies (root Worker + web SPA)
npm install
npm --prefix web install

# 2. Apply all D1 migrations locally (0001 through 0009)
npm run db:migrate:local

# 3. Generate Cloudflare Worker types, typecheck, and run the 7-suite conformance tests
npm run cf-typegen
npm run typecheck
npm test

# 4. Build frontend assets and start local Worker dev server
npm run build:web
npm run dev
```

---

## CLI & Desktop IDE Bridge (`port4-mcp`)

The repository includes a publish-ready npm CLI package in [`packages/port4-mcp`](./packages/port4-mcp) (also linked at `./cli/port4-mcp.mjs`):

```bash
# 1. Inspect any live Port4 MCP endpoint (lists tools, MCP mode, and 402 payment requirements)
node ./cli/port4-mcp.mjs inspect https://port4.dev/mcp/demo

# 2. Run as a local STDIO-to-HTTP MCP Bridge for Cursor, Claude Desktop, or Windsurf
node ./cli/port4-mcp.mjs bridge --url https://port4.dev/mcp/demo --max-per-call-usd 0.05 --max-session-usd 1.00

# 3. Publish or import an OpenAPI 3.x spec from the terminal / CI using a scoped API key
PORT4_API_KEY=p4_live_... node ./cli/port4-mcp.mjs tenants
```

To publish the CLI package to npm:
```bash
cd packages/port4-mcp
npm test
npm publish --access public
```

---

## Production Deployment

```bash
# 1. Apply any pending D1 migrations to remote port4-db
npx wrangler d1 migrations apply port4-db --remote

# 2. Run typecheck + conformance test suite
npm run typecheck
npm test

# 3. Build web bundle and deploy to Cloudflare Workers
npm run deploy
```
