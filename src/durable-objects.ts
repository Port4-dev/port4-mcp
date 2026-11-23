import { DurableObject } from "cloudflare:workers";
import type { AppBindings, PaymentExecutionContext, X402SettlementReceipt } from "./types";

const encoder = new TextEncoder();

export interface RateLimitConsumeInput {
  limit?: number;
  limitRpm?: number;
  windowSeconds?: number;
  dailyQuota?: number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  reason?: "rpm_exceeded" | "daily_quota_exceeded";
  remaining: number;
  remainingRpm: number;
  remainingDaily: number;
  limitRpm: number;
  dailyQuota: number;
  resetAt: number;
  resetSeconds: number;
  sequence: number;
}

export interface FeeSequenceResult {
  ok: true;
  sequence: number;
}

export interface ReserveTapNonceInput {
  expiresEpochSec?: number;
  ttlSeconds?: number;
}

export interface ReserveTapNonceResult {
  ok: true;
  reserved: boolean;
}

interface RateLimitRequest extends RateLimitConsumeInput, ReserveTapNonceInput {
  operation?: "consume" | "next_fee_sequence" | "reserve_tap_nonce";
}

interface RateLimitState {
  windowStart: number;
  count: number;
  dayStart: number;
  dayCount: number;
  sequence: number;
}

const DAY_MS = 86_400_000;
const MAX_TAP_NONCE_TTL_SEC = 3600;

/**
 * Strongly-consistent per-tenant/IP rate limiter + daily abuse quota + tenant-wide paid fee sequence + TAP nonce store.
 */
export class EdgeRateLimiter extends DurableObject<AppBindings> {
  private async handleNextFeeSequence(): Promise<FeeSequenceResult> {
    const currentSeq = (await this.ctx.storage.get<number>("paid_sequence")) ?? 0;
    const baseSeq =
      typeof currentSeq === "number" && Number.isSafeInteger(currentSeq) && currentSeq >= 0
        ? currentSeq
        : 0;
    const nextSeq = baseSeq < Number.MAX_SAFE_INTEGER ? baseSeq + 1 : 1;
    await this.ctx.storage.put("paid_sequence", nextSeq);
    return { ok: true, sequence: nextSeq };
  }

  private async handleReserveTapNonce(
    input: ReserveTapNonceInput
  ): Promise<ReserveTapNonceResult> {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const rawExpires =
      input.expiresEpochSec !== undefined
        ? Number(input.expiresEpochSec)
        : input.ttlSeconds !== undefined
          ? nowSec + Number(input.ttlSeconds)
          : nowSec + 60;

    if (!Number.isFinite(rawExpires) || rawExpires <= nowSec) {
      return { ok: true, reserved: false };
    }

    const expiresSec = Math.min(Math.ceil(rawExpires), nowSec + MAX_TAP_NONCE_TTL_SEC);
    if (expiresSec <= nowSec) {
      return { ok: true, reserved: false };
    }

    const [existingUntil, currentState] = await Promise.all([
      this.ctx.storage.get<number>("tap_nonce_until"),
      this.ctx.storage.get<RateLimitState>("state")
    ]);

    if (
      existingUntil !== undefined &&
      Number.isFinite(existingUntil) &&
      existingUntil > nowSec
    ) {
      return { ok: true, reserved: false };
    }

    await this.ctx.storage.put("tap_nonce_until", expiresSec);

    const tapDeadlineMs = expiresSec * 1000 + 5_000;
    const stateDeadlineMs =
      currentState &&
      typeof currentState.dayStart === "number" &&
      Number.isFinite(currentState.dayStart) &&
      currentState.dayStart + DAY_MS > now
        ? currentState.dayStart + DAY_MS + 60_000
        : null;

    const nextAlarmMs =
      stateDeadlineMs !== null ? Math.min(tapDeadlineMs, stateDeadlineMs) : tapDeadlineMs;
    await this.ctx.storage.setAlarm(nextAlarmMs);
    return { ok: true, reserved: true };
  }

  private async handleConsume(
    input: RateLimitConsumeInput
  ): Promise<
    | { ok: true; data: RateLimitConsumeResult }
    | { ok: false; status: 400; error: string }
  > {
    const limit = input.limit ?? input.limitRpm ?? 120;
    const windowSeconds = input.windowSeconds ?? 60;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100_000 ||
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 3600
    ) {
      return { ok: false, status: 400, error: "invalid_rate_limit_configuration" };
    }

