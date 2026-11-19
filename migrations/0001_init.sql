-- Port4 D1 Schema (SQLite)
-- Multi-tenant Paid MCP & x402 API Monetization Gateway

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subdomain TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  upstream_base_url TEXT NOT NULL,
  payout_wallet TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'eip155:84532',
  auth_mode TEXT NOT NULL DEFAULT 'x402', -- 'x402' | 'x402+oauth_v2'
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  http_method TEXT NOT NULL DEFAULT 'POST',
  upstream_path TEXT NOT NULL,
  input_schema_json TEXT NOT NULL DEFAULT '{"type":"object","properties":{}}',
  price_usd TEXT NOT NULL DEFAULT '0.001',
  price_atomic TEXT NOT NULL DEFAULT '1000', -- USDC 6 decimals (1000 = $0.001)
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  payer_wallet TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  amount_usd TEXT NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  status TEXT NOT NULL, -- 'settled' | 'sandbox_settled' | 'failed'
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenants_user_id ON tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);
CREATE INDEX IF NOT EXISTS idx_tools_tenant_id ON tools(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_created ON transactions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);

-- Seed built-in sandbox user, tenant, and demo paid tool for immediate 1-Click verification
INSERT OR IGNORE INTO users (id, github_id, login, avatar_url, email)
VALUES (
  'usr_port4_sandbox',
  '0',
  'port4-demo',
  'https://avatars.githubusercontent.com/u/9919?v=4',
  'info@port4.dev'
);

INSERT OR IGNORE INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, auth_mode, is_active)
VALUES (
  'ten_port4_sandbox',
  'usr_port4_sandbox',
  'demo',
  'Port4 Demo Gateway',
  'internal://sandbox',
  '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  'eip155:84532',
  'x402',
  1
);

INSERT OR IGNORE INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, is_active)
VALUES (
  'tool_sandbox_quote',
  'ten_port4_sandbox',
  'market_quote',
  'Real-time edge crypto & FX quote paid via x402 USDC on Base Sepolia.',
  'POST',
  '/quote',
  '{"type":"object","properties":{"symbol":{"type":"string","description":"Ticker symbol, e.g. ETH-USD or BTC-USD"}},"required":["symbol"]}',
  '0.001',
  '1000',
  1
);

INSERT OR IGNORE INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, is_active)
VALUES (
  'tool_sandbox_dns',
  'ten_port4_sandbox',
  'edge_dns_lookup',
  'Low-latency DNS record intelligence at Cloudflare Edge.',
  'POST',
  '/dns',
  '{"type":"object","properties":{"domain":{"type":"string","description":"Domain name to inspect"}},"required":["domain"]}',
  '0.002',
  '2000',
  1
);
