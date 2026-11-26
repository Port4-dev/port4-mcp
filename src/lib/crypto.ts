const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveAesGcmKey(masterSecret: string): Promise<CryptoKey> {
  if (!masterSecret || masterSecret.length < 16) {
    throw new Error("Master secret of at least 16 chars is required for AES-GCM encryption.");
  }
  const rawKey = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`port4:aes-gcm:v1:${masterSecret}`)
  );
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ]);
}

/**
 * Encrypts sensitive third-party upstream credentials at rest using AES-256-GCM.
 * Stored format: `enc:v1:<12-byte-iv-hex>:<ciphertext+tag-hex>`
 */
export async function encryptSecretAtRest(
  plaintext: string,
  masterSecret: string
): Promise<string> {
  const key = await deriveAesGcmKey(masterSecret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );
  return `enc:v1:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypts an `enc:v1:<ivHex>:<cipherHex>` secret at rest.
 * Falls back gracefully for legacy unencrypted values in local dev.
 */
export async function decryptSecretAtRest(
  stored: string,
  masterSecret: string
): Promise<string> {
  if (!stored.startsWith("enc:v1:")) {
    return stored;
  }
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted secret format.");
  }
  const iv = hexToBytes(parts[2]);
  const cipherBytes = hexToBytes(parts[3]);
  const key = await deriveAesGcmKey(masterSecret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipherBytes
  );
  return decoder.decode(decrypted);
}

const FORBIDDEN_EXACT_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "origin",
  "referer",
  "cookie",
  "set-cookie",
  "idempotency-key"
]);

/**
 * Validates a custom upstream authentication header name and blocks reserved
 * protocol/security headers from being overridden.
 */
export function isValidCustomAuthHeaderName(name: string): boolean {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9-]{2,64}$/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_EXACT_HEADERS.has(lower)) return false;
  if (
    lower.startsWith("x-port4-") ||
    lower.startsWith("cf-") ||
    lower.startsWith("payment-") ||
    lower.startsWith("mcp-")
  ) {
    return false;
  }
  return true;
}

export function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = encoder.encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeBase64Json<T>(base64: string): T {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return JSON.parse(decoder.decode(bytes)) as T;
}

export function usdToAtomicUsdc(
  priceUsd: string,
  options?: { allowZero?: boolean }
): string {
  const cleaned = priceUsd.replace(/^\$/, "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(cleaned)) {
    throw new Error("Price must be a non-negative USD decimal with no more than 6 fractional digits.");
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const minAtomic = options?.allowZero ? 0n : 1n;
  if (atomic < minAtomic || atomic > 1_000_000_000_000n) {
    throw new Error(
      options?.allowZero
        ? "Price must be between 0 and 1,000,000 USD."
        : "Price must be between 0.000001 and 1,000,000 USD."
    );
  }
  return atomic.toString();
}
