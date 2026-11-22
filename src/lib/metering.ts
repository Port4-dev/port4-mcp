import type { AppBindings, MeteringEvent } from "../types";

export function writeGatewayAnalytics(env: AppBindings, event: MeteringEvent): void {
  if (!env.GATEWAY_ANALYTICS) return;
  env.GATEWAY_ANALYTICS.writeDataPoint({
    indexes: [event.tenantId, event.toolName],
    doubles: [Number(event.amountUsd), event.latencyMs, event.status === "sandbox_settled" ? 1 : 0],
    blobs: [event.tenantSubdomain, event.network, event.status]
  });
}

function hourStart(iso: string): string {
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

/**
 * Authoritative & Idempotent Queue Consumer for Financial Metering:
 * 1. Deduplicates events against `processed_metering_events` so Queue retries never inflate revenue.
 * 2. Inserts immutable settlement records into `transactions` (`INSERT OR IGNORE`).
 * 3. Aggregates integer atomic units (`gross_atomic`) + USD into `usage_rollups`.
 * 4. Updates `tenants.call_count` and `tenants.settled_call_sequence` atomically.
 * 5. Archives raw NDJSON batch to R2 (`LEDGER_ARCHIVE`) if bound.
 */
export async function consumeMeteringEvents(
  batch: MessageBatch<unknown>,
  env: AppBindings
): Promise<void> {
  const candidates: MeteringEvent[] = [];

  for (const message of batch.messages) {
    const event = message.body as Partial<MeteringEvent> | null;
    if (
      !event ||
      typeof event.id !== "string" ||
      typeof event.tenantId !== "string" ||
      typeof event.toolName !== "string" ||
      typeof event.network !== "string" ||
      typeof event.amountAtomic !== "string" ||
      !/^\d+$/.test(event.amountAtomic) ||
      typeof event.occurredAt !== "string" ||
      typeof event.latencyMs !== "number" ||
      !Number.isFinite(event.latencyMs) ||
      !Number.isFinite(Number(event.amountUsd))
    ) {
      message.ack();
      continue;
    }
    candidates.push(event as MeteringEvent);
  }

  if (candidates.length === 0) {
    return;
  }

  try {
    // 1. Check which event IDs have already been processed (idempotency across Queue retries)
    const alreadyProcessed = new Set<string>();
    const ids = candidates.map((c) => c.id);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      const existingRes = await env.DB.prepare(
        `SELECT event_id FROM processed_metering_events WHERE event_id IN (${placeholders})`
      )
        .bind(...chunk)
        .all<{ event_id: string }>();
      for (const row of existingRes.results ?? []) {
        alreadyProcessed.add(row.event_id);
      }
    }

    const freshEvents = candidates.filter((e) => !alreadyProcessed.has(e.id));
    if (freshEvents.length === 0) {
      for (const message of batch.messages) message.ack();
      return;
    }

    const rollups = new Map<
      string,
      {
        tenantId: string;
        toolName: string;
        network: string;
        hour: string;
        callCount: number;
        grossAtomic: bigint;
        grossUsd: number;
        totalLatencyMs: number;
        sandboxCalls: number;
        platformFeeCalls: number;
      }
    >();
    const tenantIncrements = new Map<string, number>();

    for (const valid of freshEvents) {
      const hour = hourStart(valid.occurredAt);
      const key = `${valid.tenantId}\u0000${valid.toolName}\u0000${valid.network}\u0000${hour}`;
      const current = rollups.get(key) ?? {
        tenantId: valid.tenantId,
        toolName: valid.toolName,
        network: valid.network,
        hour,
        callCount: 0,
        grossAtomic: 0n,
        grossUsd: 0,
        totalLatencyMs: 0,
        sandboxCalls: 0,
        platformFeeCalls: 0
      };
      current.callCount += 1;
      current.grossAtomic += BigInt(valid.amountAtomic);
      current.grossUsd += Number(valid.amountUsd);
      current.totalLatencyMs += Math.max(0, Math.floor(valid.latencyMs));
      current.sandboxCalls += valid.status === "sandbox_settled" ? 1 : 0;
      current.platformFeeCalls += valid.isPlatformFee ? 1 : 0;
      rollups.set(key, current);

      tenantIncrements.set(valid.tenantId, (tenantIncrements.get(valid.tenantId) ?? 0) + 1);
    }

    // 2. Optional immutable NDJSON archive in R2
    if (env.LEDGER_ARCHIVE) {
      const now = new Date();
      const prefix = `ledger/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${String(now.getUTCHours()).padStart(2, "0")}`;
      const objectKey = `${prefix}/${crypto.randomUUID()}.ndjson`;
      const ndjson = freshEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await env.LEDGER_ARCHIVE.put(objectKey, ndjson, {
        httpMetadata: { contentType: "application/x-ndjson" }
      });
    }

    // 3. Atomic D1 batch: processed_metering_events + transactions + usage_rollups + tenant counters
    const statements: D1PreparedStatement[] = [
      ...freshEvents.map((ev) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO processed_metering_events
           (event_id, tenant_id, tool_name, tx_hash, amount_atomic, is_platform_fee, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          ev.id,
          ev.tenantId,
          ev.toolName,
          ev.txHash,
          Number(ev.amountAtomic),
          ev.isPlatformFee ? 1 : 0,
          ev.status,
          ev.occurredAt
        )
      ),
      ...freshEvents.map((ev) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO transactions
           (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status, latency_ms, is_platform_fee, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          ev.id,
          ev.tenantId,
          ev.toolName,
          ev.payerWallet,
          ev.amountAtomic,
          ev.amountUsd,
          ev.network,
          ev.txHash,
          ev.status,
          Math.max(1, Math.floor(ev.latencyMs)),
          ev.isPlatformFee ? 1 : 0,
          ev.occurredAt
        )
      ),
      ...[...rollups.values()].map((rollup) =>
        env.DB.prepare(
          `INSERT INTO usage_rollups
           (tenant_id, tool_name, network, hour_start, call_count, gross_usd, gross_atomic, total_latency_ms, sandbox_call_count, platform_fee_call_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, tool_name, network, hour_start) DO UPDATE SET
             call_count = call_count + excluded.call_count,
             gross_usd = gross_usd + excluded.gross_usd,
             gross_atomic = gross_atomic + excluded.gross_atomic,
             total_latency_ms = total_latency_ms + excluded.total_latency_ms,
             sandbox_call_count = sandbox_call_count + excluded.sandbox_call_count,
             platform_fee_call_count = platform_fee_call_count + excluded.platform_fee_call_count`
        ).bind(
          rollup.tenantId,
          rollup.toolName,
          rollup.network,
          rollup.hour,
          rollup.callCount,
          rollup.grossUsd,
          Number(rollup.grossAtomic),
          rollup.totalLatencyMs,
          rollup.sandboxCalls,
          rollup.platformFeeCalls
        )
      ),
      ...[...tenantIncrements.entries()].map(([tenantId, inc]) =>
        env.DB.prepare(
          "UPDATE tenants SET call_count = call_count + ?, settled_call_sequence = COALESCE(settled_call_sequence, 0) + ? WHERE id = ?"
        ).bind(inc, inc, tenantId)
      )
    ];

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }

    for (const message of batch.messages) message.ack();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "metering_rollup_failed",
        error: error instanceof Error ? error.name : "unknown"
      })
    );
    batch.retryAll({ delaySeconds: 30 });
  }
}
