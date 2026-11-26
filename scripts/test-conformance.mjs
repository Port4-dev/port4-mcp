/**
 * Port4 (`port4.dev`) Conformance, Security, & Integration Test Suite (Tiers 1–4)
 *
 * Loads REAL `src/**` TypeScript modules in-memory via Node 24 `node:module` `register()`
 * + `esbuild.transform` + `cloudflare:workers` virtual shim (zero inline re-implementations).
 *
 * Usage:
 *   node scripts/test-conformance.mjs                 # Strict mode (M5 release gate; fails on any pending/broken item)
 *   node scripts/test-conformance.mjs --mode=baseline # Diagnostic mode during M1-M4 remediation
 *   node scripts/test-conformance.mjs --skip-typecheck
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { register } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const MODE = args.has("--mode=baseline") ? "baseline" : "strict";
const SKIP_TYPECHECK = args.has("--skip-typecheck");

// Polyfill Cloudflare Workers' `crypto.subtle.timingSafeEqual` on Node 24 WebCrypto
if (typeof globalThis.crypto?.subtle?.timingSafeEqual !== "function") {
  globalThis.crypto.subtle.timingSafeEqual = (a, b) => {
    const toU8 = (v) =>
      v instanceof ArrayBuffer
        ? new Uint8Array(v)
        : ArrayBuffer.isView(v)
          ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
          : new Uint8Array(v);
    const ua = toU8(a);
    const ub = toU8(b);
    if (ua.byteLength !== ub.byteLength) return false;
    return crypto.timingSafeEqual(ua, ub);
  };
}

// ---------------------------------------------------------------------------
// 1. Register in-memory ESM TS + `cloudflare:workers` loader hook
// ---------------------------------------------------------------------------
const esbuildEntryUrl = pathToFileURL(path.join(ROOT, "node_modules", "esbuild", "lib", "main.js")).href;
const rootUrlPrefix = pathToFileURL(ROOT).href.toLowerCase();

const loaderHookSource = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const esbuild = await import(${JSON.stringify(esbuildEntryUrl)});
const CLOUDFLARE_SHIM_URL = "cloudflare-shim:workers";
const ROOT_URL_PREFIX = ${JSON.stringify(rootUrlPrefix)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: CLOUDFLARE_SHIM_URL, shortCircuit: true };
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL &&
    context.parentURL.toLowerCase().startsWith(ROOT_URL_PREFIX) &&
    !/\\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const tsCandidate = path.resolve(path.dirname(parentPath), specifier + ".ts");
    if (fs.existsSync(tsCandidate)) {
      return { url: pathToFileURL(tsCandidate).href, shortCircuit: true };
    }
    const indexCandidate = path.resolve(path.dirname(parentPath), specifier, "index.ts");
    if (fs.existsSync(indexCandidate)) {
      return { url: pathToFileURL(indexCandidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === CLOUDFLARE_SHIM_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: \`
        export class DurableObject {
          constructor(ctx, env) {
            this.ctx = ctx;
            this.env = env;
          }
        }
        export class RpcTarget {}
        export class WorkerEntrypoint {
          constructor(ctx, env) {
            this.ctx = ctx;
            this.env = env;
          }
        }
      \`
    };
  }
  if (url.startsWith("file:///") && url.endsWith(".ts")) {
    const filePath = fileURLToPath(url);
    const source = fs.readFileSync(filePath, "utf8");
    const result = await esbuild.transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2022",
      sourcemap: "inline",
      sourcefile: filePath
    });
    return {
      format: "module",
      shortCircuit: true,
      source: result.code
    };
  }
  return nextLoad(url, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderHookSource)}`);

// Dynamic import AFTER hook registration so ESM static hoisting does not bypass the hook
const importSrc = (relPath) => import(pathToFileURL(path.join(ROOT, relPath)).href);

const [
  indexMod,
  doMod,
  kvSyncMod,
  schemaMod,
  cryptoMod,
  networksMod,
  facilitatorMod,
  meteringMod,
  visaTapMod,
  mppTempoMod,
  cfAccessMod,
  codemodeMod,
  openapiImportMod,
  x402GateMod,
  securityMod,
  mcpRouteMod,
  sandboxMod,
  walletsWebMod,
  honoJwtMod
] = await Promise.all([
  importSrc("src/index.ts"),
  importSrc("src/durable-objects.ts"),
  importSrc("src/lib/kv-sync.ts"),
  importSrc("src/lib/schema-validator.ts"),
  importSrc("src/lib/crypto.ts"),
  importSrc("src/lib/networks.ts"),
  importSrc("src/lib/facilitator.ts"),
  importSrc("src/lib/metering.ts"),
  importSrc("src/lib/visa-tap.ts"),
  importSrc("src/lib/mpp-tempo.ts"),
  importSrc("src/lib/cloudflare-access.ts"),
  importSrc("src/lib/codemode.ts"),
  importSrc("src/lib/openapi-import.ts"),
  importSrc("src/middleware/x402-gate.ts"),
  importSrc("src/middleware/security.ts"),
  importSrc("src/routes/mcp.ts"),
  importSrc("src/routes/sandbox.ts"),
  importSrc("web/src/lib/wallets.ts"),
  import("hono/jwt")
]);

const workerEntry = indexMod.default;
const { EdgeRateLimiter, PaymentReplayGuard } = doMod;

// ---------------------------------------------------------------------------
// 2. Stateful Binding Mocks & Deterministic Helpers
// ---------------------------------------------------------------------------
const MIGRATION_FILES = fs
  .readdirSync(path.join(ROOT, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const MIGRATION_SQL_LIST = MIGRATION_FILES.map((f) => ({
  name: f,
  sql: fs.readFileSync(path.join(ROOT, "migrations", f), "utf8")
}));

function normalizeSqliteVal(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function toPlainRow(row) {
  return row ? { ...row } : null;
}

class MockD1PreparedStatement {
  constructor(db, sql, params = []) {
    this._db = db;
    this._sql = sql;
    this._params = params;
  }

  bind(...args) {
    return new MockD1PreparedStatement(this._db, this._sql, args.map(normalizeSqliteVal));
  }

  async first(colName) {
    const stmt = this._db.prepare(this._sql);
    const row = toPlainRow(stmt.get(...this._params));
    if (!row) return null;
    return colName ? row[colName] : row;
  }

  async all() {
    const stmt = this._db.prepare(this._sql);
    const rows = stmt.all(...this._params).map((r) => ({ ...r }));
    return { results: rows, success: true, meta: { changes: 0, duration: 0 } };
  }

  async run() {
    const stmt = this._db.prepare(this._sql);
    const info = stmt.run(...this._params);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        duration: 0
      }
    };
  }

  async raw() {
    const stmt = this._db.prepare(this._sql);
    return stmt.all(...this._params).map((r) => Object.values(r));
  }
}

class MockD1Database {
  constructor(applyMigrations = true) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    if (applyMigrations) {
      for (const m of MIGRATION_SQL_LIST) {
        this.sqlite.exec(m.sql);
      }
    }
  }

  prepare(sql) {
    return new MockD1PreparedStatement(this.sqlite, sql);
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  async batch(statements) {
    const results = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const st of statements) {
        const sqlTrim = st._sql.trim().toUpperCase();
        if (sqlTrim.startsWith("SELECT") || sqlTrim.startsWith("PRAGMA")) {
          results.push(await st.all());
        } else {
          results.push(await st.run());
        }
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (err) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  close() {
    this.sqlite.close();
  }
}

class MockKVNamespace {
  constructor() {
    this.map = new Map();
  }

  async get(key, type) {
    const val = this.map.get(key);
    if (val === undefined) return null;
    if (type === "json") return JSON.parse(val);
    return val;
  }

  async put(key, value) {
    this.map.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  async delete(key) {
    this.map.delete(key);
  }
}

class MockDurableObjectStorage {
  constructor() {
    this.store = new Map();
    this.alarmAt = null;
  }

  async get(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) {
      const out = new Map();
      for (const k of keyOrKeys) {
        if (this.store.has(k)) out.set(k, structuredClone(this.store.get(k)));
      }
      return out;
    }
    const v = this.store.get(keyOrKeys);
    return v === undefined ? undefined : structuredClone(v);
  }

  async put(keyOrEntries, value) {
    if (typeof keyOrEntries === "string") {
      this.store.set(keyOrEntries, structuredClone(value));
      return;
    }
    for (const [k, v] of Object.entries(keyOrEntries)) {
      this.store.set(k, structuredClone(v));
    }
  }

  async delete(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) {
      let count = 0;
      for (const k of keyOrKeys) {
        if (this.store.delete(k)) count += 1;
      }
      return count;
    }
    return this.store.delete(keyOrKeys);
  }

  async list() {
    return new Map(this.store);
  }

  async deleteAll() {
    this.store.clear();
    this.alarmAt = null;
  }

  async setAlarm(scheduledTime) {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }
}

class MockDurableObjectNamespace {
  constructor(DoClass, envProvider) {
    this.DoClass = DoClass;
    this.envProvider = envProvider;
    this.instances = new Map();
  }

  idFromName(name) {
    const key = String(name);
    return {
      name: key,
      toString: () => key,
      equals: (other) => other?.toString?.() === key
    };
  }

  newUniqueId() {
    return this.idFromName(crypto.randomUUID());
  }

  _getEntry(idOrName) {
    const key = typeof idOrName === "string" ? idOrName : idOrName.toString();
    let entry = this.instances.get(key);
    if (!entry) {
      const storage = new MockDurableObjectStorage();
      const ctx = {
        id: this.idFromName(key),
        storage,
        waitUntil: (p) => {
          void Promise.resolve(p).catch(() => {});
        },
        blockConcurrencyWhile: (fn) => fn()
      };
      const instance = new this.DoClass(ctx, this.envProvider());
      entry = { ctx, storage, instance };
      this.instances.set(key, entry);
    }
    return entry;
  }

  get(id) {
    const entry = this._getEntry(id);
    return {
      fetch: (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        return entry.instance.fetch(req);
      }
    };
  }

  async triggerAlarm(idOrName) {
    const entry = this._getEntry(idOrName);
    if (typeof entry.instance.alarm === "function") {
      entry.storage.alarmAt = null;
      await entry.instance.alarm();
    }
    return entry;
  }

  rawStorage(idOrName) {
    return this._getEntry(idOrName).storage.store;
  }
}

class MockQueue {
  constructor() {
    this.sent = [];
  }

  async send(body) {
    this.sent.push(structuredClone(body));
  }

  async sendBatch(messages) {
    for (const m of messages) {
      this.sent.push(structuredClone(m.body));
    }
  }

  drainToBatch() {
    const items = this.sent.splice(0, this.sent.length);
    const messages = items.map((body, idx) => ({
      id: `msg_${idx}_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      }
    }));
    return {
      queue: "port4-metering",
      messages,
      ackAll() {
        for (const m of messages) m.ack();
      },
      retryAll() {
        for (const m of messages) m.retry();
      }
    };
  }
}

class MockWorkerLoader {
  constructor() {
    this.loadedConfigs = [];
  }

  load(config) {
    this.loadedConfigs.push(config);
    return {
      getEntrypoint() {
        return {
          async evaluate(dispatchers, connectors) {
            const savedConsole = {
              log: console.log,
              warn: console.warn,
              error: console.error
            };
            try {
              const b64 = Buffer.from(config.modules[config.mainModule], "utf8").toString("base64");
              const mod = await import(`data:text/javascript;base64,${b64}`);
              const Executor = mod.default;
              const instance = new Executor({}, config.env || {});
              return await instance.evaluate(dispatchers, connectors);
            } finally {
              console.log = savedConsole.log;
              console.warn = savedConsole.warn;
              console.error = savedConsole.error;
            }
          }
        };
      }
    };
  }
}

function createHarness(envOverrides = {}) {
  const db = new MockD1Database(true);
  const kv = new MockKVNamespace();
  const queue = new MockQueue();
  const loader = new MockWorkerLoader();
  const analyticsPoints = [];
  const r2Objects = new Map();

  let envRef = null;
  const rateLimiter = new MockDurableObjectNamespace(EdgeRateLimiter, () => envRef);
  const replayGuard = new MockDurableObjectNamespace(PaymentReplayGuard, () => envRef);

  envRef = {
    APP_URL: "https://port4.dev",
    ADMIN_GITHUB_LOGIN: "Ishabarundo",
    FACILITATOR_URL: "https://x402.org/facilitator",
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    X402_NETWORK: "eip155:84532",
    X402_USDC_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    SANDBOX_PAYOUT_WALLET: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    JWT_SECRET: "test_jwt_master_secret_0123456789abcdef",
    PORT4_TREASURY_WALLET: "0x9999999999999999999999999999999999999999",
    PORT4_TREASURY_SOLANA_WALLET: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    DB: db,
    TENANT_ROUTING: kv,
    METERING_EVENTS: queue,
    LOADER: loader,
    EDGE_RATE_LIMITER: rateLimiter,
    PAYMENT_REPLAY_GUARD: replayGuard,
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><html><body>Port4 SPA</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        })
    },
    GATEWAY_ANALYTICS: {
      writeDataPoint(dp) {
        analyticsPoints.push(dp);
      }
    },
    LEDGER_ARCHIVE: {
      async put(key, val, opts) {
        r2Objects.set(key, { val, opts });
      }
    },
    ...envOverrides
  };

  const pendingWaitUntils = [];
  const execCtx = {
    waitUntil(promise) {
      pendingWaitUntils.push(Promise.resolve(promise));
    },
    passThroughOnException() {}
  };

  async function flush() {
    while (pendingWaitUntils.length > 0) {
      const batch = pendingWaitUntils.splice(0, pendingWaitUntils.length);
      await Promise.allSettled(batch);
    }
  }

  async function callApp(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const res = await workerEntry.fetch(req, envRef, execCtx);
    await flush();
    return res;
  }

  async function seedUser({
    id = `usr_${crypto.randomUUID().slice(0, 8)}`,
    githubId = String(Math.floor(100000 + Math.random() * 900000)),
    login = "dev-user",
    isAdmin = 0,
    plan = "free"
  } = {}) {
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, github_id, login, avatar_url, email, is_admin, plan) VALUES (?, ?, ?, NULL, ?, ?, ?)"
      )
      .bind(id, githubId, login, `${login}@example.com`, isAdmin, plan)
      .run();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await honoJwtMod.sign(
      {
        sub: id,
        jti: crypto.randomBytes(8).toString("hex"),
        github_id: githubId,
        login,
        avatar_url: null,
        email: `${login}@example.com`,
        is_admin: isAdmin,
        plan,
        iat: now,
        exp: now + 3600
      },
      envRef.JWT_SECRET,
      "HS256"
    );
    return { id, githubId, login, isAdmin, plan, cookie: `port4_session=${jwt}`, jwt };
  }

  return {
    env: envRef,
    db,
    kv,
    queue,
    loader,
    rateLimiter,
    replayGuard,
    analyticsPoints,
    r2Objects,
    execCtx,
    flush,
    callApp,
    seedUser,
    close: () => db.close()
  };
}

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init, input);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withFixedNow(epochMs, fn) {
  const realNow = Date.now;
  Date.now = () => epochMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

function makeEd25519Agent(agentId = `agt_${crypto.randomUUID().slice(0, 8)}`, opts = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const jkt = crypto
    .createHash("sha256")
    .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x }))
    .digest("base64url");
  const spkiPem = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyB64Pem = Buffer.from(spkiPem, "utf8").toString("base64");
  const keyId = opts.useUuidKeyId ? crypto.randomUUID() : jkt;
  const listing = {
    id: agentId,
    name: opts.name ?? "Test Visa TAP Agent",
    isActive: opts.isActive ?? true,
    simulated: opts.simulated ?? false,
    keys: [
      {
        id: keyId,
        agentId,
        jkt,
        publicKey: publicKeyB64Pem,
        status: opts.keyStatus ?? "active",
        algorithm: opts.listingAlg ?? "ed25519",
        expirationDate: opts.expirationDate ?? null
      }
    ]
  };
  return { publicKey, privateKey, jwk, jkt, keyId, agentId, listing };
}

function signTapRequest({
  agent,
  method = "POST",
  authority = "port4.dev",
  pathName = "/mcp/demo",
  query = "?",
  rawBody = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  created,
  expires,
  nonce = Buffer.from(crypto.randomBytes(32)).toString("base64"),
  tag = "agent-browser-auth",
  components,
  extraHeaders = {},
  alg = "ed25519",
  label = "sig2",
  signatureAgent = '"https://agenticdirectory.visa.com"'
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cTime = created ?? nowSec;
  const eTime = expires ?? cTime + (tag === "agent-browser-auth" ? 60 : 300);
  const baseComps =
    components ??
    (tag === "agent-browser-auth"
      ? ["@method", "@scheme", "@authority", "@path", "@query", "content-digest"]
      : ["@method", "@authority", "@path", "content-digest"]);
  const comps =
    signatureAgent !== null && signatureAgent !== undefined && !baseComps.includes("signature-agent")
      ? [...baseComps, "signature-agent"]
      : [...baseComps];

  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const contentDigest = `sha-256=:${crypto.createHash("sha256").update(bodyBuf).digest("base64")}:`;

  const headers = {
    "content-type": "application/json",
    "content-digest": contentDigest,
    ...(signatureAgent !== null && signatureAgent !== undefined ? { "signature-agent": signatureAgent } : {}),
    ...extraHeaders
  };

  const derived = {
    "@method": method,
    "@scheme": "https",
    "@authority": authority,
    "@path": pathName,
    "@query": query
  };

  const quotedComps = comps.map((c) => `"${c}"`).join(" ");
  const sigParams = `(${quotedComps});created=${cTime};expires=${eTime};keyid="${agent.keyId}";alg="${alg}";nonce="${nonce}";tag="${tag}"`;
  const lines = comps.map((name) => `"${name}": ${name.startsWith("@") ? derived[name] : headers[name]}`);
  lines.push(`"@signature-params": ${sigParams}`);
  const sigBase = lines.join("\n");
  const sigBytes = crypto.sign(null, Buffer.from(sigBase, "utf8"), agent.privateKey);

  headers["signature-input"] = `${label}=${sigParams}`;
  headers["signature"] = `${label}=:${sigBytes.toString("base64")}:`;
  return { headers, rawBody, nonce, contentDigest, sigParams, sigBase };
}

function makeRsaJwksFixture(kid = `kid_${crypto.randomUUID().slice(0, 8)}`) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";

  function signJwt(payload, headerOverrides = {}) {
    const header = { alg: "RS256", typ: "JWT", kid, ...headerOverrides };
    const h = Buffer.from(JSON.stringify(header)).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
    return `${h}.${p}.${sig}`;
  }

  return { kid, jwk, signJwt };
}

function makeEvmPaymentHeader({
  network = "eip155:84532",
  from = "0x1111111111111111111111111111111111111111",
  to,
  value,
  nonce = `0x${crypto.randomBytes(32).toString("hex")}`,
  mode,
  jwtSecret,
  prettyJson = false,
  reverseKeys = false
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  let signature = `0x${"ab".repeat(65)}`;
  if (mode === "port4-sandbox-demo" && jwtSecret) {
    const canonical = `${network}|${from}|${to}|${value}|${nonce}`;
    const mac = crypto.createHmac("sha256", jwtSecret).update(canonical).digest("hex");
    signature = `0x${mac}`;
  }
  const authorization = reverseKeys
    ? {
        nonce,
        validBefore: String(nowSec + 120),
        validAfter: String(nowSec - 10),
        value,
        to,
        from
      }
    : {
        from,
        to,
        value,
        validAfter: String(nowSec - 10),
        validBefore: String(nowSec + 120),
        nonce
      };

  const obj = reverseKeys
    ? {
        payload: {
          ...(mode ? { mode } : {}),
          authorization,
          signature
        },
        network,
        scheme: "exact",
        x402Version: 2
      }
    : {
        x402Version: 2,
        scheme: "exact",
        network,
        payload: {
          ...(mode ? { mode } : {}),
          signature,
          authorization
        }
      };

  const json = prettyJson ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  return Buffer.from(json, "utf8").toString("base64");
}

function makeMppAuthHeader(credentialObj) {
  return `Payment ${Buffer.from(JSON.stringify(credentialObj), "utf8").toString("base64url")}`;
}

function buildTenantRecord(overrides = {}) {
  return {
    id: overrides.id ?? `ten_${crypto.randomUUID().slice(0, 8)}`,
    user_id: overrides.user_id ?? "usr_1",
    subdomain: overrides.subdomain ?? "acme",
    name: overrides.name ?? "Acme API",
    upstream_base_url: overrides.upstream_base_url ?? "https://api.acme.example",
    payout_wallet: overrides.payout_wallet ?? "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    payout_wallets: overrides.payout_wallets ?? [
      {
        network: overrides.network ?? "eip155:84532",
        address: overrides.payout_wallet ?? "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      }
    ],
    network: overrides.network ?? "eip155:84532",
    auth_mode: overrides.auth_mode ?? "x402",
    status: overrides.status ?? "active",
    is_featured: overrides.is_featured ?? 0,
    call_count: overrides.call_count ?? 0,
    settled_call_sequence: overrides.settled_call_sequence ?? 0,
    owner_plan: overrides.owner_plan ?? "free",
    upstream_signing_secret: overrides.upstream_signing_secret ?? "p4_whsec_test_secret_1234",
    upstream_verified: overrides.upstream_verified ?? 1,
    require_upstream_verified: overrides.require_upstream_verified ?? 0,
    require_visa_tap: overrides.require_visa_tap ?? 0,
    allow_tap_simulated: overrides.allow_tap_simulated ?? 0,
    upstream_auth_type: overrides.upstream_auth_type ?? "none",
    upstream_auth_header: overrides.upstream_auth_header ?? null,
    upstream_auth_secret: overrides.upstream_auth_secret ?? null,
    rate_limit_rpm: overrides.rate_limit_rpm ?? 120,
    daily_quota: overrides.daily_quota ?? 10000,
    mcp_mode: overrides.mcp_mode ?? "direct",
    codemode_price_usd: overrides.codemode_price_usd ?? "0.01",
    codemode_max_subcalls: overrides.codemode_max_subcalls ?? 10,
    cf_access_team_domain: overrides.cf_access_team_domain ?? null,
    cf_access_aud: overrides.cf_access_aud ?? null,
    tools: overrides.tools ?? [
      {
        id: "tool_1",
        tenant_id: overrides.id ?? "ten_1",
        name: "quote",
        description: "Get quote",
        http_method: "POST",
        upstream_path: "/v1/quote",
        input_schema_json: '{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}',
        price_usd: "0.002",
        price_atomic: "2000",
        is_active: 1,
        source_type: "rest",
        remote_tool_name: null
      }
    ],
    cached_at: new Date().toISOString()
  };
}

function makeTempoOusdTransferLog(from, to, amountAtomic) {
  const padAddr = (addr) => `0x000000000000000000000000${addr.replace(/^0x/i, "").toLowerCase()}`;
  const amtHex = BigInt(amountAtomic).toString(16).padStart(64, "0");
  return {
    address: mppTempoMod.TEMPO_OUSD_ADDRESS,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      padAddr(from),
      padAddr(to)
    ],
    data: `0x${amtHex}`
  };
}

// ---------------------------------------------------------------------------
// 3. Test Registry & Runner
// ---------------------------------------------------------------------------
const tests = [];
function registerTest(id, feature, tier, metaOrFn, maybeFn) {
  const hasMeta = typeof metaOrFn === "object" && metaOrFn !== null;
  const meta = hasMeta ? metaOrFn : {};
  const fn = hasMeta ? maybeFn : metaOrFn;
  tests.push({
    id,
    feature,
    tier,
    pendingMilestone: meta.pendingMilestone ?? null,
    pendingReason: meta.pendingReason ?? null,
    fn
  });
}

// ===========================================================================
// TIER 1 — Isolated Feature Coverage (F1–F14)
// ===========================================================================

// --- F1: Platform Config & Wrangler Bindings ---
registerTest("T1-F1-01", "F1", 1, async () => {
  const raw = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(stripped);
  assert.equal(cfg.compatibility_date, "2026-11-19");
  assert.ok(Array.isArray(cfg.compatibility_flags) && cfg.compatibility_flags.includes("nodejs_compat"));
  assert.equal(cfg.observability?.enabled, true);
  assert.equal(cfg.observability?.logs?.enabled, true);
  assert.equal(cfg.observability?.traces?.enabled, true);
});

registerTest("T1-F1-02", "F1", 1, async () => {
  const raw = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);
  assert.equal(cfg.assets?.binding, "ASSETS");
  assert.equal(cfg.assets?.run_worker_first, true);
  assert.ok(cfg.worker_loaders?.some((l) => l.binding === "LOADER"));
  const doBindings = cfg.durable_objects?.bindings ?? [];
  assert.ok(doBindings.some((b) => b.name === "EDGE_RATE_LIMITER" && b.class_name === "EdgeRateLimiter"));
  assert.ok(doBindings.some((b) => b.name === "PAYMENT_REPLAY_GUARD" && b.class_name === "PaymentReplayGuard"));
  assert.equal(cfg.exports?.EdgeRateLimiter?.storage, "sqlite");
  assert.equal(cfg.exports?.PaymentReplayGuard?.storage, "sqlite");
  assert.ok(cfg.queues?.producers?.some((p) => p.binding === "METERING_EVENTS"));
});

registerTest("T1-F1-03", "F1", 1, async () => {
  const walkTs = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkTs(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  };
  const files = walkTs(path.join(ROOT, "src"));
  assert.ok(files.length >= 20);
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.equal(/\bBuffer\b/.test(src), false, `Forbidden Buffer reference in ${f}`);
    assert.equal(/from\s+["']node:/.test(src), false, `Forbidden node: import in ${f}`);
    assert.equal(/import\s*\(\s*["']node:/.test(src), false, `Forbidden dynamic node: import in ${f}`);
  }
});

registerTest("T1-F1-04", "F1", 1, async () => {
  if (SKIP_TYPECHECK) return;
  const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tscBin, "--noEmit"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
});

registerTest(
  "T1-F1-05",
  "F1",
  1,
  { pendingMilestone: "M1", pendingReason: "AppBindings/MeteringEvent/AppVariables pending M1 updates" },
  async () => {
    const typesSrc = fs.readFileSync(path.join(ROOT, "src", "types.ts"), "utf8");
    assert.match(typesSrc, /TEMPO_RPC_URL\?\s*:\s*string/);
    assert.match(typesSrc, /X402_MAINNET_FACILITATOR_URL\?\s*:\s*string/);
    assert.match(typesSrc, /VISA_TAP_REGISTRY_URL\?\s*:\s*string/);
    assert.match(typesSrc, /tapAgentId\?\s*:\s*string\s*\|\s*null/);
    assert.match(typesSrc, /mppReceiptHeader|settlementReceiptHeader/);
  }
);

registerTest("T1-F1-06", "F1", 1, async () => {
  const raw = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);
  const hasExports =
    cfg.exports?.EdgeRateLimiter?.type === "durable-object" &&
    cfg.exports?.EdgeRateLimiter?.storage === "sqlite" &&
    cfg.exports?.PaymentReplayGuard?.type === "durable-object" &&
    cfg.exports?.PaymentReplayGuard?.storage === "sqlite";
  const allNewSqlite = (cfg.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
  const hasMigrations =
    allNewSqlite.includes("EdgeRateLimiter") && allNewSqlite.includes("PaymentReplayGuard");
  assert.ok(
    (hasExports && !cfg.migrations) || (!cfg.exports && hasMigrations),
    "wrangler.jsonc must configure SQLite DOs via declarative exports (storage: 'sqlite') OR mutually-exclusive migrations (new_sqlite_classes)"
  );
});

// --- F2: D1 Schema & Migrations ---
registerTest("T1-F2-01", "F2", 1, async () => {
  assert.equal(MIGRATION_SQL_LIST.length, 10);
  const db = new MockD1Database(true);
  try {
    const fk = await db.prepare("PRAGMA foreign_key_check").all();
    assert.equal(fk.results.length, 0);
  } finally {
    db.close();
  }
});

registerTest("T1-F2-02", "F2", 1, async () => {
  const db = new MockD1Database(true);
  try {
    const demo = await db.prepare("SELECT * FROM tenants WHERE subdomain = 'demo'").first();
    assert.equal(demo.id, "ten_port4_sandbox");
    assert.equal(demo.is_featured, 1);
    assert.equal(demo.status, "active");
    assert.equal(demo.upstream_base_url, "internal://sandbox");
    const tools = await db
      .prepare("SELECT name FROM tools WHERE tenant_id = ? AND is_active = 1 ORDER BY name ASC")
      .bind(demo.id)
      .all();
    assert.deepEqual(
      tools.results.map((r) => r.name),
      ["edge_dns_lookup", "market_quote", "ping"]
    );
  } finally {
    db.close();
  }
});

registerTest("T1-F2-03", "F2", 1, async () => {
  const db = new MockD1Database(true);
  try {
    const colsOf = async (table) =>
      new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((r) => r.name));
    const tenantCols = await colsOf("tenants");
    for (const col of [
      "deleted_at",
      "settled_call_sequence",
      "require_visa_tap",
      "allow_tap_simulated",
      "mcp_mode",
      "cf_access_team_domain",
      "cf_access_aud",
      "payout_wallets_json"
    ]) {
      assert.ok(tenantCols.has(col), `tenants missing column ${col}`);
    }
    const txCols = await colsOf("transactions");
    assert.ok(txCols.has("tap_agent_id"));
    assert.ok(txCols.has("is_platform_fee"));
    const toolCols = await colsOf("tools");
    assert.ok(toolCols.has("source_type"));
    assert.ok(toolCols.has("remote_tool_name"));
  } finally {
    db.close();
  }
});

registerTest("T1-F2-04", "F2", 1, async () => {
  const db = new MockD1Database(true);
  try {
    const pme = (await db.prepare("PRAGMA table_info(processed_metering_events)").all()).results;
    const pkCol = pme.find((c) => c.name === "event_id");
    assert.equal(pkCol?.pk, 1);
    const rollups = (await db.prepare("PRAGMA table_info(usage_rollups)").all()).results;
    assert.ok(rollups.some((c) => c.name === "gross_atomic"));
    const pkCols = rollups.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(pkCols, ["tenant_id", "tool_name", "network", "hour_start"]);
  } finally {
    db.close();
  }
});

registerTest("T1-F2-05", "F2", 1, async () => {
  const db = new MockD1Database(true);
  try {
    await db
      .prepare("INSERT INTO revoked_sessions (token_hash, user_id) VALUES (?, ?)")
      .bind("hash_1", "usr_port4_sandbox")
      .run();
    const rev = await db.prepare("SELECT * FROM revoked_sessions WHERE token_hash = ?").bind("hash_1").first();
    assert.equal(rev.user_id, "usr_port4_sandbox");

    await db
      .prepare("INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?)")
      .bind("aud_1", "usr_port4_sandbox", "test.action", "tenant", "ten_port4_sandbox")
      .run();
    const aud = await db.prepare("SELECT * FROM audit_logs WHERE id = ?").bind("aud_1").first();
    assert.equal(aud.action, "test.action");

    const idxs = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()).results.map((r) => r.name);
    assert.ok(idxs.includes("idx_processed_events_tenant"));
    assert.ok(idxs.includes("idx_tenants_verified"));
    assert.ok(idxs.includes("idx_transactions_platform_fee"));
  } finally {
    db.close();
  }
});

// --- F3: Durable Objects & KV Sync ---
registerTest("T1-F3-01", "F3", 1, async () => {
  const h = createHarness();
  try {
    const stub = h.rateLimiter.get(h.rateLimiter.idFromName("rl_test_1"));
    const call = async () =>
      (
        await stub.fetch("https://rl/", {
          method: "POST",
          body: JSON.stringify({ limit: 2, windowSeconds: 60, dailyQuota: 10 })
        })
      ).json();
    const r1 = await call();
    const r2 = await call();
    const r3 = await call();
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 1);
    assert.equal(r1.sequence, 1);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 0);
    assert.equal(r2.sequence, 2);
    assert.equal(r3.allowed, false);
    assert.equal(r3.reason, "rpm_exceeded");
  } finally {
    h.close();
  }
});

registerTest("T1-F3-02", "F3", 1, async () => {
  const h = createHarness();
  try {
    const stub = h.rateLimiter.get(h.rateLimiter.idFromName("fee_seq_test"));
    const next = async () =>
      (
        await stub.fetch("https://rl/", {
          method: "POST",
          body: JSON.stringify({ operation: "next_fee_sequence" })
        })
      ).json();
    assert.equal((await next()).sequence, 1);
    assert.equal((await next()).sequence, 2);
    assert.equal((await next()).sequence, 3);
  } finally {
    h.close();
  }
});

registerTest("T1-F3-03", "F3", 1, async () => {
  const h = createHarness();
  try {
    const stub = h.rateLimiter.get(h.rateLimiter.idFromName("nonce_1"));
    const exp = Math.floor(Date.now() / 1000) + 60;
    const r1 = await (
      await stub.fetch("https://rl/", {
        method: "POST",
        body: JSON.stringify({ operation: "reserve_tap_nonce", expiresEpochSec: exp })
      })
    ).json();
    const r2 = await (
      await stub.fetch("https://rl/", {
        method: "POST",
        body: JSON.stringify({ operation: "reserve_tap_nonce", expiresEpochSec: exp })
      })
    ).json();
    assert.equal(r1.reserved, true);
    assert.equal(r2.reserved, false);
  } finally {
    h.close();
  }
});

registerTest("T1-F3-04", "F3", 1, async () => {
  const h = createHarness();
  try {
    const stub = h.replayGuard.get(h.replayGuard.idFromName("fp_lifecycle"));
    const context = {
      tenantId: "t1",
      toolName: "quote",
      resourceUrl: "https://port4.dev/mcp/acme",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amountAtomic: "1000",
      payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
    };
    const receipt = {
      success: true,
      transaction: "0xtx_1",
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
      errorReason: null,
      mode: "facilitator",
      isPlatformFee: false,
      payTo: context.payTo
    };
    const c1 = await (
      await stub.fetch("https://prg/", {
        method: "POST",
        body: JSON.stringify({ operation: "claim", context, leaseToken: "lease_1" })
      })
    ).json();
    assert.equal(c1.status, "claimed");

    const ms = await (
      await stub.fetch("https://prg/", {
        method: "POST",
        body: JSON.stringify({ operation: "mark_settled", leaseToken: "lease_1", receipt })
      })
    ).json();
    assert.equal(ms.status, "settled_pending_upstream");

    const comp = await (
      await stub.fetch("https://prg/", {
        method: "POST",
        body: JSON.stringify({
          operation: "complete",
          leaseToken: "lease_1",
          receipt,
          responseBody: '{"ok":true}'
        })
      })
    ).json();
    assert.equal(comp.status, "completed");

    const c2 = await (
      await stub.fetch("https://prg/", {
        method: "POST",
        body: JSON.stringify({ operation: "claim", context, leaseToken: "lease_2" })
      })
    ).json();
    assert.equal(c2.status, "completed");
    assert.equal(c2.claimed, false);
    assert.equal(c2.responseBody, '{"ok":true}');
    assert.equal(c2.receipt.transaction, "0xtx_1");
  } finally {
    h.close();
  }
});

registerTest("T1-F3-05", "F3", 1, async () => {
  const h = createHarness();
  try {
    const stub = h.replayGuard.get(h.replayGuard.idFromName("fp_pending"));
    const context = {
      tenantId: "t1",
      toolName: "quote",
      resourceUrl: "https://port4.dev/mcp/acme",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amountAtomic: "1000",
      payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
    };
    const receipt = {
      success: false,
      settlementPending: true,
      transaction: "",
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
      errorReason: "settlement_pending",
      mode: "facilitator",
      isPlatformFee: false,
      payTo: context.payTo
    };
    await stub.fetch("https://prg/", {
      method: "POST",
      body: JSON.stringify({ operation: "claim", context, leaseToken: "lease_1" })
    });
    await stub.fetch("https://prg/", {
      method: "POST",
      body: JSON.stringify({ operation: "mark_settlement_pending", leaseToken: "lease_1", receipt })
    });
    const c2 = await (
      await stub.fetch("https://prg/", {
        method: "POST",
        body: JSON.stringify({ operation: "claim", context, leaseToken: "lease_2" })
      })
    ).json();
    assert.equal(c2.status, "settlement_pending");
    assert.equal(c2.claimed, false);
    assert.equal(c2.receipt.settlementPending, true);
  } finally {
    h.close();
  }
});

registerTest("T1-F3-06", "F3", 1, async () => {
  const h = createHarness();
  try {
    const synced = await kvSyncMod.syncTenantToKv(h.env, "demo");
    assert.equal(synced?.subdomain, "demo");
    assert.ok(await h.kv.get("tenant:demo"));
    const resolved = await kvSyncMod.resolveTenant(h.env, "demo");
    assert.equal(resolved?.id, "ten_port4_sandbox");

    await h.kv.put("demo", "legacy");
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    assert.equal(await h.kv.get("tenant:demo"), null);
    assert.equal(await h.kv.get("demo"), null);
  } finally {
    h.close();
  }
});

// --- F4: Core Router, CORS & OpenAPI Mounts ---
registerTest("T1-F4-01", "F4", 1, async () => {
  const h = createHarness();
  try {
    for (const p of ["/health", "/api/health"]) {
      const res = await h.callApp(`https://port4.dev${p}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.mcpSpec, "2026-07-28");
      assert.equal(body.x402Version, 2);
      assert.equal(typeof body.capabilities?.codemodeLoader, "boolean");
      assert.equal(body.capabilities?.visaTap, true);
      assert.equal(body.capabilities?.tempoMpp, true);
    }
  } finally {
    h.close();
  }
});

registerTest("T1-F4-02", "F4", 1, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp");
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error, "method_not_allowed");
  } finally {
    h.close();
  }
});

registerTest("T1-F4-03", "F4", 1, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "OPTIONS",
      headers: {
        Origin: "https://cursor.sh",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "Signature, Signature-Input, Content-Digest, Signature-Agent, Authorization, PAYMENT-SIGNATURE"
      }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const hdr of [
      "payment-required",
      "payment-response",
      "www-authenticate",
      "payment-receipt",
      "x-port4-tap-agent"
    ]) {
      assert.ok(expose.includes(hdr), `Missing exposed header ${hdr} in ${expose}`);
    }
  } finally {
    h.close();
  }
});

registerTest("T1-F4-04", "F4", 1, async () => {
  const h = createHarness();
  try {
    const r1 = await h.callApp("https://port4.dev/mcp/demo/openapi.json");
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("cache-control"), "public, max-age=300");
    const j1 = await r1.json();
    assert.equal(j1.openapi, "3.1.0");
    assert.equal(j1["x-port4-tenant"]?.subdomain, "demo");

    const r2 = await h.callApp("https://demo.port4.dev/openapi.json");
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.openapi, "3.1.0");
    assert.equal(j2.servers?.[0]?.url, "https://demo.port4.dev");
  } finally {
    h.close();
  }
});

registerTest("T1-F4-05", "F4", 1, async () => {
  const h = createHarness();
  try {
    const localRes = await h.callApp("https://port4.dev/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "X-Port4-Tenant": "demo"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(localRes.status, 200);

    const extRes = await h.callApp("https://port4.dev/mcp", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.5",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "X-Port4-Tenant": "demo"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(extRes.status, 400);
    const extJson = await extRes.json();
    assert.equal(extJson.error, "missing_tenant_subdomain");
  } finally {
    h.close();
  }
});

registerTest("T1-F4-06", "F4", 1, async () => {
  const h = createHarness();
  const savedErr = console.error;
  const capturedErrs = [];
  console.error = (...msgs) => capturedErrs.push(msgs.join(" "));
  try {
    const r404 = await h.callApp("https://port4.dev/api/does-not-exist");
    assert.equal(r404.status, 404);
    const j404 = await r404.json();
    assert.match(j404.message, /Lost on Port5/);

    // Force an unhandled error inside DB to trigger app.onError
    const origPrepare = h.db.prepare.bind(h.db);
    h.db.prepare = () => {
      throw new Error("boom_db_failure");
    };
    const r500 = await h.callApp("https://port4.dev/api/public/featured");
    h.db.prepare = origPrepare;
    assert.equal(r500.status, 500);
    const j500 = await r500.json();
    assert.equal(j500.error, "internal_server_error");
    assert.ok(capturedErrs.some((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.event === "unhandled_worker_error";
      } catch {
        return false;
      }
    }));
  } finally {
    console.error = savedErr;
    h.close();
  }
});

// --- F5: Stateless MCP 2026-07-28 Headers & Rate Limit ---
registerTest("T1-F5-01", "F5", 1, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}"
    });
    assert.equal(res.status, 415);
    const body = await res.json();
    assert.equal(body.error?.code, -32600);
  } finally {
    h.close();
  }
});

registerTest("T1-F5-02", "F5", 1, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2024-11-05"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, -32600);
    assert.equal(body.error?.data?.expected, "2026-07-28");
  } finally {
    h.close();
  }
});

registerTest("T1-F5-03", "F5", 1, async () => {
  const h = createHarness();
  try {
    for (const method of ["initialize", "notifications/initialized"]) {
      const res = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method })
      });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("mcp-session-id"), null);
      const body = await res.json();
      assert.equal(body.error?.code, -32600);
    }
  } finally {
    h.close();
  }
});

registerTest("T1-F5-04", "F5", 1, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: {} }
      })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, -32600);
  } finally {
    h.close();
  }
});

registerTest("T1-F5-05", "F5", 1, async () => {
  assert.equal(schemaMod.isAllowedMcpOrigin(undefined), true);
  assert.equal(schemaMod.isAllowedMcpOrigin("https://cursor.sh"), true);
  for (const bad of [
    "http://127.0.0.1:8080",
    "http://169.254.169.254",
    "http://metadata.internal",
    "http://a.local",
    "http://a.arpa",
    "http://0.0.0.0"
  ]) {
    assert.equal(schemaMod.isAllowedMcpOrigin(bad), false, `Expected ${bad} to be forbidden`);
  }
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:8080",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error?.code, -32600);
  } finally {
    h.close();
  }
});

registerTest("T1-F5-06", "F5", 1, async () => {
  const h = createHarness();
  try {
    await h.db.prepare("UPDATE tenants SET rate_limit_rpm = 2 WHERE subdomain = 'demo'").run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const call = () =>
      h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "198.51.100.77",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
    const r1 = await call();
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("ratelimit-limit"), "2");
    assert.equal(r1.headers.get("ratelimit-remaining"), "1");
    const r2 = await call();
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get("ratelimit-remaining"), "0");
    const r3 = await call();
    assert.equal(r3.status, 429);
    assert.ok(Number(r3.headers.get("retry-after")) >= 1);
    assert.equal((await r3.json()).error, "rpm_exceeded");
  } finally {
    h.close();
  }
});

// --- F6: Visa TAP (RFC 9421 + JKT) ---
registerTest("T1-F6-01", "F6", 1, async () => {
  const verify = visaTapMod.createTapVerifier({
    reserveNonce: async () => true
  });
  const out = await verify({
    method: "POST",
    publicOrigin: "https://port4.dev",
    target: "/mcp/demo",
    headers: { "content-type": "application/json" },
    rawBody: "{}"
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal(out.code, "tap_missing");
  assert.equal(out.reason, "no_signature_headers");
  assert.equal(out.judged, true);
});

registerTest("T1-F6-02", "F6", 1, async () => {
  const h = createHarness();
  try {
    await h.db.prepare("UPDATE tenants SET require_visa_tap = 1 WHERE subdomain = 'demo'").run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const agent = makeEd25519Agent("agt_browser_1");
    const signed = signTapRequest({
      agent,
      authority: "port4.dev",
      pathName: "/mcp/demo",
      tag: "agent-browser-auth"
    });
    let registryCalls = 0;
    await withMockFetch(
      async (url) => {
        if (url.includes("/v1/tap/registry/keys/")) {
          registryCalls += 1;
          return Response.json(agent.listing);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const res = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: signed.headers,
          body: signed.rawBody
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-port4-tap-agent"), "agt_browser_1");
        assert.equal(registryCalls, 1);
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T1-F6-03", "F6", 1, async () => {
  const agent = makeEd25519Agent("agt_payer_1");
  let reserveCalls = 0;
  const nowSec = 1_750_000_000;
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => Response.json(agent.listing),
    reserveNonce: async () => {
      reserveCalls += 1;
      return true;
    }
  });
  const signed = signTapRequest({
    agent,
    authority: "demo.port4.dev",
    pathName: "/mcp",
    tag: "agent-payer-auth",
    created: nowSec,
    expires: nowSec + 480,
    components: ["@method", "@authority", "@path"]
  });
  const out = await verify({
    method: "POST",
    publicOrigin: "https://demo.port4.dev",
    target: "/mcp",
    headers: signed.headers,
    rawBody: signed.rawBody
  });
  assert.equal(out.ok, true);
  assert.equal(out.tag, "agent-payer-auth");
  assert.equal(reserveCalls, 1);
});

registerTest("T1-F6-04", "F6", 1, async () => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const expected = crypto
    .createHash("sha256")
    .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x }))
    .digest("base64url");
  const actual = await visaTapMod.computeEd25519JwkThumbprint(jwk.x);
  assert.equal(actual.length, 43);
  assert.equal(actual, expected);
});

registerTest("T1-F6-05", "F6", 1, async () => {
  const agent = makeEd25519Agent();
  const nowSec = 1_750_000_000;
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => Response.json(agent.listing),
    reserveNonce: async () => true
  });
  const signed = signTapRequest({
    agent,
    created: nowSec,
    expires: nowSec + 60,
    signatureAgent: '"https://evil.example"'
  });
  const out = await verify({
    method: "POST",
    publicOrigin: "https://port4.dev",
    target: "/mcp/demo",
    headers: signed.headers,
    rawBody: signed.rawBody
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal(out.code, "tap_signature_agent_not_accepted");
  assert.equal(out.reason, "signature_agent_not_accepted");
});

registerTest("T1-F6-06", "F6", 1, async () => {
  const nowSec = 1_750_000_000;
  // 404 -> tap_key_unknown
  const a1 = makeEd25519Agent();
  const v404 = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => new Response("Not Found", { status: 404 }),
    reserveNonce: async () => true
  });
  const s1 = signTapRequest({ agent: a1, created: nowSec, expires: nowSec + 60 });
  const o404 = await v404({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: s1.headers, rawBody: s1.rawBody });
  assert.equal(o404.status, 403);
  assert.equal(o404.code, "tap_key_unknown");

  // 500 with Retry-After -> 503 tap_trust_unavailable
  const a2 = makeEd25519Agent();
  const v500 = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => new Response("Down", { status: 500, headers: { "Retry-After": "15" } }),
    reserveNonce: async () => true
  });
  const s2 = signTapRequest({ agent: a2, created: nowSec, expires: nowSec + 60 });
  const o500 = await v500({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: s2.headers, rawBody: s2.rawBody });
  assert.equal(o500.status, 503);
  assert.equal(o500.code, "tap_trust_unavailable");
  assert.equal(o500.judged, false);
  assert.equal(o500.retryAfterSeconds, 15);

  // simulated listing when acceptSimulated=false vs true
  const aSim = makeEd25519Agent("agt_sim", { simulated: true });
  const sSim = signTapRequest({ agent: aSim, created: nowSec, expires: nowSec + 60 });
  const vNoSim = visaTapMod.createTapVerifier({
    now: () => nowSec,
    acceptSimulated: false,
    fetchImpl: async () => Response.json(aSim.listing),
    reserveNonce: async () => true
  });
  const oNoSim = await vNoSim({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: sSim.headers, rawBody: sSim.rawBody });
  assert.equal(oNoSim.status, 403);
  assert.equal(oNoSim.code, "tap_simulated_not_accepted");

  const vYesSim = visaTapMod.createTapVerifier({
    now: () => nowSec,
    acceptSimulated: true,
    fetchImpl: async () => Response.json(aSim.listing),
    reserveNonce: async () => true
  });
  const oYesSim = await vYesSim({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: sSim.headers, rawBody: sSim.rawBody });
  assert.equal(oYesSim.ok, true);
  assert.equal(oYesSim.simulated, true);
});

// --- F7: Cloudflare One Access (x402+oauth_v2) ---
registerTest("T1-F7-01", "F7", 1, async () => {
  assert.equal(cfAccessMod.normalizeAccessTeamDomain("https://myteam.cloudflareaccess.com/cdn-cgi"), "myteam.cloudflareaccess.com");
  assert.equal(cfAccessMod.normalizeAccessTeamDomain("evil.com"), null);
  assert.equal(cfAccessMod.normalizeAccessTeamDomain(""), null);
  assert.equal(cfAccessMod.normalizeAccessTeamDomain("a.b.cloudflareaccess.com"), null);
});

registerTest("T1-F7-02", "F7", 1, async () => {
  const { jwk, signJwt } = makeRsaJwksFixture();
  const team = `t1f702-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt({
    iss: `https://${team}`,
    aud: ["aud_test_1234567890"],
    exp: now + 300,
    nbf: now - 10,
    email: "alice@acme.dev"
  });
  await withMockFetch(
    async () => Response.json({ keys: [jwk] }),
    async () => {
      const res = await cfAccessMod.verifyCloudflareAccessJwt({
        token: jwt,
        teamDomain: team,
        expectedAud: "aud_test_1234567890"
      });
      assert.equal(res.ok, true);
      assert.equal(res.subject, "alice@acme.dev");
    }
  );
});

registerTest("T1-F7-03", "F7", 1, async () => {
  const { jwk, signJwt } = makeRsaJwksFixture();
  const team = `t1f703-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt({
    iss: `https://${team}`,
    aud: "aud_svc_1234567890",
    exp: now + 300,
    common_name: `non_identity@${team}`
  });
  await withMockFetch(
    async () => Response.json({ keys: [jwk] }),
    async () => {
      const res = await cfAccessMod.verifyCloudflareAccessJwt({
        token: jwt,
        teamDomain: team,
        expectedAud: "aud_svc_1234567890"
      });
      assert.equal(res.ok, true);
      assert.equal(res.subject, `non_identity@${team}`);
    }
  );
});

registerTest("T1-F7-04", "F7", 1, async () => {
  const h = createHarness();
  try {
    await h.db
      .prepare(
        "UPDATE tenants SET auth_mode = 'x402+oauth_v2', cf_access_team_domain = 'corp.cloudflareaccess.com', cf_access_aud = 'aud_tag_123456789012' WHERE subdomain = 'demo'"
      )
      .run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: {} }
      })
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error?.code, -32001);
  } finally {
    h.close();
  }
});

registerTest("T1-F7-05", "F7", 1, async () => {
  const { jwk, signJwt } = makeRsaJwksFixture();
  const team = `t1f705-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
  const now = Math.floor(Date.now() / 1000);
  await withMockFetch(
    async () => Response.json({ keys: [jwk] }),
    async () => {
      const wrongIss = await cfAccessMod.verifyCloudflareAccessJwt({
        token: signJwt({ iss: "https://other.cloudflareaccess.com", aud: "aud_1", exp: now + 60 }),
        teamDomain: team,
        expectedAud: "aud_1"
      });
      assert.equal(wrongIss.status, 403);

      const wrongAud = await cfAccessMod.verifyCloudflareAccessJwt({
        token: signJwt({ iss: `https://${team}`, aud: "aud_wrong", exp: now + 60 }),
        teamDomain: team,
        expectedAud: "aud_1"
      });
      assert.equal(wrongAud.status, 403);

      const expired = await cfAccessMod.verifyCloudflareAccessJwt({
        token: signJwt({ iss: `https://${team}`, aud: "aud_1", exp: now - 1 }),
        teamDomain: team,
        expectedAud: "aud_1"
      });
      assert.equal(expired.status, 401);

      const futureNbf = await cfAccessMod.verifyCloudflareAccessJwt({
        token: signJwt({ iss: `https://${team}`, aud: "aud_1", exp: now + 300, nbf: now + 60 }),
        teamDomain: team,
        expectedAud: "aud_1"
      });
      assert.equal(futureNbf.status, 401);

      const wrongAlg = await cfAccessMod.verifyCloudflareAccessJwt({
        token: signJwt({ iss: `https://${team}`, aud: "aud_1", exp: now + 60 }, { alg: "HS256" }),
        teamDomain: team,
        expectedAud: "aud_1"
      });
      assert.equal(wrongAlg.status, 401);
    }
  );
});

// --- F8: x402 v2 Multi-Chain, Fee Split & Metering ---
registerTest("T1-F8-01", "F8", 1, async () => {
  assert.equal(networksMod.SUPPORTED_NETWORKS.length, 12);
  const evmCount = networksMod.SUPPORTED_NETWORKS.filter((n) => n.family === "evm").length;
  const solCount = networksMod.SUPPORTED_NETWORKS.filter((n) => n.family === "solana").length;
  assert.equal(evmCount, 10);
  assert.equal(solCount, 2);
  for (const net of networksMod.SUPPORTED_NETWORKS) {
    assert.equal(networksMod.resolveUsdcAssetForNetwork(net.id, "fallback"), net.usdcAsset);
  }
  assert.equal(
    networksMod.isValidWalletForNetwork("eip155:84532", "0x227c258fF5f873450e0C8ff9dC5C5E355066D1b2"),
    true
  );
  assert.equal(
    networksMod.isValidWalletForNetwork("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    true
  );
  assert.equal(networksMod.isValidWalletForNetwork("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "0x123"), false);
});

registerTest("T1-F8-02", "F8", 1, async () => {
  const h = createHarness();
  try {
    const tenant = buildTenantRecord({
      network: "eip155:84532",
      payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      payout_wallets: [
        { network: "eip155:84532", address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" },
        { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
      ]
    });
    const fakeCtx = { req: { url: "https://acme.port4.dev/mcp" }, env: h.env };
    const { paymentRequired } = x402GateMod.buildPaymentRequired(fakeCtx, tenant, tenant.tools[0], 1);
    assert.equal(paymentRequired.x402Version, 2);
    assert.equal(paymentRequired.accepts.length, 2);
    assert.equal(paymentRequired.accepts[0].scheme, "exact");
    assert.equal(paymentRequired.accepts[0].amount, "2000");
    assert.equal(paymentRequired.accepts[1].network, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    assert.equal(paymentRequired.accepts[1].payTo, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  } finally {
    h.close();
  }
});

registerTest("T1-F8-03", "F8", 1, async () => {
  const h = createHarness();
  try {
    const freeTenant = buildTenantRecord({ owner_plan: "free" });
    assert.equal(x402GateMod.computeFeeSplit(h.env, freeTenant, 32).isPlatformFee, false);
    const feeFree = x402GateMod.computeFeeSplit(h.env, freeTenant, 33);
    assert.equal(feeFree.isPlatformFee, true);
    assert.equal(feeFree.payTo, h.env.PORT4_TREASURY_WALLET);

    const proTenant = buildTenantRecord({ owner_plan: "pro" });
    assert.equal(x402GateMod.computeFeeSplit(h.env, proTenant, 33).isPlatformFee, false);
    const feePro = x402GateMod.computeFeeSplit(h.env, proTenant, 100);
    assert.equal(feePro.isPlatformFee, true);
    assert.equal(feePro.payTo, h.env.PORT4_TREASURY_WALLET);
  } finally {
    h.close();
  }
});

registerTest("T1-F8-04", "F8", 1, async () => {
  const h = createHarness({
    X402_MAINNET_FACILITATOR_URL: "https://mainnet.fac.example/",
    X402_FACILITATOR_API_KEY: "fac_secret_key"
  });
  try {
    const cfg = facilitatorMod.resolveFacilitatorConfig(h.env, "eip155:8453");
    assert.equal(cfg.baseUrl, "https://mainnet.fac.example");
    assert.equal(cfg.isMainnet, true);
    assert.equal(cfg.headers.Authorization, "Bearer fac_secret_key");

    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        if (calls === 1) return new Response("Bad Gateway", { status: 502 });
        return Response.json({ isValid: true });
      },
      async () => {
        const res = await facilitatorMod.fetchFacilitatorVerify(cfg, { test: 1 });
        assert.equal(res.status, 200);
        assert.equal(calls, 2);
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T1-F8-05", "F8", 1, async () => {
  const h = createHarness();
  try {
    const nowIso = new Date().toISOString();
    await h.queue.send({
      id: "tx_m_1",
      tenantId: "ten_port4_sandbox",
      tenantSubdomain: "demo",
      toolName: "market_quote",
      payerWallet: "0x1111111111111111111111111111111111111111",
      amountAtomic: "1000",
      amountUsd: "0.001",
      network: "eip155:84532",
      txHash: "0xabc1",
      latencyMs: 25,
      status: "settled",
      isPlatformFee: false,
      occurredAt: nowIso
    });
    await h.queue.send({
      id: "tx_m_2",
      tenantId: "ten_port4_sandbox",
      tenantSubdomain: "demo",
      toolName: "market_quote",
      payerWallet: "0x1111111111111111111111111111111111111111",
      amountAtomic: "1000",
      amountUsd: "0.001",
      network: "eip155:84532",
      txHash: "0xabc2",
      latencyMs: 35,
      status: "settled",
      isPlatformFee: true,
      occurredAt: nowIso
    });
    const batch1 = h.queue.drainToBatch();
    await meteringMod.consumeMeteringEvents(batch1, h.env);

    // Retry duplicate batch
    await h.queue.send(batch1.messages[0].body);
    await h.queue.send(batch1.messages[1].body);
    await meteringMod.consumeMeteringEvents(h.queue.drainToBatch(), h.env);

    const txCount = await h.db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE id IN ('tx_m_1','tx_m_2')").first("c");
    assert.equal(txCount, 2);
    const rollup = await h.db
      .prepare("SELECT call_count, gross_atomic, platform_fee_call_count FROM usage_rollups WHERE tenant_id = 'ten_port4_sandbox'")
      .first();
    assert.equal(rollup.call_count, 2);
    assert.equal(rollup.gross_atomic, 2000);
    assert.equal(rollup.platform_fee_call_count, 1);
    const tenantRow = await h.db.prepare("SELECT call_count, settled_call_sequence FROM tenants WHERE id = 'ten_port4_sandbox'").first();
    assert.equal(tenantRow.call_count, 2);
    assert.equal(tenantRow.settled_call_sequence, 2);
  } finally {
    h.close();
  }
});

registerTest(
  "T1-F8-06",
  "F8",
  1,
  { pendingMilestone: "M2", pendingReason: "metering.ts does not persist tap_agent_id yet" },
  async () => {
    const h = createHarness();
    try {
      await h.queue.send({
        id: "tx_tap_1",
        tenantId: "ten_port4_sandbox",
        tenantSubdomain: "demo",
        toolName: "market_quote",
        payerWallet: "0x1111111111111111111111111111111111111111",
        amountAtomic: "1000",
        amountUsd: "0.001",
        network: "eip155:84532",
        txHash: "0xtap1",
        latencyMs: 12,
        status: "settled",
        isPlatformFee: false,
        tapAgentId: "tap_agt_123",
        occurredAt: new Date().toISOString()
      });
      await meteringMod.consumeMeteringEvents(h.queue.drainToBatch(), h.env);
      const row = await h.db.prepare("SELECT tap_agent_id FROM transactions WHERE id = 'tx_tap_1'").first();
      assert.equal(row?.tap_agent_id, "tap_agt_123");
    } finally {
      h.close();
    }
  }
);

// --- F9: Tempo OUSD MPP & OpenAPI x-payment-info ---
registerTest("T1-F9-01", "F9", 1, async () => {
  const hdrTest = mppTempoMod.buildMppAuthenticateHeader({
    challengeId: "ch_test",
    realm: "port4.dev",
    amountAtomic: "1000",
    recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    isTestnet: true
  });
  assert.match(hdrTest, /^Payment id="ch_test", realm="port4\.dev", method="tempo", intent="charge", request="/);
  const b64Test = /request="([^"]+)"/.exec(hdrTest)[1];
  const decTest = mppTempoMod.decodeBase64UrlJson(b64Test);
  assert.equal(decTest.currency, mppTempoMod.TEMPO_OUSD_ADDRESS);
  assert.equal(decTest.methodDetails.chainId, 42431);

  const hdrMain = mppTempoMod.buildMppAuthenticateHeader({
    challengeId: "ch_main",
    realm: "port4.dev",
    amountAtomic: "2000",
    recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    isTestnet: false
  });
  const decMain = mppTempoMod.decodeBase64UrlJson(/request="([^"]+)"/.exec(hdrMain)[1]);
  assert.equal(decMain.methodDetails.chainId, 4217);
});

registerTest("T1-F9-02", "F9", 1, async () => {
  const evmTenant = buildTenantRecord();
  assert.equal(mppTempoMod.resolveTempoRecipient(evmTenant, evmTenant.payout_wallet), evmTenant.payout_wallet);

  const solTenant = buildTenantRecord({
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    payout_wallet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payout_wallets: [{ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]
  });
  assert.equal(mppTempoMod.resolveTempoRecipient(solTenant, solTenant.payout_wallet), null);
});

registerTest(
  "T1-F9-03",
  "F9",
  1,
  { pendingMilestone: "M2", pendingReason: "buildTenantOpenApiDocument uses # fragments and ignores mcp_mode" },
  async () => {
    for (const mode of ["direct", "codemode", "openapi_codemode"]) {
      const t = buildTenantRecord({ mcp_mode: mode });
      const doc = mppTempoMod.buildTenantOpenApiDocument(t, "https://acme.port4.dev");
      assert.equal(doc.openapi, "3.1.0");
      const pathKeys = Object.keys(doc.paths);
      assert.ok(pathKeys.length >= 1);
      for (const k of pathKeys) {
        assert.equal(k.includes("#"), false, `OpenAPI path '${k}' must not contain '#'`);
      }
      if (mode === "codemode") {
        assert.ok(JSON.stringify(doc.paths).includes('"code"'));
      }
      if (mode === "openapi_codemode") {
        assert.ok(JSON.stringify(doc.paths).includes('"execute"'));
      }
    }
  }
);

registerTest(
  "T1-F9-04",
  "F9",
  1,
  { pendingMilestone: "M2", pendingReason: "verifyMppPaymentCredential not yet implemented" },
  async () => {
    assert.equal(typeof mppTempoMod.verifyMppPaymentCredential, "function", "verifyMppPaymentCredential must be exported");
    const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
    try {
      await withMockFetch(
        async () =>
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              status: "0x1",
              transactionHash: `0x${"aa".repeat(32)}`,
              logs: [
                makeTempoOusdTransferLog(
                  "0x1111111111111111111111111111111111111111",
                  "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                  "1000"
                )
              ]
            }
          }),
        async () => {
          const authHeader = makeMppAuthHeader({
            challengeId: "ch_tempo_1",
            txHash: `0x${"aa".repeat(32)}`,
            amount: "1000",
            currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
            recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
            chainId: 42431,
            payer: "0x1111111111111111111111111111111111111111"
          });
          const res = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "MCP-Protocol-Version": "2026-07-28",
              Authorization: authHeader
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "market_quote", arguments: { symbol: "ETH-USD" } }
            })
          });
          assert.equal(res.status, 200);
          assert.ok(res.headers.get("payment-receipt"));
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest("T1-F9-05", "F9", 1, async () => {
  const h = createHarness();
  try {
    const rSub = await h.callApp("https://demo.port4.dev/openapi.json");
    assert.equal(rSub.status, 200);
    const jSub = await rSub.json();
    assert.equal(jSub.servers?.[0]?.url, "https://demo.port4.dev");
    assert.equal(jSub["x-port4-tenant"]?.mcp_endpoint, "https://demo.port4.dev/mcp");

    const rPath = await h.callApp("https://port4.dev/mcp/demo/openapi.json");
    assert.equal(rPath.status, 200);
    const jPath = await rPath.json();
    assert.equal(jPath["x-port4-tenant"]?.mcp_endpoint, "https://port4.dev/mcp/demo");

    const r404 = await h.callApp("https://port4.dev/mcp/nonexistent/openapi.json");
    assert.equal(r404.status, 404);
  } finally {
    h.close();
  }
});

// --- F10: Code Mode & MCP Execution ---
registerTest("T1-F10-01", "F10", 1, async () => {
  const cmTenant = buildTenantRecord({ mcp_mode: "codemode" });
  const cmTools = codemodeMod.buildCodeModeMcpTools(cmTenant, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(cmTools.length, 1);
  assert.equal(cmTools[0].name, "code");
  assert.ok(cmTools[0].description.includes("declare const codemode"));

  const oaTenant = buildTenantRecord({ mcp_mode: "openapi_codemode" });
  const oaTools = codemodeMod.buildCodeModeMcpTools(oaTenant, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(oaTools.length, 2);
  assert.equal(oaTools[0].name, "search");
  assert.equal(oaTools[0]._meta?.free, true);
  assert.equal(oaTools[1].name, "execute");
  assert.ok(oaTools[1]._meta?.x402);
});

registerTest("T1-F10-02", "F10", 1, async () => {
  const t = buildTenantRecord({
    tools: [
      { ...buildTenantRecord().tools[0], name: "market_quote", upstream_path: "/quote", description: "FX quote" },
      { ...buildTenantRecord().tools[0], id: "t2", name: "dns_lookup", upstream_path: "/dns", description: "DNS" }
    ]
  });
  const q1 = codemodeMod.searchTenantTools(t, "quote");
  assert.equal(q1.matches[0].name, "market_quote");
  assert.ok(q1.types.includes("market_quote"));
  assert.equal(q1.types.includes("dns_lookup"), false);

  const qEmpty = codemodeMod.searchTenantTools(t, "");
  assert.equal(qEmpty.total, 2);
});

registerTest("T1-F10-03", "F10", 1, async () => {
  const h = createHarness();
  try {
    await h.db.prepare("UPDATE tenants SET mcp_mode = 'openapi_codemode' WHERE subdomain = 'demo'").run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "quote" } }
      })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    const body = await res.json();
    assert.equal(body.result?.isError, false);
    assert.ok(body.result.content[0].text.includes("market_quote"));
  } finally {
    h.close();
  }
});

registerTest("T1-F10-04", "F10", 1, async () => {
  const h = createHarness();
  try {
    const t = buildTenantRecord({ mcp_mode: "codemode", codemode_max_subcalls: 5 });
    let dispatches = 0;
    const out = await codemodeMod.executeCodeModePlan({
      env: h.env,
      tenant: t,
      code: 'async () => { const a = await codemode.quote({ symbol: "ETH" }); const b = await codemode.quote({ symbol: "BTC" }); return { a, b }; }',
      authorizedAtomicBudget: "10000",
      dispatchTool: async (_tool, a) => {
        dispatches += 1;
        return { symbol: a.symbol, ok: true };
      }
    });
    assert.equal(out.ok, true);
    assert.equal(out.subcalls, 2);
    assert.equal(dispatches, 2);
    assert.equal(out.consumedAtomic, "4000");
    assert.equal(h.loader.loadedConfigs[0]?.globalOutbound, null);
  } finally {
    h.close();
  }
});

registerTest("T1-F10-05", "F10", 1, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    // Create REST + MCP tools tenant
    await h.db
      .prepare(
        "INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, upstream_signing_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind("ten_proto", u.id, "proto", "Proto", "https://upstream.example", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "eip155:84532", "p4_whsec_proto")
      .run();
    await h.db
      .prepare(
        "INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, source_type, remote_tool_name) VALUES (?, ?, ?, ?, 'POST', '/mcp', '{}', '0.001', '1000', 'mcp', 'remote_echo')"
      )
      .bind("tl_mcp", "ten_proto", "echo", "MCP echo", )
      .run();
    await h.db
      .prepare(
        "INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, source_type) VALUES (?, ?, ?, ?, 'GET', '/items/{id}', '{}', '0.001', '1000', 'rest')"
      )
      .bind("tl_rest", "ten_proto", "get_item", "REST item")
      .run();

    const payTo = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
    const sawCalls = [];
    await withMockFetch(
      async (url, init) => {
        if (url.endsWith("/verify")) return Response.json({ isValid: true });
        if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"11".repeat(32)}`, network: "eip155:84532" });
        sawCalls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
        if (url === "https://upstream.example/mcp") {
          return Response.json({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: "from_mcp" }] } });
        }
        return Response.json({ item: 42 });
      },
      async () => {
        const sig1 = makeEvmPaymentHeader({ to: payTo, value: "1000" });
        const rMcp = await h.callApp("https://port4.dev/mcp/proto", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig1 },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } })
        });
        assert.equal(rMcp.status, 200);
        const mcpCall = sawCalls.find((c) => c.url === "https://upstream.example/mcp");
        assert.equal(mcpCall.headers["MCP-Protocol-Version"], "2026-07-28");
        assert.equal(mcpCall.headers["Mcp-Method"], "tools/call");
        assert.equal(mcpCall.headers["Mcp-Name"], "remote_echo");

        const sig2 = makeEvmPaymentHeader({ to: payTo, value: "1000" });
        const rRest = await h.callApp("https://port4.dev/mcp/proto", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig2 },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_item", arguments: { id: "99", q: "hi" } } })
        });
        assert.equal(rRest.status, 200);
        const restCall = sawCalls.find((c) => c.url.includes("/items/99"));
        assert.equal(restCall.method, "GET");
        assert.ok(restCall.url.includes("q=hi"));
        assert.ok(restCall.headers["X-Port4-Signature"]?.startsWith("v1="));
      }
    );
  } finally {
    h.close();
  }
});

registerTest(
  "T1-F10-06",
  "F10",
  1,
  { pendingMilestone: "M3", pendingReason: "mcp.ts does not pass tapAgentId into MeteringEvent yet" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare(
          "INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, require_visa_tap) VALUES (?, ?, 'tapcm', 'TapCm', 'https://up.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532', 1)"
        )
        .bind("ten_tap_m3", u.id)
        .run();
      await h.db
        .prepare(
          "INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_tap_1', 'ten_tap_m3', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')"
        )
        .run();

      const agent = makeEd25519Agent("agt_meter_1");
      const rawBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
      const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
      const signed = signTapRequest({
        agent,
        authority: "port4.dev",
        pathName: "/mcp/tapcm",
        rawBody,
        tag: "agent-payer-auth",
        extraHeaders: { "payment-signature": paySig }
      });

      let upHeaders = null;
      await withMockFetch(
        async (url, init) => {
          if (url.includes("/v1/tap/registry/keys/")) return Response.json(agent.listing);
          if (url.endsWith("/verify")) return Response.json({ isValid: true });
          if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"22".repeat(32)}`, network: "eip155:84532" });
          upHeaders = init?.headers;
          return Response.json({ ok: true });
        },
        async () => {
          const res = await h.callApp("https://port4.dev/mcp/tapcm", {
            method: "POST",
            headers: signed.headers,
            body: rawBody
          });
          assert.equal(res.status, 200);
          assert.equal(upHeaders["X-Port4-Tap-Verified"], "true");
          assert.equal(upHeaders["X-Port4-Tap-Agent-Id"], "agt_meter_1");
          assert.equal(h.queue.sent[0]?.tapAgentId, "agt_meter_1");
        }
      );
    } finally {
      h.close();
    }
  }
);

// --- F11: Control Plane, Auth, Admin, Crypto & Sandbox ---
registerTest("T1-F11-01", "F11", 1, async () => {
  const master = "master_secret_for_aes_gcm_testing";
  const enc = await cryptoMod.encryptSecretAtRest("sk_live_vendor_123", master);
  assert.ok(enc.startsWith("enc:v1:"));
  assert.equal(await cryptoMod.decryptSecretAtRest(enc, master), "sk_live_vendor_123");

  const parts = enc.split(":");
  const flippedChar = parts[3][0] === "a" ? "b" : "a";
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${flippedChar}${parts[3].slice(1)}`;
  await assert.rejects(() => cryptoMod.decryptSecretAtRest(tampered, master));

  assert.equal(await cryptoMod.timingSafeEqualString("abc", "abc"), true);
  assert.equal(await cryptoMod.timingSafeEqualString("abc", "abd"), false);
});

registerTest("T1-F11-02", "F11", 1, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    const createRes = await h.callApp("https://port4.dev/api/keys", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CI Key" })
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.ok(created.secret.startsWith("p4_live_"));

    const listRes = await h.callApp("https://port4.dev/api/tenants", {
      headers: { Authorization: `Bearer ${created.secret}` }
    });
    assert.equal(listRes.status, 200);

    const delRes = await h.callApp(`https://port4.dev/api/keys/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${created.secret}` }
    });
    assert.equal(delRes.status, 200);

    const afterRevoke = await h.callApp("https://port4.dev/api/tenants", {
      headers: { Authorization: `Bearer ${created.secret}` }
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    h.close();
  }
});

registerTest("T1-F11-03", "F11", 1, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    const meBefore = await (await h.callApp("https://port4.dev/api/auth/me", { headers: { Cookie: u.cookie } })).json();
    assert.equal(meBefore.authenticated, true);

    const logoutRes = await h.callApp("https://port4.dev/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: u.cookie }
    });
    assert.equal(logoutRes.status, 200);

    const meAfter = await (await h.callApp("https://port4.dev/api/auth/me", { headers: { Cookie: u.cookie } })).json();
    assert.equal(meAfter.authenticated, false);
  } finally {
    h.close();
  }
});

registerTest("T1-F11-04", "F11", 1, async () => {
  const h = createHarness();
  try {
    const nonAdmin = await h.seedUser({ isAdmin: 0 });
    const admin = await h.seedUser({ isAdmin: 1, login: "adminuser" });

    assert.equal((await h.callApp("https://port4.dev/api/admin/stats", { headers: { Cookie: nonAdmin.cookie } })).status, 403);

    // Standard API key belonging to admin user must still be blocked
    const keyRes = await (
      await h.callApp("https://port4.dev/api/keys", {
        method: "POST",
        headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "NonAdminScope" })
      })
    ).json();
    const keyTry = await h.callApp("https://port4.dev/api/admin/stats", {
      headers: { Authorization: `Bearer ${keyRes.secret}` }
    });
    assert.equal(keyTry.status, 403);
    assert.equal((await keyTry.json()).error, "insufficient_api_key_scope");

    const okTry = await h.callApp("https://port4.dev/api/admin/stats", { headers: { Cookie: admin.cookie } });
    assert.equal(okTry.status, 200);
  } finally {
    h.close();
  }
});

registerTest("T1-F11-05", "F11", 1, async () => {
  const h = createHarness();
  try {
    const admin = await h.seedUser({ isAdmin: 1 });
    await kvSyncMod.syncTenantToKv(h.env, "demo");

    const susp = await h.callApp("https://port4.dev/api/admin/tenants/demo/status", {
      method: "PATCH",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" })
    });
    assert.equal(susp.status, 200);
    assert.equal(await h.kv.get("tenant:demo"), null);

    const act = await h.callApp("https://port4.dev/api/admin/tenants/demo/status", {
      method: "PATCH",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" })
    });
    assert.equal(act.status, 200);
    assert.ok(await h.kv.get("tenant:demo"));

    const planRes = await h.callApp("https://port4.dev/api/admin/users/usr_port4_sandbox/plan", {
      method: "PATCH",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" })
    });
    assert.equal(planRes.status, 200);
    assert.equal((await planRes.json()).fee_rate_pct, 1);
  } finally {
    h.close();
  }
});

registerTest("T1-F11-06", "F11", 1, async () => {
  const h = createHarness();
  try {
    const runRes = await h.callApp("https://port4.dev/api/sandbox/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "market_quote", arguments: { symbol: "ETH-USD" } })
    });
    assert.equal(runRes.status, 200);
    const runJson = await runRes.json();
    assert.equal(runJson.ok, true);
    assert.equal(runJson.simulated, true);
    assert.equal(runJson.basescanUrl, null);
    assert.equal(runJson.step1_402?.status, 402);
    assert.equal(runJson.step3_200?.status, 200);

    const nonAdmin = await h.seedUser({ isAdmin: 0 });
    const admin = await h.seedUser({ isAdmin: 1 });
    const signForbidden = await h.callApp("https://port4.dev/api/sandbox/sign", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: nonAdmin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentRequiredHeader: runJson.step1_402.paymentRequiredHeader })
    });
    assert.equal(signForbidden.status, 403);

    const signOk = await h.callApp("https://port4.dev/api/sandbox/sign", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentRequiredHeader: runJson.step1_402.paymentRequiredHeader })
    });
    assert.equal(signOk.status, 200);
    assert.ok((await signOk.json()).paymentSignatureHeader);
  } finally {
    h.close();
  }
});

// --- F12: Frontend UI (web/) ---
registerTest("T1-F12-01", "F12", 1, async () => {
  const css = fs.readFileSync(path.join(ROOT, "web", "src", "styles", "theme.css"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  assert.match(css, /--cf-bg:\s*#fafafa/i);
  assert.match(css, /--cf-surface:\s*#ffffff/i);
  assert.match(css, /--cf-orange:\s*#f6821f/i);
  assert.match(html, /theme-color"\s+content="#FAFAFA"/i);
  assert.match(html, /bg-\[#FAFAFA\]/i);
});

registerTest("T1-F12-02", "F12", 1, async () => {
  const appSrc = fs.readFileSync(path.join(ROOT, "web", "src", "App.tsx"), "utf8");
  assert.match(appSrc, /Turn any API into/);
  assert.match(appSrc, /Paid MCP\./);
  assert.match(appSrc, /step="01"/);
  assert.match(appSrc, /step="02"/);
  assert.match(appSrc, /step="03"/);
  assert.match(appSrc, /Get Started/);
  assert.match(appSrc, /Read Docs/);
});

registerTest("T1-F12-03", "F12", 1, async () => {
  const docsSrc = fs.readFileSync(path.join(ROOT, "web", "src", "components", "Docs.tsx"), "utf8");
  const headings = [...docsSrc.matchAll(/<h2[^>]*>\s*(\d+)\./g)].map((m) => Number(m[1]));
  assert.ok(headings.length >= 5);
  const expected = headings.map((_, i) => i + 1);
  assert.deepEqual(headings, expected, `Headings must be sequential without duplicates; got ${JSON.stringify(headings)}`);
});

registerTest("T1-F12-04", "F12", 1, async () => {
  const backendIds = networksMod.SUPPORTED_NETWORKS.map((n) => ({ id: n.id, family: n.family }));
  const frontendIds = walletsWebMod.NETWORK_OPTIONS.map((n) => ({ id: n.id, family: n.family }));
  assert.deepEqual(frontendIds, backendIds);
});

registerTest("T1-F12-05", "F12", 1, async () => {
  const sbx = fs.readFileSync(path.join(ROOT, "web", "src", "components", "Sandbox.tsx"), "utf8");
  const rev = fs.readFileSync(path.join(ROOT, "web", "src", "components", "RevenueTable.tsx"), "utf8");
  const adm = fs.readFileSync(path.join(ROOT, "web", "src", "components", "AdminDashboard.tsx"), "utf8");
  assert.match(sbx, /Simulated Off-Chain Receipt/);
  assert.match(rev, /tx\.explorer_url/);
  assert.match(rev, /\(sim\)/);
  assert.match(adm, /explorer_url|basescan_url/);
  assert.equal(sbx.includes("sepolia.basescan.org"), false);
  assert.equal(rev.includes("sepolia.basescan.org"), false);
});

// --- F13: CLI & npm Package ---
registerTest("T1-F13-01", "F13", 1, async () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "cli", "port4-mcp.mjs"), "--self-test"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.match(out, /PASS: Port4 STDIO MCP Bridge self-test/);
});

registerTest("T1-F13-02", "F13", 1, async () => {
  const modUrl = pathToFileURL(path.join(ROOT, "packages", "port4-mcp", "bin", "port4-mcp.mjs")).href;
  const code = `
    import assert from "node:assert/strict";
    import { handleLocalMcpLifecycle } from ${JSON.stringify(modUrl)};
    const init = handleLocalMcpLifecycle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
    assert.equal(init.result.serverInfo.name, "port4-mcp-bridge");
    assert.equal(init.result.protocolVersion, "2026-07-28");
    assert.equal(handleLocalMcpLifecycle({ jsonrpc: "2.0", method: "notifications/initialized" }), "IGNORE_NOTIFICATION");
    assert.equal(handleLocalMcpLifecycle({ jsonrpc: "2.0", method: "notifications/cancelled" }), "IGNORE_NOTIFICATION");
    assert.deepEqual(handleLocalMcpLifecycle({ jsonrpc: "2.0", id: 2, method: "ping" }), { jsonrpc: "2.0", id: 2, result: {} });
    assert.equal(handleLocalMcpLifecycle({ jsonrpc: "2.0", id: 3, method: "tools/list" }), null);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, input: "", encoding: "utf8" });
});

registerTest("T1-F13-03", "F13", 1, async () => {
  const modUrl = pathToFileURL(path.join(ROOT, "packages", "port4-mcp", "bin", "port4-mcp.mjs")).href;
  const code = `
    import assert from "node:assert/strict";
    import { Port4BudgetGuard } from ${JSON.stringify(modUrl)};
    const g = new Port4BudgetGuard(0.05, 0.12);
    assert.equal(g.checkAndReserve("0.04").allowed, true);
    assert.equal(g.checkAndReserve("0.06").allowed, false);
    assert.equal(g.checkAndReserve("0.05").allowed, true);
    assert.equal(g.checkAndReserve("0.04").allowed, false);
    assert.equal(g.checkAndReserve("-1").allowed, false);
    assert.equal(g.checkAndReserve("abc").allowed, false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, input: "", encoding: "utf8" });
});

registerTest("T1-F13-04", "F13", 1, async () => {
  const seenHeaders = [];
  const srv = http.createServer((req, res) => {
    seenHeaders.push(req.headers);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "cli", "port4-mcp.mjs"), "--url", `http://127.0.0.1:${port}/mcp/demo`],
    {
      cwd: ROOT,
      env: { ...process.env, CF_ACCESS_CLIENT_ID: "cid_1", CF_ACCESS_CLIENT_SECRET: "csec_1" },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  try {
    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    const nextLine = () => new Promise((resolve) => rl.once("line", (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    const r1 = await nextLine();
    assert.equal(r1.result.ok, true);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } }) + "\n"
    );
    await nextLine();
    rl.close();
    assert.equal(seenHeaders[0]["mcp-protocol-version"], "2026-07-28");
    assert.equal(seenHeaders[0]["mcp-method"], "tools/list");
    assert.equal(seenHeaders[0]["cf-access-client-id"], "cid_1");
    assert.equal(seenHeaders[1]["mcp-name"], "ping");
  } finally {
    child.stdin.end();
    child.kill();
    srv.close();
  }
});

registerTest("T1-F13-05", "F13", 1, async () => {
  const { trySignWithEvmPrivateKey } = await import(
    pathToFileURL(path.join(ROOT, "packages", "port4-mcp", "bin", "port4-mcp.mjs")).href
  );
  let calledV2 = false;
  const fakeReq = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    extra: { name: "USD Coin", version: "2" }
  };
  const signed = await trySignWithEvmPrivateKey(
    `0x${"11".repeat(32)}`,
    { x402Version: 2, accepts: [fakeReq] },
    fakeReq,
    {
      viemAccounts: {
        privateKeyToAccount: () => ({ address: "0x2222222222222222222222222222222222222222" })
      },
      x402Evm: {
        toClientEvmSigner: (a) => a,
        ExactEvmScheme: class {
          async createPaymentPayload(ver, req) {
            calledV2 = ver === 2 && req.network === "eip155:84532";
            return { x402Version: 2, payload: { signature: "0xsig" } };
          }
        }
      }
    }
  );
  assert.equal(calledV2, true);
  assert.equal(signed.ok, true);
});

// --- F14: E2E / Conformance Suite & Local Verification ---
registerTest("T1-F14-01", "F14", 1, async () => {
  assert.equal(typeof workerEntry.fetch, "function");
  assert.equal(typeof workerEntry.queue, "function");
  assert.equal(typeof EdgeRateLimiter, "function");
  assert.equal(typeof PaymentReplayGuard, "function");
  assert.equal(typeof visaTapMod.createTapVerifier, "function");
});

registerTest("T1-F14-02", "F14", 1, async () => {
  if (SKIP_TYPECHECK) return;
  const webTsc = path.join(ROOT, "web", "node_modules", "typescript", "bin", "tsc");
  if (fs.existsSync(webTsc)) {
    execFileSync(process.execPath, [webTsc, "--noEmit"], {
      cwd: path.join(ROOT, "web"),
      encoding: "utf8",
      stdio: "pipe"
    });
  } else {
    execFileSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "web", "tsconfig.json"), "--noEmit"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe"
    });
  }
});

registerTest("T1-F14-03", "F14", 1, async () => {
  assert.ok(fs.existsSync(path.join(ROOT, "dist", "index.html")), "dist/index.html must exist (run npm run build)");
});

registerTest("T1-F14-04", "F14", 1, async () => {
  assert.equal(MIGRATION_FILES[0], "0001_init.sql");
  assert.equal(MIGRATION_FILES[MIGRATION_FILES.length - 1], "0010_ops_billing_and_hygiene.sql");
});

registerTest("T1-F14-05", "F14", 1, async () => {
  const localE2e = fs.readFileSync(path.join(ROOT, "scripts", "test-local-e2e.mjs"), "utf8");
  assert.match(localE2e, /wrangler\.js/);
  assert.match(localE2e, /--local/);
  assert.match(localE2e, /--persist-to/);
});

// ===========================================================================
// TIER 2 — Boundary & Corner Cases (F1–F14)
// ===========================================================================

// --- F1 Edge Cases ---
registerTest("T2-F1-01", "F1", 2, async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const varKeys = Object.keys(cfg.vars ?? {});
  for (const secretName of ["JWT_SECRET", "GITHUB_CLIENT_SECRET", "DEMO_PAYER_PRIVATE_KEY", "X402_FACILITATOR_API_KEY"]) {
    assert.equal(varKeys.includes(secretName), false, `Secret ${secretName} must never appear in wrangler.jsonc vars`);
  }
});

registerTest(
  "T2-F1-02",
  "F1",
  2,
  { pendingMilestone: "M1", pendingReason: "Check all c.env.* reads declared on AppBindings/CloudflareBindings" },
  async () => {
    const typesSrc = fs.readFileSync(path.join(ROOT, "src", "types.ts"), "utf8");
    const workerCfgDts = fs.readFileSync(path.join(ROOT, "worker-configuration.d.ts"), "utf8");
    const combinedDecl = `${typesSrc}\n${workerCfgDts}`;
    const walkTs = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkTs(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const envNames = new Set();
    for (const f of walkTs(path.join(ROOT, "src"))) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bc\.env\.([A-Z][A-Z0-9_]+)\b/g)) {
        envNames.add(m[1]);
      }
    }
    for (const name of envNames) {
      assert.ok(new RegExp(`\\b${name}\\??:`).test(combinedDecl), `Binding '${name}' missing from AppBindings/CloudflareBindings`);
    }
  }
);

registerTest("T2-F1-03", "F1", 2, async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.ok(cfg.routes?.some((r) => r.pattern === "port4.dev" && r.custom_domain === true));
  assert.ok(cfg.routes?.some((r) => r.pattern === "*.port4.dev/*" && r.zone_name === "port4.dev"));
});

registerTest("T2-F1-04", "F1", 2, async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(cfg.observability?.traces?.enabled, true);
});

registerTest("T2-F1-05", "F1", 2, async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const indexSrc = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  for (const b of cfg.durable_objects?.bindings ?? []) {
    assert.ok(indexSrc.includes(b.class_name), `src/index.ts must export DO class ${b.class_name}`);
    assert.equal(cfg.exports?.[b.class_name]?.type, "durable-object");
    assert.equal(cfg.exports?.[b.class_name]?.storage, "sqlite");
  }
});

// --- F2 Edge Cases ---
registerTest("T2-F2-01", "F2", 2, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    await h.db
      .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet) VALUES ('ten_s', ?, 'soft', 'Soft', 'https://a.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e')")
      .bind(u.id)
      .run();
    await h.db
      .prepare("INSERT INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status) VALUES ('tx_s1', 'ten_s', 't', '0x1111111111111111111111111111111111111111', '1000', '0.001', 'eip155:84532', '0x1', 'settled')")
      .run();
    const del = await h.callApp("https://port4.dev/api/tenants/ten_s", {
      method: "DELETE",
      headers: { Origin: "https://port4.dev", Cookie: u.cookie }
    });
    assert.equal(del.status, 200);
    assert.equal(await h.db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE tenant_id = 'ten_s'").first("c"), 1);
  } finally {
    h.close();
  }
});

registerTest("T2-F2-02", "F2", 2, async () => {
  const db = new MockD1Database(true);
  try {
    await assert.rejects(() =>
      db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, upstream_path) VALUES ('dup_1', 'ten_port4_sandbox', 'market_quote', 'dup', '/q')")
        .run()
    );
  } finally {
    db.close();
  }
});

registerTest("T2-F2-03", "F2", 2, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    const res1 = await h.callApp("https://port4.dev/api/tenants", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: "reclaim",
        name: "Reclaim",
        upstream_base_url: "https://api.reclaim.example",
        payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      })
    });
    const t1 = (await res1.json()).tenant;
    await h.callApp(`https://port4.dev/api/tenants/${t1.id}`, {
      method: "DELETE",
      headers: { Origin: "https://port4.dev", Cookie: u.cookie }
    });
    const res2 = await h.callApp("https://port4.dev/api/tenants", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: "reclaim",
        name: "Reclaim2",
        upstream_base_url: "https://api.reclaim.example",
        payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      })
    });
    assert.equal(res2.status, 201);
  } finally {
    h.close();
  }
});

registerTest("T2-F2-04", "F2", 2, async () => {
  const db = new MockD1Database(true);
  try {
    await assert.rejects(() =>
      db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, upstream_path) VALUES ('orph_1', 'no_such_tenant', 'x', 'x', '/x')")
        .run()
    );
  } finally {
    db.close();
  }
});

registerTest("T2-F2-05", "F2", 2, async () => {
  const db = new MockD1Database(true);
  try {
    await db
      .prepare("INSERT INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status, tap_agent_id) VALUES ('tx_n1', 'ten_port4_sandbox', 'ping', '0x1111111111111111111111111111111111111111', '1000', '0.001', 'eip155:84532', '0x1', 'settled', NULL)")
      .run();
    await db
      .prepare("INSERT INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status, tap_agent_id) VALUES ('tx_n2', 'ten_port4_sandbox', 'ping', '0x1111111111111111111111111111111111111111', '1000', '0.001', 'eip155:84532', '0x2', 'settled', 'agt_ok')")
      .run();
    assert.equal(await db.prepare("SELECT tap_agent_id FROM transactions WHERE id = 'tx_n1'").first("tap_agent_id"), null);
    assert.equal(await db.prepare("SELECT tap_agent_id FROM transactions WHERE id = 'tx_n2'").first("tap_agent_id"), "agt_ok");
  } finally {
    db.close();
  }
});

// --- F3 Edge Cases ---
registerTest(
  "T2-F3-01",
  "F3",
  2,
  { pendingMilestone: "M1", pendingReason: "EdgeRateLimiter.alarm() does not delete tap_nonce_until" },
  async () => {
    const h = createHarness();
    try {
      const id = h.rateLimiter.idFromName("tap_alarm_key");
      const stub = h.rateLimiter.get(id);
      const t0 = 1_750_000_000_000;
      await withFixedNow(t0, async () => {
        await stub.fetch("https://rl/", {
          method: "POST",
          body: JSON.stringify({ operation: "reserve_tap_nonce", expiresEpochSec: Math.floor(t0 / 1000) + 10 })
        });
        await stub.fetch("https://rl/", {
          method: "POST",
          body: JSON.stringify({ operation: "next_fee_sequence" })
        });
      });
      await withFixedNow(t0 + 20_000, async () => {
        await h.rateLimiter.triggerAlarm(id);
      });
      const raw = h.rateLimiter.rawStorage(id);
      assert.equal(raw.has("tap_nonce_until"), false, "alarm() must delete expired tap_nonce_until");
      assert.equal(raw.get("paid_sequence"), 1, "alarm() must preserve paid_sequence");
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F3-02", "F3", 2, async () => {
  const h = createHarness();
  try {
    const id = h.replayGuard.idFromName("fp_lease_race");
    const stub = h.replayGuard.get(id);
    const context = {
      tenantId: "t1",
      toolName: "quote",
      resourceUrl: "https://port4.dev/mcp/acme",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amountAtomic: "1000",
      payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
    };
    const receipt = {
      success: true,
      transaction: "0xtx_race",
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
      errorReason: null,
      mode: "facilitator",
      isPlatformFee: false,
      payTo: context.payTo
    };
    const t0 = 1_750_000_000_000;
    await withFixedNow(t0, async () => {
      await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context, leaseToken: "L1" }) });
      await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "mark_settled", leaseToken: "L1", receipt }) });
    });
    await withFixedNow(t0 + 1_000, async () => {
      // While L1 is still executing upstream within IN_FLIGHT_LEASE_MS, concurrent claim gets in_flight
      const whileExecuting = await (
        await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context, leaseToken: "L2" }) })
      ).json();
      assert.equal(whileExecuting.status, "in_flight");
      assert.equal(whileExecuting.claimed, false);

      // Explicit mark_upstream_failed clears lease for immediate retry_upstream
      await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "mark_upstream_failed", leaseToken: "L1" }) });
      const retry1 = await (
        await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context, leaseToken: "L2" }) })
      ).json();
      assert.equal(retry1.status, "retry_upstream");
      assert.equal(retry1.claimed, true);

      const concurrent = await (
        await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context, leaseToken: "L3" }) })
      ).json();
      assert.equal(concurrent.status, "in_flight");
      assert.equal(concurrent.claimed, false);
    });
    await withFixedNow(t0 + 65_000, async () => {
      const afterExpiry = await (
        await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context, leaseToken: "L4" }) })
      ).json();
      assert.equal(afterExpiry.status, "retry_upstream");
      assert.equal(afterExpiry.claimed, true);
    });
  } finally {
    h.close();
  }
});

registerTest("T2-F3-03", "F3", 2, async () => {
  const h = createHarness();
  try {
    const stub = h.replayGuard.get(h.replayGuard.idFromName("fp_ctx_mismatch"));
    const ctxA = {
      tenantId: "t1",
      toolName: "ping",
      resourceUrl: "https://port4.dev/mcp/a",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amountAtomic: "1000",
      payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
    };
    await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context: ctxA, leaseToken: "L1" }) });
    const crossTenant = await (
      await stub.fetch("https://prg/", {
        method: "POST",
        body: JSON.stringify({ operation: "claim", context: { ...ctxA, tenantId: "t2" }, leaseToken: "L2" })
      })
    ).json();
    assert.equal(crossTenant.status, "context_mismatch");
    assert.equal(crossTenant.claimed, false);
  } finally {
    h.close();
  }
});

registerTest("T2-F3-04", "F3", 2, async () => {
  const h = createHarness();
  try {
    const stub = h.replayGuard.get(h.replayGuard.idFromName("fp_fencing"));
    const context = {
      tenantId: "t1",
      toolName: "ping",
      resourceUrl: "https://port4.dev/mcp/a",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amountAtomic: "1000",
      payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
    };
    const receipt = {
      success: true,
      transaction: "0xtx_fence",
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
      errorReason: null,
      mode: "facilitator",
      isPlatformFee: false,
      payTo: context.payTo
    };
    await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "claim", context, leaseToken: "L1" }) });
    const badMark = await stub.fetch("https://prg/", {
      method: "POST",
      body: JSON.stringify({ operation: "mark_settled", leaseToken: "WRONG", receipt })
    });
    assert.equal(badMark.status, 409);
    await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "mark_settled", leaseToken: "L1", receipt }) });
    const badRel = await (
      await stub.fetch("https://prg/", { method: "POST", body: JSON.stringify({ operation: "release", leaseToken: "L1" }) })
    ).json();
    assert.equal(badRel.released, false);
  } finally {
    h.close();
  }
});

registerTest("T2-F3-05", "F3", 2, async () => {
  const h = createHarness();
  try {
    const stub = h.rateLimiter.get(h.rateLimiter.idFromName("rl_quota"));
    await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify({ limit: 100, windowSeconds: 60, dailyQuota: 2 }) });
    await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify({ limit: 100, windowSeconds: 60, dailyQuota: 2 }) });
    const r3 = await (await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify({ limit: 100, windowSeconds: 60, dailyQuota: 2 }) })).json();
    assert.equal(r3.allowed, false);
    assert.equal(r3.reason, "daily_quota_exceeded");

    assert.equal((await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify({ limit: 0 }) })).status, 400);
    assert.equal((await stub.fetch("https://rl/", { method: "POST", body: JSON.stringify({ windowSeconds: 9999 }) })).status, 400);
  } finally {
    h.close();
  }
});

registerTest(
  "T2-F3-06",
  "F3",
  2,
  { pendingMilestone: "M1", pendingReason: "syncUserTenantsToKv lacks AND deleted_at IS NULL filter" },
  async () => {
    const kvSyncSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "kv-sync.ts"), "utf8");
    const fnMatch = /async function syncUserTenantsToKv[\s\S]*?\n\}/.exec(kvSyncSrc);
    assert.ok(fnMatch && /deleted_at\s+IS\s+NULL/i.test(fnMatch[0]), "syncUserTenantsToKv SQL must filter deleted_at IS NULL");
  }
);

// --- F4 Edge Cases ---
registerTest("T2-F4-01", "F4", 2, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://demo.port4.dev/", {
      headers: { Host: "evil.port4.dev", "X-Forwarded-Host": "attacker.com" }
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.tenant, "demo");
  } finally {
    h.close();
  }
});

registerTest(
  "T2-F4-02",
  "F4",
  2,
  { pendingMilestone: "M1", pendingReason: "GET /mcp/:tenant and GET /sandbox/mcp currently fall through to ASSETS" },
  async () => {
    const h = createHarness();
    try {
      const r1 = await h.callApp("https://port4.dev/mcp/demo");
      assert.equal(r1.status, 405);
      const r2 = await h.callApp("https://port4.dev/sandbox/mcp");
      assert.equal(r2.status, 405);
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F4-03",
  "F4",
  2,
  { pendingMilestone: "M1", pendingReason: "/sandbox/* CORS missing Authorization/TAP/MPP headers" },
  async () => {
    const h = createHarness();
    try {
      const res = await h.callApp("https://port4.dev/sandbox/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://cursor.sh", "Access-Control-Request-Method": "POST" }
      });
      const allow = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
      assert.ok(allow.includes("authorization"));
      assert.ok(allow.includes("signature-input"));
      assert.ok(expose.includes("www-authenticate"));
      assert.ok(expose.includes("payment-receipt"));
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F4-04",
  "F4",
  2,
  { pendingMilestone: "M1", pendingReason: "isLocalDev does not recognize ::ffff:127.0.0.1" },
  async () => {
    const h = createHarness();
    try {
      const localRes = await h.callApp("https://port4.dev/mcp", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "::ffff:127.0.0.1",
          "X-Port4-Tenant": "demo",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      assert.equal(localRes.status, 200);
      const extRes = await h.callApp("https://port4.dev/mcp", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "1.2.3.4",
          "X-Port4-Tenant": "demo",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      assert.equal(extRes.status, 400);
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F4-05", "F4", 2, async () => {
  const h = createHarness();
  try {
    const wwwRes = await h.callApp("https://www.port4.dev/");
    assert.equal(wwwRes.status, 200);
    assert.match(await wwwRes.text(), /Port4 SPA/);

    const acmeRes = await h.callApp("https://acme.port4.dev/");
    assert.equal(acmeRes.status, 200);
    const acmeJson = await acmeRes.json();
    assert.equal(acmeJson.tenant, "acme");
    assert.equal(acmeJson.mcp_endpoint, "https://acme.port4.dev/mcp");
  } finally {
    h.close();
  }
});

// --- F5 Edge Cases ---
registerTest(
  "T2-F5-01",
  "F5",
  2,
  { pendingMilestone: "M2", pendingReason: "mcpHeadersMiddleware buffers full body via c.req.text() before byte cap" },
  async () => {
    const h = createHarness();
    try {
      let chunksDelivered = 0;
      const hugeStream = new ReadableStream({
        pull(controller) {
          chunksDelivered += 1;
          if (chunksDelivered > 20) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode("a".repeat(8192)));
        }
      });
      const req = new Request("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
        body: hugeStream,
        duplex: "half"
      });
      const res = await h.callApp(req);
      assert.equal(res.status, 413);
      assert.ok(chunksDelivered < 15, `Stream must abort early around 64 KiB, but read ${chunksDelivered} chunks`);
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F5-02", "F5", 2, async () => {
  const h = createHarness();
  try {
    const base = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"';
    const suffix = '"}}';
    const exactPadLen = 65536 - base.length - suffix.length;
    const okBody = `${base}${"a".repeat(exactPadLen)}${suffix}`;
    assert.equal(Buffer.byteLength(okBody, "utf8"), 65536);

    const rOk = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: okBody
    });
    assert.equal(rOk.status, 200);

    const overBody = `${base}${"a".repeat(exactPadLen + 1)}${suffix}`;
    assert.equal(Buffer.byteLength(overBody, "utf8"), 65537);
    const r413 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: overBody
    });
    assert.equal(r413.status, 413);
  } finally {
    h.close();
  }
});

registerTest("T2-F5-03", "F5", 2, async () => {
  const h = createHarness();
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "€".repeat(30000) } });
    assert.ok(body.length < 65536);
    assert.ok(Buffer.byteLength(body, "utf8") > 65536);
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body
    });
    assert.equal(res.status, 413);
  } finally {
    h.close();
  }
});

registerTest("T2-F5-04", "F5", 2, async () => {
  const h = createHarness();
  try {
    for (const meta of [["bad"], "str"]) {
      const res = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", _meta: meta } })
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error?.code, -32602);
    }
  } finally {
    h.close();
  }
});

registerTest("T2-F5-05", "F5", 2, async () => {
  const h = createHarness();
  try {
    const rMissingName = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })
    });
    assert.equal(rMissingName.status, 400);
    assert.equal((await rMissingName.json()).error?.code, -32602);

    const rMismatch = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Name": "other" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
    });
    assert.equal(rMismatch.status, 400);
    assert.equal((await rMismatch.json()).error?.code, -32600);
  } finally {
    h.close();
  }
});

registerTest("T2-F5-06", "F5", 2, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Session-Id": "sess_123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.equal(schemaMod.isAllowedMcpOrigin("not a url"), false);
    assert.equal(schemaMod.isAllowedMcpOrigin("ftp://port4.dev"), false);
  } finally {
    h.close();
  }
});

// --- F6 Edge Cases (Visa TAP) ---
registerTest(
  "T2-F6-01",
  "F6",
  2,
  { pendingMilestone: "M2", pendingReason: "TRANSPORT_HEADERS currently bypasses credential_header_present" },
  async () => {
    const agent = makeEd25519Agent();
    const nowSec = 1_750_000_000;
    const verify = visaTapMod.createTapVerifier({
      now: () => nowSec,
      fetchImpl: async () => Response.json(agent.listing),
      reserveNonce: async () => true
    });
    for (const hdr of [
      { authorization: "Bearer x" },
      { "payment-signature": "y" },
      { cookie: "a=b" },
      { "x-payment": "z" }
    ]) {
      const signed = signTapRequest({
        agent,
        created: nowSec,
        expires: nowSec + 60,
        tag: "agent-browser-auth",
        extraHeaders: hdr
      });
      const out = await verify({
        method: "POST",
        publicOrigin: "https://port4.dev",
        target: "/mcp/demo",
        headers: signed.headers,
        rawBody: signed.rawBody
      });
      assert.equal(out.ok, false);
      assert.equal(out.status, 403);
      assert.equal(out.code, "tap_malformed");
      assert.equal(out.reason, "credential_header_present");
    }
  }
);

registerTest(
  "T2-F6-02",
  "F6",
  2,
  { pendingMilestone: "M2", pendingReason: "visa-tap.ts normalTarget does not reject double-slash '/mcp//demo' in path" },
  async () => {
    const agent = makeEd25519Agent();
    const nowSec = 1_750_000_000;
    const verify = visaTapMod.createTapVerifier({
      now: () => nowSec,
      fetchImpl: async () => Response.json(agent.listing),
      reserveNonce: async () => true
    });
    for (const target of ["/mcp/../admin", "/mcp//demo", "/mcp/%2e/demo", "/mcp/%2f/demo", "/mcp/%5c/demo", "/mcp/./demo"]) {
      const signed = signTapRequest({ agent, pathName: target, created: nowSec, expires: nowSec + 60 });
      const out = await verify({
        method: "POST",
        publicOrigin: "https://port4.dev",
        target,
        headers: signed.headers,
        rawBody: signed.rawBody
      });
      assert.equal(out.ok, false, `Target '${target}' must be refused as non-normalized`);
      assert.equal(out.status, 403);
      assert.equal(out.reason, "request_target_invalid");
    }
  }
);

registerTest("T2-F6-03", "F6", 2, async () => {
  const h = createHarness();
  try {
    await h.db.prepare("UPDATE tenants SET require_visa_tap = 1 WHERE subdomain = 'demo'").run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const agent = makeEd25519Agent("agt_spoof");
    const signedOk = signTapRequest({
      agent,
      authority: "demo.port4.dev",
      pathName: "/mcp",
      extraHeaders: { host: "evil.com", "x-forwarded-host": "evil.com" }
    });
    const signedEvil = signTapRequest({
      agent,
      authority: "evil.com",
      pathName: "/mcp",
      extraHeaders: { host: "evil.com", "x-forwarded-host": "evil.com" }
    });
    await withMockFetch(
      async (url) => {
        if (url.includes("/v1/tap/registry/keys/")) return Response.json(agent.listing);
        throw new Error(`Unexpected ${url}`);
      },
      async () => {
        const okRes = await h.callApp("https://demo.port4.dev/mcp", {
          method: "POST",
          headers: signedOk.headers,
          body: signedOk.rawBody
        });
        assert.equal(okRes.status, 200);
        const badRes = await h.callApp("https://demo.port4.dev/mcp", {
          method: "POST",
          headers: signedEvil.headers,
          body: signedEvil.rawBody
        });
        assert.equal(badRes.status, 403);
        assert.equal((await badRes.json()).code, "tap_signature_invalid");
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T2-F6-04", "F6", 2, async () => {
  const agent = makeEd25519Agent();
  const nowSec = 1_750_000_000;
  let reserveCalls = 0;
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => Response.json(agent.listing),
    reserveNonce: async () => {
      reserveCalls += 1;
      return true;
    }
  });
  const signed = signTapRequest({ agent, created: nowSec, expires: nowSec + 60 });
  const out = await verify({
    method: "POST",
    publicOrigin: "https://port4.dev",
    target: "/mcp/demo",
    headers: signed.headers,
    rawBody: '{"tampered":true}'
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "tap_signature_invalid");
  assert.equal(out.reason, "body_digest_mismatch");
  assert.equal(reserveCalls, 0);
});

registerTest("T2-F6-05", "F6", 2, async () => {
  const agent = makeEd25519Agent();
  const nowSec = 1_750_000_000;
  const seenNonces = new Set();
  let reserveCalls = 0;
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => Response.json(agent.listing),
    reserveNonce: async (k) => {
      reserveCalls += 1;
      if (seenNonces.has(k)) return false;
      seenNonces.add(k);
      return true;
    }
  });
  const signed = signTapRequest({ agent, created: nowSec, expires: nowSec + 60 });
  const origSig = signed.headers.signature;
  // Flip one char in signature
  const forgedHeaders = {
    ...signed.headers,
    signature: origSig.replace(/^sig2=:(.)/, (_, ch) => `sig2=:${ch === "A" ? "B" : "A"}`)
  };
  const failOut = await verify({
    method: "POST",
    publicOrigin: "https://port4.dev",
    target: "/mcp/demo",
    headers: forgedHeaders,
    rawBody: signed.rawBody
  });
  assert.equal(failOut.ok, false);
  assert.equal(failOut.code, "tap_signature_invalid");
  assert.equal(failOut.reason, "signature_mismatch");
  assert.equal(reserveCalls, 0);

  // Valid request with same nonce must still succeed
  const okOut = await verify({
    method: "POST",
    publicOrigin: "https://port4.dev",
    target: "/mcp/demo",
    headers: signed.headers,
    rawBody: signed.rawBody
  });
  assert.equal(okOut.ok, true);
});

registerTest("T2-F6-06", "F6", 2, async () => {
  const agent = makeEd25519Agent();
  const nowSec = 1_750_000_000;
  const used = new Set();
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => Response.json(agent.listing),
    reserveNonce: async (k) => {
      if (used.has(k)) return false;
      used.add(k);
      return true;
    }
  });
  const signed = signTapRequest({ agent, created: nowSec, expires: nowSec + 60 });
  const r1 = await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: signed.headers, rawBody: signed.rawBody });
  const r2 = await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: signed.headers, rawBody: signed.rawBody });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 403);
  assert.equal(r2.code, "tap_replayed");
  assert.equal(r2.reason, "nonce_reused");
});

registerTest("T2-F6-07", "F6", 2, async () => {
  const nowSec = 1_750_000_000;
  const uuidAgent = makeEd25519Agent("agt_u", { useUuidKeyId: true });
  const jktAgent = makeEd25519Agent("agt_j");
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async (url) => Response.json(url.includes(uuidAgent.keyId) ? uuidAgent.listing : jktAgent.listing),
    reserveNonce: async () => true
  });
  const s301 = signTapRequest({
    agent: uuidAgent,
    tag: "agent-payer-auth",
    created: nowSec,
    expires: nowSec + 301,
    components: ["@method", "@authority", "@path"]
  });
  const o301 = await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: s301.headers, rawBody: s301.rawBody });
  assert.equal(o301.code, "tap_expired");
  assert.equal(o301.reason, "lifetime_too_long");

  const s480 = signTapRequest({
    agent: jktAgent,
    tag: "agent-payer-auth",
    created: nowSec,
    expires: nowSec + 480,
    components: ["@method", "@authority", "@path"]
  });
  assert.equal((await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: s480.headers, rawBody: s480.rawBody })).ok, true);

  const s481 = signTapRequest({
    agent: jktAgent,
    tag: "agent-payer-auth",
    created: nowSec,
    expires: nowSec + 481,
    components: ["@method", "@authority", "@path"]
  });
  assert.equal((await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: s481.headers, rawBody: s481.rawBody })).status, 403);

  const sMissing = signTapRequest({
    agent: jktAgent,
    tag: "agent-payer-auth",
    created: nowSec,
    expires: nowSec + 60,
    components: ["@method", "@path"]
  });
  const oMissing = await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: sMissing.headers, rawBody: sMissing.rawBody });
  assert.equal(oMissing.reason, "required_components_missing");
});

registerTest("T2-F6-08", "F6", 2, async () => {
  const agent = makeEd25519Agent();
  const nowSec = 1_750_000_000;
  const verify = visaTapMod.createTapVerifier({
    now: () => nowSec,
    fetchImpl: async () => Response.json(agent.listing),
    reserveNonce: async () => true
  });
  const sFuture = signTapRequest({ agent, created: nowSec + 31, expires: nowSec + 60 });
  assert.equal((await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: sFuture.headers, rawBody: sFuture.rawBody })).reason, "not_yet_valid");

  const sSkewOk = signTapRequest({ agent, created: nowSec + 30, expires: nowSec + 60 });
  assert.equal((await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: sSkewOk.headers, rawBody: sSkewOk.rawBody })).ok, true);

  const sExpired = signTapRequest({ agent, created: nowSec - 60, expires: nowSec });
  assert.equal((await verify({ method: "POST", publicOrigin: "https://port4.dev", target: "/mcp/demo", headers: sExpired.headers, rawBody: sExpired.rawBody })).reason, "expired");
});

registerTest(
  "T2-F6-09",
  "F6",
  2,
  { pendingMilestone: "M2", pendingReason: "ecdsa-p256-sha256 in INPUT_RE vs ed25519-only readListing inconsistency" },
  async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "lib", "visa-tap.ts"), "utf8");
    const inputLine = /const INPUT_RE\s*=[\s\S]*?;\r?\n/.exec(src)?.[0] ?? "";
    assert.equal(
      inputLine.includes("ecdsa-p256-sha256"),
      false,
      "INPUT_RE should not accept ecdsa-p256-sha256 if readListing/WebCrypto only supports ed25519"
    );

    const agent = makeEd25519Agent("agt_alg");
    const signed = signTapRequest({ agent, alg: "ecdsa-p256-sha256" });
    const verify = visaTapMod.createTapVerifier({
      registryOrigin: "https://auth.visacli.sh",
      fetchImpl: async () => Response.json(agent.listing),
      reserveNonce: async () => true
    });
    const out = await verify({
      method: "POST",
      publicOrigin: "https://port4.dev",
      target: "/mcp/demo",
      headers: signed.headers,
      rawBody: signed.rawBody
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "signature_input_format");
  }
);

registerTest(
  "T2-F6-10",
  "F6",
  2,
  { pendingMilestone: "M2", pendingReason: "registryKeyCache in visa-tap.ts has no max-size bound" },
  async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "lib", "visa-tap.ts"), "utf8");
    assert.match(src, /MAX_REGISTRY_CACHE|registryKeyCache\.size\s*>=/);
  }
);

// --- F7 Edge Cases ---
registerTest(
  "T2-F7-01",
  "F7",
  2,
  { pendingMilestone: "M2", pendingReason: "verifyCloudflareAccessJwt does not refresh JWKS on unknown kid" },
  async () => {
    const k1 = makeRsaJwksFixture("kid_1");
    const k2 = makeRsaJwksFixture("kid_2");
    const team = `rot-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
    const now = Math.floor(Date.now() / 1000);
    let fetchCount = 0;
    await withMockFetch(
      async () => {
        fetchCount += 1;
        return Response.json({ keys: fetchCount === 1 ? [k1.jwk] : [k1.jwk, k2.jwk] });
      },
      async () => {
        const r1 = await cfAccessMod.verifyCloudflareAccessJwt({
          token: k1.signJwt({ iss: `https://${team}`, aud: "aud_rot", exp: now + 60, email: "a@b.c" }),
          teamDomain: team,
          expectedAud: "aud_rot"
        });
        assert.equal(r1.ok, true);
        const r2 = await cfAccessMod.verifyCloudflareAccessJwt({
          token: k2.signJwt({ iss: `https://${team}`, aud: "aud_rot", exp: now + 60, email: "a@b.c" }),
          teamDomain: team,
          expectedAud: "aud_rot"
        });
        assert.equal(r2.ok, true);
        assert.equal(fetchCount, 2);
      }
    );
  }
);

registerTest(
  "T2-F7-02",
  "F7",
  2,
  { pendingMilestone: "M2", pendingReason: "JWKS fetch failure currently returns 401 instead of 503" },
  async () => {
    const { signJwt } = makeRsaJwksFixture("kid_503");
    const team = `err-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
    const now = Math.floor(Date.now() / 1000);
    await withMockFetch(
      async () => new Response("Error", { status: 500 }),
      async () => {
        const res = await cfAccessMod.verifyCloudflareAccessJwt({
          token: signJwt({ iss: `https://${team}`, aud: "aud_503", exp: now + 60 }),
          teamDomain: team,
          expectedAud: "aud_503"
        });
        assert.equal(res.ok, false);
        assert.equal(res.status, 503);
      }
    );
  }
);

registerTest(
  "T2-F7-03",
  "F7",
  2,
  { pendingMilestone: "M2", pendingReason: "cloudflare-access.ts fetchJwks lacks redirect: error and bounded jwksCache" },
  async () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "lib", "cloudflare-access.ts"), "utf8");
    assert.match(src, /redirect:\s*["']error["']/);
    assert.match(src, /jwksCache\.size\s*>=|MAX_JWKS_CACHE/);
  }
);

registerTest("T2-F7-04", "F7", 2, async () => {
  const h = createHarness();
  try {
    await h.db.prepare("UPDATE tenants SET auth_mode = 'x402+oauth_v2', cf_access_team_domain = NULL, cf_access_aud = NULL WHERE subdomain = 'demo'").run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const res = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
    });
    assert.equal(res.status, 503);
  } finally {
    h.close();
  }
});

registerTest(
  "T2-F7-05",
  "F7",
  2,
  { pendingMilestone: "M2", pendingReason: "Authorization: Payment with Cf-Access-Jwt-Assertion on x402+oauth_v2 requires MPP gate" },
  async () => {
    const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
    try {
      const { jwk, signJwt } = makeRsaJwksFixture("kid_mpp_oauth");
      const team = `mpp-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
      const aud = "aud_mpp_oauth_1234567890";
      await h.db
        .prepare("UPDATE tenants SET auth_mode = 'x402+oauth_v2', cf_access_team_domain = ?, cf_access_aud = ? WHERE subdomain = 'demo'")
        .bind(team, aud)
        .run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");

      const now = Math.floor(Date.now() / 1000);
      const accessJwt = signJwt({ iss: `https://${team}`, aud, exp: now + 300, email: "agent@corp.com" });
      const mppHeader = makeMppAuthHeader({
        challengeId: "ch_mpp_1",
        txHash: `0x${"bb".repeat(32)}`,
        amount: "1000",
        currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
        recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        chainId: 42431,
        payer: "0x1111111111111111111111111111111111111111"
      });

      await withMockFetch(
        async (url) => {
          if (url.includes("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              status: "0x1",
              transactionHash: `0x${"bb".repeat(32)}`,
              logs: [
                makeTempoOusdTransferLog(
                  "0x1111111111111111111111111111111111111111",
                  "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                  "1000"
                )
              ]
            }
          });
        },
        async () => {
          const rNoJwt = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: mppHeader },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
          });
          assert.equal(rNoJwt.status, 401);

          const rBoth = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Cf-Access-Jwt-Assertion": accessJwt,
              Authorization: mppHeader
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } })
          });
          assert.equal(rBoth.status, 200);
          assert.ok(rBoth.headers.get("payment-receipt"));
        }
      );
    } finally {
      h.close();
    }
  }
);

// --- F8 Edge Cases ---
registerTest(
  "T2-F8-01",
  "F8",
  2,
  { pendingMilestone: "M2", pendingReason: "x402GateMiddleware does not call EdgeRateLimiter next_fee_sequence yet" },
  async () => {
    const h = createHarness();
    try {
      await h.db.prepare("UPDATE tenants SET settled_call_sequence = 31 WHERE subdomain = 'demo'").run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      // Discovery must NOT advance fee counter
      await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      const callUnpaid = async () => {
        const res = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } })
        });
        assert.equal(res.status, 402);
        return (await res.json()).x402.accepts[0];
      };
      const a32 = await callUnpaid();
      assert.equal(a32.extra.isPlatformFee, false);
      const a33 = await callUnpaid();
      assert.equal(a33.extra.isPlatformFee, true);
      assert.equal(a33.payTo, h.env.PORT4_TREASURY_WALLET);
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F8-02", "F8", 2, async () => {
  const h = createHarness();
  try {
    const payTo = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
    const nonce = `0x${crypto.randomBytes(32).toString("hex")}`;
    const sig1 = makeEvmPaymentHeader({ to: payTo, value: "1000", nonce, mode: "port4-sandbox-demo", jwtSecret: h.env.JWT_SECRET });
    const sig2 = makeEvmPaymentHeader({
      to: payTo,
      value: "1000",
      nonce,
      mode: "port4-sandbox-demo",
      jwtSecret: h.env.JWT_SECRET,
      prettyJson: true,
      reverseKeys: true
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
    const r1 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig1 },
      body
    });
    assert.equal(r1.status, 200);
    const r2 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig2 },
      body
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get("x-port4-idempotent-replay"), "true");
  } finally {
    h.close();
  }
});

registerTest("T2-F8-03", "F8", 2, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    await h.db
      .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_sp', ?, 'spend', 'Spend', 'https://up.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532')")
      .bind(u.id)
      .run();
    await h.db
      .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_sp', 'ten_sp', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
      .run();

    let settleCount = 0;
    const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
    await withMockFetch(
      async (url) => {
        if (url.endsWith("/verify")) return Response.json({ isValid: true });
        if (url.endsWith("/settle")) {
          settleCount += 1;
          return new Response("Gateway Timeout", { status: 504 });
        }
        throw new Error(`Unexpected ${url}`);
      },
      async () => {
        const r1 = await h.callApp("https://port4.dev/mcp/spend", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
          body
        });
        assert.equal(r1.status, 409);
        assert.equal((await r1.json()).error, "payment_settlement_pending");
        assert.equal(settleCount, 1);

        const r2 = await h.callApp("https://port4.dev/mcp/spend", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
          body
        });
        assert.equal(r2.status, 409);
        assert.equal(settleCount, 1);
      }
    );
  } finally {
    h.close();
  }
});

registerTest(
  "T2-F8-04",
  "F8",
  2,
  { pendingMilestone: "M3", pendingReason: "mcp.ts does not call mark_upstream_failed on transient 502 yet" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_up502', ?, 'up502', 'Up502', 'https://up502.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532')")
        .bind(u.id)
        .run();
      await h.db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_up502', 'ten_up502', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
        .run();

      let facCalls = 0;
      let upstreamFail = true;
      const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
      await withMockFetch(
        async (url) => {
          if (url.endsWith("/verify")) {
            facCalls += 1;
            return Response.json({ isValid: true });
          }
          if (url.endsWith("/settle")) {
            facCalls += 1;
            return Response.json({ success: true, transaction: `0x${"55".repeat(32)}`, network: "eip155:84532" });
          }
          if (upstreamFail) return new Response("Down", { status: 502 });
          return Response.json({ recovered: true });
        },
        async () => {
          const r1 = await h.callApp("https://port4.dev/mcp/up502", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
            body
          });
          assert.equal(r1.status, 502);
          assert.equal(facCalls, 2);

          facCalls = 0;
          upstreamFail = false;
          const r2 = await h.callApp("https://port4.dev/mcp/up502", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
            body
          });
          assert.equal(r2.status, 200);
          assert.equal(facCalls, 0);
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F8-05", "F8", 2, async () => {
  const h = createHarness();
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
    const badB64 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": "!!!not_base64!!!" },
      body
    });
    assert.equal(badB64.status, 402);
    assert.equal((await badB64.json()).error, "invalid_payment_signature_encoding");

    const wrongTargetSig = makeEvmPaymentHeader({
      to: "0x000000000000000000000000000000000000dead",
      value: "1000"
    });
    const rWrong = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": wrongTargetSig },
      body
    });
    assert.equal(rWrong.status, 402);
    assert.equal((await rWrong.json()).error, "invalid_payment_authorization_target");
    assert.equal(h.replayGuard.instances.size, 0);
  } finally {
    h.close();
  }
});

registerTest(
  "T2-F8-06",
  "F8",
  2,
  { pendingMilestone: "M2", pendingReason: "buildPaymentRequired hardcodes extra.name='USD Coin' even for Tempo OUSD" },
  async () => {
    const h = createHarness();
    try {
      const t = buildTenantRecord({ network: "eip155:42431" });
      const fakeCtx = { req: { url: "https://acme.port4.dev/mcp" }, env: h.env };
      const { paymentRequired } = x402GateMod.buildPaymentRequired(fakeCtx, t, t.tools[0], 1);
      assert.notEqual(paymentRequired.accepts[0].extra.name, "USD Coin", "Tempo OUSD asset metadata must not claim 'USD Coin'");
    } finally {
      h.close();
    }
  }
);

// --- F9 Edge Cases ---
registerTest(
  "T2-F9-01",
  "F9",
  2,
  { pendingMilestone: "M2", pendingReason: "buildTenantOpenApiDocument currently emits # fragment keys" },
  async () => {
    const doc = mppTempoMod.buildTenantOpenApiDocument(buildTenantRecord(), "https://acme.port4.dev");
    for (const k of Object.keys(doc.paths)) {
      assert.equal(k.includes("#"), false, `Path key '${k}' must not contain '#'`);
    }
  }
);

registerTest(
  "T2-F9-02",
  "F9",
  2,
  { pendingMilestone: "M2", pendingReason: "buildTenantOpenApiDocument ignores codemode and openapi_codemode" },
  async () => {
    const cmDoc = mppTempoMod.buildTenantOpenApiDocument(buildTenantRecord({ mcp_mode: "codemode" }), "https://acme.port4.dev");
    assert.equal(Object.keys(cmDoc.paths).length, 1);
    assert.ok(JSON.stringify(cmDoc.paths).includes('"code"'));
    assert.equal(JSON.stringify(cmDoc.paths).includes('"quote"'), false);

    const oaDoc = mppTempoMod.buildTenantOpenApiDocument(buildTenantRecord({ mcp_mode: "openapi_codemode" }), "https://acme.port4.dev");
    assert.ok(JSON.stringify(oaDoc.paths).includes('"execute"'));
  }
);

registerTest(
  "T2-F9-03",
  "F9",
  2,
  { pendingMilestone: "M2", pendingReason: "verifyMppPaymentCredential replay & context mismatch not yet implemented" },
  async () => {
    const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
    try {
      const txHash = `0x${"f9".repeat(32)}`;
      const mppHeader = makeMppAuthHeader({
        challengeId: "ch_f903",
        txHash,
        amount: "1000",
        currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
        recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        chainId: 42431,
        payer: "0x1111111111111111111111111111111111111111"
      });
      let rpcHits = 0;
      await withMockFetch(
        async () => {
          rpcHits += 1;
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              status: "0x1",
              transactionHash: txHash,
              logs: [
                makeTempoOusdTransferLog(
                  "0x1111111111111111111111111111111111111111",
                  "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                  "1000"
                )
              ]
            }
          });
        },
        async () => {
          const pingBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "ping", arguments: {} }
          });
          const r1 = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: mppHeader },
            body: pingBody
          });
          assert.equal(r1.status, 200);
          assert.ok(r1.headers.get("payment-receipt"));
          assert.equal(rpcHits, 1);

          // Same tool + same credential -> idempotent replay (no second RPC hit)
          const rReplay = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: mppHeader },
            body: pingBody
          });
          assert.equal(rReplay.status, 200);
          assert.equal(rReplay.headers.get("x-port4-idempotent-replay"), "true");
          assert.equal(rpcHits, 1);

          // Cross-tool replay of the same credential -> 409 payment_context_mismatch
          const quoteBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "market_quote", arguments: { symbol: "ETH-USD" } }
          });
          const rMismatch = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: mppHeader },
            body: quoteBody
          });
          assert.equal(rMismatch.status, 409);
          assert.equal((await rMismatch.json()).error, "payment_context_mismatch");
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F9-04",
  "F9",
  2,
  { pendingMilestone: "M2", pendingReason: "verifyMppPaymentCredential amount/recipient/chainId check not yet implemented" },
  async () => {
    const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: {} }
      });
      const baseCred = {
        challengeId: "ch_f904",
        txHash: `0x${"94".repeat(32)}`,
        amount: "1000",
        currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
        recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        chainId: 42431,
        payer: "0x1111111111111111111111111111111111111111"
      };

      // 1. Underpaid amount -> 402
      const rUnderpaid = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: makeMppAuthHeader({ ...baseCred, amount: "500" })
        },
        body
      });
      assert.equal(rUnderpaid.status, 402);

      // 2. Wrong recipient -> 402
      const rWrongRecip = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: makeMppAuthHeader({
            ...baseCred,
            recipient: "0x000000000000000000000000000000000000dead"
          })
        },
        body
      });
      assert.equal(rWrongRecip.status, 402);

      // 3. Wrong chainId -> 402
      const rWrongChain = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: makeMppAuthHeader({ ...baseCred, chainId: 4217 })
        },
        body
      });
      assert.equal(rWrongChain.status, 402);
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F9-05", "F9", 2, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    await h.db
      .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_sol', ?, 'solonly', 'SolOnly', 'https://sol.example', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')")
      .bind(u.id)
      .run();
    await h.db
      .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_sol', 'ten_sol', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
      .run();

    const res = await h.callApp("https://port4.dev/mcp/solonly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
    });
    assert.equal(res.status, 402);
    assert.ok(res.headers.get("payment-required"));
    assert.equal(res.headers.get("www-authenticate"), null);
  } finally {
    h.close();
  }
});

// --- F10 Edge Cases ---
registerTest(
  "T2-F10-01",
  "F10",
  2,
  { pendingMilestone: "M3", pendingReason: "Failed Code Mode returns 200 before PaymentReplayGuard /complete" },
  async () => {
    const h = createHarness();
    try {
      await h.db.prepare("UPDATE tenants SET mcp_mode = 'codemode' WHERE subdomain = 'demo'").run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      const paySig = makeEvmPaymentHeader({
        to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        value: "10000",
        mode: "port4-sandbox-demo",
        jwtSecret: h.env.JWT_SECRET
      });
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "code", arguments: { code: 'async () => { throw new Error("boom"); }' } }
      });
      const r1 = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
        body
      });
      assert.equal(r1.status, 200);
      assert.equal((await r1.json()).result?.isError, true);
      assert.equal(h.queue.sent.length, 1, "Metering must run on completed failed Code Mode call");

      const r2 = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
        body
      });
      assert.equal(r2.headers.get("x-port4-idempotent-replay"), "true");
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F10-02",
  "F10",
  2,
  { pendingMilestone: "M3", pendingReason: "Deterministic upstream 4xx does not complete PaymentReplayGuard" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_4xx', ?, 'up4xx', 'Up4xx', 'https://up4xx.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532')")
        .bind(u.id)
        .run();
      await h.db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_4xx', 'ten_4xx', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
        .run();

      const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
      let upstreamCalls = 0;
      await withMockFetch(
        async (url) => {
          if (url.endsWith("/verify")) return Response.json({ isValid: true });
          if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"44".repeat(32)}`, network: "eip155:84532" });
          upstreamCalls += 1;
          return new Response("Bad Request", { status: 400 });
        },
        async () => {
          await h.callApp("https://port4.dev/mcp/up4xx", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
            body
          });
          const r2 = await h.callApp("https://port4.dev/mcp/up4xx", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
            body
          });
          assert.equal(upstreamCalls, 1, "Deterministic 4xx must complete replay guard so retry does not re-hit upstream");
          assert.equal(r2.headers.get("x-port4-idempotent-replay"), "true");
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest("T2-F10-03", "F10", 2, async () => {
  const t = buildTenantRecord({ mcp_mode: "codemode" });
  const res = await codemodeMod.executeCodeModePlan({
    env: {},
    tenant: t,
    code: "async () => 1",
    authorizedAtomicBudget: "10000",
    dispatchTool: async () => ({})
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /LOADER binding is not configured/);
});

registerTest("T2-F10-04", "F10", 2, async () => {
  const h = createHarness();
  try {
    const t = buildTenantRecord({ mcp_mode: "codemode", codemode_max_subcalls: 2 });
    let dispatches = 0;
    const res = await codemodeMod.executeCodeModePlan({
      env: h.env,
      tenant: t,
      code: 'async () => { await codemode.quote({ symbol: "A" }); await codemode.quote({ symbol: "B" }); return await codemode.quote({ symbol: "C" }); }',
      authorizedAtomicBudget: "50000",
      dispatchTool: async () => {
        dispatches += 1;
        return { ok: true };
      }
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /sub-call limit exceeded/i);
    assert.equal(dispatches, 2);
  } finally {
    h.close();
  }
});

registerTest("T2-F10-05", "F10", 2, async () => {
  const h = createHarness();
  try {
    const t = buildTenantRecord({ mcp_mode: "codemode", codemode_max_subcalls: 5 });
    t.tools[0].price_atomic = "3000";
    let dispatches = 0;
    const res = await codemodeMod.executeCodeModePlan({
      env: h.env,
      tenant: t,
      code: 'async () => { await codemode.quote({ symbol: "A" }); return await codemode.quote({ symbol: "B" }); }',
      authorizedAtomicBudget: "5000",
      dispatchTool: async () => {
        dispatches += 1;
        return { ok: true };
      }
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /execution budget exceeded/i);
    assert.equal(dispatches, 1);
    assert.equal(res.consumedAtomic, "3000");
  } finally {
    h.close();
  }
});

registerTest("T2-F10-06", "F10", 2, async () => {
  const h = createHarness();
  try {
    const t = buildTenantRecord({ mcp_mode: "codemode" });
    let dispatches = 0;
    const badArgs = await codemodeMod.executeCodeModePlan({
      env: h.env,
      tenant: t,
      code: 'async () => await codemode.quote({ symbol: 123 })',
      authorizedAtomicBudget: "10000",
      dispatchTool: async () => {
        dispatches += 1;
        return {};
      }
    });
    assert.equal(badArgs.ok, false);
    assert.match(badArgs.error, /Invalid arguments/);
    assert.equal(dispatches, 0);

    const tooLong = await codemodeMod.executeCodeModePlan({
      env: h.env,
      tenant: t,
      code: "x".repeat(32_769),
      authorizedAtomicBudget: "10000",
      dispatchTool: async () => ({})
    });
    assert.equal(tooLong.ok, false);

    const empty = await codemodeMod.executeCodeModePlan({
      env: h.env,
      tenant: t,
      code: "   ",
      authorizedAtomicBudget: "10000",
      dispatchTool: async () => ({})
    });
    assert.equal(empty.ok, false);
  } finally {
    h.close();
  }
});

// --- F11 Edge Cases ---
registerTest(
  "T2-F11-01",
  "F11",
  2,
  { pendingMilestone: "M3", pendingReason: "api.ts tenant sub-routes lack AND deleted_at IS NULL" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      const createRes = await h.callApp("https://port4.dev/api/tenants", {
        method: "POST",
        headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          subdomain: "subdel",
          name: "SubDel",
          upstream_base_url: "https://api.subdel.example",
          payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          initial_tool: { name: "t1", description: "t", upstream_path: "/t", price_usd: "0.001" }
        })
      });
      const created = await createRes.json();
      const tid = created.tenant.id;
      const toolId = created.tenant.tools[0].id;
      await h.callApp(`https://port4.dev/api/tenants/${tid}`, {
        method: "DELETE",
        headers: { Origin: "https://port4.dev", Cookie: u.cookie }
      });

      const subRoutes = [
        ["POST", `/api/tenants/${tid}/verify-upstream`, {}],
        ["POST", `/api/tenants/${tid}/rotate-secret`, {}],
        ["PATCH", `/api/tenants/${tid}`, { name: "x" }],
        ["POST", `/api/tenants/${tid}/import-openapi`, { spec: { paths: {} } }],
        ["POST", `/api/tenants/${tid}/tools`, { name: "t2", upstream_path: "/t2", price_usd: "0.001" }],
        ["PATCH", `/api/tenants/${tid}/tools/${toolId}`, { name: "t1b" }],
        ["DELETE", `/api/tenants/${tid}/tools/${toolId}`, null],
        ["POST", `/api/tenants/${tid}/test-call`, { tool_name: "t1" }],
        ["POST", `/api/tenants/${tid}/sync-mcp`, {}]
      ];
      for (const [method, p, body] of subRoutes) {
        const res = await h.callApp(`https://port4.dev${p}`, {
          method,
          headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
        assert.equal(res.status, 404, `Soft-deleted tenant route ${method} ${p} must return 404, got ${res.status}`);
      }
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F11-02",
  "F11",
  2,
  { pendingMilestone: "M3", pendingReason: "validateUpstreamBaseUrl allows internal://sandbox for arbitrary callers" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      const rPost = await h.callApp("https://port4.dev/api/tenants", {
        method: "POST",
        headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          subdomain: "sneaky",
          name: "Sneaky",
          upstream_base_url: "internal://sandbox",
          payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
        })
      });
      assert.equal(rPost.status, 400);
      assert.equal((await rPost.json()).error, "invalid_upstream_url");
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F11-03",
  "F11",
  2,
  { pendingMilestone: "M3", pendingReason: "test-call does not handle source_type === 'mcp'" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_tcmcp', ?, 'tcmcp', 'TcMcp', 'https://up.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532')")
        .bind(u.id)
        .run();
      await h.db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic, source_type, remote_tool_name) VALUES ('tl_tc', 'ten_tcmcp', 'ping', 'p', 'POST', '/mcp', '{}', '0.001', '1000', 'mcp', 'remote_ping')")
        .run();

      let sawHeaders = null;
      let sawBody = null;
      await withMockFetch(
        async (_url, init) => {
          sawHeaders = init?.headers;
          sawBody = JSON.parse(init?.body ?? "{}");
          return Response.json({ jsonrpc: "2.0", id: sawBody.id, result: { pong: "remote" } });
        },
        async () => {
          const res = await h.callApp("https://port4.dev/api/tenants/ten_tcmcp/test-call", {
            method: "POST",
            headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ tool_name: "ping", arguments: { a: 1 } })
          });
          assert.equal(res.status, 200);
          assert.equal(sawHeaders["MCP-Protocol-Version"], "2026-07-28");
          assert.equal(sawHeaders["Mcp-Method"], "tools/call");
          assert.equal(sawHeaders["Mcp-Name"], "remote_ping");
          assert.equal(sawBody.params?.name, "remote_ping");
          assert.deepEqual((await res.json()).response, { pong: "remote" });
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F11-04",
  "F11",
  2,
  { pendingMilestone: "M3", pendingReason: "sync-mcp lacks path traversal guard and upstream auth injection" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      const enc = await cryptoMod.encryptSecretAtRest("secret_tok", h.env.JWT_SECRET);
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, upstream_auth_type, upstream_auth_secret) VALUES ('ten_sync', ?, 'syncmcp', 'SyncMcp', 'https://up.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532', 'bearer', ?)")
        .bind(u.id, enc)
        .run();

      for (const badPath of ["//evil.com/mcp", "/../admin", "/mcp?x=1"]) {
        const badRes = await h.callApp("https://port4.dev/api/tenants/ten_sync/sync-mcp", {
          method: "POST",
          headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ mcp_path: badPath })
        });
        assert.equal(badRes.status, 400, `sync-mcp must reject bad mcp_path ${badPath}`);
      }

      let sawAuth = null;
      await withMockFetch(
        async (_url, init) => {
          sawAuth = init?.headers?.Authorization;
          return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
        },
        async () => {
          const okRes = await h.callApp("https://port4.dev/api/tenants/ten_sync/sync-mcp", {
            method: "POST",
            headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ mcp_path: "/mcp" })
          });
          assert.equal(okRes.status, 200);
          assert.equal(sawAuth, "Bearer secret_tok");
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F11-05",
  "F11",
  2,
  { pendingMilestone: "M3", pendingReason: "validateUpstreamBaseUrl checks ::ffff: without stripping IPv6 brackets from [::ffff:7f00:1]" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      for (const badUrl of [
        "http://api.example.com",
        "https://user:pass@api.example.com",
        "https://127.0.0.1",
        "https://localhost",
        "https://10.0.0.1",
        "https://172.16.0.1",
        "https://192.168.1.1",
        "https://169.254.169.254",
        "https://100.64.0.1",
        "https://[::ffff:127.0.0.1]",
        "https://a.internal",
        "https://a.local",
        "https://a.arpa"
      ]) {
        const res = await h.callApp("https://port4.dev/api/tenants", {
          method: "POST",
          headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            subdomain: "ssrfchk",
            name: "SSRF",
            upstream_base_url: badUrl,
            payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
          })
        });
        assert.equal(res.status, 400, `SSRF URL ${badUrl} must be rejected`);
      }
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T2-F11-06",
  "F11",
  2,
  { pendingMilestone: "M3", pendingReason: "security.ts rejects local dev origins when APP_URL is production" },
  async () => {
    assert.equal(securityMod.isTrustedBrowserOrigin("https://evil.com", "https://port4.dev"), false);
    assert.equal(securityMod.isTrustedBrowserOrigin("https://port4.dev", "https://port4.dev"), true);
    assert.equal(
      securityMod.isTrustedBrowserOrigin("http://127.0.0.1:8787", "https://port4.dev", "http://127.0.0.1:8787/api/keys"),
      true
    );
    assert.equal(
      securityMod.isTrustedBrowserOrigin("http://localhost:5173", "https://port4.dev", "http://127.0.0.1:8787/api/keys"),
      true
    );
    assert.equal(
      securityMod.isTrustedBrowserOrigin("http://localhost:5173", "https://port4.dev", "https://port4.dev/api/keys"),
      false,
      "Loopback Origin must be rejected when targeting production https://port4.dev"
    );
  }
);

registerTest("T2-F11-07", "F11", 2, async () => {
  assert.equal(cryptoMod.isValidCustomAuthHeaderName("X-API-Key"), true);
  for (const bad of ["Host", "Cookie", "Idempotency-Key", "X-Port4-Tenant", "CF-Access-Client-Id", "PAYMENT-SIGNATURE", "Mcp-Method", "Bad Header"]) {
    assert.equal(cryptoMod.isValidCustomAuthHeaderName(bad), false, `Header ${bad} must be blocked`);
  }
});

// --- F12 Edge Cases ---
registerTest("T2-F12-01", "F12", 2, async () => {
  const appSrc = fs.readFileSync(path.join(ROOT, "web", "src", "App.tsx"), "utf8");
  assert.match(appSrc, /lazy\(\(\)\s*=>\s*import\("\.\/components\/Docs"\)/);
  assert.match(appSrc, /lazy\(\(\)\s*=>[\s\S]*?import\("\.\/components\/EndpointForm"\)/);
  assert.match(appSrc, /lazy\(\(\)\s*=>[\s\S]*?import\("\.\/components\/RevenueTable"\)/);
  assert.match(appSrc, /lazy\(\(\)\s*=>[\s\S]*?import\("\.\/components\/AdminDashboard"\)/);
  assert.match(appSrc, /if \(view === "docs"\)/);
  assert.match(appSrc, /if \(view === "dashboard"\)/);
  assert.match(appSrc, /\{view === "home" &&/);
});

registerTest("T2-F12-02", "F12", 2, async () => {
  const checkFiles = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx|js)$/.test(e.name)) checkFiles.push(f);
    }
  };
  walk(path.join(ROOT, "web", "src"));
  walk(path.join(ROOT, "dist", "assets"));
  for (const f of checkFiles) {
    const content = fs.readFileSync(f, "utf8");
    for (const tok of ["DEMO_PAYER_PRIVATE_KEY", "JWT_SECRET", "GITHUB_CLIENT_SECRET", "p4_whsec_"]) {
      assert.equal(content.includes(tok), false, `Sensitive token ${tok} leaked in ${f}`);
    }
  }
});

registerTest("T2-F12-03", "F12", 2, async () => {
  const docsSrc = fs.readFileSync(path.join(ROOT, "web", "src", "components", "Docs.tsx"), "utf8");
  const headings = [...docsSrc.matchAll(/<h2[^>]*>\s*(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(headings, [1, 2, 3, 4, 5, 6]);
});

registerTest("T2-F12-04", "F12", 2, async () => {
  assert.equal(walletsWebMod.isValidWalletAddress("eip155:4217", "0x227c258fF5f873450e0C8ff9dC5C5E355066D1b2"), true);
  assert.equal(walletsWebMod.isValidWalletAddress("eip155:42431", "0x123"), false);
  assert.equal(walletsWebMod.isValidWalletAddress("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), true);
  assert.equal(walletsWebMod.isValidWalletAddress("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "0OIl" + "1".repeat(32)), false);
});

registerTest("T2-F12-05", "F12", 2, async () => {
  const rev = fs.readFileSync(path.join(ROOT, "web", "src", "components", "RevenueTable.tsx"), "utf8");
  assert.match(rev, /tx\.status\s*!==\s*"sandbox_settled"/);
  assert.match(rev, /isSafeHttpsUrl\(tx\.explorer_url\)[\s\S]*?\?\s*\(\s*<a/);
  assert.match(rev, /\(sim\)/);
});

// --- F13 Edge Cases ---
registerTest("T2-F13-01", "F13", 2, async () => {
  const { Port4BudgetGuard, forwardToPort4Edge } = await import(
    pathToFileURL(path.join(ROOT, "packages", "port4-mcp", "bin", "port4-mcp.mjs")).href
  );
  const guard = new Port4BudgetGuard("0.05", "0.08");
  const challengeRes = () =>
    new Response(
      JSON.stringify({
        x402: {
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "eip155:84532", amount: "50000", extra: { priceUsd: "0.05" } }]
        }
      }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    );
  const callMsg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "q", arguments: {} } };
  const baseOpts = { url: "https://port4.dev/mcp/demo", privateKey: `0x${"11".repeat(32)}`, network: "", paymentSignature: "" };

  // Failed signing rolls back reservation
  await forwardToPort4Edge(callMsg, baseOpts, guard, async () => challengeRes(), async () => ({ ok: false, reason: "sign_err" }));
  assert.equal(guard.spentUsd, 0);
  assert.equal(guard.reservedAtomic, 0n);

  // HTTP 502 on retry rolls back reservation so subsequent $0.05 call succeeds
  let attempt = 0;
  await forwardToPort4Edge(
    callMsg,
    baseOpts,
    guard,
    async () => (++attempt === 1 ? challengeRes() : new Response("Bad Gateway", { status: 502 })),
    async () => ({ ok: true, header: "sig_b64" })
  );
  assert.equal(guard.spentUsd, 0);
  assert.equal(guard.checkAndReserve("0.05").allowed, true);
});

registerTest("T2-F13-02", "F13", 2, async () => {
  const { Port4BudgetGuard, forwardToPort4Edge, selectEvmPaymentRequirement, resolveRequirementMicroUsd } = await import(
    pathToFileURL(path.join(ROOT, "packages", "port4-mcp", "bin", "port4-mcp.mjs")).href
  );
  const multi = {
    x402Version: 2,
    accepts: [
      { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", amount: "500000", extra: { priceUsd: "0.50" } },
      { scheme: "exact", network: "eip155:84532", amount: "20000", extra: { priceUsd: "0.02" } }
    ]
  };
  const selected = selectEvmPaymentRequirement(multi);
  assert.equal(selected.network, "eip155:84532");
  assert.equal(resolveRequirementMicroUsd(selected), 20_000n);

  const guard = new Port4BudgetGuard("0.05", "0.10");
  let attempt = 0;
  const reply = await forwardToPort4Edge(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "q", arguments: {} } },
    { url: "https://port4.dev/mcp/demo", privateKey: `0x${"11".repeat(32)}`, network: "", paymentSignature: "" },
    guard,
    async () => {
      if (++attempt === 1) return new Response(JSON.stringify({ x402: multi }), { status: 402 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }), { status: 200 });
    },
    async (_pk, _pr, req) => {
      assert.equal(req.network, "eip155:84532");
      return { ok: true, header: "sig_evm" };
    }
  );
  assert.equal(reply.result.ok, true);
  assert.equal(guard.committedAtomic, 20_000n);
});

registerTest("T2-F13-03", "F13", 2, async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "cli", "port4-mcp.mjs"), "--url", "http://127.0.0.1:9/mcp"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"]
  });
  try {
    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    const linePromise = new Promise((resolve) => rl.once("line", (l) => resolve(JSON.parse(l))));
    child.stdin.write("{malformed json\n");
    const reply = await linePromise;
    rl.close();
    assert.equal(reply.error?.code, -32700);
    assert.equal(reply.error?.message, "Parse error");
  } finally {
    child.stdin.end();
    child.kill();
  }
});

registerTest("T2-F13-04", "F13", 2, async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "payment_required",
        x402: {
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "eip155:84532", amount: "50000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", extra: { priceUsd: "0.05" } }]
        }
      })
    );
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "cli", "port4-mcp.mjs"), "--url", `http://127.0.0.1:${port}/mcp/demo`, "--max-per-call-usd", "0.01"],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }
  );
  try {
    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    const linePromise = new Promise((resolve) => rl.once("line", (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "quote", arguments: {} } }) + "\n");
    const reply = await linePromise;
    rl.close();
    assert.equal(reply.result?.isError, true);
    const parsed = JSON.parse(reply.result.content[0].text);
    assert.equal(parsed.budgetGuard?.allowed, false);
  } finally {
    child.stdin.end();
    child.kill();
    srv.close();
  }
});

registerTest("T2-F13-05", "F13", 2, async () => {
  const cliEntry = fs.readFileSync(path.join(ROOT, "cli", "port4-mcp.mjs"), "utf8");
  assert.match(cliEntry, /packages\/port4-mcp\/bin\/port4-mcp\.mjs/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "port4-mcp", "package.json"), "utf8"));
  assert.equal(pkg.bin?.["port4-mcp"], "bin/port4-mcp.mjs");
});

// --- F14 Edge Cases ---
registerTest("T2-F14-01", "F14", 2, async () => {
  const selfSrc = fs.readFileSync(__filename, "utf8");
  assert.equal(/readFileSync\([^)]*\.dev\.vars/.test(selfSrc), false, "Tests must never read .dev.vars");
  assert.equal(/wrangler"\s*,\s*"deploy"|wrangler\s+deploy|wrangler\s+secret\s+put/.test(selfSrc), false);
});

registerTest("T2-F14-02", "F14", 2, async () => {
  const selfSrc = fs.readFileSync(__filename, "utf8");
  assert.equal(/function isAllowedMcpOrigin\(/.test(selfSrc), false);
  assert.equal(/function validateToolArguments\(/.test(selfSrc), false);
  assert.equal(/function isValidCustomAuthHeaderName\(/.test(selfSrc), false);
});

registerTest("T2-F14-03", "F14", 2, async () => {
  assert.equal(typeof withFixedNow, "function");
  assert.equal(typeof visaTapMod.createTapVerifier, "function");
});

registerTest("T2-F14-04", "F14", 2, async () => {
  const localSrc = fs.readFileSync(path.join(ROOT, "scripts", "test-local-e2e.mjs"), "utf8");
  assert.match(localSrc, /finally/);
  assert.match(localSrc, /removeDirWithRetry|rmSync/);
});

registerTest("T2-F14-05", "F14", 2, async () => {
  assert.ok(tests.length >= 161, `Expected at least 161 registered conformance tests, found ${tests.length}`);
  const ids = new Set(tests.map((t) => t.id));
  assert.equal(ids.size, tests.length, "Every registered test ID must be unique");
});

// ===========================================================================
// TIER 3 — Cross-Feature Pairwise Combinations (15 Tests)
// ===========================================================================
registerTest(
  "T3-01",
  "F7+F9",
  3,
  { pendingMilestone: "M2", pendingReason: "Tempo MPP Authorization: Payment with CF Access x402+oauth_v2" },
  async () => {
    const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
    try {
      const { jwk, signJwt } = makeRsaJwksFixture("kid_t301");
      const team = `t301-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
      const aud = "aud_t301_123456789012";
      await h.db
        .prepare("UPDATE tenants SET auth_mode = 'x402+oauth_v2', cf_access_team_domain = ?, cf_access_aud = ? WHERE subdomain = 'demo'")
        .bind(team, aud)
        .run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      const now = Math.floor(Date.now() / 1000);
      const accessJwt = signJwt({ iss: `https://${team}`, aud, exp: now + 300, email: "u@corp.dev" });
      const mpp = makeMppAuthHeader({
        challengeId: "ch_t301",
        txHash: `0x${"31".repeat(32)}`,
        amount: "1000",
        currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
        recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        chainId: 42431,
        payer: "0x1111111111111111111111111111111111111111"
      });
      await withMockFetch(
        async (url) => {
          if (url.includes("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              status: "0x1",
              transactionHash: `0x${"31".repeat(32)}`,
              logs: [
                makeTempoOusdTransferLog(
                  "0x1111111111111111111111111111111111111111",
                  "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                  "1000"
                )
              ]
            }
          });
        },
        async () => {
          const rOnlyMpp = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: mpp },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
          });
          assert.equal(rOnlyMpp.status, 401);

          const rOk = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": accessJwt, Authorization: mpp },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } })
          });
          assert.equal(rOk.status, 200);
          assert.ok(rOk.headers.get("payment-receipt"));
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T3-02",
  "F6+F8+F10",
  3,
  { pendingMilestone: "M3", pendingReason: "tapAgentId propagation through mcp.ts -> metering.ts -> D1" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, require_visa_tap) VALUES ('ten_t302', ?, 't302', 'T302', 'https://up.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532', 1)")
        .bind(u.id)
        .run();
      await h.db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_t302', 'ten_t302', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
        .run();
      const agent = makeEd25519Agent("agt_99");
      const rawBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
      const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
      const signed = signTapRequest({ agent, authority: "port4.dev", pathName: "/mcp/t302", rawBody, tag: "agent-payer-auth", extraHeaders: { "payment-signature": paySig } });

      let upHeaders = null;
      await withMockFetch(
        async (url, init) => {
          if (url.includes("/v1/tap/registry/keys/")) return Response.json(agent.listing);
          if (url.endsWith("/verify")) return Response.json({ isValid: true });
          if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"99".repeat(32)}`, network: "eip155:84532" });
          upHeaders = init?.headers;
          return Response.json({ ok: true });
        },
        async () => {
          const res = await h.callApp("https://port4.dev/mcp/t302", { method: "POST", headers: signed.headers, body: rawBody });
          assert.equal(res.status, 200);
          assert.equal(res.headers.get("x-port4-tap-agent"), "agt_99");
          assert.equal(upHeaders["X-Port4-Tap-Verified"], "true");
          assert.equal(upHeaders["X-Port4-Tap-Agent-Id"], "agt_99");
          assert.equal(h.queue.sent[0]?.tapAgentId, "agt_99");
          await meteringMod.consumeMeteringEvents(h.queue.drainToBatch(), h.env);
          const row = await h.db.prepare("SELECT tap_agent_id FROM transactions WHERE tenant_id = 'ten_t302'").first();
          assert.equal(row?.tap_agent_id, "agt_99");
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T3-03",
  "F10+F8",
  3,
  { pendingMilestone: "M2", pendingReason: "x402GateMiddleware does not invoke EdgeRateLimiter.next_fee_sequence yet" },
  async () => {
    const h = createHarness();
    try {
      await h.db.prepare("UPDATE tenants SET mcp_mode = 'codemode', settled_call_sequence = 32 WHERE subdomain = 'demo'").run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      const stub = h.rateLimiter.get(h.rateLimiter.idFromName("ten_port4_sandbox:fee_seq"));
      // Even if DO is at 32, next call hits 33rd fee split
      const r402 = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "code", arguments: { code: "async () => 1" } } })
      });
      assert.equal(r402.status, 402);
      const j402 = await r402.json();
      assert.equal(j402.x402.accepts[0].extra.isPlatformFee, true);
      assert.equal(j402.x402.accepts[0].payTo, h.env.PORT4_TREASURY_WALLET);
    } finally {
      h.close();
    }
  }
);

registerTest("T3-04", "F7+F10", 3, async () => {
  const h = createHarness();
  try {
    const { jwk, signJwt } = makeRsaJwksFixture("kid_t304");
    const team = `t304-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
    const aud = "aud_t304_123456789012";
    await h.db
      .prepare("UPDATE tenants SET auth_mode = 'x402+oauth_v2', mcp_mode = 'openapi_codemode', cf_access_team_domain = ?, cf_access_aud = ? WHERE subdomain = 'demo'")
      .bind(team, aud)
      .run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt({ iss: `https://${team}`, aud, exp: now + 300, email: "a@b.c" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "quote" } } });

    const r401 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    assert.equal(r401.status, 401);

    await withMockFetch(
      async () => Response.json({ keys: [jwk] }),
      async () => {
        const r200 = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt },
          body
        });
        assert.equal(r200.status, 200);
        assert.ok((await r200.json()).result.content[0].text.includes("market_quote"));
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T3-05", "F8+F9", 3, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    const wallets = [
      { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      { network: "eip155:84532", address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" }
    ];
    await h.db
      .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, payout_wallets_json, network) VALUES ('ten_multi', ?, 'multi', 'Multi', 'https://up.example', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', ?, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')")
      .bind(u.id, JSON.stringify(wallets))
      .run();
    await h.db
      .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_multi', 'ten_multi', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
      .run();

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
    const r402 = await h.callApp("https://port4.dev/mcp/multi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    assert.equal(r402.status, 402);
    assert.ok(r402.headers.get("www-authenticate")?.startsWith("Payment "));
    assert.equal((await r402.json()).x402.accepts.length, 2);

    const svmSig = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payload: { transaction: "svm_base64_signed_tx_longer_than_16_chars_123456" }
      })
    ).toString("base64");

    await withMockFetch(
      async (url) => {
        if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: "SolPayer11111111111111111111111111111111" });
        if (url.endsWith("/settle")) return Response.json({ success: true, transaction: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp_sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
        return Response.json({ solanaOk: true });
      },
      async () => {
        const r200 = await h.callApp("https://port4.dev/mcp/multi", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": svmSig },
          body
        });
        assert.equal(r200.status, 200);
        assert.ok(r200.headers.get("payment-response"));
      }
    );
  } finally {
    h.close();
  }
});

registerTest(
  "T3-06",
  "F11+F3+F4",
  3,
  { pendingMilestone: "M3", pendingReason: "api.ts sub-routes must return 404 after tenant soft-delete" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      const created = await (
        await h.callApp("https://port4.dev/api/tenants", {
          method: "POST",
          headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            subdomain: "softpair",
            name: "SoftPair",
            upstream_base_url: "https://api.softpair.example",
            payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
          })
        })
      ).json();
      const tid = created.tenant.id;
      await h.db
        .prepare("INSERT INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status) VALUES ('tx_sp_1', ?, 'ping', '0x1111111111111111111111111111111111111111', '1000', '0.001', 'eip155:84532', '0x1', 'settled')")
        .bind(tid)
        .run();
      await h.callApp(`https://port4.dev/api/tenants/${tid}`, {
        method: "DELETE",
        headers: { Origin: "https://port4.dev", Cookie: u.cookie }
      });
      assert.equal(await h.kv.get("tenant:softpair"), null);
      assert.equal(
        (
          await h.callApp("https://port4.dev/mcp/softpair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
          })
        ).status,
        404
      );
      assert.equal((await h.callApp("https://port4.dev/mcp/softpair/openapi.json")).status, 404);
      assert.equal(
        (
          await h.callApp(`https://port4.dev/api/tenants/${tid}/tools`, {
            method: "POST",
            headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "t2", upstream_path: "/t2", price_usd: "0.001" })
          })
        ).status,
        404
      );
      assert.equal(await h.db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE tenant_id = ?").bind(tid).first("c"), 1);
    } finally {
      h.close();
    }
  }
);

registerTest("T3-07", "F5+F6+F8", 3, async () => {
  const h = createHarness();
  try {
    await h.db.prepare("UPDATE tenants SET rate_limit_rpm = 1, require_visa_tap = 1 WHERE subdomain = 'demo'").run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const agent = makeEd25519Agent("agt_rl");
    const signed = signTapRequest({ agent, authority: "port4.dev", pathName: "/mcp/demo", tag: "agent-browser-auth" });

    let registryCalls = 0;
    await withMockFetch(
      async () => {
        registryCalls += 1;
        return Response.json(agent.listing);
      },
      async () => {
        // 1st call succeeds and consumes RPM=1 and TAP nonce
        const r1 = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { ...signed.headers, "CF-Connecting-IP": "198.51.100.88" },
          body: signed.rawBody
        });
        assert.equal(r1.status, 200);

        // 2nd call with fresh nonce from same IP hits 429 BEFORE TAP or ReplayGuard runs
        const signed2 = signTapRequest({ agent, authority: "port4.dev", pathName: "/mcp/demo", tag: "agent-browser-auth" });
        const r429 = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { ...signed2.headers, "CF-Connecting-IP": "198.51.100.88" },
          body: signed2.rawBody
        });
        assert.equal(r429.status, 429);
        assert.equal(registryCalls, 1);

        // signed2 nonce was never consumed, so calling from another IP succeeds
        const rOtherIp = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { ...signed2.headers, "CF-Connecting-IP": "198.51.100.89" },
          body: signed2.rawBody
        });
        assert.equal(rOtherIp.status, 200);
      }
    );
  } finally {
    h.close();
  }
});

registerTest(
  "T3-08",
  "F6+F5",
  3,
  { pendingMilestone: "M2", pendingReason: "Chunked >64 KiB stream must abort at mcpHeadersMiddleware before TAP" },
  async () => {
    const h = createHarness();
    try {
      await h.db.prepare("UPDATE tenants SET require_visa_tap = 1 WHERE subdomain = 'demo'").run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      let chunks = 0;
      const huge = new ReadableStream({
        pull(c) {
          chunks += 1;
          if (chunks > 20) return c.close();
          c.enqueue(new TextEncoder().encode("b".repeat(8192)));
        }
      });
      let registryCalls = 0;
      await withMockFetch(
        async () => {
          registryCalls += 1;
          return new Response("", { status: 500 });
        },
        async () => {
          const res = await h.callApp(
            new Request("https://port4.dev/mcp/demo", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Signature-Input": "sig2=..." },
              body: huge,
              duplex: "half"
            })
          );
          assert.equal(res.status, 413);
          assert.equal(registryCalls, 0);
          assert.ok(chunks < 15);
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest("T3-09", "F11+F3+F4", 3, async () => {
  const h = createHarness();
  try {
    const admin = await h.seedUser({ isAdmin: 1 });
    await kvSyncMod.syncTenantToKv(h.env, "demo");

    await h.callApp("https://port4.dev/api/admin/tenants/demo/status", {
      method: "PATCH",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" })
    });
    const r404 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(r404.status, 404);

    await h.callApp("https://port4.dev/api/admin/tenants/demo/status", {
      method: "PATCH",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" })
    });
    const r200 = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(r200.status, 200);
  } finally {
    h.close();
  }
});

registerTest("T3-10", "F11+F3+F8", 3, async () => {
  const h = createHarness();
  try {
    const admin = await h.seedUser({ isAdmin: 1 });
    await h.callApp("https://port4.dev/api/admin/users/usr_port4_sandbox/plan", {
      method: "PATCH",
      headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" })
    });
    const tenant = await kvSyncMod.resolveTenant(h.env, "demo");
    assert.equal(tenant.owner_plan, "pro");
    assert.ok(tenant.rate_limit_rpm >= 600);
    assert.equal(x402GateMod.computeFeeSplit(h.env, tenant, 33).isPlatformFee, false);
    assert.equal(x402GateMod.computeFeeSplit(h.env, tenant, 100).isPlatformFee, true);
  } finally {
    h.close();
  }
});

registerTest("T3-11", "F11+F10", 3, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    const enc = await cryptoMod.encryptSecretAtRest("vendor_super_secret_key", h.env.JWT_SECRET);
    await h.db
      .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, mcp_mode, upstream_auth_type, upstream_auth_header, upstream_auth_secret, upstream_signing_secret) VALUES ('ten_cm_sec', ?, 'cmsec', 'CmSec', 'https://vendor.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532', 'codemode', 'api_key_header', 'X-Vendor-Key', ?, 'p4_whsec_cm')")
      .bind(u.id, enc)
      .run();
    await h.db
      .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_cm_1', 'ten_cm_sec', 'ping_vendor', 'p', 'POST', '/v1/ping', '{}', '0.001', '1000')")
      .run();

    const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "10000" });
    const sawVendorHeaders = [];
    await withMockFetch(
      async (url, init) => {
        if (url.endsWith("/verify")) return Response.json({ isValid: true });
        if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"77".repeat(32)}`, network: "eip155:84532" });
        sawVendorHeaders.push(init?.headers);
        return Response.json({ vendor: "ok" });
      },
      async () => {
        const res = await h.callApp("https://port4.dev/mcp/cmsec", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "code",
              arguments: {
                code: "async () => { const a = await codemode.ping_vendor({}); const b = await codemode.ping_vendor({}); return { a, b }; }"
              }
            }
          })
        });
        assert.equal(res.status, 200);
        assert.equal(sawVendorHeaders.length, 2);
        assert.equal(sawVendorHeaders[0]["X-Vendor-Key"], "vendor_super_secret_key");
        assert.ok(sawVendorHeaders[0]["X-Port4-Signature"]?.startsWith("v1="));
      }
    );
  } finally {
    h.close();
  }
});

registerTest(
  "T3-12",
  "F11+F9+F10",
  3,
  { pendingMilestone: "M2", pendingReason: "buildTenantOpenApiDocument must respect openapi_codemode without # fragments" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      const created = await (
        await h.callApp("https://port4.dev/api/tenants", {
          method: "POST",
          headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            subdomain: "oa312",
            name: "OA312",
            upstream_base_url: "https://api.oa312.example",
            payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
          })
        })
      ).json();
      const spec = {
        openapi: "3.0.0",
        paths: {
          "/a": { get: { operationId: "op_a" } },
          "/b": { post: { operationId: "op_b" } },
          "/c": { get: { operationId: "op_c" } },
          "/d": { post: { operationId: "op_d" } },
          "/e": { delete: { operationId: "op_e" } }
        }
      };
      const imp = await h.callApp(`https://port4.dev/api/tenants/${created.tenant.id}/import-openapi`, {
        method: "POST",
        headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ spec, mcp_mode: "openapi_codemode", default_price_usd: "0.005" })
      });
      assert.equal(imp.status, 200);
      assert.equal((await imp.json()).imported_count, 5);

      const list = await (
        await h.callApp("https://port4.dev/mcp/oa312", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        })
      ).json();
      assert.deepEqual(
        list.result.tools.map((t) => t.name),
        ["search", "execute"]
      );

      const oaDoc = await (await h.callApp("https://port4.dev/mcp/oa312/openapi.json")).json();
      for (const k of Object.keys(oaDoc.paths)) {
        assert.equal(k.includes("#"), false);
      }
      assert.ok(JSON.stringify(oaDoc.paths).includes('"execute"'));
    } finally {
      h.close();
    }
  }
);

registerTest("T3-13", "F13+F7+F8", 3, async () => {
  const { Port4BudgetGuard, forwardToPort4Edge } = await import(
    pathToFileURL(path.join(ROOT, "packages", "port4-mcp", "bin", "port4-mcp.mjs")).href
  );
  const seenHeaders = [];
  const guard = new Port4BudgetGuard("0.05", "0.20");
  const challenge = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:84532", amount: "20000", payTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", extra: { priceUsd: "0.02" } }]
  };
  let attempt = 0;
  const reply = await forwardToPort4Edge(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "quote", arguments: {} } },
    {
      url: "https://port4.dev/mcp/ent",
      privateKey: `0x${"11".repeat(32)}`,
      network: "eip155:84532",
      cfAccessClientId: "cid_ent",
      cfAccessClientSecret: "csec_ent",
      paymentSignature: ""
    },
    guard,
    async (_url, init) => {
      seenHeaders.push(init.headers);
      if (++attempt === 1) return new Response(JSON.stringify({ x402: challenge }), { status: 402 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    },
    async () => ({ ok: true, header: "signed_evm_v2" })
  );
  assert.equal(reply.result.ok, true);
  assert.equal(seenHeaders[0]["CF-Access-Client-Id"], "cid_ent");
  assert.equal(seenHeaders[1]["CF-Access-Client-Id"], "cid_ent");
  assert.equal(seenHeaders[1]["PAYMENT-SIGNATURE"], "signed_evm_v2");
  assert.equal(guard.committedAtomic, 20_000n);
});

registerTest(
  "T3-14",
  "F10+F8",
  3,
  { pendingMilestone: "M3", pendingReason: "Failed Code Mode must complete PaymentReplayGuard so replay is cached isError: true" },
  async () => {
    const h = createHarness();
    try {
      await h.db.prepare("UPDATE tenants SET mcp_mode = 'codemode' WHERE subdomain = 'demo'").run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      const paySig = makeEvmPaymentHeader({
        to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        value: "10000",
        mode: "port4-sandbox-demo",
        jwtSecret: h.env.JWT_SECRET
      });
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "code", arguments: { code: 'async () => { throw new Error("script_err"); }' } }
      });
      const r1 = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
        body
      });
      assert.equal(r1.status, 200);
      assert.equal((await r1.json()).result?.isError, true);

      const r2 = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
        body
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get("x-port4-idempotent-replay"), "true");
      assert.equal((await r2.json()).result?.isError, true);
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T3-15",
  "F11+F10",
  3,
  { pendingMilestone: "M3", pendingReason: "test-call does not dispatch source_type === 'mcp' as JSON-RPC 2.0" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      const created = await (
        await h.callApp("https://port4.dev/api/tenants", {
          method: "POST",
          headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            subdomain: "mcpsync15",
            name: "McpSync15",
            upstream_base_url: "https://remote-mcp.example",
            payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
          })
        })
      ).json();
      const tid = created.tenant.id;
      let sawTestCallMethod = null;
      await withMockFetch(
        async (_url, init) => {
          const parsed = JSON.parse(init?.body ?? "{}");
          if (parsed.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: 1,
              result: { tools: [{ name: "remote_tool", description: "Remote", inputSchema: { type: "object" } }] }
            });
          }
          sawTestCallMethod = parsed.method;
          return Response.json({ jsonrpc: "2.0", id: parsed.id, result: { ok: "from_remote" } });
        },
        async () => {
          await h.callApp(`https://port4.dev/api/tenants/${tid}/sync-mcp`, {
            method: "POST",
            headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ default_price_usd: "0.025", mcp_path: "/mcp" })
          });
          await h.db.prepare("UPDATE tools SET price_usd = '0.099', price_atomic = '99000' WHERE tenant_id = ? AND name = 'remote_tool'").bind(tid).run();
          await h.callApp(`https://port4.dev/api/tenants/${tid}/sync-mcp`, {
            method: "POST",
            headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ default_price_usd: "0.005", mcp_path: "/mcp" })
          });
          const tl = await h.db.prepare("SELECT price_usd FROM tools WHERE tenant_id = ? AND name = 'remote_tool'").bind(tid).first();
          assert.equal(tl.price_usd, "0.099");

          const tc = await h.callApp(`https://port4.dev/api/tenants/${tid}/test-call`, {
            method: "POST",
            headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ tool_name: "remote_tool", arguments: {} })
          });
          assert.equal(tc.status, 200);
          assert.equal(sawTestCallMethod, "tools/call");
        }
      );
    } finally {
      h.close();
    }
  }
);

// ===========================================================================
// TIER 4 — Real-World Application Scenarios (7 End-to-End Flows)
// ===========================================================================
registerTest("T4-01", "E2E-01", 4, async () => {
  const h = createHarness();
  try {
    const u = await h.seedUser();
    const keyJson = await (
      await h.callApp("https://port4.dev/api/keys", {
        method: "POST",
        headers: { Origin: "https://port4.dev", Cookie: u.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E Deploy Key" })
      })
    ).json();
    const apiKey = keyJson.secret;

    const createRes = await h.callApp("https://port4.dev/api/tenants", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: "e2e01",
        name: "E2E01 API",
        upstream_base_url: "https://up-e2e01.example",
        payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      })
    });
    assert.equal(createRes.status, 201);
    const tenant = (await createRes.json()).tenant;

    const impRes = await h.callApp(`https://port4.dev/api/tenants/${tenant.id}/import-openapi`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        default_price_usd: "0.002",
        spec: {
          openapi: "3.0.0",
          paths: { "/quote": { post: { operationId: "get_quote", summary: "Quote" } } }
        }
      })
    });
    assert.equal(impRes.status, 200);

    const listRes = await h.callApp("https://port4.dev/mcp/e2e01", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get("cache-control"), "public, max-age=300");

    const callBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_quote", arguments: {} } });
    const unpaid = await h.callApp("https://port4.dev/mcp/e2e01", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: callBody
    });
    assert.equal(unpaid.status, 402);
    assert.ok(unpaid.headers.get("payment-required"));

    let upstreamHits = 0;
    let sawPort4Sig = null;
    const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "2000" });
    await withMockFetch(
      async (url, init) => {
        if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: "0x1111111111111111111111111111111111111111" });
        if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"e1".repeat(32)}`, network: "eip155:84532" });
        upstreamHits += 1;
        sawPort4Sig = init?.headers?.["X-Port4-Signature"];
        return Response.json({ price: 3500 });
      },
      async () => {
        const paid = await h.callApp("https://port4.dev/mcp/e2e01", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
          body: callBody
        });
        assert.equal(paid.status, 200);
        assert.ok(paid.headers.get("payment-response"));
        assert.ok(sawPort4Sig?.startsWith("v1="));

        const replay = await h.callApp("https://port4.dev/mcp/e2e01", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
          body: callBody
        });
        assert.equal(replay.status, 200);
        assert.equal(replay.headers.get("x-port4-idempotent-replay"), "true");
        assert.equal(upstreamHits, 1);
      }
    );

    // Process queue metering + duplicate delivery check
    const msg = h.queue.sent[0];
    await workerEntry.queue(h.queue.drainToBatch(), h.env);
    await h.queue.send(msg);
    await workerEntry.queue(h.queue.drainToBatch(), h.env);

    const ledgerRes = await h.callApp("https://port4.dev/api/ledger", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    assert.equal(ledgerRes.status, 200);
    const ledger = await ledgerRes.json();
    assert.equal(ledger.summary.total_calls, 1);
    assert.equal(ledger.transactions.length, 1);
  } finally {
    h.close();
  }
});

registerTest(
  "T4-02",
  "E2E-02",
  4,
  { pendingMilestone: "M3", pendingReason: "tapAgentId must flow from TAP verification through Code Mode into D1 transactions" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network, mcp_mode, require_visa_tap, upstream_signing_secret) VALUES ('ten_e2e02', ?, 'e2e02', 'E2E02', 'https://up-e2e02.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532', 'codemode', 1, 'p4_whsec_e2e02')")
        .bind(u.id)
        .run();
      await h.db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_e2e02', 'ten_e2e02', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
        .run();

      const rawBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "code", arguments: { code: "async () => { const a = await codemode.ping({}); const b = await codemode.ping({}); return { a, b }; }" } }
      });

      // Missing TAP -> 403 tap_missing
      const rMissing = await h.callApp("https://port4.dev/mcp/e2e02", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody
      });
      assert.equal(rMissing.status, 403);
      assert.equal((await rMissing.json()).code, "tap_missing");

      const agent = makeEd25519Agent("agt_e2e02");
      const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "10000" });
      const signed = signTapRequest({
        agent,
        authority: "port4.dev",
        pathName: "/mcp/e2e02",
        rawBody,
        tag: "agent-payer-auth",
        extraHeaders: { "payment-signature": paySig }
      });
      const seenUpstream = [];
      await withMockFetch(
        async (url, init) => {
          if (url.includes("/v1/tap/registry/keys/")) return Response.json(agent.listing);
          if (url.endsWith("/verify")) return Response.json({ isValid: true });
          if (url.endsWith("/settle")) return Response.json({ success: true, transaction: `0x${"e2".repeat(32)}`, network: "eip155:84532" });
          seenUpstream.push(init?.headers);
          return Response.json({ ok: true });
        },
        async () => {
          const rOk = await h.callApp("https://port4.dev/mcp/e2e02", { method: "POST", headers: signed.headers, body: rawBody });
          assert.equal(rOk.status, 200);
          assert.equal(seenUpstream.length, 2);
          assert.equal(seenUpstream[0]["X-Port4-Tap-Verified"], "true");
          assert.equal(seenUpstream[0]["X-Port4-Tap-Agent-Id"], "agt_e2e02");
          assert.ok(seenUpstream[0]["X-Port4-Signature"]?.startsWith("v1="));

          // Replay same TAP nonce -> 403 tap_replayed
          const rReplay = await h.callApp("https://port4.dev/mcp/e2e02", { method: "POST", headers: signed.headers, body: rawBody });
          assert.equal(rReplay.status, 403);
          assert.equal((await rReplay.json()).code, "tap_replayed");
        }
      );

      await workerEntry.queue(h.queue.drainToBatch(), h.env);
      const txRow = await h.db.prepare("SELECT tap_agent_id FROM transactions WHERE tenant_id = 'ten_e2e02'").first();
      assert.equal(txRow?.tap_agent_id, "agt_e2e02");
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T4-03",
  "E2E-03",
  4,
  { pendingMilestone: "M2", pendingReason: "Tempo OUSD MPP OpenAPI paths + Authorization: Payment settlement + Payment-Receipt" },
  async () => {
    const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
    try {
      const oaRes = await h.callApp("https://port4.dev/mcp/demo/openapi.json");
      assert.equal(oaRes.status, 200);
      const oa = await oaRes.json();
      for (const k of Object.keys(oa.paths)) {
        assert.equal(k.includes("#"), false);
      }
      assert.ok(JSON.stringify(oa.paths).includes(mppTempoMod.TEMPO_OUSD_ADDRESS));

      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "market_quote", arguments: { symbol: "ETH-USD" } } });
      const r402 = await h.callApp("https://port4.dev/mcp/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      assert.equal(r402.status, 402);
      const wwwAuth = r402.headers.get("www-authenticate");
      assert.ok(wwwAuth?.startsWith("Payment "));
      const reqB64 = /request="([^"]+)"/.exec(wwwAuth)[1];
      const reqDecoded = mppTempoMod.decodeBase64UrlJson(reqB64);

      const mppHeader = makeMppAuthHeader({
        challengeId: /id="([^"]+)"/.exec(wwwAuth)[1],
        txHash: `0x${"e3".repeat(32)}`,
        amount: reqDecoded.amount,
        currency: reqDecoded.currency,
        recipient: reqDecoded.recipient,
        chainId: reqDecoded.methodDetails.chainId,
        payer: "0x1111111111111111111111111111111111111111"
      });
      await withMockFetch(
        async () =>
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              status: "0x1",
              transactionHash: `0x${"e3".repeat(32)}`,
              logs: [
                makeTempoOusdTransferLog(
                  "0x1111111111111111111111111111111111111111",
                  reqDecoded.recipient,
                  reqDecoded.amount
                )
              ]
            }
          }),
        async () => {
          const r200 = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: mppHeader },
            body
          });
          assert.equal(r200.status, 200);
          assert.ok(r200.headers.get("payment-receipt"));
        }
      );
      await workerEntry.queue(h.queue.drainToBatch(), h.env);
      const cnt = await h.db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE tenant_id = 'ten_port4_sandbox'").first("c");
      assert.ok(cnt >= 1);
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T4-04",
  "E2E-04",
  4,
  { pendingMilestone: "M2", pendingReason: "JWKS key rotation retry on unknown kid during x402+oauth_v2 session" },
  async () => {
    const h = createHarness();
    try {
      const k1 = makeRsaJwksFixture("kid_e2e4_1");
      const k2 = makeRsaJwksFixture("kid_e2e4_2");
      const team = `e2e4-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
      const aud = "aud_e2e4_123456789012";
      await h.db
        .prepare("UPDATE tenants SET auth_mode = 'x402+oauth_v2', mcp_mode = 'openapi_codemode', cf_access_team_domain = ?, cf_access_aud = ? WHERE subdomain = 'demo'")
        .bind(team, aud)
        .run();
      await kvSyncMod.invalidateTenantKv(h.env, "demo");
      const now = Math.floor(Date.now() / 1000);
      const jwt1 = k1.signJwt({ iss: `https://${team}`, aud, exp: now + 300, email: "ent@corp.com" });
      const jwt2 = k2.signJwt({ iss: `https://${team}`, aud, exp: now + 300, email: "ent@corp.com" });

      let jwksFetchCount = 0;
      await withMockFetch(
        async () => {
          jwksFetchCount += 1;
          return Response.json({ keys: jwksFetchCount === 1 ? [k1.jwk] : [k1.jwk, k2.jwk] });
        },
        async () => {
          // Prime JWKS with k1 via free search
          const s1 = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt1 },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "quote" } } })
          });
          assert.equal(s1.status, 200);

          // Rotate to k2 -> unpaid execute returns 402 (after JWKS rotation refresh succeeds)
          const r402 = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt2 },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute", arguments: { code: "async () => 1" } } })
          });
          assert.equal(r402.status, 402);

          const paySig = makeEvmPaymentHeader({
            to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
            value: "10000",
            mode: "port4-sandbox-demo",
            jwtSecret: h.env.JWT_SECRET
          });
          const r200 = await h.callApp("https://port4.dev/mcp/demo", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt2, "PAYMENT-SIGNATURE": paySig },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "execute", arguments: { code: 'async () => await codemode.market_quote({ symbol: "ETH-USD" })' } }
            })
          });
          assert.equal(r200.status, 200);
          assert.equal((await r200.json()).result.isError, false);
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest(
  "T4-05",
  "E2E-05",
  4,
  { pendingMilestone: "M3", pendingReason: "mcp.ts does not call mark_upstream_failed on transient 502 yet" },
  async () => {
    const h = createHarness();
    try {
      const u = await h.seedUser();
      await h.db
        .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_e2e05', ?, 'e2e05', 'E2E05', 'https://up-e2e05.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532')")
        .bind(u.id)
        .run();
      await h.db
        .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_e2e05', 'ten_e2e05', 'ping', 'p', 'POST', '/ping', '{}', '0.001', '1000')")
        .run();

      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });

      // Part A: /settle timeout -> settlement_pending (409), never retried
      let settleCalls = 0;
      const sigTimeout = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
      await withMockFetch(
        async (url) => {
          if (url.endsWith("/verify")) return Response.json({ isValid: true });
          if (url.endsWith("/settle")) {
            settleCalls += 1;
            throw new Error("ETIMEDOUT");
          }
          throw new Error(`Unexpected ${url}`);
        },
        async () => {
          const r1 = await h.callApp("https://port4.dev/mcp/e2e05", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sigTimeout },
            body
          });
          assert.equal(r1.status, 409);
          assert.equal((await r1.json()).error, "payment_settlement_pending");
          assert.equal(settleCalls, 1);

          const r2 = await h.callApp("https://port4.dev/mcp/e2e05", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sigTimeout },
            body
          });
          assert.equal(r2.status, 409);
          assert.equal(settleCalls, 1);
        }
      );

      // Part B: /settle succeeds, upstream 502 -> settled_pending_upstream, immediate retry skips facilitator
      let facCalls = 0;
      let failUpstream = true;
      const sigUpstream = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "1000" });
      await withMockFetch(
        async (url) => {
          if (url.endsWith("/verify")) {
            facCalls += 1;
            return Response.json({ isValid: true });
          }
          if (url.endsWith("/settle")) {
            facCalls += 1;
            return Response.json({ success: true, transaction: `0x${"e5".repeat(32)}`, network: "eip155:84532" });
          }
          if (failUpstream) return new Response("Bad Gateway", { status: 502 });
          return Response.json({ recovered: true });
        },
        async () => {
          const r502 = await h.callApp("https://port4.dev/mcp/e2e05", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sigUpstream },
            body
          });
          assert.equal(r502.status, 502);
          assert.equal(facCalls, 2);

          facCalls = 0;
          failUpstream = false;
          const r200 = await h.callApp("https://port4.dev/mcp/e2e05", {
            method: "POST",
            headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sigUpstream },
            body
          });
          assert.equal(r200.status, 200);
          assert.equal(facCalls, 0);
        }
      );
    } finally {
      h.close();
    }
  }
);

registerTest("T4-06", "E2E-06", 4, async () => {
  // Verify scripts/test-local-e2e.mjs syntax + run STDIO CLI bridge against live in-process app.fetch HTTP server
  execFileSync(process.execPath, ["--check", path.join(ROOT, "scripts", "test-local-e2e.mjs")], {
    cwd: ROOT,
    stdio: "pipe"
  });

  const h = createHarness();
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyBuf = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const cfReq = new Request(`https://port4.dev${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: bodyBuf })
    });
    const cfRes = await h.callApp(cfReq);
    res.writeHead(cfRes.status, Object.fromEntries(cfRes.headers.entries()));
    res.end(Buffer.from(await cfRes.arrayBuffer()));
  });

  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "cli", "port4-mcp.mjs"),
      "--url",
      `http://127.0.0.1:${port}/mcp/demo`,
      "--max-per-call-usd",
      "0.0005"
    ],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }
  );
  try {
    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    const nextLine = () => new Promise((resolve) => rl.once("line", (l) => resolve(JSON.parse(l))));

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } }) + "\n");
    assert.equal((await nextLine()).result?.serverInfo?.name, "port4-mcp-bridge");

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const list = await nextLine();
    assert.ok(list.result.tools.some((t) => t.name === "market_quote"));

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "market_quote", arguments: { symbol: "ETH-USD" } } }) + "\n");
    const callRes = await nextLine();
    assert.equal(callRes.result?.isError, true);
    assert.equal(JSON.parse(callRes.result.content[0].text).budgetGuard?.allowed, false);
    rl.close();
  } finally {
    child.stdin.end();
    child.kill();
    srv.close();
    h.close();
  }
});

registerTest(
  "T4-07",
  "E2E-07",
  4,
  { pendingMilestone: "M2", pendingReason: "Fee-split sequence must use DO next_fee_sequence rather than stale KV" },
  async () => {
    const h = createHarness();
    try {
      const admin = await h.seedUser({ isAdmin: 1 });
      const dev = await h.seedUser({ isAdmin: 0, plan: "free" });

      const created = await (
        await h.callApp("https://port4.dev/api/tenants", {
          method: "POST",
          headers: { Origin: "https://port4.dev", Cookie: dev.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            subdomain: "e2e07",
            name: "E2E07",
            upstream_base_url: "https://api.e2e07.example",
            payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
            initial_tool: { name: "ping", description: "p", upstream_path: "/ping", price_usd: "0.001" }
          })
        })
      ).json();
      const tid = created.tenant.id;

      assert.equal((await h.callApp("https://port4.dev/api/admin/stats", { headers: { Cookie: admin.cookie } })).status, 200);
      assert.equal((await h.callApp("https://port4.dev/api/admin/tenants", { headers: { Cookie: admin.cookie } })).status, 200);

      const upPlan = await h.callApp(`https://port4.dev/api/admin/users/${dev.id}/plan`, {
        method: "PATCH",
        headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" })
      });
      assert.equal((await upPlan.json()).fee_rate_pct, 1);

      await h.callApp("https://port4.dev/api/admin/tenants/e2e07/featured", {
        method: "PATCH",
        headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ is_featured: 1 })
      });
      const feat = await (await h.callApp("https://port4.dev/api/public/featured")).json();
      assert.ok(feat.featured.some((f) => f.slug === "e2e07"));

      // Suspend -> immediate 404 on /mcp/e2e07
      await h.callApp("https://port4.dev/api/admin/tenants/e2e07/status", {
        method: "PATCH",
        headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended" })
      });
      assert.equal(
        (
          await h.callApp("https://port4.dev/mcp/e2e07", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
          })
        ).status,
        404
      );

      // Re-activate, record a transaction, check fee-split DO counter, then soft-delete
      await h.callApp("https://port4.dev/api/admin/tenants/e2e07/status", {
        method: "PATCH",
        headers: { Origin: "https://port4.dev", Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" })
      });
      await h.db
        .prepare("INSERT INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status) VALUES ('tx_e2e07_1', ?, 'ping', '0x1111111111111111111111111111111111111111', '1000', '0.001', 'eip155:84532', '0xe7', 'settled')")
        .bind(tid)
        .run();

      // Advance DO paid sequence check on pro (interval=100): seed settled_call_sequence=99 and verify 100th call hits platform fee
      await h.db
        .prepare("UPDATE tenants SET settled_call_sequence = 99 WHERE id = ?")
        .bind(tid)
        .run();
      await kvSyncMod.invalidateTenantKv(h.env, "e2e07");
      const r402 = await (
        await h.callApp("https://port4.dev/mcp/e2e07", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
        })
      ).json();
      assert.equal(r402.x402.accepts[0].extra.isPlatformFee, true);
      assert.equal(r402.x402.accepts[0].payTo, h.env.PORT4_TREASURY_WALLET);

      // Soft delete preserves historical transactions in /api/admin/transactions
      await h.callApp(`https://port4.dev/api/tenants/${tid}`, {
        method: "DELETE",
        headers: { Origin: "https://port4.dev", Cookie: dev.cookie }
      });
      const admTx = await (await h.callApp("https://port4.dev/api/admin/transactions", { headers: { Cookie: admin.cookie } })).json();
      assert.ok(admTx.transactions.some((tx) => tx.id === "tx_e2e07_1"));
    } finally {
      h.close();
    }
  }
);

// ---------------------------------------------------------------------------
// 3b. Hardening & Feature-Completeness Regression Suite (Audit Remediation)
// ---------------------------------------------------------------------------
registerTest("T5-SEC-01", "F11", 1, async () => {
  const h = createHarness();
  try {
    const dev = await h.seedUser({ isAdmin: 0 });
    const createKey = async (scopes) => {
      const res = await h.callApp("https://port4.dev/api/keys", {
        method: "POST",
        headers: { Origin: "https://port4.dev", Cookie: dev.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: scopes.join(","), scopes })
      });
      assert.equal(res.status, 201);
      return (await res.json()).secret;
    };

    const ledgerKey = await createKey(["ledger:read"]);
    const readKey = await createKey(["tenant:read"]);

    // ledger:read cannot read/write tenants or mint keys
    assert.equal((await h.callApp("https://port4.dev/api/tenants", { headers: { Authorization: `Bearer ${ledgerKey}` } })).status, 403);
    assert.equal((await h.callApp("https://port4.dev/api/tenants", { method: "POST", headers: { Authorization: `Bearer ${ledgerKey}`, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await h.callApp("https://port4.dev/api/keys", { headers: { Authorization: `Bearer ${ledgerKey}` } })).status, 403);
    assert.equal((await h.callApp("https://port4.dev/api/ledger", { headers: { Authorization: `Bearer ${ledgerKey}` } })).status, 200);

    // tenant:read can GET /tenants but cannot POST /tenants or GET /ledger
    assert.equal((await h.callApp("https://port4.dev/api/tenants", { headers: { Authorization: `Bearer ${readKey}` } })).status, 200);
    assert.equal((await h.callApp("https://port4.dev/api/tenants", { method: "POST", headers: { Authorization: `Bearer ${readKey}`, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await h.callApp("https://port4.dev/api/ledger", { headers: { Authorization: `Bearer ${readKey}` } })).status, 403);
  } finally {
    h.close();
  }
});

registerTest("T5-SEC-02", "F11", 1, async () => {
  const h = createHarness();
  try {
    const dev = await h.seedUser({ isAdmin: 0 });
    const createRes = await h.callApp("https://port4.dev/api/tenants", {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: dev.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: "sanitest",
        name: "SaniTest",
        upstream_base_url: "https://api.sanitest.example",
        payout_wallet: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        upstream_auth_type: "bearer",
        upstream_auth_secret: "super-secret-upstream-token"
      })
    });
    assert.equal(createRes.status, 201);
    const createJson = await createRes.json();
    assert.equal(createJson.tenant.upstream_signing_secret, undefined);
    assert.equal(createJson.tenant.upstream_auth_secret, undefined);
    assert.equal(createJson.tenant.has_upstream_auth_secret, true);

    const addToolRes = await h.callApp(`https://port4.dev/api/tenants/${createJson.tenant.id}/tools`, {
      method: "POST",
      headers: { Origin: "https://port4.dev", Cookie: dev.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "op1", http_method: "GET", upstream_path: "/v1/op1", price_usd: "0" })
    });
    assert.equal(addToolRes.status, 201);
    const addToolJson = await addToolRes.json();
    assert.equal(addToolJson.tenant.upstream_signing_secret, undefined);
    assert.equal(addToolJson.tenant.upstream_auth_secret, undefined);
    assert.equal(addToolJson.tenant.has_upstream_auth_secret, true);
  } finally {
    h.close();
  }
});

registerTest("T5-SEC-03", "F9", 1, async () => {
  const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
  try {
    const txHash = `0x${"cd".repeat(32)}`;
    const mpp = makeMppAuthHeader({
      challengeId: "ch_empty_logs",
      txHash,
      amount: "1000",
      currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      chainId: 42431,
      payer: "0x1111111111111111111111111111111111111111"
    });
    await withMockFetch(
      async () => Response.json({ jsonrpc: "2.0", id: 1, result: { status: "0x1", transactionHash: txHash, logs: [] } }),
      async () => {
        const res = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: mpp },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } })
        });
        assert.equal(res.status, 402);
        assert.equal((await res.json()).error, "tempo_ousd_transfer_log_missing");
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T5-SEC-04", "F9", 1, async () => {
  const h = createHarness({ TEMPO_RPC_URL: "https://tempo-rpc.example" });
  try {
    const txHash = `0x${"ef".repeat(32)}`;
    const mpp = makeMppAuthHeader({
      challengeId: "ch_pending_recover",
      txHash,
      amount: "1000",
      currency: mppTempoMod.TEMPO_OUSD_ADDRESS,
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      chainId: 42431,
      payer: "0x1111111111111111111111111111111111111111"
    });
    let mined = false;
    await withMockFetch(
      async () => {
        if (!mined) return Response.json({ jsonrpc: "2.0", id: 1, result: null });
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "0x1",
            transactionHash: txHash,
            logs: [
              makeTempoOusdTransferLog(
                "0x1111111111111111111111111111111111111111",
                "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                "1000"
              )
            ]
          }
        });
      },
      async () => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
        const r1 = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: mpp },
          body
        });
        assert.equal(r1.status, 409);
        assert.equal((await r1.json()).error, "payment_settlement_pending");

        mined = true;
        const r2 = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: mpp },
          body
        });
        assert.equal(r2.status, 200);
        assert.ok(r2.headers.get("payment-receipt"));
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T5-SEC-05", "F8", 1, async () => {
  const h = createHarness();
  try {
    let settleCalls = 0;
    const paySig = makeEvmPaymentHeader({ to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", value: "2000" });
    await withMockFetch(
      async (url) => {
        settleCalls += 1;
        throw new Error(`Facilitator must not be called for invalid args (${url})`);
      },
      async () => {
        // edge_dns_lookup requires `domain`; passing `{}` with PAYMENT-SIGNATURE must 400 BEFORE settling
        const res = await h.callApp("https://port4.dev/mcp/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paySig },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edge_dns_lookup", arguments: {} } })
        });
        assert.equal(res.status, 400);
        assert.equal(settleCalls, 0);
      }
    );
  } finally {
    h.close();
  }
});

registerTest("T5-SEC-06", "F11", 1, async () => {
  const h = createHarness();
  try {
    const res = await h.callApp("https://port4.dev/health");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'none'/);
    assert.ok(res.headers.get("strict-transport-security"));

    // Sandbox run updates usage_rollups cleanly
    const sbx = await h.callApp("https://port4.dev/api/sandbox/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "ping" })
    });
    assert.equal(sbx.status, 200);
    await h.flush();
    await workerEntry.queue(h.queue.drainToBatch(), h.env);
    const rollup = await h.db.prepare("SELECT call_count FROM usage_rollups WHERE tenant_id = 'ten_port4_sandbox'").first("call_count");
    assert.ok(Number(rollup) >= 1);
  } finally {
    h.close();
  }
});

registerTest("T5-PROTO-01", "F9", 1, async () => {
  const h = createHarness();
  try {
    // Advertised /openapi.json tool path routes cleanly for both 402 challenge and free $0 tool
    const r402 = await h.callApp("https://port4.dev/mcp/demo/tools/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" })
    });
    assert.equal(r402.status, 402);

    // MCP stateless ping
    const rPing = await h.callApp("https://port4.dev/mcp/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })
    });
    assert.equal(rPing.status, 200);
    assert.deepEqual(await rPing.json(), { jsonrpc: "2.0", id: 99, result: {} });

    // Free $0 direct tool
    await h.db
      .prepare("INSERT INTO tools (id, tenant_id, name, description, http_method, upstream_path, input_schema_json, price_usd, price_atomic) VALUES ('tl_free', 'ten_port4_sandbox', 'free_ping', 'Free ping', 'POST', '/ping', '{}', '0', '0')")
      .run();
    await kvSyncMod.invalidateTenantKv(h.env, "demo");
    const rFree = await h.callApp("https://port4.dev/mcp/demo/tools/free_ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "free" })
    });
    assert.equal(rFree.status, 200);
    const rFreeJson = await rFree.json();
    assert.equal(rFreeJson.result?._meta?.free, true);
  } finally {
    h.close();
  }
});

registerTest("T5-PROTO-02", "F7", 1, async () => {
  // OpenAPI $ref + PATCH + path-level params + YAML import
  const yamlSpec = `
openapi: "3.1.0"
paths:
  /items/{id}:
    parameters:
      - $ref: "#/components/parameters/ItemId"
    patch:
      operationId: update_item
      summary: Update item
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/UpdateBody"
components:
  parameters:
    ItemId:
      name: id
      in: path
      required: true
      schema:
        type: string
  schemas:
    UpdateBody:
      type: object
      required:
        - status
      properties:
        status:
          type: string
`;
  const tools = openapiImportMod.parseOpenApiSpecToTools(yamlSpec);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "update_item");
  assert.equal(tools[0].http_method, "PATCH");
  const schema = JSON.parse(tools[0].input_schema_json);
  assert.ok(schema.properties.id);
  assert.ok(schema.properties.status);
  assert.deepEqual(schema.required, ["id", "status"]);

  // Schema validator: pattern, nested object, array.items, oneOf
  const nestedSchema = JSON.stringify({
    type: "object",
    properties: {
      code: { type: "string", pattern: "^[A-Z]{3}$" },
      tags: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
      meta: { type: "object", required: ["env"], properties: { env: { oneOf: [{ const: "prod" }, { type: "string", enum: ["prod", "dev"] }] } } }
    }
  });
  assert.equal(schemaMod.validateToolArguments(nestedSchema, { code: "bad", tags: [1] }).ok, false);
  assert.equal(schemaMod.validateToolArguments(nestedSchema, { code: "ABC", tags: [0] }).ok, false);
  assert.equal(schemaMod.validateToolArguments(nestedSchema, { code: "ABC", tags: [1], meta: {} }).ok, false);
  assert.equal(schemaMod.validateToolArguments(nestedSchema, { code: "ABC", tags: [1], meta: { env: "dev" } }).ok, true);
});

registerTest("T5-OPS-01", "F11", 1, async () => {
  const h = createHarness({
    STRIPE_WEBHOOK_SECRET: "whsec_test_1234567890"
  });
  try {
    const dev = await h.seedUser({ isAdmin: 0 });
    const admin = await h.seedUser({ isAdmin: 1 });

    // Stripe webhook upgrades user to pro
    const evtBody = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: dev.id, customer: "cus_123" } }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await cryptoMod.hmacSha256Hex("whsec_test_1234567890", `${ts}.${evtBody}`);
    const hookRes = await h.callApp("https://port4.dev/api/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${ts},v1=${sig}` },
      body: evtBody
    });
    assert.equal(hookRes.status, 200);
    const updatedPlan = await h.db.prepare("SELECT plan FROM users WHERE id = ?").bind(dev.id).first("plan");
    assert.equal(updatedPlan, "pro");

    // Admin audit-logs + payment reconcile endpoints
    const alRes = await h.callApp("https://port4.dev/api/admin/audit-logs", {
      headers: { Cookie: admin.cookie }
    });
    assert.equal(alRes.status, 200);
    assert.ok((await alRes.json()).audit_logs.some((a) => a.action === "billing.plan_upgraded"));

    // Ledger export CSV formula injection protection
    await h.db
      .prepare("INSERT INTO tenants (id, user_id, subdomain, name, upstream_base_url, payout_wallet, network) VALUES ('ten_exp', ?, 'expten', 'Exp', 'https://exp.example', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'eip155:84532')")
      .bind(dev.id)
      .run();
    await h.db
      .prepare("INSERT INTO transactions (id, tenant_id, tool_name, payer_wallet, amount_atomic, amount_usd, network, tx_hash, status, latency_ms) VALUES ('tx_exp1', 'ten_exp', '=CMD()', '0x1111', '1000', '0.001', 'eip155:84532', '0xhash', 'settled', 5)")
      .run();
    const csvRes = await h.callApp("https://port4.dev/api/ledger/export?format=csv", {
      headers: { Cookie: dev.cookie }
    });
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('"\'=CMD()"'));
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Execute All Tests & Print Summary Table
// ---------------------------------------------------------------------------
async function runAll() {
  console.log(`Port4 Conformance & Integration Suite (mode=${MODE}, skipTypecheck=${SKIP_TYPECHECK})`);
  console.log(`Loaded ${tests.length} test cases across Tiers 1–4.\n`);

  const stats = {
    passed: 0,
    failed: 0,
    pending: 0,
    byTier: { 1: { pass: 0, fail: 0, pending: 0 }, 2: { pass: 0, fail: 0, pending: 0 }, 3: { pass: 0, fail: 0, pending: 0 }, 4: { pass: 0, fail: 0, pending: 0 } },
    byFeature: new Map(),
    failures: [],
    pendingList: []
  };

  const bumpFeature = (feat, kind) => {
    const cur = stats.byFeature.get(feat) ?? { pass: 0, fail: 0, pending: 0 };
    cur[kind] += 1;
    stats.byFeature.set(feat, cur);
  };

  for (const t of tests) {
    try {
      await t.fn();
      stats.passed += 1;
      stats.byTier[t.tier].pass += 1;
      bumpFeature(t.feature, "pass");
    } catch (err) {
      const isExpectedAssertion = err instanceof assert.AssertionError || err?.code === "ERR_ASSERTION";
      if (MODE === "baseline" && t.pendingMilestone && isExpectedAssertion) {
        stats.pending += 1;
        stats.byTier[t.tier].pending += 1;
        bumpFeature(t.feature, "pending");
        stats.pendingList.push({ id: t.id, milestone: t.pendingMilestone, reason: t.pendingReason });
        console.log(`[PENDING_${t.pendingMilestone}] ${t.id} (${t.feature}): ${t.pendingReason}`);
      } else {
        stats.failed += 1;
        stats.byTier[t.tier].fail += 1;
        bumpFeature(t.feature, "fail");
        const msg = err instanceof Error ? err.message : String(err);
        stats.failures.push({ id: t.id, feature: t.feature, tier: t.tier, pendingMilestone: t.pendingMilestone, msg });
        console.error(`[FAIL] ${t.id} (${t.feature}): ${msg}`);
      }
    }
  }

  console.log("\n=== Summary by Tier ===");
  for (const tier of [1, 2, 3, 4]) {
    const s = stats.byTier[tier];
    console.log(`  Tier ${tier}: pass=${s.pass}  fail=${s.fail}  pending=${s.pending}`);
  }

  console.log("\n=== Summary by Feature ===");
  for (const [feat, s] of stats.byFeature.entries()) {
    console.log(`  ${feat.padEnd(10)} pass=${String(s.pass).padEnd(3)} fail=${String(s.fail).padEnd(3)} pending=${s.pending}`);
  }

  console.log(`\nTOTAL: ${tests.length} | PASSED: ${stats.passed} | FAILED: ${stats.failed} | PENDING: ${stats.pending}`);

  if (stats.failed > 0) {
    process.exitCode = 1;
  } else if (MODE === "strict" && stats.pending > 0) {
    process.exitCode = 1;
  }
}

await runAll();
