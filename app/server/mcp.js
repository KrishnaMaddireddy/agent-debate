// Remote MCP servers as a tool source.
//
// Seats never speak MCP: they use the same one-JSON-line protocol as every other tool, and the
// server does the JSON-RPC. That keeps symmetry — a seat cannot tell an MCP tool from an HTTP
// one — and keeps the transport in one place.
//
// Only remote servers (http/https) are supported, deliberately: a stdio server would mean a
// model's tool call spawns a process on the operator's machine.
//
// mcp.json shape:
//   { "servers": { "docs": {
//       "label": "Team docs", "url": "https://…/mcp", "enabled": true,
//       "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" },
//       "allow": ["web_search"], "budget_per_turn": 3, "timeoutMs": 20000 } } }
// `${VAR}` in headers is an environment variable from .env — never a literal key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGET } from "../core/tools-protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MCP_PATH = path.join(here, "..", "..", "local", "mcp.json");
const DEFAULT_TIMEOUT_MS = 20000;
const CACHE_MS = 5 * 60 * 1000;
const LOOKS_LIKE_KEY = /^(sk-|sk_|xai-|Bearer\s+\S{12,}|[A-Za-z0-9_-]{32,})$/;

const cache = new Map();   // server id → { at, tools }

export function loadMcp(file = MCP_PATH) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = {};
  for (const [id, def] of Object.entries(raw.servers || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`mcp.json: "${id}" — server ids are lower_snake_case`);
    for (const [k, v] of Object.entries(def.headers || {})) {
      if (!/\$\{[A-Z0-9_]+\??\}/.test(String(v)) && LOOKS_LIKE_KEY.test(String(v).trim())) throw new Error(`mcp.json: servers.${id}.headers.${k} looks like a key. Put the key in .env and write \${VAR_NAME} here.`);
    }
    // Some servers take the key in the query string (Alpha Vantage: /mcp?apikey=…), so the URL
    // gets the same treatment as a header: ${VAR} only, never the key itself.
    for (const [, v] of String(def.url || "").matchAll(/[?&][^=&]+=([^&]+)/g)) {
      if (!/\$\{[A-Z0-9_]+\??\}/.test(v) && LOOKS_LIKE_KEY.test(decodeURIComponent(v).trim())) throw new Error(`mcp.json: servers.${id}.url has what looks like a key in the query string. Put it in .env and write \${VAR_NAME} in the URL.`);
    }
    out[id] = {
      id, label: def.label || id, url: String(def.url || ""), headers: def.headers || {},
      enabled: def.enabled === true, allow: Array.isArray(def.allow) ? def.allow : null,
      budget_per_turn: Number(def.budget_per_turn) || DEFAULT_BUDGET,
      timeoutMs: Number(def.timeoutMs) || DEFAULT_TIMEOUT_MS,
    };
  }
  return out;
}

export function saveMcp(servers, file = MCP_PATH) {
  const out = { servers: {} };
  for (const s of Object.values(servers)) {
    out.servers[s.id] = { label: s.label, url: s.url, headers: s.headers || {}, ...(s.enabled ? { enabled: true } : {}), ...(s.allow ? { allow: s.allow } : {}), ...(s.budget_per_turn !== DEFAULT_BUDGET ? { budget_per_turn: s.budget_per_turn } : {}), ...(s.timeoutMs !== DEFAULT_TIMEOUT_MS ? { timeoutMs: s.timeoutMs } : {}) };
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return file;
}

/** The URL with ${VAR} filled in from .env. Unset variables are reported, never sent empty. */
export function resolveUrl(server) {
  const missing = [];
  const url = String(server.url || "").replace(/\$\{([A-Z0-9_]+)(\??)\}/g, (_, name, optional) => {
    const val = process.env[name];
    if (!val) { if (!optional) missing.push(name); return ""; }
    return encodeURIComponent(val);
  });
  return { url, missing };
}

/** Env-substituted headers; a header whose variable is unset is dropped, and reported. */
export function resolveHeaders(server) {
  const headers = {}, missing = [];
  for (const [k, v] of Object.entries(server.headers || {})) {
    let dropped = false;
    const filled = String(v).replace(/\$\{([A-Z0-9_]+)(\??)\}/g, (_, name, optional) => {
      const val = process.env[name];
      // A half-substituted header ("Bearer ") is worse than no header: the server answers 401
      // and the operator hunts the wrong thing. Drop it, and name the variable instead.
      if (!val) { dropped = true; if (!optional) missing.push(name); return ""; }
      return val;
    });
    if (!dropped && filled.trim()) headers[k] = filled;
  }
  return { headers, missing };
}

export function checkUrl(url) {
  let u;
  try { u = new URL(String(url).replace(/\$\{[A-Z0-9_]+\??\}/g, "x")); } catch { throw new Error("not a URL"); }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return u;
  throw new Error("MCP servers must be https:// (or http:// on localhost)");
}

// A streamable-HTTP MCP endpoint answers either application/json or an SSE stream; both carry
// the same JSON-RPC envelopes, so read whichever arrived and take the first result.
async function rpc(server, method, params, { fetchImpl = fetch, sessionId } = {}) {
  const { url, missing: urlMissing } = resolveUrl(server);
  checkUrl(url);
  const { headers, missing } = resolveHeaders(server);
  const absent = [...new Set([...urlMissing, ...missing])];
  if (absent.length) throw new Error(`${absent.join(", ")} not set in .env`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), server.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    const session = res.headers.get("mcp-session-id") || sessionId || null;
    const env = parseRpc(body);
    if (env?.error) throw new Error(env.error.message || JSON.stringify(env.error));
    return { result: env?.result ?? null, session };
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `no response within ${Math.round((server.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s` : e.message);
  } finally { clearTimeout(timer); }
}

