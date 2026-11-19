# Port4 (`port4.dev`) — Architecture Decision Log

## ADR-001: Single Multi-Tenant Gateway Worker vs. Workers for Platforms
- **Status:** Accepted (MVP)
- **Decision:** Run a single Hono TypeScript Worker bound to `port4.dev/*` and `*.port4.dev/*` on the Cloudflare Workers Free Plan ($0/mo). Isolate tenants via `TENANT_ROUTING` KV and D1 foreign keys.

## ADR-002: Workers Static Assets with `run_worker_first: true`
- **Status:** Accepted
- **Decision:** Configure `assets.directory: "./dist"`, `binding: "ASSETS"`, `not_found_handling: "single-page-application"`, and `run_worker_first: true` so the Worker intercepts wildcard `/mcp` and `/api/*` traffic before falling back to `env.ASSETS.fetch(request)`.

## ADR-003: Stateless MCP `2026-07-28` Protocol
- **Status:** Accepted
- **Decision:** Reject stateful `initialize` calls and `Mcp-Session-Id` headers. Validate `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers against the JSON-RPC 2.0 body (rejecting mismatches with `400`). Serve `tools/list` with `Cache-Control: public, max-age=300` for edge caching.

## ADR-004: Deterministic Non-Custodial Fee Split
- **Status:** Accepted
- **Context:** Port4 must collect platform fees without custodying developer funds or adding extra on-chain settlement hops.
- **Decision:** Deterministically route `payTo` in `PAYMENT-REQUIRED` to `c.env.PORT4_TREASURY_WALLET` based on the tenant owner's plan (`free`: 3% = every 33rd call; `pro`: 1% = every 100th call) and record `is_platform_fee = 1` in D1 `transactions`.
- **Consequences:** 100% non-custodial, zero extra gas, auditable in D1 and BaseScan.

## ADR-005: Super-Admin RBAC & Instant Edge Kill-Switch
- **Status:** Accepted
- **Decision:** Auto-promote `ADMIN_GITHUB_LOGIN` (`Ishabarundo`) to `is_admin = 1` on GitHub OAuth login. Protect all `/api/admin/*` routes with `requireAdmin`, which verifies the HTTP-only JWT cookie *and* re-checks `is_admin === 1` against D1 on every request. Suspending a tenant updates D1 `status = 'suspended'` and immediately deletes the tenant key from `TENANT_ROUTING` KV for millisecond edge cutoff.
