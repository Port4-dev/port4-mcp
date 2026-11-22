-- Migration 0008: Authoritative Ledger, Idempotent Metering, Soft-Delete Preservation,
-- Protocol Adapters (REST/MCP/OpenAPI), Upstream Auth Credentials, Scoped API Keys & Audit Logs

CREATE TABLE IF NOT EXISTS processed_metering_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  amount_atomic INTEGER NOT NULL,
  is_platform_fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_processed_events_tenant ON processed_metering_events(tenant_id, created_at DESC);

ALTER TABLE usage_rollups ADD COLUMN gross_atomic INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tenants ADD COLUMN deleted_at TEXT;
ALTER TABLE tenants ADD COLUMN settled_call_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN upstream_auth_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tenants ADD COLUMN upstream_auth_header TEXT;
ALTER TABLE tenants ADD COLUMN upstream_auth_secret TEXT;
ALTER TABLE tenants ADD COLUMN require_upstream_verified INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tools ADD COLUMN source_type TEXT NOT NULL DEFAULT 'rest';
ALTER TABLE tools ADD COLUMN remote_tool_name TEXT;

ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'tenant:read,tenant:write';
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;

CREATE TABLE IF NOT EXISTS revoked_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
