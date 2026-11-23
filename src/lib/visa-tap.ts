/**
 * Visa Trusted Agent Protocol (TAP RFC 9421) Verifier for Cloudflare Workers (100% Web Crypto API)
 * Built on Visa CLI's reference verifier specification (`https://app.visacli.sh/docs/verifier-code.md`):
 * - Verifies `sig2` (and `sig1`) Ed25519 RFC 9421 HTTP Message Signatures via Web Crypto.
 * - Supports both `tag="agent-browser-auth"` (60s identity requests) and `tag="agent-payer-auth"` (300s/480s paid requests).
 * - Resolves agent public keys from `https://auth.visacli.sh/v1/tap/registry/keys/{keyid}`.
 * - Computes and verifies RFC 7638 JWK SHA-256 thumbprints (`jkt`) locally.
 * - Enforces atomic nonce reservation via Cloudflare Durable Objects.
 */

import { bytesToBase64Url } from "./mpp-tempo";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export interface TapVerifiedResult {
  ok: true;
  keyId: string;
  jkt: string;
  agentId: string | null;
  agentName: string;
  simulated: boolean;
  tag: "agent-browser-auth" | "agent-payer-auth";
  covered: string[];
  expires: number;
}

export interface TapRefusalResult {
  ok: false;
  code: string;
  reason: string;
  message: string;
  judged: boolean;
  status: 403 | 503;
  retryAfterSeconds: number | null;
  header?: string;
}

export type TapVerificationOutcome = TapVerifiedResult | TapRefusalResult;

const REASONS: Record<string, [string, string]> = {
  no_signature_headers: ["tap_missing", "The request has no Signature-Input and Signature headers."],
  signature_input_format: [
    "tap_malformed",
    'Signature-Input must be label sig2 (or sig1), then the covered components, created, expires, keyid, alg, nonce and tag="agent-browser-auth" (or "agent-payer-auth").'
  ],
  signature_header_format: ["tap_malformed", "Signature must be sig2=:<base64>:."],
  components_invalid: ["tap_malformed", "The covered components are unreadable or repeated."],
  directory_components_missing: [
    "tap_malformed",
    "A key named by directory ID must also cover @query, accept and content-type when sent."
  ],
  required_components_missing: [
    "tap_malformed",
    "The signature must cover the required profile components in order."
  ],
  credential_header_present: [
    "tap_malformed",
    "Authorization, Cookie, X-Payment and Payment-Signature are refused on unpaid identity requests."
  ],
  method_not_allowed: ["tap_malformed", "Only GET, HEAD and POST can be signed."],
  signed_header_invalid: [
    "tap_malformed",
    "A covered header is out of order, absent, starts or ends with a space, is not printable ASCII, is over 4096 characters, or is one this profile never signs."
  ],
  uncovered_header: [
    "tap_malformed",
    "The request carries a header the signature does not cover. Only transport headers may go unsigned."
  ],
  nonce_format: ["tap_malformed", "The nonce must be exactly 32 bytes of canonical base64."],
  body_too_large: ["tap_malformed", "The body is over 1 MiB."],
  digest_format: ["tap_malformed", "Content-Digest must be sha-256=:<base64>:."],
  not_yet_valid: ["tap_expired", "The signature was created in the future. Check the clock."],
  expired: ["tap_expired", "The signature has expired. Sign a new request."],
  lifetime_too_long: ["tap_expired", "The signature lifetime exceeds the profile maximum."],
  nonce_reused: ["tap_replayed", "This key and nonce were already used. Sign a new request."],
  key_not_listed: [
    "tap_key_unknown",
    "This key has no live listing. It may be unknown, paused or revoked."
  ],
  agent_not_live: ["tap_key_inactive", "The registry reports this agent as not live."],
  key_not_live: [
    "tap_key_inactive",
    "This key is not one of the agent's live keys: it was replaced, or its expirationDate has passed."
  ],
  body_digest_mismatch: [
    "tap_signature_invalid",
    "The body does not match the signed Content-Digest."
  ],
  signature_mismatch: [
    "tap_signature_invalid",
    "The signature does not verify for this exact request."
  ],
  algorithm_mismatch: [
    "tap_signature_invalid",
    "The signature's alg is not the algorithm of the listed key."
  ],
  signature_agent_not_accepted: [
    "tap_signature_agent_not_accepted",
    "Signature-Agent is not on your allowlist."
  ],
  simulated_listing: [
    "tap_simulated_not_accepted",
    "This key belongs to a simulated test listing, which this endpoint does not accept."
  ],
  listing_unusable: [
    "tap_trust_invalid",
    "The registry returned an unusable answer. The agent has not been judged."
  ],
  registry_unavailable: [
    "tap_trust_unavailable",
    "The registry could not be reached. The agent has not been judged; retry later."
  ],
  nonce_store_unavailable: [
    "tap_trust_unavailable",
    "The nonce store could not be reached. The agent has not been judged; retry later."
  ],
  request_target_invalid: ["tap_malformed", "The request target is not in normal form."],
  request_unreadable: ["tap_malformed", "The request could not be read."],
  origin_not_https: ["tap_malformed", "The pinned public origin is not https."],
  origin_not_normal: ["tap_malformed", "The pinned public origin is not in normal form."]
};

