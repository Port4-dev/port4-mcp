import { DurableObject } from "cloudflare:workers";
import type { PaymentExecutionContext, X402SettlementReceipt } from "./types";

interface RateLimitRequest {
  operation?: "consume" | "next_fee_sequence";
  limit?: number;
  windowSeconds?: number;
  dailyQuota?: number;
}

interface RateLimitState {
  windowStart: number;
  count: number;
  dayStart: number;
  dayCount: number;
  sequence: number;
}

/**
 * Strongly-consistent per-tenant/IP rate limiter + daily abuse quota + tenant-wide paid fee sequence.
 */
export class EdgeRateLimiter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    let input: RateLimitRequest;
    try {
      input = (await request.json()) as RateLimitRequest;
    } catch {
      return Response.json({ error: "invalid_rate_limit_request" }, { status: 400 });
    }

    // Tenant-wide paid call sequence (isolated from per-IP discovery requests)
    if (input.operation === "next_fee_sequence") {
      const currentSeq = (await this.ctx.storage.get<number>("paid_sequence")) ?? 0;
      const nextSeq = currentSeq + 1;
      await this.ctx.storage.put("paid_sequence", nextSeq);
      return Response.json({ sequence: nextSeq });
    }

    const limit = input.limit ?? 120;
    const windowSeconds = input.windowSeconds ?? 60;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100_000 ||
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 3600
    ) {
      return Response.json({ error: "invalid_rate_limit_configuration" }, { status: 400 });
    }

    const dailyQuota =
      typeof input.dailyQuota === "number" && Number.isInteger(input.dailyQuota) && input.dailyQuota > 0
        ? input.dailyQuota
        : 100_000;

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const dayMs = 86_400_000;
    const dayStart = Math.floor(now / dayMs) * dayMs;

    const current = await this.ctx.storage.get<RateLimitState>("state");
    const state: RateLimitState = {
      windowStart,
      count: current && current.windowStart === windowStart ? current.count : 0,
      dayStart,
      dayCount: current && current.dayStart === dayStart ? current.dayCount : 0,
      sequence: current?.sequence ?? 0
    };

    const nextCount = state.count + 1;
    const nextDayCount = state.dayCount + 1;

    if (nextDayCount > dailyQuota) {
      return Response.json({
        allowed: false,
        reason: "daily_quota_exceeded",
        remaining: 0,
        resetAt: dayStart + dayMs,
        sequence: state.sequence
      });
    }

    state.count = nextCount;
    state.dayCount = nextDayCount;
    if (nextCount <= limit) {
      state.sequence += 1;
    }

    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(dayStart + dayMs + 60_000);

    return Response.json({
      allowed: state.count <= limit,
      reason: state.count <= limit ? undefined : "rpm_exceeded",
      remaining: Math.max(0, limit - state.count),
      resetAt: windowStart + windowMs,
      sequence: state.sequence
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete("state");
  }
}

interface IdempotencyRecord {
  status:
    | "in_flight"
    | "settlement_pending"
    | "settled_pending_upstream"
    | "completed";
  claimedAt: number;
  leaseToken: string;
  context: PaymentExecutionContext;
  receipt?: X402SettlementReceipt;
  responseBody?: string;
}

type ReplayOperation =
  | { operation: "claim"; context: PaymentExecutionContext; leaseToken: string }
  | {
      operation: "mark_settlement_pending";
      leaseToken: string;
      receipt: X402SettlementReceipt;
    }
  | {
      operation: "mark_settled";
      leaseToken: string;
      receipt: X402SettlementReceipt;
    }
  | {
      operation: "complete";
      leaseToken: string;
      receipt: X402SettlementReceipt;
      responseBody: string;
    }
  | { operation: "release"; leaseToken: string };

const IN_FLIGHT_LEASE_MS = 60_000;
const RECORD_TTL_MS = 86_400_000;
const MAX_CACHED_RESPONSE_BYTES = 65_536;

function contextsMatch(a: PaymentExecutionContext, b: PaymentExecutionContext): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.toolName === b.toolName &&
    a.network === b.network &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.amountAtomic === b.amountAtomic &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase()
  );
}

