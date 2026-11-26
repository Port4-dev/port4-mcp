import {
  DynamicWorkerExecutor,
  generateTypesFromJsonSchema,
  normalizeCode,
  sanitizeToolName,
  truncateResult,
  type JsonSchemaToolDescriptors
} from "@cloudflare/codemode";
import type { JSONSchema7 } from "json-schema";
import type { AppBindings, TenantRoutingRecord, ToolRecord } from "../types";
import { usdToAtomicUsdc } from "./crypto";
import { validateToolArguments } from "./schema-validator";

function parseJsonSchema(raw: string): JSONSchema7 {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JSONSchema7;
    }
  } catch {
    // fallback
  }
  return { type: "object", properties: {} };
}

function buildUniqueToolMap(tools: ToolRecord[]): Map<string, ToolRecord> {
  const map = new Map<string, ToolRecord>();
  tools.forEach((tool, idx) => {
    let safeName = sanitizeToolName(tool.name);
    if (map.has(safeName)) {
      safeName = `${safeName}_${idx + 1}`;
    }
    map.set(safeName, tool);
  });
  return map;
}

/**
 * Generates compact TypeScript declarations (`declare const codemode: { ... }`)
 * for a set of Port4 tenant tools using @cloudflare/codemode's JSON Schema generator.
 */
export function generateTenantCodeModeTypes(tools: ToolRecord[]): string {
  const descriptors: JsonSchemaToolDescriptors = {};
  const uniqueMap = buildUniqueToolMap(tools);
  for (const [safeName, tool] of uniqueMap.entries()) {
    descriptors[safeName] = {
      description: `${tool.description || tool.name} (${tool.http_method} ${tool.upstream_path}, $${tool.price_usd} USDC)`,
      inputSchema: parseJsonSchema(tool.input_schema_json)
    };
  }
  return generateTypesFromJsonSchema(descriptors);
}

/**
 * Progressive discovery for `openapi_codemode`: searches a tenant's tool catalog
 * and returns ranked matches + focused TypeScript declarations only for matched tools.
 */
export function searchTenantTools(
  tenant: TenantRoutingRecord,
  query: string,
  limit = 12
): {
  query: string;
  total: number;
  matches: Array<{
    name: string;
    sanitizedName: string;
    method: string;
    path: string;
    description: string;
    priceUsd: string;
  }>;
  types: string;
} {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const scored = tenant.tools
    .map((tool) => {
      const haystack = `${tool.name} ${tool.description} ${tool.upstream_path} ${tool.http_method}`.toLowerCase();
      if (terms.length === 0) return { tool, score: 1 };
      let score = 0;
      for (const term of terms) {
        if (tool.name.toLowerCase().includes(term)) score += 3;
        if (tool.upstream_path.toLowerCase().includes(term)) score += 2;
        if (haystack.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, Math.max(1, Math.min(25, limit))).map((s) => s.tool);

  return {
    query,
    total: scored.length,
    matches: top.map((t) => ({
      name: t.name,
      sanitizedName: sanitizeToolName(t.name),
      method: t.http_method,
      path: t.upstream_path,
      description: t.description,
      priceUsd: `$${t.price_usd}`
    })),
    types: top.length > 0 ? generateTenantCodeModeTypes(top) : "// No matching tools found."
  };
}

/**
 * Builds MCP `tools/list` definitions for Code Mode tenants:
 * - `codemode`: Single `code` tool with generated TS declarations for all tenant tools.
 * - `openapi_codemode`: Fixed-footprint `search` (free) + `execute` (paid) tools (~1,000 tokens).
 */
export function buildCodeModeMcpTools(
  tenant: TenantRoutingRecord,
  resolvedAsset: string
): Array<Record<string, unknown>> {
  const priceUsd = tenant.codemode_price_usd || "0.01";
  let priceAtomic = "10000";
  try {
    priceAtomic = usdToAtomicUsdc(priceUsd);
  } catch {
    priceAtomic = "10000";
  }

  const paidMeta = {
    x402: {
      scheme: "exact",
      network: tenant.network,
      asset: resolvedAsset,
      priceUsd: `$${priceUsd}`,
      amountAtomic: priceAtomic,
      payTo: tenant.payout_wallet
    }
  };

  if (tenant.mcp_mode === "openapi_codemode") {
    return [
      {
        name: "search",
        description: `Free progressive discovery across ${tenant.tools.length} tools on ${tenant.name}. Returns matching method names and TypeScript declarations for use inside the 'execute' tool.`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword(s) to search tool names, paths, and descriptions (leave empty to list top tools)."
            },
            limit: {
              type: "number",
              description: "Maximum tools to return (1-25, default 12)."
            }
          }
        },
        _meta: { free: true }
      },
      {
        name: "execute",
        description: `Execute an async JavaScript arrow function inside an isolated Cloudflare Dynamic Worker sandbox against ${tenant.name} tools via the typed 'codemode.*' namespace. Call 'search' first to discover method signatures. Max ${tenant.codemode_max_subcalls} upstream calls and $${priceUsd} USDC cumulative budget per execution.`,
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "Async arrow function using codemode.<toolName>(args), e.g. `async () => { return await codemode.ping({}); }`"
            }
          },
          required: ["code"]
        },
        _meta: paidMeta
      }
    ];
  }

  // Single `code` tool mode (`codemode`)
  const typeDecls = generateTenantCodeModeTypes(tenant.tools);
  return [
    {
      name: "code",
      description: [
        `Execute an async JavaScript arrow function inside an isolated Cloudflare Dynamic Worker sandbox for ${tenant.name}.`,
        `Compose multiple tool calls, loop, filter, and return only the final result (max ${tenant.codemode_max_subcalls} upstream calls and $${priceUsd} USDC cumulative budget per run).`,
        "",
        "Available typed methods on `codemode`:",
        "```ts",
        typeDecls,
        "```"
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Async arrow function using codemode.<toolName>(args), e.g. `async () => { const a = await codemode.my_tool({}); return a; }`"
          }
        },
        required: ["code"]
      },
      _meta: paidMeta
    }
  ];
}

