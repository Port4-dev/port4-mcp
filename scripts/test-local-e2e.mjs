/**
 * Port4 Local E2E Verification (`Flow E2E-06`)
 * Exercises real `workerd` (`wrangler dev`), real local D1 (`--local`),
 * and the STDIO-to-HTTP CLI bridge (`cli/port4-mcp.mjs`) end-to-end.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const WRANGLER_BIN = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate ephemeral port"));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function removeDirWithRetry(dirPath, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function waitForHealth(baseUrl, proc, getLogs, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `wrangler dev exited prematurely (code=${proc.exitCode}). Logs:\n${getLogs()}`
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000)
      });
      if (res.ok) {
        return res;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${baseUrl}/health.\nLogs:\n${getLogs()}`);
}

async function testStdioBridge(mcpUrl) {
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "cli", "port4-mcp.mjs"),
      "--url",
      mcpUrl,
      "--max-per-call-usd",
      "0.0005",
      "--max-session-usd",
      "0.01"
    ],
    {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString("utf8")));

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const lines = [];
  const waiters = [];

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed);
    if (waiters.length > 0) {
      waiters.shift()(parsed);
    } else {
      lines.push(parsed);
    }
  });

  const nextResponse = (timeoutMs = 15_000) => {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`STDIO bridge response timeout. stderr=${stderrChunks.join("")}`));
      }, timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };

  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2026-07-28" }
      }) + "\n"
    );
    const initRes = await nextResponse();
    assert.equal(initRes.id, 1);
    assert.equal(initRes.result?.serverInfo?.name, "port4-mcp-bridge");

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }) + "\n"
    );

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      }) + "\n"
    );
    const listRes = await nextResponse();
    assert.equal(listRes.id, 2);
    const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes("market_quote"), `Expected market_quote in ${JSON.stringify(toolNames)}`);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "market_quote", arguments: { symbol: "ETH-USD" } }
      }) + "\n"
    );
    const callRes = await nextResponse();
    assert.equal(callRes.id, 3);
    assert.equal(callRes.result?.isError, true, "Budget guard must flag isError=true when price exceeds maxPerCallUsd");
    const payload = JSON.parse(callRes.result.content[0].text);
    assert.equal(payload.status, 402);
    assert.equal(payload.paymentRequired, true);
    assert.equal(payload.budgetGuard?.allowed, false);
  } finally {
    rl.close();
    child.stdin.end();
    killProcessTree(child);
  }
}

async function main() {
  if (!fs.existsSync(WRANGLER_BIN)) {
    throw new Error(`Wrangler CLI not found at ${WRANGLER_BIN}`);
  }
  const distIndex = path.join(ROOT, "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `Static assets build missing at ${distIndex}. Run 'npm run build' before running test-local-e2e.mjs.`
    );
  }

  const persistDir = path.join(os.tmpdir(), `port4-local-e2e-${crypto.randomUUID()}`);
  fs.mkdirSync(persistDir, { recursive: true });
  let wranglerProc = null;
  const logLines = [];

  try {
    console.log(`[E2E-06] Applying local D1 migrations to ${persistDir}...`);
    execFileSync(
      process.execPath,
      [
        WRANGLER_BIN,
        "d1",
        "migrations",
        "apply",
        "port4-db",
        "--local",
        "--persist-to",
        persistDir,
        "-y"
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe"
      }
    );
    console.log("[E2E-06] PASS: Local D1 migrations (0001-0009) applied cleanly.");

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[E2E-06] Starting local wrangler dev on ${baseUrl}...`);

    wranglerProc = spawn(
      process.execPath,
      [
        WRANGLER_BIN,
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--inspector-port",
        "0",
        "--persist-to",
        persistDir
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    wranglerProc.stdout.on("data", (chunk) => logLines.push(chunk.toString("utf8")));
    wranglerProc.stderr.on("data", (chunk) => logLines.push(chunk.toString("utf8")));

    const healthRes = await waitForHealth(baseUrl, wranglerProc, () => logLines.join(""));
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.mcpSpec, "2026-07-28");
    assert.equal(healthJson.x402Version, 2);
    console.log("[E2E-06] PASS: GET /health -> 200 OK (mcpSpec=2026-07-28, x402Version=2)");

    const getMcpRes = await fetch(`${baseUrl}/mcp`);
    assert.equal(getMcpRes.status, 405);
    const getMcpJson = await getMcpRes.json();
    assert.equal(getMcpJson.error, "method_not_allowed");
    console.log("[E2E-06] PASS: GET /mcp -> 405 method_not_allowed");

    const openApiRes = await fetch(`${baseUrl}/mcp/demo/openapi.json`);
    assert.equal(openApiRes.status, 200);
    const openApiJson = await openApiRes.json();
    assert.equal(openApiJson.openapi, "3.1.0");
    assert.equal(openApiJson["x-port4-tenant"]?.subdomain, "demo");
    console.log("[E2E-06] PASS: GET /mcp/demo/openapi.json -> 200 OK (openapi=3.1.0)");

    const listRes = await fetch(`${baseUrl}/mcp/demo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    const names = (listJson.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("market_quote"));
    assert.ok(names.includes("edge_dns_lookup"));
    assert.ok(names.includes("ping"));
    console.log(`[E2E-06] PASS: POST /mcp/demo tools/list -> 200 (${names.join(", ")})`);

    const unpaidRes = await fetch(`${baseUrl}/mcp/demo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "market_quote"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "market_quote", arguments: { symbol: "ETH-USD" } }
      })
    });
    assert.equal(unpaidRes.status, 402);
    const payReqHeader = unpaidRes.headers.get("payment-required");
    const wwwAuthHeader = unpaidRes.headers.get("www-authenticate");
    assert.ok(payReqHeader, "402 response must include PAYMENT-REQUIRED header");
    assert.ok(wwwAuthHeader && wwwAuthHeader.startsWith("Payment "), "402 response must include WWW-Authenticate: Payment");
    const decodedPayReq = JSON.parse(Buffer.from(payReqHeader, "base64").toString("utf8"));
    assert.equal(decodedPayReq.x402Version, 2);
    console.log("[E2E-06] PASS: POST /mcp/demo unpaid tools/call -> 402 + PAYMENT-REQUIRED + WWW-Authenticate: Payment");

    const sandboxRes = await fetch(`${baseUrl}/api/sandbox/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "market_quote", arguments: { symbol: "ETH-USD" } })
    });
    assert.equal(sandboxRes.status, 200);
    const sandboxJson = await sandboxRes.json();
    assert.equal(sandboxJson.ok, true);
    assert.equal(sandboxJson.simulated, true);
    assert.equal(sandboxJson.basescanUrl, null);
    assert.equal(sandboxJson.step3_200?.status, 200);
    console.log("[E2E-06] PASS: POST /api/sandbox/run -> 200 OK (simulated=true, basescanUrl=null)");

    await testStdioBridge(`${baseUrl}/mcp/demo`);
    console.log("[E2E-06] PASS: STDIO CLI bridge (`cli/port4-mcp.mjs`) against local workerd passed.");

    console.log("ALL LOCAL E2E CHECKS (Flow E2E-06) PASSED!");
  } finally {
    killProcessTree(wranglerProc);
    await removeDirWithRetry(persistDir);
  }
}

await main();