const COULD_NOT_CHECK = new Set(["tap_trust_invalid", "tap_trust_unavailable"]);

export function refusal(
  reason: string,
  retryAfterSeconds: number | null = null,
  header: string | null = null
): TapRefusalResult {
  const [code, message] = REASONS[reason] ?? ["tap_malformed", "Request signature invalid."];
  const judged = !COULD_NOT_CHECK.has(code);
  return {
    ok: false,
    code,
    reason,
    message: header ? `${message} Header: ${header}.` : message,
    judged,
    status: judged ? 403 : 503,
    retryAfterSeconds,
    ...(header ? { header } : {})
  };
}

const HOST_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(?::[1-9][0-9]{0,4})?$/;
const INPUT_RE =
  /^(sig2|sig1)=\(([^)]+)\);created=(\d+);expires=(\d+);keyid="([A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";alg="(ed25519|Ed25519)";nonce="([A-Za-z0-9+/]{43}=)";tag="(agent-browser-auth|agent-payer-auth)"$/;
const SIGNATURE_RE =
  /^(sig2|sig1)=:((?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=):$/;
const CORE_IDENTITY = ["@method", "@scheme", "@authority", "@path", "@query", "content-digest"];
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/;
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]+={0,2}:$/;
const CLOCK_SKEW_SECONDS = 30;
export const MAX_TAP_BODY_BYTES = 1024 * 1024;

export const TRANSPORT_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "accept",
  "accept-language",
  "accept-encoding",
  "user-agent",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-ssl",
  "x-real-ip",
  "true-client-ip",
  "cdn-loop",
  "traceparent",
  "tracestate",
  "x-request-id",
  "x-amzn-trace-id",
  "x-cloud-trace-context",
  "b3",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "cf-ray",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-pseudo-ipv4",
  "cf-connecting-o2o",
  "cf-ew-via",
  "cf-worker",
  "cf-visitor",
  "cf-ipcountry",
  "cf-ipcity",
  "cf-ipcontinent",
  "cf-iplatitude",
  "cf-iplongitude",
  "cf-region",
  "cf-region-code",
  "cf-metro-code",
  "cf-postal-code",
  "cf-timezone",
  "x-vercel-id",
  "x-vercel-forwarded-for",
  "x-vercel-deployment-url",
  "x-vercel-ip-continent",
  "x-vercel-ip-country",
  "x-vercel-ip-country-region",
  "x-vercel-ip-city",
  "x-vercel-ip-latitude",
  "x-vercel-ip-longitude",
  "x-vercel-ip-timezone",
  "x-vercel-ip-postal-code",
  "fly-client-ip",
  "fly-forwarded-port",
  "fly-region",
  "fly-request-id",
  "signature",
  "signature-input",
  "content-digest",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
  "x-port4-tenant",
  "idempotency-key",
  "payment-signature",
  "authorization",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret"
]);

