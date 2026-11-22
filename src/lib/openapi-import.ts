import { sanitizeToolName } from "@cloudflare/codemode";

export interface ImportedToolSpec {
  name: string;
  description: string;
  http_method: "GET" | "POST" | "PUT" | "DELETE";
  upstream_path: string;
  input_schema_json: string;
}

interface OpenApiParam {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParam[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

interface OpenApiDocument {
  openapi?: string;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

const ALLOWED_METHODS = ["get", "post", "put", "delete"] as const;

/**
 * Extracts Port4 tool definitions from an OpenAPI 3.x JSON document.
 * Safely caps at 100 operations per import to protect D1/KV sizes.
 */
export function parseOpenApiSpecToTools(rawSpec: unknown, maxTools = 100): ImportedToolSpec[] {
  if (!rawSpec || typeof rawSpec !== "object") {
    throw new Error("OpenAPI specification must be a valid JSON object.");
  }
  const doc = rawSpec as OpenApiDocument;
  if (!doc.paths || typeof doc.paths !== "object") {
    throw new Error("OpenAPI specification is missing a 'paths' object.");
  }

  const seenNames = new Set<string>();
  const tools: ImportedToolSpec[] = [];

  for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
    if (!pathKey.startsWith("/") || !pathItem || typeof pathItem !== "object") continue;

    for (const methodLower of ALLOWED_METHODS) {
      if (tools.length >= maxTools) break;
      const op = pathItem[methodLower];
      if (!op || typeof op !== "object") continue;

      const method = methodLower.toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";
      const rawName =
        op.operationId ||
        `${methodLower}_${pathKey.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      let name = sanitizeToolName(rawName).slice(0, 56);
      if (name.length < 2) name = `op_${tools.length + 1}`;
      if (seenNames.has(name)) {
        name = `${name.slice(0, 50)}_${tools.length + 1}`;
      }
      seenNames.add(name);

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (Array.isArray(op.parameters)) {
        for (const param of op.parameters) {
          if (!param?.name) continue;
          properties[param.name] = {
            ...(param.schema && typeof param.schema === "object" ? param.schema : { type: "string" }),
            ...(param.description ? { description: param.description } : {})
          };
          if (param.required) required.push(param.name);
        }
      }

      const jsonBodySchema = op.requestBody?.content?.["application/json"]?.schema;
      if (jsonBodySchema && typeof jsonBodySchema === "object") {
        const bodyProps = (jsonBodySchema as { properties?: Record<string, unknown> }).properties;
        const bodyReq = (jsonBodySchema as { required?: string[] }).required;
        if (bodyProps && typeof bodyProps === "object") {
          Object.assign(properties, bodyProps);
        }
        if (Array.isArray(bodyReq)) {
          for (const r of bodyReq) {
            if (typeof r === "string" && !required.includes(r)) required.push(r);
          }
        }
      }

      const inputSchema: Record<string, unknown> = {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {})
      };

      const desc = (op.summary || op.description || `${method} ${pathKey}`).trim().slice(0, 512);

      tools.push({
        name,
        description: desc,
        http_method: method,
        upstream_path: pathKey.slice(0, 512),
        input_schema_json: JSON.stringify(inputSchema)
      });
    }
  }

  return tools;
}