    const dailyQuota =
      typeof input.dailyQuota === "number" &&
      Number.isInteger(input.dailyQuota) &&
      input.dailyQuota > 0
        ? input.dailyQuota
        : 100_000;

    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

    const [current, tapNonceUntil] = await Promise.all([
      this.ctx.storage.get<RateLimitState>("state"),
      this.ctx.storage.get<number>("tap_nonce_until")
    ]);
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
      return {
        ok: true,
        data: {
          allowed: false,
          reason: "daily_quota_exceeded",
          remaining: 0,
          remainingRpm: Math.max(0, limit - state.count),
          remainingDaily: 0,
          limitRpm: limit,
          dailyQuota,
          resetAt: dayStart + DAY_MS,
          resetSeconds: Math.max(1, Math.ceil((dayStart + DAY_MS - now) / 1000)),
          sequence: state.sequence
        }
      };
    }

    state.count = nextCount;
    state.dayCount = nextDayCount;
    if (nextCount <= limit) {
      state.sequence += 1;
    }

    await this.ctx.storage.put("state", state);

    const stateDeadlineMs = dayStart + DAY_MS + 60_000;
    const tapDeadlineMs =
      tapNonceUntil !== undefined && Number.isFinite(tapNonceUntil) && tapNonceUntil > nowSec
        ? tapNonceUntil * 1000 + 5_000
        : null;
    await this.ctx.storage.setAlarm(
      tapDeadlineMs !== null ? Math.min(stateDeadlineMs, tapDeadlineMs) : stateDeadlineMs
    );

    const remainingRpm = Math.max(0, limit - state.count);
    const remainingDaily = Math.max(0, dailyQuota - state.dayCount);
    const allowed = state.count <= limit;

    return {
      ok: true,
      data: {
        allowed,
        reason: allowed ? undefined : "rpm_exceeded",
        remaining: remainingRpm,
        remainingRpm,
        remainingDaily,
        limitRpm: limit,
        dailyQuota,
        resetAt: windowStart + windowMs,
        resetSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
        sequence: state.sequence
      }
    };
  }

  async consume(input: RateLimitConsumeInput = {}): Promise<RateLimitConsumeResult> {
    const res = await this.handleConsume(input);
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.data;
  }

  async nextFeeSequence(): Promise<FeeSequenceResult> {
    return this.handleNextFeeSequence();
  }

  async reserveTapNonce(input: ReserveTapNonceInput = {}): Promise<ReserveTapNonceResult> {
    return this.handleReserveTapNonce(input);
  }

  async fetch(request: Request): Promise<Response> {
    let input: RateLimitRequest;
    try {
      input = (await request.json()) as RateLimitRequest;
    } catch {
      return Response.json({ error: "invalid_rate_limit_request" }, { status: 400 });
    }

    // Tenant-wide paid call sequence (isolated from per-IP discovery requests)
    if (input.operation === "next_fee_sequence") {
      return Response.json(await this.handleNextFeeSequence());
    }

    // Atomic distributed nonce reservation for Visa Trusted Agent Protocol (TAP RFC 9421)
    if (input.operation === "reserve_tap_nonce") {
      return Response.json(await this.handleReserveTapNonce(input));
    }

    const res = await this.handleConsume(input);
    if (!res.ok) {
      return Response.json({ error: res.error }, { status: res.status });
    }
    return Response.json(res.data);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const [state, tapNonceUntil] = await Promise.all([
      this.ctx.storage.get<RateLimitState>("state"),
      this.ctx.storage.get<number>("tap_nonce_until")
    ]);

    const keysToDelete: string[] = [];
    let nextDeadlineMs: number | null = null;

    if (tapNonceUntil !== undefined) {
      if (!Number.isFinite(tapNonceUntil) || tapNonceUntil <= nowSec) {
        keysToDelete.push("tap_nonce_until");
      } else {
        const tapDeadlineMs = tapNonceUntil * 1000 + 5_000;
        nextDeadlineMs =
          nextDeadlineMs === null ? tapDeadlineMs : Math.min(nextDeadlineMs, tapDeadlineMs);
      }
    }

    if (state !== undefined) {
      const stateExpiryMs =
        state && typeof state.dayStart === "number" && Number.isFinite(state.dayStart)
          ? state.dayStart + DAY_MS
          : 0;
      if (stateExpiryMs <= now) {
        keysToDelete.push("state");
      } else {
        const stateDeadlineMs = stateExpiryMs + 5_000;
        nextDeadlineMs =
          nextDeadlineMs === null ? stateDeadlineMs : Math.min(nextDeadlineMs, stateDeadlineMs);
      }
    }

    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete);
    }

    if (nextDeadlineMs !== null) {
      await this.ctx.storage.setAlarm(Math.max(now + 1_000, nextDeadlineMs));
    }
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