const NEVER_SIGNED_IDENTITY = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "expect",
  "via",
  "forwarded",
  "origin",
  "referer",
  "content-digest",
  "signature",
  "signature-input",
  "agent-payer-auth",
  "payment",
  "payment-signature",
  "payment-required",
  "payment-receipt",
  "payment-response"
]);

const NEVER_SIGNED_PREFIX =
  /^(?:proxy-|sec-|x-forwarded-|x-visa(?:$|-)|x-stamp(?:$|-)|x-payment(?:$|-))/;

const UNPAID_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "payment",
  "payment-signature",
  "x-payment"
]);

function originIsNormal(publicOrigin: string): boolean {
  try {
    return (
      new URL(publicOrigin).origin === publicOrigin &&
      HOST_RE.test(publicOrigin.slice("https://".length))
    );
  } catch {
    return false;
  }
}

const EXPIRY_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;

export function expirySeconds(value: unknown): number | null {
  const found = typeof value === "string" ? EXPIRY_RE.exec(value) : null;
  if (!found) return null;
  const [year, month, day, hour, minute, second] = found.slice(1, 7).map(Number);
  const [offsetHours, offsetMinutes] = [Number(found[9] ?? 0), Number(found[10] ?? 0)];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    !monthDays ||
    day < 1 ||
    day > monthDays ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    return null;
  }
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const days =
    era * 146097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear -
    719468;
  const offset = (found[8] === "-" ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60);
  return (
    days * 86400 +
    hour * 3600 +
    minute * 60 +
    second -
    offset +
    Number((found[7] ?? "").slice(0, 3).padEnd(3, "0")) / 1000
  );
}

function normalTarget(publicOrigin: string, target: string): URL | null {
  if (typeof target !== "string" || !target.startsWith("/")) {
    return null;
  }
  const pathOnly = target.split("?")[0];
  if (pathOnly.includes("//") || pathOnly.includes("\\") || pathOnly.includes("^")) {
    return null;
  }
  if (pathOnly.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(`${publicOrigin}${target}`);
  } catch {
    return null;
  }
  if (url.origin !== publicOrigin || `${url.pathname}${url.search}` !== target) return null;
  if (/%2e|%2f|%5c/i.test(url.pathname)) return null;
  return url;
}

export async function computeEd25519JwkThumbprint(xBase64Url: string): Promise<string> {
  const canonical = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: xBase64Url });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return bytesToBase64Url(new Uint8Array(digest));
}

// 12-byte ASN.1 DER SPKI header for Ed25519 (`1.3.101.112`)
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

async function importEd25519FromBase64Pem(
  base64Pem: string
): Promise<{ cryptoKey: CryptoKey; thumbprint: string } | null> {
  try {
    const pemText = decoder.decode(base64ToBytes(base64Pem));
    const b64Body = pemText
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    const spki = base64ToBytes(b64Body);
    if (spki.length !== 44) return null;
    for (let i = 0; i < ED25519_SPKI_PREFIX.length; i++) {
      if (spki[i] !== ED25519_SPKI_PREFIX[i]) return null;
    }
    const raw32 = spki.subarray(12, 44);
    const xBase64Url = bytesToBase64Url(raw32);
    const thumbprint = await computeEd25519JwkThumbprint(xBase64Url);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      raw32,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return { cryptoKey, thumbprint };
  } catch {
    return null;
  }
}

interface ParsedListing {
  listed?: boolean;
  unavailable?: boolean;
  invalid?: boolean;
  notListed?: boolean;
  retryAfterSeconds?: number | null;
  agent?: {
    id: string | null;
    name: string;
    isActive: boolean;
    simulated?: boolean;
  };
  key?: {
    id: string;
    jkt: string;
    expirationDate: string | null;
  };
  cryptoKey?: CryptoKey;
  algorithm?: string;
  thumbprint?: string;
}

