# Port4 (`port4.dev`) — Architecture Decision Log

## ADR-001: Single Multi-Tenant Gateway Worker on Workers Paid Plan
- **Status:** Accepted
- **Decision:** Run a single Hono TypeScript Worker (`port4-gateway`) bound to `port4.dev` (`custom_domain: true`) and `*.port4.dev/*` (`zone_name: "port4.dev"`) on the Cloudflare Workers Paid Plan ($5/mo, required for Queues, Dynamic Worker Loaders `LOADER`, Traces, and optional R2/Analytics Engine). Isolate tenants via `TENANT_ROUTING` KV, D1 foreign keys, and declarative SQLite-backed Durable Object `exports`.

## ADR-002: Workers Static Assets with `run_worker_first: true`
- **Status:** Accepted
- **Decision:** Configure `assets.directory: "./dist"`, `binding: "ASSETS"`, `not_found_handling: "single-page-application"`, and `run_worker_first: true` so the Worker intercepts wildcard `/mcp*`, `/openapi.json`, `/sandbox/*`, and `/api/*` traffic before falling back to `env.ASSETS.fetch(request)`.

## ADR-003: Stateless MCP `2026-07-28` Protocol
- **Status:** Accepted
- **Decision:** Reject stateful `initialize` calls (`400`) and `GET` stream probes on `/mcp`, `/mcp/:tenant`, and `/sandbox/mcp` (`405` with `Allow: POST, OPTIONS`). Ignore `Mcp-Session-Id` headers per stateless MCP rules. Enforce 64 KiB body caps, DNS-rebinding `Origin` checks, and `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` header-body consistency. Serve `tools/list` with `Cache-Control: public, max-age=300`.

## ADR-004: Deterministic Multi-Chain Non-Custodial Fee Split
- **Status:** Accepted
- **Context:** Port4 must collect platform fees across EVM USDC, Tempo OUSD, and Solana SPL USDC without custodying developer funds or adding extra on-chain settlement hops.
- **Decision:** Deterministically route `payTo` in `PAYMENT-REQUIRED` to `c.env.PORT4_TREASURY_WALLET` (EVM/Tempo) or `c.env.PORT4_TREASURY_SOLANA_WALLET` (Solana) based on the tenant owner's plan (`free`: 3% = every 33rd call; `pro`: 1% = every 100th call) and record `is_platform_fee = 1` in D1 `transactions`.
- **Consequences:** 100% non-custodial, zero extra gas, auditable in D1 and across all 12 supported chain explorers (`BaseScan`, `Arbiscan`, `Optimistic Etherscan`, `PolygonScan`, `Etherscan`, `Snowtrace`, `Tempo Explorer`, `Solscan`).

## ADR-005: Super-Admin RBAC, Immutable Admin ID & Instant Edge Kill-Switch
- **Status:** Accepted
- **Decision:** Prioritize immutable `ADMIN_GITHUB_ID` (falling back to `ADMIN_GITHUB_LOGIN` only when `ADMIN_GITHUB_ID` is unset) to auto-promote `is_admin = 1` on GitHub OAuth login. Protect all `/api/admin/*` routes with `requireAdmin`, which verifies the HTTP-only JWT cookie (checked against `revoked_sessions`), rejects non-`admin:all` API keys (`403`), and re-checks `is_admin === 1` against D1 on every request. Suspending a tenant updates D1 `status = 'suspended'`, logs to `audit_logs`, and immediately deletes the tenant key from `TENANT_ROUTING` KV for millisecond edge cutoff.

## ADR-006: 4-State Durable Object `PaymentReplayGuard` & Idempotent Queue Metering
- **Status:** Accepted
- **Decision:** Bind every payment authorization fingerprint to `(tenantId, toolName, network, asset, amountAtomic, payTo)` in SQLite-backed `PaymentReplayGuard` DOs across 4 states (`in_flight` → `settlement_pending` → `settled_pending_upstream` → `completed`) with `leaseToken` fencing and `IN_FLIGHT_LEASE_MS` (60s) protection against concurrent upstream double-execution. Offload D1 financial writes from the hot path to the `METERING_EVENTS` Queue (`port4-metering`), deduplicating via `processed_metering_events` before batching `transactions`, `usage_rollups`, and `tenants.settled_call_sequence`.

## ADR-007: Cloudflare Code Mode (`@cloudflare/codemode` + `LOADER`)
- **Status:** Accepted
- **Decision:** Support `direct`, `codemode`, and `openapi_codemode` per tenant. Execute multi-step agent scripts inside isolated Dynamic Workers (`env.LOADER`) with `globalOutbound: null` so scripts can only invoke scoped, budget-capped Port4 sub-tool RPC bindings (`codemode_max_subcalls` and authorized atomic spend cap).

## ADR-008: Enterprise Zero-Trust Gate via Cloudflare One Access (`x402+oauth_v2`)
- **Status:** Accepted
- **Decision:** Allow tenants with `auth_mode = 'x402+oauth_v2'` to require a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` or `Authorization: Bearer <jwt>`) verified against the tenant's `<team>.cloudflareaccess.com/cdn-cgi/access/certs` JWKS and `cf_access_aud` claim before payment or tool execution.

## ADR-009: Upstream Credential Encryption at Rest & Outgoing HMAC-SHA256 Signing
- **Status:** Accepted
- **Decision:** Encrypt third-party `upstream_auth_secret` values at rest using AES-256-GCM (`enc:v1:<iv>:<ciphertext>`) derived from `JWT_SECRET` before storing in D1 or caching in `TENANT_ROUTING` KV, and block reserved protocol headers (`X-Port4-*`, `CF-*`, `Payment-*`, `Mcp-*`, `Host`, etc.) on custom auth headers. Sign outgoing upstream requests with `X-Port4-Timestamp` and `X-Port4-Signature: v1=<hmac-sha256>` so origin APIs can verify Port4 authenticity.

## ADR-010: Dual-Rail Agent Monetization — Visa TAP (`RFC 9421`) & Tempo OUSD MPP
- **Status:** Accepted
- **Decision:** Support Visa Trusted Agent Protocol (`Signature-Input` / `Signature` / `Content-Digest` Ed25519 verification against Visa Agent Directory RFC 7638 JKT keys, plus distributed nonce reservation in `EdgeRateLimiter`) alongside Tempo OUSD Machine Payments Protocol (`WWW-Authenticate: Payment` dual-rail 402 challenges, strict ERC-20 `Transfer` log verification, and `/openapi.json` `x-payment-info` discovery).