export type ReplayClaimResult =
  | { status: "claimed"; claimed: true; leaseToken: string }
  | {
      status: "retry_upstream";
      claimed: true;
      leaseToken: string;
      receipt: X402SettlementReceipt;
    }
  | { status: "in_flight" | "context_mismatch"; claimed: false }
  | {
      status: "settlement_pending";
      claimed: false;
      receipt?: X402SettlementReceipt;
    }
  | {
      status: "completed";
      claimed: false;
      receipt?: X402SettlementReceipt;
      responseBody?: string;
    };

export type ReplayTransitionResult =
  | { ok: true; status: IdempotencyRecord["status"] }
  | { ok: false; error: string };

export type ReplayReleaseResult =
  | { released: true }
  | { released: false; status: IdempotencyRecord["status"] };

type ReplayOperation =
  | { operation?: "claim"; context: PaymentExecutionContext; leaseToken: string }
  | {
      operation?: "mark_settlement_pending";
      leaseToken: string;
      receipt: X402SettlementReceipt;
    }
  | {
      operation?: "mark_settled";
      leaseToken: string;
      receipt: X402SettlementReceipt;
    }
  | {
      operation?: "complete";
      leaseToken: string;
      receipt: X402SettlementReceipt;
      responseBody: string;
    }
  | { operation?: "release"; leaseToken: string }
  | { operation?: "mark_upstream_failed"; leaseToken: string };

type ReplayOperationName = NonNullable<ReplayOperation["operation"]>;

const PATH_OPERATION_MAP: Record<string, ReplayOperationName> = {
  "/claim": "claim",
  "/settlement-pending": "mark_settlement_pending",
  "/mark_settlement_pending": "mark_settlement_pending",
  "/settled-pending-upstream": "mark_settled",
  "/mark_settled": "mark_settled",
  "/complete": "complete",
  "/release": "release",
  "/mark_upstream_failed": "mark_upstream_failed",
  "/upstream-failed": "mark_upstream_failed"
};

const IN_FLIGHT_LEASE_MS = 60_000;
const RECORD_TTL_MS = 86_400_000;
const MAX_CACHED_RESPONSE_BYTES = 65_536;

function contextsMatch(a: PaymentExecutionContext, b: PaymentExecutionContext): boolean {
  const isSolana = a.network.startsWith("solana:");
  const assetMatches = isSolana
    ? a.asset === b.asset
    : a.asset.toLowerCase() === b.asset.toLowerCase();
  const payToMatches = isSolana
    ? a.payTo === b.payTo
    : a.payTo.toLowerCase() === b.payTo.toLowerCase();
  return (
    a.tenantId === b.tenantId &&
    a.toolName === b.toolName &&
    a.network === b.network &&
    assetMatches &&
    a.amountAtomic === b.amountAtomic &&
    payToMatches
  );
}

/**
 * Durable idempotency & cross-context replay guard with fencing lease tokens:
 * - Binds every payment authorization to (tenantId, toolName, network, asset, amountAtomic, payTo).
 * - Rejects cross-tenant or cross-tool replay attempts with `context_mismatch`.
 * - Tracks `settlement_pending` so broadcast transactions are never prematurely released.
 * - Fences concurrent retries during `settled_pending_upstream` via `IN_FLIGHT_LEASE_MS`.
 * - Requires synchronous `complete` before returning 200 OK to prevent duplicate upstream execution.
 */
export class PaymentReplayGuard extends DurableObject<AppBindings> {
  private async handleRelease(leaseToken: string): Promise<ReplayReleaseResult> {
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
    if (
      !existing ||
      (existing.status === "in_flight" && existing.leaseToken === leaseToken)
    ) {
      await this.ctx.storage.delete("record");
      await this.ctx.storage.deleteAlarm();
      return { released: true };
    }
    return { released: false, status: existing.status };
  }

