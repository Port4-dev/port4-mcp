# Port4 (`port4.dev`)

[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](./LICENSE)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-blue.svg)](https://modelcontextprotocol.io)
[![x402 v2](https://img.shields.io/badge/x402-v2-emerald.svg)](https://x402.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](https://workers.cloudflare.com)

**Turn any REST API, OpenAPI spec, or MCP server into a Paid, Code-Mode MCP Gateway at the Cloudflare Edge.**

Port4 is an open-source, multi-tenant **Stateless MCP (`2026-07-28`), x402 v2, Visa TAP & Tempo OUSD MPP API Monetization Gateway** built on Cloudflare Workers, Durable Objects, Queues, D1, KV, and **Cloudflare Dynamic Workers (`@cloudflare/codemode`)**.

- **Live Instance:** [`https://port4.dev`](https://port4.dev) (`/dashboard`, `/docs`)
- **Repository:** [`https://github.com/Port4-dev/port4-mcp`](https://github.com/Port4-dev/port4-mcp) — ⭐ **Star on GitHub** if you find Port4 useful!
- **Machine-Readable Spec:** [`https://port4.dev/llms.txt`](https://port4.dev/llms.txt)
- **CLI & Desktop IDE Bridge:** `npx port4-mcp` ([`packages/port4-mcp`](./packages/port4-mcp))

---

## Features

- **Stateless MCP `2026-07-28` Gateway:** `POST`-only JSON-RPC 2.0, 64 KiB body cap, DNS-rebinding `Origin` guard, header/body consistency checks, cursor-paginated `tools/list`, and free `$0` direct tools.
- **Dual Payment Rails (x402 v2 + Tempo MPP):** Multi-chain EVM USDC (8 chains), Tempo OUSD (2 chains), and Solana SPL USDC (2 chains) with non-custodial direct-to-merchant settlement and durable anti-replay (`PaymentReplayGuard` Durable Object).
- **Cloudflare Code Mode (`@cloudflare/codemode`):** Runs agent JavaScript inside isolated Cloudflare Dynamic Workers (`LOADER`, `globalOutbound: null`) with JSON Schema argument validation, max sub-call caps, and atomic budget enforcement.
- **Enterprise Agent Security:** Optional Cloudflare One Access Zero Trust (`x402+oauth_v2`), Visa Trusted Agent Protocol (TAP RFC 9421 Ed25519 + JKT verification), AES-256-GCM encrypted upstream secrets, and HMAC-SHA256 `X-Port4-Signature` outbound signing.
- **Zero-Hot-Path Financial Ledger:** Async Cloudflare Queues (`METERING_EVENTS`) deduplicating into D1 `processed_metering_events`, `transactions`, `usage_rollups`, and optional R2 NDJSON archival.
- **OpenAPI 3.x & Remote MCP Importer:** Import REST APIs from OpenAPI JSON/YAML (up to 256 KiB) or sync tools from existing MCP servers in one click.

---

## Architecture

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
  │      └─ Outbound Security: decrypts AES-256-GCM upstream credentials + signs `X-Port4-Signature` (HMAC-SHA256)
  └─► 8. Authoritative Async Metering (`METERING_EVENTS` Queue → D1 ledger + optional R2 archive / Analytics Engine)
```

---

## Quick Start (Local Development)

### Prerequisites
- Node.js `>= 20`
- npm `>= 10`
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included in `devDependencies`)

### 1. Clone & Install

```bash
git clone https://github.com/Port4-dev/port4-mcp.git
cd port4-mcp

npm install
npm --prefix web install
```

### 2. Configure Local Environment Variables

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set a strong `JWT_SECRET` (at least 32 characters). Never commit `.dev.vars` — it is ignored by `.gitignore`.

### 3. Apply D1 Migrations, Build & Run

```bash
# Apply all D1 migrations locally (0001 through 0010)
npm run db:migrate:local

# Generate Cloudflare Worker types, typecheck, and run the conformance test suite
npm run cf-typegen
npm run typecheck
npm test

# Build the React SPA and start local Cloudflare Worker dev server
npm run build:web
npm run dev
```

---

## Self-Hosting on Cloudflare Workers

1. Provision your own Cloudflare resources:
   ```bash
   npx wrangler d1 create port4-db
   npx wrangler kv namespace create TENANT_ROUTING
   npx wrangler queues create port4-metering
   npx wrangler queues create port4-metering-dlq
   ```
2. Update `wrangler.jsonc` with your own `database_id`, `kv_namespaces.id`, `routes`, `APP_URL`, and `ADMIN_GITHUB_LOGIN` / `ADMIN_GITHUB_ID`.
3. Set required secrets via Wrangler (never hardcode secrets in source or frontend files):
   ```bash
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
4. Apply remote D1 migrations and deploy:
   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```

### Environment Variables & Secrets

| Name | Type | Purpose |
| :--- | :--- | :--- |
| `APP_URL` | Var | Canonical public origin (e.g. `https://port4.dev`) |
| `X402_NETWORK` | Var | Default settlement network (`eip155:84532`) |
| `X402_USDC_ASSET` | Var | Default USDC token contract address |
| `X402_FACILITATOR_URL` / `FACILITATOR_URL` | Var | Default x402 testnet facilitator URL |
| `X402_MAINNET_FACILITATOR_URL` | Var / Secret | Optional mainnet facilitator URL for production EVM/Solana settlement |
| `X402_FACILITATOR_API_KEY` | Secret | Optional Bearer API key for mainnet facilitator authentication |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Secret | Optional Coinbase CDP EdDSA/ES256 credentials for mainnet facilitator JWTs |
| `SANDBOX_PAYOUT_WALLET` | Var | Built-in demo tenant payout wallet |
| `ADMIN_GITHUB_LOGIN` / `ADMIN_GITHUB_ID` | Var / Secret | Super-Admin GitHub handle or numeric ID for `/admin` RBAC |
| `DEMO_AUTH_ENABLED` | Var | Optional local-dev demo login toggle (`"true"` only in local dev) |
| `JWT_SECRET` | Secret | HMAC/AES-256-GCM master key for session JWTs, sandbox proofs, and encrypted upstream secrets |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Secret | GitHub OAuth app credentials for developer sign-in |
| `PORT4_TREASURY_WALLET` / `PORT4_TREASURY_SOLANA_WALLET` | Var / Secret | Platform fee recipient addresses (EVM `0x...` / Solana Base58) |
| `VISA_TAP_REGISTRY_URL` | Var | Visa Trusted Agent Protocol JWKS directory URL (default `https://auth.visacli.sh`) |
| `TEMPO_MAINNET_RPC_URL` / `TEMPO_TESTNET_RPC_URL` | Var / Secret | Tempo JSON-RPC endpoints (Mainnet `4217` / Testnet `42431`) for OUSD MPP verification |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRO_PRICE_ID` | Secret | Optional Stripe billing credentials for self-serve Pro plan upgrades |
| `MCP_RATE_LIMIT_PER_MINUTE` | Var | Fallback per-minute rate limit when tenant RPM is unset (default `120`) |

---

## Supported Settlement Networks (`GET /api/networks`)

Tenants can configure a primary payout wallet plus up to 10 additional chain wallets (`accepts[]`):
- **EVM (`0x...` Circle USDC):** Base Mainnet (`eip155:8453`), Base Sepolia (`eip155:84532`), Arbitrum One (`eip155:42161`), Arbitrum Sepolia (`eip155:421614`), Optimism (`eip155:10`), Polygon PoS (`eip155:137`), Ethereum Mainnet (`eip155:1`), Avalanche C-Chain (`eip155:43114`)
- **Tempo (`0x...` Visa CLI OUSD):** Tempo Mainnet (`eip155:4217`), Tempo Testnet (`eip155:42431`)
- **Solana (`Base58` SPL USDC):** Solana Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)

---

## CLI & Desktop IDE Bridge (`port4-mcp`)

The repository includes the official npm CLI package in [`packages/port4-mcp`](./packages/port4-mcp) (also linked at `./cli/port4-mcp.mjs`):

```bash
# Inspect any live Port4 MCP endpoint (lists tools, MCP mode, and 402 payment requirements)
npx -y port4-mcp inspect https://port4.dev/mcp/demo

# Run as a local STDIO-to-HTTP MCP Bridge for Cursor, Claude Desktop, or Windsurf
npx -y port4-mcp bridge --url https://port4.dev/mcp/demo --max-per-call-usd 0.05 --max-session-usd 1.00

# Manage endpoints or import OpenAPI 3.x specs from CI using a scoped API key
PORT4_API_KEY=p4_live_... npx -y port4-mcp tenants
```

---

## Testing

```bash
# Full check: Worker & Web TypeScript typecheck + 190 conformance tests + CLI self-test
npm run test:all

# End-to-end local workerd + D1 + STDIO bridge verification
npm run build:web
npm run test:e2e
```

---

## Contributing

Contributions are welcome! Please:
1. Fork the repository and create a feature branch from `main`.
2. Ensure `npm run test:all` passes cleanly with zero typecheck or conformance regressions.
3. Never commit secrets, `.dev.vars`, or private credentials.
4. Open a pull request describing the change and how it was verified.

## Security

If you discover a security vulnerability, please do not open a public issue — email **info@port4.dev** with details so we can investigate and patch it promptly.

## License

Released under the [MIT License](./LICENSE).
