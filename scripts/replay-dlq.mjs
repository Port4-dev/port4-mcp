#!/usr/bin/env node
/**
 * Port4 Metering Dead-Letter Queue (DLQ) Replay Utility
 *
 * Reads NDJSON metering events exported from `port4-metering-dlq` and replays them
 * idempotently into D1 (`processed_metering_events`, `transactions`, `usage_rollups`)
 * via `wrangler d1 execute`.
 *
 * Usage:
 *   node scripts/replay-dlq.mjs ./dlq-events.ndjson [--remote]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function sqlString(val) {
  if (val === null || val === undefined) return "NULL";
  return `'${String(val).replace(/'/g, "''")}'`;
}

export function buildReplaySqlStatements(events) {
  const statements = [];
  for (const ev of events) {
    if (!ev?.id || !ev?.tenantId || !ev?.toolName || !ev?.txHash) continue;
    const hour = `${String(ev.occurredAt || new Date().toISOString()).slice(0, 13)}:00:00.000Z`;
    const atomicNum = Number(ev.amountAtomic || 0);
    const usdNum = Number(ev.amountUsd || 0);
    const latency = Math.max(1, Math.floor(Number(ev.latencyMs || 1)));
    const isFee = ev.isPlatformFee ? 1 : 0;
    const isSandbox = ev.status === "sandbox_settled" ? 1 : 0;

    statements.push(
      `INSERT OR IGNORE INTO processed_metering_events (event_id, tenant_id, tool_name, tx_hash, amount_atomic, is_platform_fee, status, created_at) VALUES (${sqlString(ev.id)}, ${sqlString(ev.tenantId)}, ${sqlString(ev.toolName)}, ${sqlString(ev.txHash)}, ${atomicNum}, ${isFee}, ${sqlString(ev.status)}, ${sqlString(ev.occurredAt)});`
    );
    statements.push(
      `INSERT OR IGNORE INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status, latency_ms, is_platform_fee, tap_agent_id, created_at) VALUES (${sqlString(ev.id)}, ${sqlString(ev.tenantId)}, ${sqlString(ev.toolName)}, ${sqlString(ev.payerWallet || "unknown")}, ${sqlString(ev.amountAtomic || "0")}, ${sqlString(ev.amountUsd || "0")}, ${sqlString(ev.network || "eip155:84532")}, ${sqlString(ev.txHash)}, ${sqlString(ev.status)}, ${latency}, ${isFee}, ${sqlString(ev.tapAgentId ?? null)}, ${sqlString(ev.occurredAt)});`
    );
    statements.push(
      `INSERT INTO usage_rollups (tenant_id, tool_name, network, hour_start, call_count, gross_usd, gross_atomic, total_latency_ms, sandbox_call_count, platform_fee_call_count) VALUES (${sqlString(ev.tenantId)}, ${sqlString(ev.toolName)}, ${sqlString(ev.network || "eip155:84532")}, ${sqlString(hour)}, 1, ${usdNum}, ${atomicNum}, ${latency}, ${isSandbox}, ${isFee}) ON CONFLICT(tenant_id, tool_name, network, hour_start) DO UPDATE SET call_count = call_count + 1, gross_usd = gross_usd + excluded.gross_usd, gross_atomic = gross_atomic + excluded.gross_atomic, total_latency_ms = total_latency_ms + excluded.total_latency_ms, sandbox_call_count = sandbox_call_count + excluded.sandbox_call_count, platform_fee_call_count = platform_fee_call_count + excluded.platform_fee_call_count;`
    );
  }
  return statements;
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith("--"));
  const remote = args.includes("--remote");
  if (!filePath) {
    console.error("Usage: node scripts/replay-dlq.mjs <events.ndjson> [--remote]");
    process.exit(1);
  }
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  const sql = buildReplaySqlStatements(events).join("\n");
  if (!sql) {
    console.log("No valid metering events found to replay.");
    return;
  }
  const tmpSql = path.join(ROOT, ".wrangler", "dlq-replay.sql");
  fs.mkdirSync(path.dirname(tmpSql), { recursive: true });
  fs.writeFileSync(tmpSql, sql, "utf8");
  try {
    const wranglerBin = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
    execFileSync(
      process.execPath,
      [wranglerBin, "d1", "execute", "port4-db", remote ? "--remote" : "--local", "--file", tmpSql],
      { cwd: ROOT, stdio: "inherit" }
    );
    console.log(`Replayed ${events.length} DLQ metering events.`);
  } finally {
    if (fs.existsSync(tmpSql)) fs.unlinkSync(tmpSql);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
