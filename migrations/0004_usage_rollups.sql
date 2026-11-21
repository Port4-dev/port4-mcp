-- D1 remains the control plane and compact dashboard store. Per-call telemetry is
-- written to Analytics Engine; this table stores queue-batched hourly aggregates.
CREATE TABLE IF NOT EXISTS usage_rollups (
  tenant_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  network TEXT NOT NULL,
  hour_start TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  gross_usd REAL NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  sandbox_call_count INTEGER NOT NULL DEFAULT 0,
  platform_fee_call_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, tool_name, network, hour_start),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_rollups_tenant_hour ON usage_rollups(tenant_id, hour_start DESC);