async function readListing(
  keyId: string | undefined,
  doc: Record<string, unknown>
): Promise<ParsedListing | null> {
  if (
    typeof doc?.id !== "string" ||
    typeof doc.name !== "string" ||
    typeof doc.isActive !== "boolean" ||
    !Array.isArray(doc.keys)
  ) {
    return null;
  }
  for (const key of doc.keys as Array<Record<string, unknown>>) {
    if (
      typeof key?.publicKey !== "string" ||
      typeof key?.jkt !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.jkt) ||
      key.agentId !== doc.id
    ) {
      return null;
    }
    if (key.status !== "active" || key.algorithm !== "ed25519") return null;
    if (key.expirationDate != null && expirySeconds(key.expirationDate) === null) return null;
  }
  const key =
    keyId === undefined
      ? null
      : (
          doc.keys as Array<{
            id: string;
            jkt: string;
            publicKey: string;
            expirationDate: string | null;
          }>
        ).find((k) => k.id === keyId || k.jkt === keyId);
  const agentObj = {
    id: doc.id as string,
    name: doc.name as string,
    isActive: doc.isActive as boolean,
    simulated: doc.simulated === true
  };
  if (!key) return { agent: agentObj };
  const imported = await importEd25519FromBase64Pem(key.publicKey);
  if (!imported) return null;
  return {
    agent: agentObj,
    key,
    cryptoKey: imported.cryptoKey,
    algorithm: "ed25519",
    thumbprint: imported.thumbprint
  };
}

async function signatureVerifies(
  found: ParsedListing,
  base: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  if (!found.cryptoKey) return false;
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, found.cryptoKey, signature, base);
  } catch {
    return false;
  }
}

