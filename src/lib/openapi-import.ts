import { sanitizeToolName } from "@cloudflare/codemode";

export interface ImportedToolSpec {
  name: string;
  description: string;
  http_method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  upstream_path: string;
  input_schema_json: string;
}

interface OpenApiParam {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  $ref?: string;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParam[];
  requestBody?: {
    $ref?: string;
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

interface OpenApiDocument {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

const ALLOWED_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const seg of parts) {
    if (!cur || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function resolveRefsDeep(
  node: unknown,
  root: unknown,
  visited: Set<string> = new Set(),
  depth = 0
): unknown {
  if (depth > 16 || node === null || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefsDeep(item, root, visited, depth + 1));
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    if (visited.has(ref)) {
      return { type: "object" };
    }
    const target = resolveJsonPointer(root, ref);
    if (target === undefined) {
      return record;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(ref);
    const resolvedTarget = resolveRefsDeep(target, root, nextVisited, depth + 1);
    if (resolvedTarget && typeof resolvedTarget === "object" && !Array.isArray(resolvedTarget)) {
      const { $ref: _ignored, ...rest } = record;
      return { ...(resolvedTarget as Record<string, unknown>), ...rest };
    }
    return resolvedTarget;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = resolveRefsDeep(v, root, visited, depth + 1);
  }
  return out;
}

interface YamlLine {
  indent: number;
  text: string;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseYamlScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner;
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseYamlScalar(part));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }
  return s;
}

function splitYamlKeyValue(text: string): { key: string; val: string } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && text[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      if (i + 1 === text.length || /\s/.test(text[i + 1])) {
        const rawKey = text.slice(0, i).trim();
        const key =
          (rawKey.startsWith('"') && rawKey.endsWith('"')) ||
          (rawKey.startsWith("'") && rawKey.endsWith("'"))
            ? rawKey.slice(1, -1)
            : rawKey;
        const val = text.slice(i + 1).trim();
        return { key, val };
      }
    }
  }
  return null;
}

function parseYamlBlock(lines: YamlLine[], startIdx: number, indent: number): [unknown, number] {
  if (startIdx >= lines.length) return [{}, startIdx];
  const isSeq = lines[startIdx].text.startsWith("- ") || lines[startIdx].text === "-";

  if (isSeq) {
    const arr: unknown[] = [];
    let i = startIdx;
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
      const rest = lines[i].text === "-" ? "" : lines[i].text.slice(2).trim();
      if (!rest) {
        i += 1;
        if (i < lines.length && lines[i].indent > indent) {
          const [child, nextIdx] = parseYamlBlock(lines, i, lines[i].indent);
          arr.push(child);
          i = nextIdx;
        } else {
          arr.push(null);
        }
      } else {
        const kv = splitYamlKeyValue(rest);
        if (kv) {
          const itemObj: Record<string, unknown> = {};
          const itemIndent = indent + 2;
          if (kv.val === "") {
            i += 1;
            if (i < lines.length && lines[i].indent > itemIndent) {
              const [child, nextIdx] = parseYamlBlock(lines, i, lines[i].indent);
              itemObj[kv.key] = child;
              i = nextIdx;
            } else {
              itemObj[kv.key] = {};
            }
          } else {
            itemObj[kv.key] = parseYamlScalar(kv.val);
            i += 1;
          }
          if (i < lines.length && lines[i].indent >= itemIndent && !lines[i].text.startsWith("- ")) {
            const [restObj, nextIdx] = parseYamlBlock(lines, i, lines[i].indent);
            if (restObj && typeof restObj === "object" && !Array.isArray(restObj)) {
              Object.assign(itemObj, restObj);
            }
            i = nextIdx;
          }
          arr.push(itemObj);
        } else {
          arr.push(parseYamlScalar(rest));
          i += 1;
        }
      }
    }
    return [arr, i];
  }

  const obj: Record<string, unknown> = {};
  let i = startIdx;
  while (i < lines.length && lines[i].indent === indent) {
    if (lines[i].text.startsWith("- ") || lines[i].text === "-") break;
    const kv = splitYamlKeyValue(lines[i].text);
    if (!kv) {
      i += 1;
      continue;
    }
    if (kv.val === "") {
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const [child, nextIdx] = parseYamlBlock(lines, i, lines[i].indent);
        obj[kv.key] = child;
        i = nextIdx;
      } else {
        obj[kv.key] = {};
      }
    } else {
      obj[kv.key] = parseYamlScalar(kv.val);
      i += 1;
    }
  }
  return [obj, i];
}

