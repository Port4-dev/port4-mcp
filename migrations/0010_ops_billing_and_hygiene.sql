-- Migration 0010: Operations, Self-Serve Billing, Webhooks & DB Hygiene
DROP TABLE IF EXISTS payment_replays;

ALTER TABLE revoked_sessions ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires ON revoked_sessions(expires_at);

ALTER TABLE tenants ADD COLUMN webhook_url TEXT;

ALTER TABLE users ADD COLUMN billing_customer_id TEXT;
ALTER TABLE users ADD COLUMN plan_upgraded_at TEXT;