export function parseRpc(body) {
  const text = String(body || "").trim();
  if (!text) return null;
  if (text.startsWith("{")) { try { return JSON.parse(text); } catch { return null; } }
  // SSE: take the last `data:` payload that carries a result or an error.
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { const o = JSON.parse(line.slice(5).trim()); if (o && (o.result !== undefined || o.error)) found = o; } catch { /* keep looking */ }
  }
  return found;
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-debate", version: "1" } };

/** Handshake + tools/list. Cached for five minutes per server. */
export async function listTools(server, { fetchImpl = fetch, fresh = false } = {}) {
  const hit = cache.get(server.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS && hit.url === server.url) return hit.tools;
  const init = await rpc(server, "initialize", INIT, { fetchImpl });
  const listed = await rpc(server, "tools/list", {}, { fetchImpl, sessionId: init.session });
  const tools = (listed.result?.tools || []).map((t) => ({
    name: String(t.name), description: t.description || "", args: argsFromSchema(t.inputSchema || t.input_schema),
  })).filter((t) => /^[A-Za-z][\w-]*$/.test(t.name));
  cache.set(server.id, { at: Date.now(), url: server.url, tools });
  return tools;
}

export function forgetTools(id) { if (id) cache.delete(id); else cache.clear(); }

/** An MCP JSON Schema becomes the same "name → human description" map every other tool uses. */
export function argsFromSchema(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    const type = Array.isArray(v?.type) ? v.type.join("|") : v?.type || "string";
    const desc = String(v?.description || "").replace(/\s+/g, " ").trim();
    out[k] = `${required.has(k) ? "" : "optional — "}${type}${desc ? ` — ${desc}` : ""}`;
  }
  return out;
}

/** Call one tool. MCP content blocks are flattened into our {text} / {items} shape. */
export async function callMcpTool(server, tool, args, { fetchImpl = fetch } = {}) {
  try {
    const init = await rpc(server, "initialize", INIT, { fetchImpl });
    const r = await rpc(server, "tools/call", { name: tool, arguments: args || {} }, { fetchImpl, sessionId: init.session });
    const res = r.result || {};
    if (res.isError) return { error: `${server.id}.${tool}: ${flatten(res).slice(0, 400) || "tool reported an error"}` };
    if (res.structuredContent && typeof res.structuredContent === "object") {
      const arr = Array.isArray(res.structuredContent) ? res.structuredContent : Array.isArray(res.structuredContent.items) ? res.structuredContent.items : null;
      if (arr) return { count: arr.length, items: arr.slice(0, 10) };
    }
    const text = flatten(res);
    if (!text) return { error: `${server.id}.${tool}: empty result` };
    return { text: text.slice(0, 8000) };
  } catch (e) { return { error: `${server.id}.${tool}: ${e.message}` }; }
}

function flatten(res) {
  const parts = [];
  for (const c of res.content || []) {
    if (c?.type === "text" && c.text) parts.push(c.text);
    else if (c?.type === "resource" && c.resource?.text) parts.push(c.resource.text);
    else if (c?.type === "image") parts.push("[image omitted — seats receive text only]");
  }
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  return parts.join("\n\n").trim();
}

/** MCP tools in the shape the picker, the prompt block and runTool already understand. */
export async function mcpToolCatalog(servers, { fetchImpl = fetch, onError } = {}) {
  const out = {};
  for (const s of Object.values(servers)) {
    if (!s.enabled) continue;
    let tools;
    try { tools = await listTools(s, { fetchImpl }); }
    catch (e) { onError?.(s, e); continue; }
    for (const t of tools) {
      if (s.allow && !s.allow.includes(t.name)) continue;
      const name = `${s.id}.${t.name}`;
      out[name] = {
        name, description: t.description || `${t.name} on ${s.label}`, args: t.args,
        budget_per_turn: s.budget_per_turn, category: "mcp", available: true, missingEnv: [],
        provider: s.id, providerLabel: s.label, mcp: { server: s, tool: t.name },
      };
    }
  }
  return out;
}
