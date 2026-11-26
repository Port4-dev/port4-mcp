/**
 * Lightweight, zero-dependency JSON Schema validator for MCP tool arguments
 * and outbound egress URL safety checks.
 */

interface JsonSchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
}

const MAX_SCHEMA_DEPTH = 8;
const MAX_PATTERN_LENGTH = 256;

function validateNode(
  node: JsonSchemaNode | undefined,
  val: unknown,
  path: string,
  depth: number
): { ok: true } | { ok: false; error: string } {
  if (!node || typeof node !== "object" || depth > MAX_SCHEMA_DEPTH) {
    return { ok: true };
  }

  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    let matches = 0;
    for (const sub of node.oneOf) {
      if (validateNode(sub, val, path, depth + 1).ok) {
        matches += 1;
      }
    }
    if (matches !== 1) {
      return {
        ok: false,
        error: `Argument '${path}' must match exactly one schema in oneOf.`
      };
    }
  }

  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    const anyMatch = node.anyOf.some((sub) => validateNode(sub, val, path, depth + 1).ok);
    if (!anyMatch) {
      return {
        ok: false,
        error: `Argument '${path}' does not match any schema in anyOf.`
      };
    }
  }

  const expectedTypes = Array.isArray(node.type)
    ? node.type
    : typeof node.type === "string"
      ? [node.type]
      : [];

  if (expectedTypes.length > 0) {
    const matchesType = expectedTypes.some((t) => {
      if (t === "string") return typeof val === "string";
      if (t === "number") return typeof val === "number" && Number.isFinite(val);
      if (t === "integer") return typeof val === "number" && Number.isInteger(val);
      if (t === "boolean") return typeof val === "boolean";
      if (t === "array") return Array.isArray(val);
      if (t === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
      if (t === "null") return val === null;
      return true;
    });
    if (!matchesType) {
      return {
        ok: false,
        error: `Argument '${path}' must be of type ${expectedTypes.join("|")}.`
      };
    }
  }

  if (node.const !== undefined && val !== node.const) {
    return {
      ok: false,
      error: `Argument '${path}' must equal ${JSON.stringify(node.const)}.`
    };
  }

  if (Array.isArray(node.enum) && !node.enum.includes(val)) {
    return {
      ok: false,
      error: `Argument '${path}' must be one of: ${node.enum.map(String).join(", ")}.`
    };
  }

  if (typeof val === "string") {
    if (typeof node.minLength === "number" && val.length < node.minLength) {
      return { ok: false, error: `Argument '${path}' must be at least ${node.minLength} characters.` };
    }
    if (typeof node.maxLength === "number" && val.length > node.maxLength) {
      return { ok: false, error: `Argument '${path}' exceeds maximum length of ${node.maxLength}.` };
    }
    if (typeof node.pattern === "string" && node.pattern.length <= MAX_PATTERN_LENGTH) {
      try {
        const re = new RegExp(node.pattern);
        if (!re.test(val)) {
          return { ok: false, error: `Argument '${path}' does not match required pattern.` };
        }
      } catch {
        // Ignore invalid author-supplied regexes
      }
    }
  }

  if (typeof val === "number") {
    if (typeof node.minimum === "number" && val < node.minimum) {
      return { ok: false, error: `Argument '${path}' must be >= ${node.minimum}.` };
    }
    if (typeof node.maximum === "number" && val > node.maximum) {
      return { ok: false, error: `Argument '${path}' must be <= ${node.maximum}.` };
    }
  }

  if (Array.isArray(val)) {
    if (typeof node.minItems === "number" && val.length < node.minItems) {
      return { ok: false, error: `Argument '${path}' must have at least ${node.minItems} items.` };
    }
    if (typeof node.maxItems === "number" && val.length > node.maxItems) {
      return { ok: false, error: `Argument '${path}' must have at most ${node.maxItems} items.` };
    }
    if (node.items && typeof node.items === "object") {
      for (let i = 0; i < val.length; i++) {
        const itemRes = validateNode(node.items, val[i], `${path}[${i}]`, depth + 1);
        if (!itemRes.ok) return itemRes;
      }
    }
  }

  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (Array.isArray(node.required)) {
      for (const reqKey of node.required) {
        if (typeof reqKey === "string" && (obj[reqKey] === undefined || obj[reqKey] === null)) {
          const fullKey = path === "$" ? reqKey : `${path}.${reqKey}`;
          return { ok: false, error: `Missing required argument '${fullKey}'.` };
        }
      }
    }

    const props = node.properties;
    if (props && typeof props === "object") {
      if (node.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            const fullKey = path === "$" ? key : `${path}.${key}`;
            return {
              ok: false,
              error: `Unexpected argument '${fullKey}' is not allowed by tool schema.`
            };
          }
        }
      }
      for (const [key, propSchema] of Object.entries(props)) {
        const childVal = obj[key];
        if (childVal === undefined || childVal === null) continue;
        const fullKey = path === "$" ? key : `${path}.${key}`;
        const childRes = validateNode(propSchema, childVal, fullKey, depth + 1);
        if (!childRes.ok) return childRes;
      }
    }
  }

  return { ok: true };
}

export function validateToolArguments(
  rawSchema: string,
  args: Record<string, unknown>
): { ok: true } | { ok: false; error: string } {
  let schema: JsonSchemaNode;
  try {
    const parsed = JSON.parse(rawSchema) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true };
    }
    schema = parsed as JsonSchemaNode;
  } catch {
    return { ok: true };
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "Tool arguments must be a JSON object." };
  }

  return validateNode(schema, args, "$", 0);
}

/**
 * Validates that an incoming MCP Origin header (if sent by a browser/local client)
 * is not attempting a localhost/private-network DNS rebinding attack against an edge gateway.
 */
export function isAllowedMcpOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    const url = new URL(originHeader);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      host.endsWith(".arpa") ||
      host === "0.0.0.0" ||
      /^169\.254\./.test(host) ||
      /^127\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