export function parseOpenApiTextOrObject(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") {
    throw new Error("OpenAPI specification must be a valid JSON object or YAML string.");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("OpenAPI specification is empty.");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }

  const parsedLines: YamlLine[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const noComment = stripYamlComment(rawLine);
    if (!noComment.trim() || noComment.trim() === "---" || noComment.trim() === "...") continue;
    const indent = noComment.search(/\S/);
    parsedLines.push({ indent, text: noComment.trim() });
  }
  if (parsedLines.length === 0) {
    throw new Error("OpenAPI YAML specification contains no content.");
  }
  const [doc] = parseYamlBlock(parsedLines, 0, parsedLines[0].indent);
  return doc;
}

/**
 * Extracts Port4 tool definitions from an OpenAPI 3.x JSON or YAML document.
 * Resolves local `#/components/...` `$ref` pointers, merges path-level parameters,
 * supports GET/POST/PUT/PATCH/DELETE, and caps at `maxTools` operations.
 */
export function parseOpenApiSpecToTools(rawSpec: unknown, maxTools = 100): ImportedToolSpec[] {
  const normalizedSpec = typeof rawSpec === "string" ? parseOpenApiTextOrObject(rawSpec) : rawSpec;
  if (!normalizedSpec || typeof normalizedSpec !== "object" || Array.isArray(normalizedSpec)) {
    throw new Error("OpenAPI specification must be a valid JSON/YAML object.");
  }
  const doc = normalizedSpec as OpenApiDocument;
  if (!doc.paths || typeof doc.paths !== "object") {
    throw new Error("OpenAPI specification is missing a 'paths' object.");
  }

  const seenNames = new Set<string>();
  const tools: ImportedToolSpec[] = [];

  for (const [pathKey, rawPathItem] of Object.entries(doc.paths)) {
    if (!pathKey.startsWith("/") || !rawPathItem || typeof rawPathItem !== "object") continue;
    const pathItem = resolveRefsDeep(rawPathItem, doc) as Record<string, unknown>;
    const pathLevelParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as OpenApiParam[])
      : [];

    for (const methodLower of ALLOWED_METHODS) {
      if (tools.length >= maxTools) break;
      const rawOp = pathItem[methodLower];
      if (!rawOp || typeof rawOp !== "object") continue;
      const op = resolveRefsDeep(rawOp, doc) as OpenApiOperation;

      const method = methodLower.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      const rawName =
        op.operationId ||
        `${methodLower}_${pathKey.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      let name = sanitizeToolName(rawName).slice(0, 56);
      if (name.length < 2) name = `op_${tools.length + 1}`;
      if (seenNames.has(name)) {
        name = `${name.slice(0, 50)}_${tools.length + 1}`;
      }
      seenNames.add(name);

      // Merge path-level parameters with operation-level parameters (operation overrides same name+in)
      const mergedParamMap = new Map<string, OpenApiParam>();
      for (const p of pathLevelParams) {
        if (p?.name) mergedParamMap.set(`${p.in ?? "query"}:${p.name}`, p);
      }
      if (Array.isArray(op.parameters)) {
        for (const p of op.parameters) {
          if (p?.name) mergedParamMap.set(`${p.in ?? "query"}:${p.name}`, p);
        }
      }

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const param of mergedParamMap.values()) {
        if (!param?.name) continue;
        properties[param.name] = {
          ...(param.schema && typeof param.schema === "object" ? param.schema : { type: "string" }),
          ...(param.description ? { description: param.description } : {})
        };
        if (param.required && !required.includes(param.name)) required.push(param.name);
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