  private async handleMarkSettlementPending(
    leaseToken: string,
    receipt: X402SettlementReceipt
  ): Promise<{ status: number; body: ReplayTransitionResult }> {
    const now = Date.now();
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
    if (!existing || existing.leaseToken !== leaseToken) {
      return { status: 409, body: { ok: false, error: "lease_token_mismatch" } };
    }
    if (existing.status === "completed") {
      return { status: 409, body: { ok: false, error: "already_completed" } };
    }
    const updated: IdempotencyRecord = {
      ...existing,
      status: "settlement_pending",
      claimedAt: now,
      receipt
    };
    await this.ctx.storage.put("record", updated);
    await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
    return { status: 200, body: { ok: true, status: updated.status } };
  }

  private async handleMarkSettled(
    leaseToken: string,
    receipt: X402SettlementReceipt
  ): Promise<{ status: number; body: ReplayTransitionResult }> {
    const now = Date.now();
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
    if (!existing || existing.leaseToken !== leaseToken) {
      return { status: 409, body: { ok: false, error: "lease_token_mismatch" } };
    }
    if (existing.status === "completed") {
      return { status: 409, body: { ok: false, error: "already_completed" } };
    }
    const updated: IdempotencyRecord = {
      ...existing,
      status: "settled_pending_upstream",
      claimedAt: now,
      receipt
    };
    await this.ctx.storage.put("record", updated);
    await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
    return { status: 200, body: { ok: true, status: updated.status } };
  }

  private async handleMarkUpstreamFailed(
    leaseToken: string
  ): Promise<{ status: number; body: ReplayTransitionResult }> {
    const now = Date.now();
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
    if (!existing || existing.leaseToken !== leaseToken) {
      return { status: 409, body: { ok: false, error: "lease_token_mismatch" } };
    }
    if (existing.status === "completed") {
      return { status: 409, body: { ok: false, error: "already_completed" } };
    }
    if (existing.status !== "settled_pending_upstream") {
      return { status: 409, body: { ok: false, error: "invalid_state_transition" } };
    }
    const updated: IdempotencyRecord = {
      ...existing,
      claimedAt: 0
    };
    await this.ctx.storage.put("record", updated);
    await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
    return { status: 200, body: { ok: true, status: updated.status } };
  }

  private async handleComplete(
    leaseToken: string,
    receipt: X402SettlementReceipt,
    responseBody: string
  ): Promise<{ status: number; body: ReplayTransitionResult }> {
    const now = Date.now();
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");
    if (!existing || existing.leaseToken !== leaseToken) {
      return { status: 409, body: { ok: false, error: "lease_token_mismatch" } };
    }
    const responseBytes =
      typeof responseBody === "string" ? encoder.encode(responseBody).byteLength : 0;
    const cachedResponseBody =
      typeof responseBody === "string" && responseBytes <= MAX_CACHED_RESPONSE_BYTES
        ? responseBody
        : undefined;

    const updated: IdempotencyRecord = {
      ...existing,
      status: "completed",
      claimedAt: now,
      receipt,
      responseBody: cachedResponseBody
    };
    await this.ctx.storage.put("record", updated);
    await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
    return { status: 200, body: { ok: true, status: updated.status } };
  }

  private async handleClaim(
    context: PaymentExecutionContext,
    leaseToken: string
  ): Promise<
    | { status: 200; body: ReplayClaimResult }
    | { status: 400; body: { error: string } }
  > {
    if (!context || !leaseToken) {
      return { status: 400, body: { error: "missing_context_or_lease" } };
    }

    const now = Date.now();
    const existing = await this.ctx.storage.get<IdempotencyRecord>("record");

    if (existing) {
      // Strict cross-tenant / cross-tool isolation check
      if (!contextsMatch(existing.context, context)) {
        return {
          status: 200,
          body: {
            status: "context_mismatch",
            claimed: false
          }
        };
      }

      if (existing.status === "completed") {
        return {
          status: 200,
          body: {
            status: "completed",
            claimed: false,
            receipt: existing.receipt,
            responseBody: existing.responseBody
          }
        };
      }

      if (existing.status === "settlement_pending") {
        return {
          status: 200,
          body: {
            status: "settlement_pending",
            claimed: false,
            receipt: existing.receipt
          }
        };
      }

      if (existing.status === "settled_pending_upstream" && existing.receipt) {
        if (now - existing.claimedAt < IN_FLIGHT_LEASE_MS) {
          return {
            status: 200,
            body: { status: "in_flight", claimed: false }
          };
        }
        const refreshed: IdempotencyRecord = {
          ...existing,
          claimedAt: now,
          leaseToken
        };
        await this.ctx.storage.put("record", refreshed);
        await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
        return {
          status: 200,
          body: {
            status: "retry_upstream",
            claimed: true,
            leaseToken,
            receipt: existing.receipt
          }
        };
      }

      if (now - existing.claimedAt < IN_FLIGHT_LEASE_MS) {
        return {
          status: 200,
          body: { status: "in_flight", claimed: false }
        };
      }
    }

    const fresh: IdempotencyRecord = {
      status: "in_flight",
      claimedAt: now,
      leaseToken,
      context
    };
    await this.ctx.storage.put("record", fresh);
    await this.ctx.storage.setAlarm(now + RECORD_TTL_MS);
    return {
      status: 200,
      body: {
        status: "claimed",
        claimed: true,
        leaseToken
      }
    };
  }

