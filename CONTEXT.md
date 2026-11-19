# Port4 (`port4.dev`) — Live Architecture Context

## Project Overview
**Port4** is a $0-cost, multi-tenant **Paid MCP (`2026-07-28`) & x402 v2 API Monetization Gateway** built on the Cloudflare Developer Platform.
- **Production Domain:** `https://port4.dev` (Wildcard tenants: `https://{tenant}.port4.dev/mcp`)
- **Cloudflare Account:** `Port 4` (`34eff427e2830dfba1ed210a8ef4d567`)
- **Strategic Target:** Cloudflare for Startups Tier 3 ($10,000 credits) verifiable $0/mo MVP.

## Cloudflare Bindings (`wrangler.jsonc`)
| Binding | Type | Resource ID | Purpose |
| :--- | :--- | :--- | :--- |
| `DB` | D1 Database (`port4-db`) | `833d7aa9-ffaa-4a9c-92e0-dfda811647b1` | Users, API keys, tenants, tools, transactions, RBAC, platform fees |
| `TENANT_ROUTING` | KV Namespace | `b5d0c5acba7a402d9ad1960ae1c9c184` | Sub-5ms edge cache for tenant config, tools, plan fee rate, and instant kill-switch |
| `ASSETS` | Workers Static Assets | `./dist` | React + Vite SPA (`run_worker_first: true`, `not_found_handling: "single-page-application"`) |

## Non-Secret Vars (`wrangler.jsonc`) & Secret Bindings (via `c.env`)
- **Vars:** `APP_URL`, `FACILITATOR_URL`, `X402_FACILITATOR_URL`, `X402_NETWORK`, `X402_USDC_ASSET`, `SANDBOX_PAYOUT_WALLET`, `ADMIN_GITHUB_LOGIN` (`Ishabarundo`).
- **Secrets (typed on `CloudflareBindings`, never logged or stored in repo):** `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PORT4_TREASURY_WALLET`, `DEMO_PAYER_PRIVATE_KEY`.

## D1 Schema (`migrations/0001_init.sql` + `migrations/0002_admin_and_fees.sql`)
- `users`: `id`, `github_id`, `login`, `avatar_url`, `email`, `is_admin` (`0|1`), `plan` (`'free'|'pro'`), `created_at`
- `api_keys`: `id`, `user_id`, `name`, `key_prefix`, `key_hash` (SHA-256), `created_at`, `last_used_at`
- `tenants`: `id`, `user_id`, `subdomain`, `name`, `upstream_base_url`, `payout_wallet`, `network`, `auth_mode`, `is_active`, `status` (`'active'|'suspended'`), `is_featured` (`0|1`), `call_count`, `created_at`, `updated_at`
- `tools`: `id`, `tenant_id`, `name`, `description`, `http_method`, `upstream_path`, `input_schema_json`, `price_usd`, `price_atomic`, `is_active`, `created_at`
- `transactions`: `id`, `tenant_id`, `tool_name`, `payer_wallet`, `amount_atomic`, `amount_usd`, `network`, `tx_hash`, `status`, `latency_ms`, `is_platform_fee` (`0|1`), `created_at`

## Routes
- **Health:** `GET /health`, `GET /api/health`
- **Auth:** `GET /api/auth/github`, `GET /api/auth/github/callback`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/demo` (also aliased at `/auth/*`)
- **Control Plane:** `/api/tenants`, `/api/tenants/:id/tools`, `/api/ledger`, `/api/keys`, `/api/public/featured`, `/api/public/ledger`
- **Super-Admin (`requireAdmin` — D1 re-verified):**
  - `GET /api/admin/stats`
  - `GET /api/admin/tenants`
  - `PATCH /api/admin/tenants/:slug/status` (instant KV kill-switch)
  - `PATCH /api/admin/tenants/:slug/featured`
  - `GET /api/admin/users`, `PATCH /api/admin/users/:id/plan`
  - `GET /api/admin/transactions`
- **Sandbox:** `POST /api/sandbox/run`, `POST /sandbox/sign`, `POST /sandbox/mcp`
- **Data Plane:** `POST /mcp` (Stateless MCP `2026-07-28` + x402 v2 + deterministic non-custodial fee split)
- **SPA Routes:** `/`, `/dashboard`, `/admin`, `/docs`, `/llms.txt`, `/llm.txt`, `/sitemap.xml`, `/robots.txt`

## Current Build Phase
- [x] Phase 1–5: Live MVP deployed to `https://port4.dev`
- [x] Phase 6: Super-Admin RBAC & `/admin` suite, non-custodial fee split, `POST /api/sandbox/run`, Blue & Green minimalist UI + Featured Registry (verified locally; awaiting approval for remote D1 migration + deploy)
