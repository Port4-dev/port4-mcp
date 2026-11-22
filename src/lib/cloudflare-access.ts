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

async function fetchJwks(teamDomain: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(8_000)
  });
  if (!res.ok) {
    throw new Error(`Unable to fetch Cloudflare Access JWKS (${res.status}).`);
  }
  const json = (await res.json()) as JwksResponse;
  const keys = Array.isArray(json.keys) ? json.keys : [];
  jwksCache.set(teamDomain, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

export async function verifyCloudflareAccessJwt(params: {
  token: string;
  teamDomain: string;
  expectedAud: string;
}): Promise<{ ok: true; subject: string } | { ok: false; status: 401 | 403; error: string }> {
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

  const expectedIss = `https://${params.teamDomain}`;
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
  try {
    keys = await fetchJwks(params.teamDomain);
  } catch {
    return { ok: false, status: 401, error: "Failed to load Cloudflare Access JWKS." };
  }

  const jwk = keys.find((k) => k.kid === header.kid);
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
