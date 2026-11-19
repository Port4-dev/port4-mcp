-- Migration 0002: Super-Admin RBAC, Plan Fee Tiers, Edge Kill-Switch, Featured Registry, Platform Fee Split

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';

ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN call_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE transactions ADD COLUMN is_platform_fee INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_featured ON tenants(is_featured, status);
CREATE INDEX IF NOT EXISTS idx_transactions_platform_fee ON transactions(is_platform_fee, created_at DESC);

-- Promote built-in demo tenant to featured & seed `ping` tool for quick 402 verification
UPDATE tenants SET is_featured = 1, status = 'active' WHERE subdomain = 'demo';

INSERT OR IGNORE INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, is_active)
VALUES (
  'tool_sandbox_ping',
  'ten_port4_sandbox',
  'ping',
  'Instant edge liveness & x402 settlement test tool ($0.001 USDC on Base Sepolia).',
  'POST',
  '/ping',
  '{"type":"object","properties":{"message":{"type":"string","description":"Optional ping payload"}}}',
  '0.001',
  '1000',
  1
);