  async claim(
    context: PaymentExecutionContext,
    leaseToken: string
  ): Promise<ReplayClaimResult> {
    const res = await this.handleClaim(context, leaseToken);
    if (res.status !== 200) {
      throw new Error(res.body.error);
    }
    return res.body;
  }

  async markSettlementPending(
    leaseToken: string,
    receipt: X402SettlementReceipt
  ): Promise<ReplayTransitionResult> {
    const res = await this.handleMarkSettlementPending(leaseToken, receipt);
    return res.body;
  }

  async markSettled(
    leaseToken: string,
    receipt: X402SettlementReceipt
  ): Promise<ReplayTransitionResult> {
    const res = await this.handleMarkSettled(leaseToken, receipt);
    return res.body;
  }

  async complete(
    leaseToken: string,
    receipt: X402SettlementReceipt,
    responseBody: string
  ): Promise<ReplayTransitionResult> {
    const res = await this.handleComplete(leaseToken, receipt, responseBody);
    return res.body;
  }

  async release(leaseToken: string): Promise<ReplayReleaseResult> {
    return this.handleRelease(leaseToken);
  }

  async markUpstreamFailed(leaseToken: string): Promise<ReplayTransitionResult> {
    const res = await this.handleMarkUpstreamFailed(leaseToken);
    return res.body;
  }

  async fetch(request: Request): Promise<Response> {
    let body: ReplayOperation;
    try {
      body = (await request.json()) as ReplayOperation;
    } catch {
      return Response.json({ error: "invalid_replay_request" }, { status: 400 });
    }

    let pathname = "";
    try {
      pathname = new URL(request.url).pathname.replace(/\/+$/, "");
    } catch {
      pathname = "";
    }
    const operation = body.operation ?? PATH_OPERATION_MAP[pathname];

    if (operation === "release") {
      const payload = body as { leaseToken: string };
      return Response.json(await this.handleRelease(payload.leaseToken));
    }

    if (operation === "mark_settlement_pending") {
      const payload = body as { leaseToken: string; receipt: X402SettlementReceipt };
      const res = await this.handleMarkSettlementPending(payload.leaseToken, payload.receipt);
      return Response.json(res.body, { status: res.status });
    }

    if (operation === "mark_settled") {
      const payload = body as { leaseToken: string; receipt: X402SettlementReceipt };
      const res = await this.handleMarkSettled(payload.leaseToken, payload.receipt);
      return Response.json(res.body, { status: res.status });
    }

    if (operation === "mark_upstream_failed") {
      const payload = body as { leaseToken: string };
      const res = await this.handleMarkUpstreamFailed(payload.leaseToken);
      return Response.json(res.body, { status: res.status });
    }

    if (operation === "complete") {
      const payload = body as {
        leaseToken: string;
        receipt: X402SettlementReceipt;
        responseBody: string;
      };
      const res = await this.handleComplete(
        payload.leaseToken,
        payload.receipt,
        payload.responseBody
      );
      return Response.json(res.body, { status: res.status });
    }

    if (operation === "claim") {
      const payload = body as { context: PaymentExecutionContext; leaseToken: string };
      const res = await this.handleClaim(payload.context, payload.leaseToken);
      return Response.json(res.body, { status: res.status });
    }

    return Response.json({ error: "unsupported_replay_operation" }, { status: 400 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete("record");
  }
}
