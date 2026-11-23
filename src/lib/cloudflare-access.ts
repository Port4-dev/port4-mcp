/**
 * Cloudflare One Access JWT verification (RS256 via JWKS + Audience/Issuer/Expiry checks).
 * Enables production-grade `x402+oauth_v2` Zero Trust MCP tenants using Cloudflare Access
 * Service Tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret` -> `Cf-Access-Jwt-Assertion`)
 * or Access OIDC JWTs (`Authorization: Bearer <jwt>`).
 */

interface JwkKey extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys?: JwkKey[];
}

interface AccessJwtHeader {
  alg?: string;
  kid?: string;
}

interface AccessJwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  common_name?: string;
}

const jwksCache = new Map<string, { keys: JwkKey[]; expiresAt: number }>();
const JWKS_TTL_MS = 5 * 60 * 1000;
const MAX_JWKS_CACHE = 200;

function base64UrlToUint8Array(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const bytes = base64UrlToUint8Array(segment);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function normalizeAccessTeamDomain(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

async function fetchJwks(
  teamDomain: string,
  forceRefresh = false
): Promise<{ keys: JwkKey[]; fromCache: boolean }> {
  const now = Date.now();
  const cached = jwksCache.get(teamDomain);
  if (!forceRefresh && cached) {
    if (cached.expiresAt > now) {
      jwksCache.delete(teamDomain);
      jwksCache.set(teamDomain, cached);
      return { keys: cached.keys, fromCache: true };
    }
    jwksCache.delete(teamDomain);
  }
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8_000)
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Unable to fetch Cloudflare Access JWKS (${res.status}).`);
  }
  const json = (await res.json()) as JwksResponse;
  if (!Array.isArray(json.keys)) {
    throw new Error("Malformed Cloudflare Access JWKS response.");
  }
  const keys = json.keys;
  jwksCache.delete(teamDomain);
  if (jwksCache.size >= MAX_JWKS_CACHE) {
    const sweepNow = Date.now();
    for (const [k, v] of jwksCache) {
      if (v.expiresAt <= sweepNow) jwksCache.delete(k);
    }
    while (jwksCache.size >= MAX_JWKS_CACHE) {
      const oldestKey = jwksCache.keys().next().value;
      if (!oldestKey) break;
      jwksCache.delete(oldestKey);
    }
  }
  jwksCache.set(teamDomain, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return { keys, fromCache: false };
}

export async function verifyCloudflareAccessJwt(params: {
  token: string;
  teamDomain: string;
  expectedAud: string;
}): Promise<{ ok: true; subject: string } | { ok: false; status: 401 | 403 | 503; error: string }> {
  const normalizedDomain = normalizeAccessTeamDomain(params.teamDomain);
  if (!normalizedDomain) {
    return { ok: false, status: 503, error: "Invalid Cloudflare Access team domain configuration." };
  }

  const parts = params.token.trim().split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: "Malformed Cloudflare Access JWT." };
  }

  let header: AccessJwtHeader;
  let payload: AccessJwtPayload;
  try {
    header = decodeBase64UrlJson<AccessJwtHeader>(parts[0]);
    payload = decodeBase64UrlJson<AccessJwtPayload>(parts[1]);
  } catch {
    return { ok: false, status: 401, error: "Unable to decode Cloudflare Access JWT." };
  }

  if (header.alg !== "RS256" || !header.kid) {
    return { ok: false, status: 401, error: "Unsupported JWT algorithm or missing kid." };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { ok: false, status: 401, error: "Cloudflare Access JWT has expired." };
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) {
    return { ok: false, status: 401, error: "Cloudflare Access JWT is not yet valid." };
  }

  const expectedIss = `https://${normalizedDomain}`;
  if (payload.iss !== expectedIss) {
    return { ok: false, status: 403, error: "Cloudflare Access JWT issuer mismatch." };
  }

  const audList = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!audList.includes(params.expectedAud)) {
    return { ok: false, status: 403, error: "Cloudflare Access JWT audience (AUD) mismatch." };
  }

  let keys: JwkKey[];
  let fromCache: boolean;
  try {
    ({ keys, fromCache } = await fetchJwks(normalizedDomain));
  } catch {
    return { ok: false, status: 503, error: "Failed to load Cloudflare Access JWKS." };
  }

  let jwk = keys.find((k) => k.kid === header.kid && (!k.kty || k.kty === "RSA"));
  if (!jwk && fromCache) {
    try {
      const refreshed = await fetchJwks(normalizedDomain, true);
      jwk = refreshed.keys.find((k) => k.kid === header.kid && (!k.kty || k.kty === "RSA"));
    } catch {
      return { ok: false, status: 503, error: "Failed to refresh Cloudflare Access JWKS." };
    }
  }
  if (!jwk) {
    return { ok: false, status: 401, error: "Unknown Cloudflare Access signing key." };
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToUint8Array(parts[2]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signingInput
    );
    if (!valid) {
      return { ok: false, status: 401, error: "Invalid Cloudflare Access JWT signature." };
    }
  } catch {
    return { ok: false, status: 401, error: "Cloudflare Access JWT verification error." };
  }

  const subject = payload.email || payload.common_name || payload.sub || "cf-access-service";
  return { ok: true, subject };
}
