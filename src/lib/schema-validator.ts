/**
 * Lightweight, zero-dependency JSON Schema validator for MCP tool arguments
 * and outbound egress URL safety checks.
 */

interface JsonSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export function validateToolArguments(
  rawSchema: string,
  args: Record<string, unknown>
): { ok: true } | { ok: false; error: string } {
  let schema: JsonSchemaObject;
  try {
    const parsed = JSON.parse(rawSchema) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true };
    }
    schema = parsed as JsonSchemaObject;
  } catch {
    return { ok: true };
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "Tool arguments must be a JSON object." };
  }

  if (Array.isArray(schema.required)) {
    for (const reqKey of schema.required) {
      if (typeof reqKey === "string" && (args[reqKey] === undefined || args[reqKey] === null)) {
        return { ok: false, error: `Missing required argument '${reqKey}'.` };
      }
    }
  }

  const props = schema.properties;
  if (props && typeof props === "object") {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(args)) {
        if (!(key in props)) {
          return { ok: false, error: `Unexpected argument '${key}' is not allowed by tool schema.` };
        }
      }
    }

    for (const [key, propSchema] of Object.entries(props)) {
      const val = args[key];
      if (val === undefined || val === null || !propSchema || typeof propSchema !== "object") {
        continue;
      }

      const expectedTypes = Array.isArray(propSchema.type)
        ? propSchema.type
        : typeof propSchema.type === "string"
          ? [propSchema.type]
          : [];

      if (expectedTypes.length > 0) {
        const matchesType = expectedTypes.some((t) => {
          if (t === "string") return typeof val === "string";
          if (t === "number") return typeof val === "number" && Number.isFinite(val);
          if (t === "integer") return typeof val === "number" && Number.isInteger(val);
          if (t === "boolean") return typeof val === "boolean";
          if (t === "array") return Array.isArray(val);
          if (t === "object") return typeof val === "object" && !Array.isArray(val);
          return true;
        });
        if (!matchesType) {
          return {
            ok: false,
            error: `Argument '${key}' must be of type ${expectedTypes.join("|")}.`
          };
        }
      }

      if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
        return {
          ok: false,
          error: `Argument '${key}' must be one of: ${propSchema.enum.map(String).join(", ")}.`
        };
      }

      if (typeof val === "string") {
        if (typeof propSchema.minLength === "number" && val.length < propSchema.minLength) {
          return { ok: false, error: `Argument '${key}' must be at least ${propSchema.minLength} characters.` };
        }
        if (typeof propSchema.maxLength === "number" && val.length > propSchema.maxLength) {
          return { ok: false, error: `Argument '${key}' exceeds maximum length of ${propSchema.maxLength}.` };
        }
      }

      if (typeof val === "number") {
        if (typeof propSchema.minimum === "number" && val < propSchema.minimum) {
          return { ok: false, error: `Argument '${key}' must be >= ${propSchema.minimum}.` };
        }
        if (typeof propSchema.maximum === "number" && val > propSchema.maximum) {
          return { ok: false, error: `Argument '${key}' must be <= ${propSchema.maximum}.` };
        }
      }
    }
  }

  return { ok: true };
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
