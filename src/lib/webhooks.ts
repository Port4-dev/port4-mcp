import type { TenantRoutingRecord } from "../types";
import { hmacSha256Hex, sha256Hex } from "./crypto";

/**
 * Dispatches an asynchronous, HMAC-signed webhook event to a tenant's configured `webhook_url`.
 * Designed for `c.executionCtx.waitUntil(...)` so gateway latency is never impacted.
 */
export async function dispatchTenantWebhook(
  tenant: TenantRoutingRecord,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = tenant.webhook_url?.trim();
  if (!url || !url.startsWith("https://")) return;

  const body = JSON.stringify({
    event: eventType,
    tenant: tenant.subdomain,
    tenant_id: tenant.id,
    occurred_at: new Date().toISOString(),
    data: payload
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Port4-Event": eventType,
    "X-Port4-Tenant": tenant.subdomain
  };

  if (tenant.upstream_signing_secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = await sha256Hex(body);
    const sig = await hmacSha256Hex(
      tenant.upstream_signing_secret,
      `${timestamp}.${tenant.subdomain}.${eventType}.${bodyHash}`
    );
    headers["X-Port4-Timestamp"] = timestamp;
    headers["X-Port4-Signature"] = `v1=${sig}`;
  }

  try {
    await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    // Best-effort alert delivery; never throws into caller
  }
}
