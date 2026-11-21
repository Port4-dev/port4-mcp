# Port4 (`port4.dev`) — Live Architecture Context

## Project Overview
**Port4** is a multi-tenant **Paid MCP (`2026-07-28`) & x402 v2 API Monetization Gateway** built on the Cloudflare Developer Platform.
- **Production Domain:** `https://port4.dev` (Wildcard tenants: `https://{tenant}.port4.dev/mcp` and path fallback `https://port4.dev/mcp/{tenant}`)
- **Cloudflare Account:** `Port 4` (`34eff427e2830dfba1ed210a8ef4d567`)
- **Supported Settlement Networks (`src/lib/networks.ts`):**
  - **EVM (`0x...`):** Base Mainnet/Sepolia, Arbitrum One/Sepolia, Optimism, Polygon PoS, Ethereum Mainnet, Avalanche C-Chain
  - **Solana (`Base58`):** Solana Mainnet & Solana Devnet (SPL USDC)
  - Multi-chain `accepts[]` per tenant via `payout_wallets_json`, plus browser wallet connect (EIP-6963 + Phantom/Solflare/Backpack).

## Cloudflare Bindings (`wrangler.jsonc`)
| Binding | Type | Resource ID / Name | Purpose |
| :--- | :--- | :--- | :--- |
| `DB` | D1 Database (`port4-db`) | `833d7aa9-ffaa-4a9c-92e0-dfda811647b1` | Control-plane metadata, users, API keys, tenants, tools, hourly `usage_rollups` |
| `TENANT_ROUTING` | KV Namespace | `b5d0c5acba7a402d9ad1960ae1c9c184` | Sub-5ms edge cache for tenant config, multi-wallet payouts, tools, quotas, and kill-switch |
| `EDGE_RATE_LIMITER` | Durable Object | `EdgeRateLimiter` | Per-tenant/IP RPM, daily quotas, and atomic sequence for non-custodial fee splits |
| `PAYMENT_REPLAY_GUARD` | Durable Object | `PaymentReplayGuard` | 3-state durable idempotency (`in_flight` → `settled_pending_upstream` → `completed`) |
| `METERING_EVENTS` | Queue | `port4-metering` | Async zero-D1 hot-path metering batched into `usage_rollups` & optional R2 archival |
| `ASSETS` | Workers Static Assets | `./dist` | React + Vite SPA (`run_worker_first: true`, `not_found_handling: "single-page-application"`) |

## Non-Secret Vars (`wrangler.jsonc`) & Secret Bindings (via `c.env`)
- **Vars:** `APP_URL`, `FACILITATOR_URL`, `X402_FACILITATOR_URL`, `X402_NETWORK`, `X402_USDC_ASSET`, `SANDBOX_PAYOUT_WALLET`, `ADMIN_GITHUB_LOGIN` (`Ishabarundo`).
- **Secrets (typed on `CloudflareBindings`, never logged or stored in repo):** `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PORT4_TREASURY_WALLET`, `PORT4_TREASURY_SOLANA_WALLET`, `DEMO_PAYER_PRIVATE_KEY`.

## D1 Migrations (`migrations/`)
1. `0001_init.sql` — `users`, `api_keys`, `tenants`, `tools`, `transactions`, demo seed
2. `0002_admin_and_fees.sql` — RBAC `is_admin`, `plan`, `status`, `is_featured`, `call_count`, `is_platform_fee`
3. `0003_payment_replay_protection.sql` — Payment replay guard table
4. `0004_usage_rollups.sql` — Queue-batched hourly aggregates (`usage_rollups`)
5. `0005_upstream_security_and_quotas.sql` — `upstream_signing_secret`, `upstream_verified`, `verification_token`, `rate_limit_rpm`, `daily_quota`
6. `0006_multi_wallet_payouts.sql` — `payout_wallets_json` for multi-chain EVM + Solana x402 v2 `accepts[]`

## Routes
- **Health & Meta:** `GET /health`, `GET /api/health`, `GET /api/networks`
- **Auth:** `GET /api/auth/github`, `GET /api/auth/github/callback`, `GET /api/auth/me`, `POST /api/auth/logout`
- **Control Plane:** `/api/tenants`, `PATCH /api/tenants/:id`, `PATCH /api/tenants/:id/tools/:toolId`, `POST /api/tenants/:id/verify-upstream`, `POST /api/tenants/:id/rotate-secret`, `POST /api/tenants/:id/test-call`, `POST /api/tenants/:id/sync-mcp`, `/api/ledger`, `/api/keys`, `/api/public/featured`, `/api/public/ledger`
- **Super-Admin (`requireAdmin` — D1 re-verified):** `/api/admin/stats`, `/api/admin/tenants`, `/api/admin/tenants/:slug/status`, `/api/admin/tenants/:slug/featured`, `/api/admin/users`, `/api/admin/users/:id/plan`, `/api/admin/transactions`
- **Sandbox:** `POST /api/sandbox/run`, `POST /sandbox/sign`, `POST /sandbox/mcp`
- **Data Plane:** `POST /mcp` & `POST /mcp/:slug` (Stateless MCP `2026-07-28` + multi-chain x402 v2 + HMAC-SHA256 upstream signing)
- **SPA Routes:** `/`, `/dashboard`, `/admin`, `/docs`, `/llms.txt`, `/llm.txt`, `/sitemap.xml`, `/robots.txt`
