# Port4 Engineering Rules (Strict)

1. **TypeScript Strict Mode:** All Worker (`src/`) and Frontend (`web/src/`) code must compile cleanly under `"strict": true` with zero `any` on `Env` or handler parameters.
2. **Configuration Format:** Use `wrangler.jsonc` exclusively. Never create `wrangler.toml`.
3. **No `process.env`:** Never access `process.env` in Worker code. Always read bindings, vars, and secrets from `c.env` typed with the generated `CloudflareBindings` interface (`npx wrangler types --env-interface CloudflareBindings`).
4. **Edge-Native Crypto & APIs:** Use Web Crypto API (`crypto.subtle`, `crypto.randomUUID()`, `crypto.getRandomValues()`), never `Math.random()` for security tokens and never Node-only built-ins.
5. **Background Work Lifetime:** Any post-response D1 transaction logging or KV sync must be awaited or attached via `c.executionCtx.waitUntil(...)` (never bare detached promises).
6. **Minimal Wording UI:** Headlines max 5–7 words. No walls of marketing copy. Let the live 1-Click x402 Sandbox and 3-tab dashboard (`Endpoints`, `Ledger`, `Deploy`) communicate the product.
7. **Verification Gate:** After every build phase, run:
   - `npx wrangler types --env-interface CloudflareBindings`
   - `npm run typecheck`
   - `npx wrangler d1 migrations apply port4-db --local`
   - `npx wrangler dev` + `curl` E2E tests against `/mcp`.