/**
 * Durable idempotency & cross-context replay guard with fencing lease tokens:
 * - Binds every payment authorization to (tenantId, toolName, network, asset, amountAtomic, payTo).
 * - Rejects cross-tenant or cross-tool replay attempts with `context_mismatch`.
 * - Tracks `settlement_pending` so broadcast transactions are never prematurely released.
 * - Requires synchronous `complete` before returning 200 OK to prevent duplicate upstream execution.
 */
export class PaymentReplayGuard extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    let body: ReplayOperation;
    try {
      body = (await request.json()) as ReplayOperation;
    } catch {
      return Response.json({ error: "invalid_replay_request" }, { status: 400 });
    }

    const now = Date.now();
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");

    if (body.operation === "release") {
      if (
        !existing ||
        (existing.status === "in_flight" && existing.leaseToken === body.leaseToken)
      ) {
        await this.ctx.storage.delete("record");
        return Response.json({ released: true });
      }
      return Response.json({ released: false, status: existing.status });
    }

    if (body.operation === "mark_settlement_pending") {
      if (!existing || existing.leaseToken !== body.leaseToken) {
        return Response.json({ error: "lease_token_mismatch" }, { status: 409 });
      }
      const updated: IdempotencyRecord = {
        ...existing,
        status: "settlement_pending",
        claimedAt: now,
        receipt: body.receipt
      };
      await this.ctx.storage.put("record", updated);
      await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.operation === "mark_settled") {
      if (!existing || existing.leaseToken !== body.leaseToken) {
        return Response.json({ error: "lease_token_mismatch" }, { status: 409 });
      }
      const updated: IdempotencyRecord = {
        ...existing,
        status: "settled_pending_upstream",
        claimedAt: now,
        receipt: body.receipt
      };
      await this.ctx.storage.put("record", updated);
      await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.operation === "complete") {
      if (!existing || existing.leaseToken !== body.leaseToken) {
        return Response.json({ error: "lease_token_mismatch" }, { status: 409 });
      }
      const updated: IdempotencyRecord = {
        ...existing,
        status: "completed",
        claimedAt: now,
        receipt: body.receipt,
        responseBody: body.responseBody.slice(0, MAX_CACHED_RESPONSE_BYTES)
      };
      await this.ctx.storage.put("record", updated);
      await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.operation === "claim") {
      if (!body.context || !body.leaseToken) {
        return Response.json({ error: "missing_context_or_lease" }, { status: 400 });
      }

      if (existing) {
        // Strict cross-tenant / cross-tool isolation check
        if (!contextsMatch(existing.context, body.context)) {
          return Response.json({
            status: "context_mismatch",
            claimed: false
          });
        }

        if (existing.status === "completed") {
          return Response.json({
            status: "completed",
            claimed: false,
            receipt: existing.receipt,
            responseBody: existing.responseBody
          });
        }

        if (existing.status === "settlement_pending") {
          return Response.json({
            status: "settlement_pending",
            claimed: false,
            receipt: existing.receipt
          });
        }

        if (existing.status === "settled_pending_upstream" && existing.receipt) {
          const refreshed: IdempotencyRecord = {
            ...existing,
            claimedAt: now,
            leaseToken: body.leaseToken
          };
          await this.ctx.storage.put("record", refreshed);
          return Response.json({
            status: "retry_upstream",
            claimed: true,
            leaseToken: body.leaseToken,
            receipt: existing.receipt
          });
        }

        if (now - existing.claimedAt < IN_FLIGHT_LEASE_MS) {
          return Response.json({ status: "in_flight", claimed: false });
        }
      }

      const fresh: IdempotencyRecord = {
        status: "in_flight",
        claimedAt: now,
        leaseToken: body.leaseToken,
        context: body.context
      };
      await this.ctx.storage.put("record", fresh);
      await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
      return Response.json({
        status: "claimed",
        claimed: true,
        leaseToken: body.leaseToken
      });
    }

    return Response.json({ error: "unsupported_replay_operation" }, { status: 400 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete("record");
  }
}
