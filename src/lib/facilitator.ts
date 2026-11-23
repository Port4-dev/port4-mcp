import type { AppBindings } from "../types";
import { randomHex } from "./crypto";
import { bytesToBase64Url, encodeBase64UrlJson } from "./mpp-tempo";
import { getSupportedNetwork } from "./networks";

export interface FacilitatorEndpointConfig {
  baseUrl: string;
  headers: Record<string, string>;
  isMainnet: boolean;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
}

const encoder = new TextEncoder();

// Fixed 16-byte PKCS#8 DER prefix for a 32-byte Ed25519 private key seed (RFC 8410)
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

// AlgorithmIdentifier for id-ecPublicKey + prime256v1 (P-256)
const EC_P256_ALG_ID = new Uint8Array([
  0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07
]);

function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function derLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  if (len < 256) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function wrapSec1EcPrivateKeyToPkcs8(sec1Der: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octetLen = derLength(sec1Der.byteLength);
  const innerLen =
    version.byteLength + EC_P256_ALG_ID.byteLength + 1 + octetLen.byteLength + sec1Der.byteLength;
  const seqLen = derLength(innerLen);
  const out = new Uint8Array(1 + seqLen.byteLength + innerLen);
  let offset = 0;
  out[offset++] = 0x30;
  out.set(seqLen, offset);
  offset += seqLen.byteLength;
  out.set(version, offset);
  offset += version.byteLength;
  out.set(EC_P256_ALG_ID, offset);
  offset += EC_P256_ALG_ID.byteLength;
  out[offset++] = 0x04;
  out.set(octetLen, offset);
  offset += octetLen.byteLength;
  out.set(sec1Der, offset);
  return out;
}

/**
 * Generates a short-lived Coinbase Developer Platform (CDP) JWT using pure Web Crypto (`crypto.subtle`).
 * Supports both Ed25519 (`EdDSA`, base64 32-byte seed or 64-byte keypair) and ECDSA P-256 (`ES256`, PEM).
 */
export async function generateCdpJwt(params: {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: string;
  requestUrl: string;
}): Promise<string> {
  const parsed = new URL(params.requestUrl);
  const uri = `${params.requestMethod.toUpperCase()} ${parsed.host}${parsed.pathname}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const secret = params.apiKeySecret.replace(/\\n/g, "\n").trim();

  let alg: "EdDSA" | "ES256";
  let signingKey: CryptoKey;

  if (secret.startsWith("-----BEGIN")) {
    const isSec1 = secret.includes("BEGIN EC PRIVATE KEY");
    const pemBody = secret
      .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
      .replace(/-----END [A-Z0-9 ]+-----/g, "")
      .replace(/\s+/g, "");
    const rawDer = base64ToBytes(pemBody);
    const pkcs8 = isSec1 ? wrapSec1EcPrivateKeyToPkcs8(rawDer) : rawDer;
    const pkcs8Buf = pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength) as ArrayBuffer;
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Buf,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    alg = "ES256";
  } else {
    const raw = base64ToBytes(secret);
    if (raw.byteLength !== 32 && raw.byteLength !== 64) {
      throw new Error("CDP_API_KEY_SECRET must be a valid Ed25519 base64 key or ECDSA PEM key.");
    }
    const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.byteLength + 32);
    pkcs8.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(raw.subarray(0, 32), ED25519_PKCS8_PREFIX.byteLength);
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8.buffer,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    alg = "EdDSA";
  }

  const headerB64 = encodeBase64UrlJson({
    alg,
    kid: params.apiKeyId.trim(),
    typ: "JWT",
    nonce: randomHex(16)
  });
  const payloadB64 = encodeBase64UrlJson({
    sub: params.apiKeyId.trim(),
    iss: "cdp",
    nbf: nowSec,
    exp: nowSec + 120,
    uris: [uri]
  });

  const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const sigBuf =
    alg === "EdDSA"
      ? await crypto.subtle.sign({ name: "Ed25519" }, signingKey, signingInput)
      : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, signingInput);

  return `${headerB64}.${payloadB64}.${bytesToBase64Url(new Uint8Array(sigBuf))}`;
}

function validateFacilitatorUrl(rawUrl: string): string {
  const normalized = rawUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Invalid x402 facilitator URL configuration.");
  }
  const isLocalHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new Error("x402 facilitator URL must use https://.");
  }
  return normalized;
}

/**
 * Resolves the appropriate x402 Facilitator URL & optional authentication credentials
 * for the target settlement network (Mainnet vs. Testnet).
 */
export function resolveFacilitatorConfig(
  env: AppBindings,
  network: string
): FacilitatorEndpointConfig {
  const netInfo = getSupportedNetwork(network);
  const isMainnet = netInfo?.isMainnet ?? false;
  const defaultRaw =
    env.FACILITATOR_URL || env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
  const mainnetRaw = env.X402_MAINNET_FACILITATOR_URL?.trim();

  const baseUrl = validateFacilitatorUrl(
    isMainnet && mainnetRaw ? mainnetRaw : defaultRaw
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (env.X402_FACILITATOR_API_KEY && env.X402_FACILITATOR_API_KEY.trim().length > 0) {
    headers["Authorization"] = `Bearer ${env.X402_FACILITATOR_API_KEY.trim()}`;
  }

  return {
    baseUrl,
    headers,
    isMainnet,
    cdpApiKeyId: env.CDP_API_KEY_ID?.trim() || undefined,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET?.trim() || undefined
  };
}

async function buildRequestHeaders(
  config: FacilitatorEndpointConfig,
  method: string,
  url: string
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...config.headers };
  if (
    config.cdpApiKeyId &&
    config.cdpApiKeySecret &&
    (config.isMainnet || config.baseUrl.includes("coinbase.com"))
  ) {
    const jwt = await generateCdpJwt({
      apiKeyId: config.cdpApiKeyId,
      apiKeySecret: config.cdpApiKeySecret,
      requestMethod: method,
      requestUrl: url
    });
    headers["Authorization"] = `Bearer ${jwt}`;
  }
  return headers;
}

/**
 * Calls `/verify` on the resolved facilitator with a 1-time retry on transient
 * network errors or 502/503/504 responses (safe because `/verify` is side-effect-free).
 */
export async function fetchFacilitatorVerify(
  config: FacilitatorEndpointConfig,
  payload: unknown
): Promise<Response> {
  const url = `${config.baseUrl}/verify`;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers = await buildRequestHeaders(config, "POST", url);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(8_000)
      });
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Facilitator verify unreachable");
}

/**
 * Calls `/settle` on the resolved facilitator (NEVER auto-retried on timeout;
 * timeouts enter `settlement_pending` in `PaymentReplayGuard`).
 */
export async function fetchFacilitatorSettle(
  config: FacilitatorEndpointConfig,
  payload: unknown
): Promise<Response> {
  const url = `${config.baseUrl}/settle`;
  const headers = await buildRequestHeaders(config, "POST", url);
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
}
