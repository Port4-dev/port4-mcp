import { DurableObject } from "cloudflare:workers";
import type { X402SettlementReceipt } from "./types";

interface RateLimitRequest {
  limit: number;
  windowSeconds: number;
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
 * Strongly-consistent per-tenant/IP rate limiter + daily abuse quota + atomic call sequence.
 * Used for both abuse protection and non-stale fee-split sequencing with zero extra RTT.
 */
export class EdgeRateLimiter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    let input: RateLimitRequest;
    try {
      input = (await request.json()) as RateLimitRequest;
    } catch {
      return Response.json({ error: "invalid_rate_limit_request" }, { status: 400 });
    }
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100_000 ||
      !Number.isInteger(input.windowSeconds) ||
      input.windowSeconds < 1 ||
      input.windowSeconds > 3600
    ) {
      return Response.json({ error: "invalid_rate_limit_configuration" }, { status: 400 });
    }

    const dailyQuota =
      typeof input.dailyQuota === "number" && Number.isInteger(input.dailyQuota) && input.dailyQuota > 0
        ? input.dailyQuota
        : 100_000;

    const now = Date.now();
    const windowMs = input.windowSeconds * 1000;
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
    if (nextCount <= input.limit) {
      state.sequence += 1;
    }

    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(dayStart + dayMs + 60_000);

    return Response.json({
      allowed: state.count <= input.limit,
      reason: state.count <= input.limit ? undefined : "rpm_exceeded",
      remaining: Math.max(0, input.limit - state.count),
      resetAt: windowStart + windowMs,
      sequence: state.sequence
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

interface IdempotencyRecord {
  status: "in_flight" | "settled_pending_upstream" | "completed";
  claimedAt: number;
  receipt?: X402SettlementReceipt;
  responseBody?: string;
}

type ReplayOperation =
  | { operation: "claim" }
  | { operation: "mark_settled"; receipt: X402SettlementReceipt }
  | { operation: "complete"; receipt: X402SettlementReceipt; responseBody: string }
  | { operation: "release" };

const IN_FLIGHT_LEASE_MS = 30_000;
const RECORD_TTL_MS = 86_400_000;
const MAX_CACHED_RESPONSE_BYTES = 65_536;

/**
 * Durable idempotency & replay guard coupling payment settlement with upstream execution:
 * - Prevents double-spend / replay of a payment authorization.
 * - Preserves settled receipts if the upstream fails so the paid caller can safely retry
 *   and obtain their result without paying twice.
 * - Returns cached response idempotently if a completed paid request is retried.
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

    if (body.operation === "release") {
      const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
      // Never release once payment is settled on-chain
      if (!existing || existing.status === "in_flight") {
        await this.ctx.storage.delete("record");
        return Response.json({ released: true });
      }
      return Response.json({ released: false, status: existing.status });
    }

    if (body.operation === "mark_settled") {
      const updated: IdempotencyRecord = {
        status: "settled_pending_upstream",
        claimedAt: now,
        receipt: body.receipt
      };
      await this.ctx.storage.put("record", updated);
      await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.operation === "complete") {
      const updated: IdempotencyRecord = {
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
      const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
      if (existing) {
        if (existing.status === "completed") {
          return Response.json({
            status: "completed",
            claimed: false,
            receipt: existing.receipt,
            responseBody: existing.responseBody
          });
        }
        if (existing.status === "settled_pending_upstream" && existing.receipt) {
          return Response.json({
            status: "retry_upstream",
            claimed: true,
            receipt: existing.receipt
          });
        }
        if (existing.status === "in_flight" && now - existing.claimedAt < IN_FLIGHT_LEASE_MS) {
          return Response.json({
            status: "in_flight",
            claimed: false,
            claimedAt: existing.claimedAt
          });
        }
      }

      const fresh: IdempotencyRecord = { status: "in_flight", claimedAt: now };
      await this.ctx.storage.put("record", fresh);
      await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
      return Response.json({ status: "claimed", claimed: true, claimedAt: now });
    }

    return Response.json({ error: "invalid_replay_operation" }, { status: 400 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
