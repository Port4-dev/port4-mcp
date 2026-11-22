-- Migration 0009: Visa Trusted Agent Protocol (TAP RFC 9421) & Tempo OUSD MPP Support
ALTER TABLE tenants ADD COLUMN require_visa_tap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN allow_tap_simulated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN tap_agent_id TEXT;
