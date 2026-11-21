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
 * Queue consumer for batched metering:
 * 1. Archives raw immutable settlement events as NDJSON to R2 (`LEDGER_ARCHIVE`) if configured.
 * 2. Upserts hourly aggregates into D1 `usage_rollups` (one row per tenant/tool/hour).
 * 3. Updates `tenants.call_count` once per tenant per batch instead of once per call.
 */
export async function consumeMeteringEvents(
  batch: MessageBatch<unknown>,
  env: AppBindings
): Promise<void> {
  const rollups = new Map<
    string,
    {
      tenantId: string;
      toolName: string;
      network: string;
      hour: string;
      callCount: number;
      grossUsd: number;
      totalLatencyMs: number;
      sandboxCalls: number;
      platformFeeCalls: number;
    }
  >();
  const tenantIncrements = new Map<string, number>();
  const validEvents: MeteringEvent[] = [];

  for (const message of batch.messages) {
    const event = message.body as Partial<MeteringEvent> | null;
    if (
      !event ||
      typeof event.tenantId !== "string" ||
      typeof event.toolName !== "string" ||
      typeof event.network !== "string" ||
      typeof event.occurredAt !== "string" ||
      typeof event.latencyMs !== "number" ||
      !Number.isFinite(event.latencyMs) ||
      !Number.isFinite(Number(event.amountUsd))
    ) {
      message.ack();
      continue;
    }
    const valid = event as MeteringEvent;
    validEvents.push(valid);
    const hour = hourStart(valid.occurredAt);
    const key = `${valid.tenantId}\u0000${valid.toolName}\u0000${valid.network}\u0000${hour}`;
    const current = rollups.get(key) ?? {
      tenantId: valid.tenantId,
      toolName: valid.toolName,
      network: valid.network,
      hour,
      callCount: 0,
      grossUsd: 0,
      totalLatencyMs: 0,
      sandboxCalls: 0,
      platformFeeCalls: 0
    };
    current.callCount += 1;
    current.grossUsd += Number(valid.amountUsd);
    current.totalLatencyMs += Math.max(0, Math.floor(valid.latencyMs));
    current.sandboxCalls += valid.status === "sandbox_settled" ? 1 : 0;
    current.platformFeeCalls += valid.isPlatformFee ? 1 : 0;
    rollups.set(key, current);

    tenantIncrements.set(valid.tenantId, (tenantIncrements.get(valid.tenantId) ?? 0) + 1);
  }

  if (validEvents.length === 0) {
    return;
  }

  try {
    // 1. Optional immutable NDJSON archive in R2 (avoids indefinite raw row retention in D1)
    if (env.LEDGER_ARCHIVE) {
      const now = new Date();
      const prefix = `ledger/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${String(now.getUTCHours()).padStart(2, "0")}`;
      const objectKey = `${prefix}/${crypto.randomUUID()}.ndjson`;
      const ndjson = validEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await env.LEDGER_ARCHIVE.put(objectKey, ndjson, {
        httpMetadata: { contentType: "application/x-ndjson" }
      });
    }

    // 2. Batched hourly rollups + tenant counter updates in D1
    const statements: D1PreparedStatement[] = [
      ...[...rollups.values()].map((rollup) =>
        env.DB.prepare(
          `INSERT INTO usage_rollups (tenant_id, tool_name, network, hour_start, call_count, gross_usd, total_latency_ms, sandbox_call_count, platform_fee_call_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, tool_name, network, hour_start) DO UPDATE SET
             call_count = call_count + excluded.call_count,
             gross_usd = gross_usd + excluded.gross_usd,
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
          rollup.totalLatencyMs,
          rollup.sandboxCalls,
          rollup.platformFeeCalls
        )
      ),
      ...[...tenantIncrements.entries()].map(([tenantId, inc]) =>
        env.DB.prepare("UPDATE tenants SET call_count = call_count + ? WHERE id = ?").bind(
          inc,
          tenantId
        )
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
