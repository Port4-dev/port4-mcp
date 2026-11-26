# Port4 (`port4.dev`)

[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](./LICENSE)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-blue.svg)](https://modelcontextprotocol.io)
[![x402 v2](https://img.shields.io/badge/x402-v2-emerald.svg)](https://x402.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](https://workers.cloudflare.com)

Turn any REST API, OpenAPI spec, or MCP server into a paid, Code Mode MCP gateway at the Cloudflare Edge.

Port4 is an open-source, multi-tenant gateway for Stateless MCP (`2026-07-28`), x402 v2, Visa TAP, and Tempo OUSD MPP. It runs on Cloudflare Workers, Durable Objects, Queues, D1, KV, and Cloudflare Dynamic Workers (`@cloudflare/codemode`).

- Live app: https://port4.dev (`/dashboard`, `/docs`)
- GitHub repo: https://github.com/Port4-dev/port4-mcp (Star on GitHub)
- Machine-readable spec: https://port4.dev/llms.txt
- CLI and IDE bridge: `npx port4-mcp` ([`packages/port4-mcp`](./packages/port4-mcp))

---

## Features

- **Stateless MCP (`2026-07-28`):** `POST`-only JSON-RPC 2.0, 64 KiB body limit, DNS-rebinding `Origin` checks, header/body consistency validation, cursor-paginated `tools/list`, and free `$0` tools.
- **Dual payment rails (x402 v2 + Tempo MPP):** Supports 8 EVM USDC chains, 2 Tempo OUSD chains, and 2 Solana SPL USDC chains. Payments settle directly to merchant wallets with durable replay protection (`PaymentReplayGuard` Durable Object).
- **Cloudflare Code Mode (`@cloudflare/codemode`):** Runs agent JavaScript inside isolated Cloudflare Dynamic Workers (`LOADER`, `globalOutbound: null`) with JSON Schema validation, max sub-call limits, and atomic spend enforcement.
- **Security and zero trust:** Optional Cloudflare One Access (`x402+oauth_v2`), Visa Trusted Agent Protocol (TAP RFC 9421 Ed25519 + JKT checks), AES-256-GCM encrypted upstream secrets, and HMAC-SHA256 `X-Port4-Signature` outbound signing.
- **Async metering ledger:** Cloudflare Queues (`METERING_EVENTS`) deduplicate settled calls into D1 (`processed_metering_events`, `transactions`, `usage_rollups`) with optional R2 NDJSON archiving.
- **OpenAPI and MCP import:** Import REST APIs from OpenAPI 3.x JSON/YAML (up to 256 KiB) or sync tools directly from an existing MCP server.

---

## How It Works

```text
AI Agent / IDE (Cursor, Claude Desktop, Windsurf, @x402/fetch, Visa CLI)
  |
  v  POST /mcp or /mcp/:tenant (MCP 2026-07-28 JSON-RPC 2.0)
[Cloudflare Edge Worker (src/index.ts)]
  1. Tenant Resolution (KV TENANT_ROUTING cache, D1 fallback)
  2. Rate Limit & Daily Quota (EdgeRateLimiter Durable Object)
  3. MCP 2026-07-28 Validation (64 KiB cap, Origin check)
  4. Optional Cloudflare One Access (RS256 JWKS + AUD check)
  5. Optional Visa TAP (RFC 9421 Ed25519 + JKT + DO nonce guard)
  6. Payment Gate & Replay Guard (x402 v2 + Tempo OUSD MPP, 4-state atomic lock)
  7. Execution Engine (direct REST/MCP adapter or Code Mode Dynamic Worker)
  8. Async Metering (METERING_EVENTS Queue -> D1 ledger + optional R2 archive)
```

---

## Local Development

### Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Wrangler CLI (installed via `devDependencies`)

### Setup

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/Port4-dev/port4-mcp.git
cd port4-mcp

npm install
npm --prefix web install
```

2. Create your local `.dev.vars` file:

```bash
cp .dev.vars.example .dev.vars
```

Set a strong `JWT_SECRET` (at least 32 characters) in `.dev.vars`. Do not commit `.dev.vars` (it is listed in `.gitignore`).

3. Apply local D1 migrations, build the frontend, and start the dev server:

```bash
npm run db:migrate:local
npm run cf-typegen
npm run typecheck
npm test

npm run build:web
npm run dev
```

---

## Self-Hosting on Cloudflare Workers

1. Create your Cloudflare resources:

```bash
npx wrangler d1 create port4-db
npx wrangler kv namespace create TENANT_ROUTING
npx wrangler queues create port4-metering
npx wrangler queues create port4-metering-dlq
```

2. Update `wrangler.jsonc` with your `database_id`, `kv_namespaces.id`, `routes`, `APP_URL`, and `ADMIN_GITHUB_LOGIN` / `ADMIN_GITHUB_ID`.

3. Add required secrets with Wrangler:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

4. Apply remote migrations and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

### Environment Variables and Secrets

| Name | Type | Purpose |
| :--- | :--- | :--- |
| `APP_URL` | Var | Public origin URL (for example `https://port4.dev`) |
| `X402_NETWORK` | Var | Default settlement network (`eip155:84532`) |
| `X402_USDC_ASSET` | Var | Default USDC token contract address |
| `X402_FACILITATOR_URL` / `FACILITATOR_URL` | Var | Default x402 testnet facilitator URL |
| `X402_MAINNET_FACILITATOR_URL` | Var / Secret | Optional mainnet facilitator URL for EVM/Solana settlement |
| `X402_FACILITATOR_API_KEY` | Secret | Optional Bearer API key for mainnet facilitator auth |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Secret | Optional Coinbase CDP credentials for mainnet facilitator JWTs |
| `SANDBOX_PAYOUT_WALLET` | Var | Payout wallet for the built-in demo tenant |
| `ADMIN_GITHUB_LOGIN` / `ADMIN_GITHUB_ID` | Var / Secret | Super-admin GitHub handle or numeric ID for `/admin` |
| `DEMO_AUTH_ENABLED` | Var | Set to `"true"` only in local development to allow demo login |
| `JWT_SECRET` | Secret | Master key for session JWTs, sandbox proofs, and encrypted secrets |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Secret | GitHub OAuth credentials for developer sign-in |
| `PORT4_TREASURY_WALLET` / `PORT4_TREASURY_SOLANA_WALLET` | Var / Secret | Platform fee recipient wallets (EVM / Solana) |
| `VISA_TAP_REGISTRY_URL` | Var | Visa TAP JWKS directory URL (default `https://auth.visacli.sh`) |
| `TEMPO_MAINNET_RPC_URL` / `TEMPO_TESTNET_RPC_URL` | Var / Secret | Tempo JSON-RPC endpoints for OUSD MPP verification |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRO_PRICE_ID` | Secret | Optional Stripe billing credentials for Pro plan upgrades |
| `MCP_RATE_LIMIT_PER_MINUTE` | Var | Fallback per-minute rate limit when tenant RPM is unset (default `120`) |

---

## Supported Settlement Networks (`GET /api/networks`)

Tenants can configure a primary payout wallet plus up to 10 additional chain wallets:

- **EVM (`0x...` Circle USDC):** Base Mainnet (`eip155:8453`), Base Sepolia (`eip155:84532`), Arbitrum One (`eip155:42161`), Arbitrum Sepolia (`eip155:421614`), Optimism (`eip155:10`), Polygon PoS (`eip155:137`), Ethereum Mainnet (`eip155:1`), Avalanche C-Chain (`eip155:43114`)
- **Tempo (`0x...` Visa CLI OUSD):** Tempo Mainnet (`eip155:4217`), Tempo Testnet (`eip155:42431`)
- **Solana (`Base58` SPL USDC):** Solana Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)

---

## CLI and Desktop IDE Bridge (`port4-mcp`)

The official CLI package lives in [`packages/port4-mcp`](./packages/port4-mcp) (also linked at `./cli/port4-mcp.mjs`):

```bash
# Inspect any Port4 MCP endpoint
npx -y port4-mcp inspect https://port4.dev/mcp/demo

# Run as a local STDIO-to-HTTP MCP bridge for Cursor, Claude Desktop, or Windsurf
npx -y port4-mcp bridge --url https://port4.dev/mcp/demo --max-per-call-usd 0.05 --max-session-usd 1.00

# Manage tenants or import OpenAPI specs from CI using a scoped API key
PORT4_API_KEY=p4_live_... npx -y port4-mcp tenants
```

---

## Testing

```bash
# Run TypeScript checks, 190 conformance tests, and CLI self-test
npm run test:all

# Run local workerd + D1 + STDIO bridge end-to-end tests
npm run build:web
npm run test:e2e
```

---

## Contributing

1. Fork the repository and create a branch from `main`.
2. Run `npm run test:all` and verify all checks pass.
3. Never commit secrets, `.dev.vars`, or private credentials.
4. Open a pull request describing your changes and how you tested them.

## Security

To report a security issue, email **info@port4.dev** instead of opening a public issue.

## License

Released under the [MIT License](./LICENSE).
