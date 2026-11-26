# Port4 (`port4.dev`) — Live Architecture Context

## Project Overview
**Port4** is a multi-tenant **Paid MCP (`2026-07-28`), x402 v2, Visa TAP, & Tempo MPP API Monetization Gateway** built on the Cloudflare Developer Platform.
- **Production Domain:** `https://port4.dev` (`custom_domain: true`; wildcard tenants: `https://{tenant}.port4.dev/mcp` and path fallback `https://port4.dev/mcp/{tenant}`)
- **Cloudflare Account:** `Port 4` (`34eff427e2830dfba1ed210a8ef4d567`)
- **Supported Settlement Networks (`src/lib/networks.ts`, 12 total):**
  - **EVM USDC (`0x...`):** Base Mainnet (`eip155:8453`), Base Sepolia (`eip155:84532`), Arbitrum One (`eip155:42161`), Arbitrum Sepolia (`eip155:421614`), Optimism (`eip155:10`), Polygon PoS (`eip155:137`), Ethereum Mainnet (`eip155:1`), Avalanche C-Chain (`eip155:43114`)
  - **Tempo OUSD (`0x20c0000000000000000000006a37da5c996874be`):** Tempo Mainnet (`eip155:4217`), Tempo Testnet (`eip155:42431`) for Visa CLI / Machine Payments Protocol (MPP)
  - **Solana SPL USDC (`Base58`):** Solana Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)
  - Multi-chain `accepts[]` per tenant via `payout_wallets_json`, plus browser wallet connect (EIP-6963 + Phantom/Solflare/Backpack).