/**
 * Executes model-written JavaScript inside an isolated Cloudflare Dynamic Worker
 * (`globalOutbound: null` — zero direct internet access, secrets never enter sandbox).
 * Enforces:
 * 1. Maximum subcall count (`tenant.codemode_max_subcalls`).
 * 2. Cumulative atomic USDC cost budget (`authorizedAtomicBudget`).
 * 3. JSON Schema argument validation before every subcall.
 */
export async function executeCodeModePlan(params: {
  env: AppBindings;
  tenant: TenantRoutingRecord;
  code: string;
  authorizedAtomicBudget: string;
  dispatchTool: (tool: ToolRecord, args: Record<string, unknown>, subcallIndex: number) => Promise<unknown>;
}): Promise<{
  ok: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
  subcalls: number;
  consumedAtomic: string;
  breakdown: Array<{ tool: string; atomic: string }>;
}> {
  const { env, tenant, code, authorizedAtomicBudget, dispatchTool } = params;

  if (!env.LOADER) {
    return {
      ok: false,
      error: "Dynamic Worker LOADER binding is not configured on this gateway.",
      subcalls: 0,
      consumedAtomic: "0",
      breakdown: []
    };
  }

  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 32_768) {
    return {
      ok: false,
      error: "Code must be a non-empty JavaScript async arrow function under 32 KiB.",
      subcalls: 0,
      consumedAtomic: "0",
      breakdown: []
    };
  }

  const maxSubcalls = Math.min(50, Math.max(1, tenant.codemode_max_subcalls || 10));
  const budgetCap = BigInt(/^\d+$/.test(authorizedAtomicBudget) ? authorizedAtomicBudget : "10000");
  let subcalls = 0;
  let consumedAtomic = 0n;
  const breakdown: Array<{ tool: string; atomic: string }> = [];

  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const uniqueMap = buildUniqueToolMap(tenant.tools);

  for (const [safeName, tool] of uniqueMap.entries()) {
    fns[safeName] = async (input?: unknown) => {
      subcalls += 1;
      if (subcalls > maxSubcalls) {
        throw new Error(
          `Code Mode sub-call limit exceeded (${maxSubcalls} max calls per execution).`
        );
      }

      const toolCost = BigInt(/^\d+$/.test(tool.price_atomic) ? tool.price_atomic : "1000");
      if (consumedAtomic + toolCost > budgetCap) {
        throw new Error(
          `Code Mode execution budget exceeded: tool '${tool.name}' costs ${toolCost.toString()} atomic units, exceeding remaining budget of ${(budgetCap - consumedAtomic).toString()} atomic units.`
        );
      }

      const argsObj =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};

      const argValidation = validateToolArguments(tool.input_schema_json, argsObj);
      if (!argValidation.ok) {
        throw new Error(`Invalid arguments for '${tool.name}': ${argValidation.error}`);
      }

      consumedAtomic += toolCost;
      breakdown.push({ tool: tool.name, atomic: toolCost.toString() });
      return dispatchTool(tool, argsObj, subcalls);
    };
  }

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: 15_000,
    globalOutbound: null
  });

  const normalized = normalizeCode(trimmed);
  const outcome = await executor.execute(normalized, [{ name: "codemode", fns }]);

  if (outcome.error) {
    return {
      ok: false,
      error: outcome.error,
      logs: outcome.logs,
      subcalls,
      consumedAtomic: consumedAtomic.toString(),
      breakdown
    };
  }

  return {
    ok: true,
    result: truncateResult(outcome.result, { maxTokens: 6000 }),
    logs: outcome.logs,
    subcalls,
    consumedAtomic: consumedAtomic.toString(),
    breakdown
  };
}
