-- Migration 0005: Tenant upstream ownership verification, HMAC request signing, and per-tenant rate limits/quotas

ALTER TABLE tenants ADD COLUMN upstream_signing_secret TEXT;
ALTER TABLE tenants ADD COLUMN upstream_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN verification_token TEXT;
ALTER TABLE tenants ADD COLUMN rate_limit_rpm INTEGER NOT NULL DEFAULT 120;
ALTER TABLE tenants ADD COLUMN daily_quota INTEGER NOT NULL DEFAULT 10000;

CREATE INDEX IF NOT EXISTS idx_tenants_verified ON tenants(upstream_verified);