async function readRegistry(
  url: string,
  parse: (doc: Record<string, unknown>) => Promise<ParsedListing | null>,
  fetchImpl: typeof fetch
): Promise<ParsedListing> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return { unavailable: true, retryAfterSeconds: null };
  }
  if (response.status === 404) return { notListed: true };
  if (!response.ok) {
    const retry = response.headers.get("retry-after") ?? "";
    return {
      unavailable: true,
      retryAfterSeconds: /^[0-9]+$/.test(retry) && Number(retry) > 0 ? Number(retry) : null
    };
  }
  try {
    const listing = await parse((await response.json()) as Record<string, unknown>);
    return listing ? { listed: true, ...listing } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

export function judgeKey(
  keyId: string,
  answer: ParsedListing,
  { acceptSimulated = false, now = Math.floor(Date.now() / 1000) } = {}
): TapRefusalResult | null {
  if (answer.unavailable) return refusal("registry_unavailable", answer.retryAfterSeconds ?? null);
  if (answer.invalid) return refusal("listing_unusable");
  if (answer.notListed) return refusal("key_not_listed");
  if (!answer.agent) return refusal("listing_unusable");
  if (answer.agent.simulated === true && !acceptSimulated) return refusal("simulated_listing");
  if (!answer.agent.isActive) return refusal("agent_not_live");
  if (!answer.key) return refusal("key_not_live");
  const computed = answer.thumbprint;
  if (
    computed !== keyId &&
    (keyId.length !== 36 || answer.key.id !== keyId || answer.key.jkt !== computed)
  ) {
    return refusal("key_not_live");
  }
  const expSec = answer.key.expirationDate != null ? expirySeconds(answer.key.expirationDate) : null;
  if (expSec !== null && expSec <= now) return refusal("key_not_live");
  return null;
}

const MAX_REGISTRY_CACHE = 500;
const registryKeyCache = new Map<string, { answer: ParsedListing; until: number }>();

export function createTapVerifier(options: {
  registryOrigin?: string;
  allowedSignatureAgents?: string[];
  acceptSimulated?: boolean;
  reserveNonce: (nonceKey: string, expiresEpochSec: number) => Promise<boolean>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  cacheSeconds?: number;
  extraTransportHeaders?: string[];
}) {
  const registryOrigin = (options.registryOrigin || "https://auth.visacli.sh").replace(/\/$/, "");
  const allowedSignatureAgents = options.allowedSignatureAgents ?? [
    '"https://sbx.agenticdirectory.visa.com"',
    '"https://agenticdirectory.visa.com"'
  ];
  const acceptSimulated = options.acceptSimulated ?? false;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheSeconds = options.cacheSeconds ?? 60;
  const transportHeaders = new Set([
    ...TRANSPORT_HEADERS,
    ...(options.extraTransportHeaders ?? []).map((n) => n.toLowerCase())
  ]);

  async function lookup(keyId: string, { fresh = false } = {}): Promise<ParsedListing> {
    const cacheKey = `${registryOrigin}:${keyId}`;
    const currentNow = now();
    const hit = registryKeyCache.get(cacheKey);
    if (!fresh && hit) {
      if (hit.until > currentNow) {
        registryKeyCache.delete(cacheKey);
        registryKeyCache.set(cacheKey, hit);
        return hit.answer;
      }
      registryKeyCache.delete(cacheKey);
    }

    const url = `${registryOrigin}/v1/tap/registry/keys/${encodeURIComponent(keyId)}`;
    const answer = await readRegistry(url, (doc) => readListing(keyId, doc), fetchImpl);

    if (answer.unavailable || answer.invalid) return answer;
    registryKeyCache.delete(cacheKey);
    if (answer.listed && answer.agent?.isActive && answer.key) {
      const storeNow = now();
      if (registryKeyCache.size >= MAX_REGISTRY_CACHE) {
        for (const [k, entry] of registryKeyCache) {
          if (entry.until <= storeNow) {
            registryKeyCache.delete(k);
          }
        }
        while (registryKeyCache.size >= MAX_REGISTRY_CACHE) {
          const oldestKey = registryKeyCache.keys().next().value;
          if (!oldestKey) break;
          registryKeyCache.delete(oldestKey);
        }
      }
      registryKeyCache.set(cacheKey, { answer, until: storeNow + cacheSeconds });
    }
    return answer;
  }

  return async function verifyTapRequest(req: {
    method: string;
    publicOrigin: string;
    target: string;
    headers: Record<string, string>;
    rawBody: Uint8Array | string;
  }): Promise<TapVerificationOutcome> {
    try {
      const { method, publicOrigin, target, headers } = req;
      const rawBodyBytes =
        typeof req.rawBody === "string" ? encoder.encode(req.rawBody) : req.rawBody;

      const input = headers["signature-input"];
      const signatureHeader = headers["signature"];
      if (!input || !signatureHeader) return refusal("no_signature_headers");

      const parsed = INPUT_RE.exec(input);
      if (!parsed) return refusal("signature_input_format");
      const signed = SIGNATURE_RE.exec(signatureHeader);
      if (!signed || signed[1] !== parsed[1]) return refusal("signature_header_format");

      const label = parsed[1];
      const parts = parsed[2].trim().split(/\s+/);
      if (!parts.every((part) => /^"[^"]+"$/.test(part))) return refusal("components_invalid");
      const components = parts.map((part) => part.slice(1, -1).toLowerCase());
      if (new Set(components).size !== components.length) return refusal("components_invalid");

      const created = Number(parsed[3]);
      const expires = Number(parsed[4]);
      if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires)) {
        return refusal("signature_input_format");
      }
      const keyId = parsed[5];
      const alg = "ed25519";
      const nonce = parsed[7];
      const tag = parsed[8] as "agent-browser-auth" | "agent-payer-auth";

      if (!String(publicOrigin).startsWith("https://")) return refusal("origin_not_https");
      if (!originIsNormal(publicOrigin)) return refusal("origin_not_normal");
      const url = normalTarget(publicOrigin, target);
      if (!url) return refusal("request_target_invalid");

      const t = now();
      if (created > t + CLOCK_SKEW_SECONDS) return refusal("not_yet_valid");
      if (expires <= t || expires <= created) return refusal("expired");

      const maxLifetime =
        tag === "agent-payer-auth" ? (keyId.length === 36 ? 300 : 480) : 60;
      if (expires - created > maxLifetime) return refusal("lifetime_too_long");

      if (!["GET", "HEAD", "POST"].includes(method)) return refusal("method_not_allowed");

      if (tag === "agent-browser-auth") {
        if (
          JSON.stringify(components.slice(0, CORE_IDENTITY.length)) !==
          JSON.stringify(CORE_IDENTITY)
        ) {
          return refusal("required_components_missing");
        }
      } else {
        const requiredPaid = ["@method", "@authority", "@path"];
        if (requiredPaid.some((reqComp) => !components.includes(reqComp))) {
          return refusal("required_components_missing");
        }
      }

      if (components.length > 38) return refusal("signed_header_invalid");
      let size = 0;
      for (const name of components) {
        if (name.startsWith("@") || name === "content-digest") continue;
        const value = headers[name];
        if (
          !HEADER_NAME_RE.test(name) ||
          typeof value !== "string" ||
          value.trim() !== value ||
          value.length > 4096 ||
          /[^\x20-\x7e]/.test(value)
        ) {
          return refusal("signed_header_invalid");
        }
        if (
          tag === "agent-browser-auth" &&
          (NEVER_SIGNED_IDENTITY.has(name) || NEVER_SIGNED_PREFIX.test(name))
        ) {
          return refusal("signed_header_invalid");
        }
        size += name.length + value.length;
      }
      if (size > 16384) return refusal("signed_header_invalid");

      if (tag === "agent-browser-auth") {
        for (const name of Object.keys(headers)) {
          if (UNPAID_CREDENTIAL_HEADERS.has(name) || name.startsWith("x-payment-")) {
            return refusal("credential_header_present", null, name);
          }
        }
      }

      for (const name of Object.keys(headers)) {
        const transport = transportHeaders.has(name) || name.startsWith("sec-fetch-");
        if (!components.includes(name) && !transport) {
          return refusal("uncovered_header", null, name);
        }
      }

      let nonceBytes: Uint8Array;
      try {
        nonceBytes = base64ToBytes(nonce);
      } catch {
        return refusal("nonce_format");
      }
      if (nonceBytes.length !== 32 || bytesToBase64(nonceBytes) !== nonce) {
        return refusal("nonce_format");
      }

      if (rawBodyBytes.byteLength > MAX_TAP_BODY_BYTES) return refusal("body_too_large");
      if (components.includes("content-digest")) {
        if (!DIGEST_RE.test(headers["content-digest"] ?? "")) return refusal("digest_format");
        const bodyHashBuf = await crypto.subtle.digest("SHA-256", rawBodyBytes);
        const digest = `sha-256=:${bytesToBase64(new Uint8Array(bodyHashBuf))}:`;
        if (headers["content-digest"] !== digest) return refusal("body_digest_mismatch");
      }

      const signatureAgent = headers["signature-agent"];
      if (signatureAgent !== undefined && !allowedSignatureAgents.includes(signatureAgent)) {
        return refusal("signature_agent_not_accepted");
      }

      let found = await lookup(keyId);
      let refused = judgeKey(keyId, found, { acceptSimulated, now: t });
      if (refused) return refused;

      const derived: Record<string, string> = {
        "@method": method,
        "@scheme": "https",
        "@authority": url.host,
        "@path": url.pathname || "/",
        "@query": url.search || "?"
      };
      const lines = components.map(
        (name) => `"${name}": ${name.startsWith("@") ? derived[name] : headers[name]}`
      );
      lines.push(`"@signature-params": ${input.slice(`${label}=`.length)}`);
      const base = encoder.encode(lines.join("\n"));
      const signature = base64ToBytes(signed[2]);

      if (found.algorithm !== alg || !(await signatureVerifies(found, base, signature))) {
        found = await lookup(keyId, { fresh: true });
        refused = judgeKey(keyId, found, { acceptSimulated, now: t });
        if (refused) return refused;
        if (found.algorithm !== alg) return refusal("algorithm_mismatch");
        if (!(await signatureVerifies(found, base, signature))) {
          return refusal("signature_mismatch");
        }
      }

      let reserved: boolean;
      try {
        reserved = await options.reserveNonce(`${keyId}:${nonce}`, expires);
      } catch {
        return refusal("nonce_store_unavailable");
      }
      if (!reserved) return refusal("nonce_reused");

      return {
        ok: true,
        keyId,
        jkt: found.key!.jkt,
        agentId: found.agent!.id,
        agentName: found.agent!.name,
        simulated: found.agent!.simulated === true,
        tag,
        covered: components,
        expires
      };
    } catch {
      return refusal("request_unreadable");
    }
  };
}
