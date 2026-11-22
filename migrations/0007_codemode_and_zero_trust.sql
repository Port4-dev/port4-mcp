-- Migration 0007: Cloudflare Code Mode (@cloudflare/codemode + Dynamic Workers) & Cloudflare One Access Zero Trust
ALTER TABLE tenants ADD COLUMN mcp_mode TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE tenants ADD COLUMN codemode_price_usd TEXT NOT NULL DEFAULT '0.01';
ALTER TABLE tenants ADD COLUMN codemode_max_subcalls INTEGER NOT NULL DEFAULT 10;
ALTER TABLE tenants ADD COLUMN cf_access_team_domain TEXT;
ALTER TABLE tenants ADD COLUMN cf_access_aud TEXT;