- **Agent Protocols & Security Rails:**
  - **Stateless MCP `2026-07-28`:** `POST`-only JSON-RPC 2.0 (`GET /mcp`, `GET /mcp/:tenant`, `GET /sandbox/mcp` return `405` with `Allow: POST, OPTIONS`), 64 KiB body cap, DNS-rebinding `Origin` guard, header/body consistency (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`), `ping`, cursor-paginated `tools/list`, and free `$0` direct tools.
  - **Visa TAP (`RFC 9421`):** Ed25519 HTTP Message Signature + Visa Agent Directory RFC 7638 JKT verification, with distributed nonce anti-replay in `EdgeRateLimiter`.
  - **Tempo OUSD MPP:** Dual-rail HTTP `402` challenge (`PAYMENT-REQUIRED` + `WWW-Authenticate: Payment`), strict ERC-20 OUSD `Transfer` log verification, and OpenAPI 3.1.0 discovery (`/openapi.json`, `/mcp/:tenant/openapi.json`) with `x-payment-info` and direct tool routes (`/mcp/tools/:toolName`, `/mcp/:tenant/tools/:toolName`).
  - **Cloudflare One Access (`x402+oauth_v2`):** JWKS-verified JWTs via `Cf-Access-Jwt-Assertion` or `Authorization: Bearer <jwt>`.
  - **Cloudflare Code Mode:** `@cloudflare/codemode` + `LOADER` Dynamic Worker sandbox (`globalOutbound: null`) using `ResolvedProvider[]` in `codemode` and `openapi_codemode` modes.

## Cloudflare Bindings (`wrangler.jsonc`)
| Binding | Type | Resource ID / Name | Purpose |
| :--- | :--- | :--- | :--- |
| `DB` | D1 Database (`port4-db`) | `833d7aa9-ffaa-4a9c-92e0-dfda811647b1` | Control-plane metadata, users, scoped API keys, tenants, tools, `processed_metering_events`, hourly `usage_rollups`, `revoked_sessions`, `audit_logs` |
| `TENANT_ROUTING` | KV Namespace | `b5d0c5acba7a402d9ad1960ae1c9c184` | Sub-5ms edge cache for tenant config, multi-wallet payouts, tools, quotas, and kill-switch |
| `EDGE_RATE_LIMITER` | Durable Object (`exports`, SQLite) | `EdgeRateLimiter` | Per-tenant/IP RPM, daily quotas, tenant-wide `next_fee_sequence`, and Visa TAP distributed nonces (`tap_nonce_until`) |
| `PAYMENT_REPLAY_GUARD` | Durable Object (`exports`, SQLite) | `PaymentReplayGuard` | 4-state durable idempotency (`in_flight` → `settlement_pending` → `settled_pending_upstream` → `completed`) with `IN_FLIGHT_LEASE_MS` fencing and cross-context isolation |
| `LOADER` | Worker Loader | `worker_loaders` | Isolated Dynamic Worker sandbox (`globalOutbound: null`) for `@cloudflare/codemode` |
| `METERING_EVENTS` | Queue | `port4-metering` (DLQ `port4-metering-dlq`) | Async zero-D1 hot-path metering deduplicated into `processed_metering_events`, `transactions`, `usage_rollups` & optional R2 archival |
| `ASSETS` | Workers Static Assets | `./dist` | React 19 + Vite 6 SPA (`run_worker_first: true`, `not_found_handling: "single-page-application"`) |

## Non-Secret Vars (`wrangler.jsonc`) & Secret / Optional Bindings (`AppBindings` in `src/types.ts`)
- **Vars (`wrangler.jsonc`):** `APP_URL`, `ADMIN_GITHUB_LOGIN` (`joro-nimo`), `ADMIN_GITHUB_ID` (`185346167`), `FACILITATOR_URL`, `X402_FACILITATOR_URL`, `X402_NETWORK`, `X402_USDC_ASSET`, `SANDBOX_PAYOUT_WALLET`, `TEMPO_MAINNET_RPC_URL`, `TEMPO_TESTNET_RPC_URL`.
- **Required Secrets (typed on `CloudflareBindings`, never logged or stored in repo):** `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
- **Optional Runtime Bindings & Config (`AppBindings`):** `PORT4_TREASURY_WALLET`, `PORT4_TREASURY_SOLANA_WALLET`, `DEMO_PAYER_PRIVATE_KEY`, `DEMO_AUTH_ENABLED`, `ADMIN_GITHUB_ID`, `X402_MAINNET_FACILITATOR_URL`, `X402_FACILITATOR_API_KEY`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `VISA_TAP_REGISTRY_URL`, `TEMPO_RPC_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `MCP_RATE_LIMIT_PER_MINUTE`, `GATEWAY_ANALYTICS` (`AnalyticsEngineDataset`), `LEDGER_ARCHIVE` (`R2Bucket`).

## D1 Migrations (`migrations/`)
1. `0001_init.sql` — `users`, `api_keys`, `tenants`, `tools`, `transactions`, demo seed
2. `0002_admin_and_fees.sql` — RBAC `is_admin`, `plan`, `status`, `is_featured`, `call_count`, `is_platform_fee`
3. `0003_payment_replay_protection.sql` — Legacy `payment_replays` table (dropped in `0010`)
4. `0004_usage_rollups.sql` — Queue-batched hourly aggregates (`usage_rollups`)
5. `0005_upstream_security_and_quotas.sql` — `upstream_signing_secret`, `upstream_verified`, `verification_token`, `rate_limit_rpm`, `daily_quota`
6. `0006_multi_wallet_payouts.sql` — `payout_wallets_json` for multi-chain EVM + Solana x402 v2 `accepts[]`
7. `0007_codemode_and_zero_trust.sql` — `mcp_mode` (`direct`/`codemode`/`openapi_codemode`), `codemode_price_usd`, `codemode_max_subcalls`, `cf_access_team_domain`, `cf_access_aud`
8. `0008_authoritative_ledger_and_isolation.sql` — `processed_metering_events`, `usage_rollups.gross_atomic`, `tenants.{deleted_at, settled_call_sequence, upstream_auth_type, upstream_auth_header, upstream_auth_secret, require_upstream_verified}`, `tools.{source_type, remote_tool_name}`, `api_keys.{scopes, expires_at, revoked_at}`, `revoked_sessions`, `audit_logs`
9. `0009_visa_tap_and_mpp.sql` — `tenants.{require_visa_tap, allow_tap_simulated}`, `transactions.tap_agent_id`
10. `0010_ops_billing_and_hygiene.sql` — Drops legacy `payment_replays`, adds `revoked_sessions.expires_at` (with daily cron pruning), `tenants.webhook_url`, and `users.{billing_customer_id, plan_upgraded_at}`

## Routes
- **Health, Meta & Discovery:** `GET /health`, `GET /api/health`, `GET /api/networks`, `GET /openapi.json`, `GET /mcp/:tenant/openapi.json`
- **Auth (`/api/auth/*` & `/auth/*`):** `GET /api/auth/github`, `GET /api/auth/github/callback`, `POST /api/auth/demo`, `GET /api/auth/me`, `POST /api/auth/logout`
- **Control Plane & Billing (API Key Scopes Enforced):** `GET/POST /api/tenants`, `PATCH/DELETE /api/tenants/:id`, `POST /api/tenants/:id/verify-upstream`, `POST /api/tenants/:id/rotate-secret`, `POST /api/tenants/:id/import-openapi`, `POST /api/tenants/:id/tools`, `PATCH/DELETE /api/tenants/:id/tools/:toolId`, `POST /api/tenants/:id/test-call`, `POST /api/tenants/:id/sync-mcp`, `GET /api/ledger`, `GET /api/ledger/export`, `GET/POST /api/keys`, `DELETE /api/keys/:id`, `GET /api/billing/plans`, `POST /api/billing/upgrade`, `POST /api/webhooks/stripe`, `GET /api/public/featured`, `GET /api/public/ledger`
- **Super-Admin (`requireAdmin` — D1 re-verified + `admin:all` scope gate):** `GET /api/admin/stats`, `GET /api/admin/tenants`, `PATCH /api/admin/tenants/:slug/status`, `PATCH /api/admin/tenants/:slug/featured`, `GET /api/admin/users`, `GET /api/admin/traffic`, `PATCH /api/admin/users/:id/plan`, `GET /api/admin/transactions`, `GET /api/admin/audit-logs`, `POST /api/admin/payments/:fingerprint/reconcile`
- **Sandbox (`/api/sandbox/*` & `/sandbox/*`):** `POST /api/sandbox/run`, `POST /api/sandbox/sign`, `POST /sandbox/mcp`, `GET /sandbox/mcp` (`405`)
- **Data Plane:** `POST /mcp`, `POST /mcp/:tenant`, `POST /mcp/tools/:toolName`, `POST /mcp/:tenant/tools/:toolName`, `GET /mcp*` (`405`)
- **SPA & Static Assets:** `/`, `/dashboard` (`/console`), `/admin`, `/docs` (`/sandbox`), `/terms`, `/privacy`, `/llms.txt`, `/llm.txt`, `/sitemap.xml`, `/robots.txt`
