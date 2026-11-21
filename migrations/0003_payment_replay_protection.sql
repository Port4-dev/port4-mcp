-- A payment authorization is a bearer instrument and must execute at most once.
CREATE TABLE IF NOT EXISTS payment_replays (
  fingerprint TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_replays_created_at ON payment_replays(created_at);
