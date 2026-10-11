// Tools for analysts — declared in tools.json, executed server-side, offered to every analyst identically.
//
// Why prompt-level and not native function calling: the panel mixes OpenAI-shape, Anthropic, Gemini,
// the Claude Code CLI and a mock. Each has a different tool schema (or none). A single text protocol —
// "reply with one JSON line to call a tool, prose to answer" — gives every seat the same tools, the
// same budget and the same result format, and yields a provenance ledger (which turn called what,
// and what came back) without asking any model to report on itself.
//
// tools.json shape:
//   { "web_search": {
//       "description": "…", "args": { "query": "string" },
//       "http": { "method": "POST", "url": "https://…", "headers": { "Authorization": "Bearer ${SERPEX_API_KEY}" },
//                 "body": { "q": "${query}", "engine": "google" } },
//       "extract": { "list": "results", "fields": ["title", "url", "snippet"], "limit": 5 },
//       "budget_per_turn": 3 } }
// `${NAME}` inside headers/url/body: an arg name if one matches, otherwise an environment variable
// (from .env). Keys therefore live in .env and never appear in a prompt, a log or the browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGET } from "../core/tools-protocol.js";
import { safeCalc } from "../core/calc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_PATH = path.join(here, "..", "..", "local", "tools.json");
export const SEARCH_PROVIDERS_PATH = path.join(here, "search-providers.json");
export const TOOL_TIMEOUT_MS = 30_000;

export function loadTools(file = TOOLS_PATH, presetsFile = SEARCH_PROVIDERS_PATH) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const presets = fs.existsSync(presetsFile) ? JSON.parse(fs.readFileSync(presetsFile, "utf8")) : {};
  const out = {};
  for (const [name, def] of Object.entries(raw)) {
    if (name.startsWith("_")) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`tools.json: "${name}" — tool names are lower_snake_case`);
    refuseInlineKeys(name, def.http);
    let t = { ...def, name, budget_per_turn: Number(def.budget_per_turn) || DEFAULT_BUDGET, category: def.category || "general" };
    if (def.builtin) {
      if (!BUILTINS[def.builtin]) throw new Error(`tools.json: "${name}" uses unknown builtin "${def.builtin}"`);
      t.available = true; t.missingEnv = [];
    } else if (Array.isArray(def.providers) && def.providers.length) {
      // Provider-independent tool: pick the backend. `use` (or env <TOOL>_PROVIDER) names one; else the first whose keys are set.
      const want = def.use || process.env[`${name.toUpperCase()}_PROVIDER`];
      const candidates = (want ? [want] : def.providers).map((id) => {
        const p = presets[id];
        if (!p) return { id, error: `unknown search provider "${id}" (see search-providers.json)` };
        const missing = envVarsIn(p).filter((v) => !(def.args && v in def.args) && !envSet(v));
        return { id, preset: p, missing };
      });
      const pick = candidates.find((c) => c.preset && !c.missing.length);
      if (pick) t = { ...t, http: pick.preset.http, extract: pick.preset.extract, provider: pick.id, providerLabel: pick.preset.label || pick.id, available: true, missingEnv: [] };
      else t = { ...t, provider: null, available: false, missingEnv: candidates.map((c) => c.error || `${c.id}: ${c.missing.join(", ")}`) };
      t.candidates = def.providers;
    } else {
      const missing = envVarsIn(t).filter((v) => !(t.args && v in t.args) && !envSet(v));
      t.available = Boolean(t.mock) || missing.length === 0;
      t.missingEnv = missing;
    }
    out[name] = t;
  }
  return out;
}

// What the browser / CLI may see: never the http block (it carries header templates).
export function publicTools(tools) {
  return Object.values(tools).map(({ name, description, args, budget_per_turn, available, missingEnv, provider, providerLabel, candidates, category, builtin, mcp, plugin }) => ({ name, description, args, budget_per_turn, available, missingEnv, provider, providerLabel, candidates, category, builtin: builtin || null, mcp: mcp ? { server: mcp.server.id, tool: mcp.tool } : null, plugin: plugin || null }));
}

// --- execution ---

// Models name arguments from memory, and get them wrong: wikipedia_summary({query}) when the
// argument is "title", or wikipedia_search() with the query attached to nothing at all. A
// mismatch used to fail the call outright and burn a slot of the seat's budget. Map what they
// sent onto what the tool declares — identically for every seat, so the harness stays symmetric.
const ARG_SYNONYMS = [["query", "q", "search", "searchterm", "term", "text", "keyword", "keywords", "prompt", "input", "topic", "title", "page", "name", "subject"], ["title", "page", "article", "name", "query", "q", "topic"], ["expression", "expr", "formula", "calculation", "math", "input"], ["url", "link", "href", "address"], ["country", "iso", "code", "nation"], ["place", "city", "location", "where"]];
const norm = (k) => String(k).toLowerCase().replace(/[^a-z]/g, "");

export function argSignature(t) {
  return Object.entries(t.args || {}).map(([k, d]) => `${k} (${String(d).split("—")[0].trim()})`).join(", ") || "no arguments";
}

export function coerceArgs(t, args) {
  const declared = Object.keys(t.args || {});
  if (!declared.length) return args && typeof args === "object" ? args : {};
  // A bare string where an object was expected: it belongs to the first declared argument.
  if (typeof args === "string") return { [declared[0]]: args };
  const out = {};
  const spare = new Map();
  for (const [k, v] of Object.entries(args || {})) {
    const hit = declared.find((d) => norm(d) === norm(k));
    if (hit) out[hit] = v; else spare.set(k, v);
  }
  const required = declared.filter((d) => !/^optional/i.test(String(t.args[d])));
  for (const need of required) {
    if (out[need] != null && out[need] !== "") continue;
    // A synonym the model used instead ("query" for "title").
    const family = ARG_SYNONYMS.find((f) => f.includes(norm(need)));
    let from = family && [...spare.keys()].find((k) => family.includes(norm(k)));
    // Or, if exactly one value is left over and only one argument is missing, it is that one.
    if (!from && spare.size === 1 && required.filter((r) => out[r] == null || out[r] === "").length === 1) from = [...spare.keys()][0];
    if (from != null && typeof spare.get(from) !== "object") { out[need] = spare.get(from); spare.delete(from); }
  }
  // Keep anything left over: a tool template may substitute arguments it does not declare.
  for (const [k, v] of spare) if (out[k] === undefined) out[k] = v;
  // Declared defaults fill an optional argument the model left out, so a URL never ends up with
  // "range=" and a 400 the seat has to interpret.
  for (const [k, v] of Object.entries(t.defaults || {})) if (out[k] == null || out[k] === "") out[k] = v;
  return out;
}

export async function runTool(tools, name, args = {}, { fetchImpl = fetch, ctx = {} } = {}) {
  const t = tools[name];
  if (!t) return { error: `unknown tool "${name}"` };
  if (!t.available) return { error: `${name} is not configured (${(t.missingEnv || []).join(", ")} not set in .env)` };
  args = coerceArgs(t, args);
  // Arguments whose description starts with "optional" may be omitted; everything else is required.
  for (const [k, desc] of Object.entries(t.args || {})) if ((args[k] == null || args[k] === "") && !/^optional/i.test(String(desc))) return { error: `missing argument "${k}" — ${name} takes: ${argSignature(t)}` };
  if (t.mcp) { const { callMcpTool } = await import("./mcp.js"); return callMcpTool(t.mcp.server, t.mcp.tool, args, { fetchImpl }); }
  if (t.mock) return mockTool(t, args);
  if (t.builtin) { try { return await BUILTINS[t.builtin](args, { ...ctx, fetchImpl, tool: t }); } catch (e) { return { error: `${name}: ${e.message}` }; } }
  const h = t.http || {};
  const sub = (s) => fill(String(s), args);
  let url = fill(String(h.url), args, encodeURIComponent);
  if (h.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(h.query)) qs.set(k, deepFill(v, args));
    url += (url.includes("?") ? "&" : "?") + qs.toString();
  }
  const headers = Object.fromEntries(Object.entries(h.headers || {}).map(([k, v]) => [k, sub(v)]).filter(([, v]) => v !== ""));
  const method = (h.method || "GET").toUpperCase();
  let body;
  if (method !== "GET" && h.body != null) { body = JSON.stringify(deepFill(h.body, args)); headers["content-type"] ||= "application/json"; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(t.timeoutMs) || TOOL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) return { error: `${name}: HTTP ${res.status} ${typeof data === "string" ? data.slice(0, 200) : data?.error?.message || data?.message || ""}`.trim() };
    return extract(t.extract, data);
  } catch (e) {
    return { error: e.name === "AbortError" ? `${name}: no response within ${Math.round((Number(t.timeoutMs) || TOOL_TIMEOUT_MS) / 1000)}s` : `${name}: ${e.cause?.code || e.message}` };
  } finally { clearTimeout(timer); }
}

export function extract(spec, data) {
  if (!spec) return typeof data === "string" ? { text: data.slice(0, 4000) } : { data };
  // Plain-text mode: the endpoint answers CSV, XML or prose rather than a list of records
  // (Stooq's CSV, EDGAR's filing feed). "strip" runs it through the HTML/XML tag stripper first.
  if (spec.text) {
    const raw = typeof data === "string" ? data : JSON.stringify(data, null, 1);
    const body = spec.text === "strip" ? stripHtml(raw) : raw;
    return { text: body.trim().slice(0, spec.maxLen || 4000) };
  }
  if (spec.object) { // a single record, not a list: pick the fields off the (sub)object
    const obj = spec.object === true ? data : getPath(data, spec.object);
    if (!obj || typeof obj !== "object") return { error: `unexpected response shape (no object at "${spec.object}")`, data };
    const rename = spec.rename || {};
    const item = spec.fields ? Object.fromEntries(spec.fields.map((f) => [rename[f] || f, cleanField(getPath(obj, f), spec.maxLen)])) : obj;
    return { items: [item], count: 1 };
  }
  let list = spec.list ? getPath(data, spec.list) : data;
  if (!Array.isArray(list)) return { error: `unexpected response shape (no array at "${spec.list}")`, data };
  if (spec.limit) list = list.slice(0, spec.limit);
  const fields = spec.fields || null;
  const rename = spec.rename || {};
  const items = list.map((row) => fields ? Object.fromEntries(fields.map((f) => [rename[f] || f, cleanField(getPath(row, f), spec.maxLen)])) : row);
  return { items, count: items.length };
}

export function stripHtml(s) { return String(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim(); }
function cleanField(v, maxLen = 400) { return v == null ? "" : typeof v === "string" ? stripHtml(v).slice(0, maxLen) : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ").slice(0, maxLen) : JSON.stringify(v).slice(0, maxLen); }
function getPath(obj, p) { return String(p).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
// ${NAME} → argument or env var; ${NAME?} → optional env var (empty when unset; an empty header is then dropped).
function fill(s, args, encodeArg = (x) => x) { return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\??\}/g, (_, k) => (k in args ? encodeArg(String(args[k])) : process.env[k] ?? "")); }
function deepFill(v, args) {
  if (typeof v === "string") { const m = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/); return m && m[1] in args ? args[m[1]] : fill(v, args); }
  if (Array.isArray(v)) return v.map((x) => deepFill(x, args));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFill(x, args)]));
  return v;
}
// tools.json is meant to be committed, so it must never carry a literal key: only ${VAR} references.
const LOOKS_LIKE_KEY = /\b(sk[-_][A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|tvly-[A-Za-z0-9-]{16,}|BSA[A-Za-z0-9]{20,})\b/;
function refuseInlineKeys(name, http) {
  if (!http) return;
  const s = JSON.stringify([http.headers, http.url, http.query, http.body]);
  if (LOOKS_LIKE_KEY.test(s)) throw new Error(`tools.json: "${name}" contains what looks like a real API key. Put it in .env and reference it as \${VAR_NAME} — tools.json is committed to git.`);
}

// A key that is empty or still a placeholder ("sk_...", "<paste…>", "your-key") counts as not set.
export function envSet(name) { const v = process.env[name]; return Boolean(v) && !/^(sk_?\.{3}|\.{3}|<.*>|your[-_ ].*|xxx+|changeme|todo)$/i.test(v.trim()); }
function envVarsIn(t) {
  const found = new Set();
  JSON.stringify(t.http || (t.preset ? t.preset.http : {}) || {}).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(\??)\}/g, (_, k, opt) => { if (!opt) found.add(k); return ""; });
  return [...found];
}

// Deterministic tool for tests and dry runs: returns `limit` fake results echoing the query.
function mockTool(t, args) {
  const q = String(Object.values(args)[0] || "");
  const n = Number(t.extract?.limit) || 3;
  return { items: Array.from({ length: n }, (_, i) => ({ title: `Result ${i + 1} for "${q}"`, url: `https://example.org/${encodeURIComponent(q)}/${i + 1}`, snippet: `Mock snippet ${i + 1} about ${q}.` })), count: n };
}

// ======================================================================================================
// Built-in tools — need code, not just an HTTP template. All free, all keyless.
// ======================================================================================================
export const BUILTINS = {
  // Read a web page: the search tools return titles and snippets; this lets a seat actually read a result.
  async fetch_url({ url, query }, { fetchImpl = fetch, tool }) {
    let u;
    try { u = new URL(String(url)); } catch { return { error: `not a valid URL: ${url}` }; }
    if (!/^https?:$/.test(u.protocol)) return { error: "only http(s) URLs" };
    if (isPrivateHost(u.hostname)) return { error: "refusing to fetch a local or private address" };
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), Number(tool?.timeoutMs) || TOOL_TIMEOUT_MS);
    try {
      const res = await fetchImpl(u.href, { redirect: "follow", headers: { "user-agent": "agent-debate/1.0 (+local tool)", accept: "text/html,application/json,text/plain,*/*" }, signal: ctrl.signal });
      const type = res.headers.get("content-type") || "";
      const raw = (await res.text()).slice(0, 2_000_000);
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
      let text = /json/.test(type) ? raw : stripHtml(raw.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " "));
      const max = Number(tool?.maxChars) || 6000;
      if (query) { // return the passages that mention the query, not the whole page
        const terms = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const sentences = text.split(/(?<=[.!?])\s+/);
        const hits = sentences.map((s, i) => ({ i, s, n: terms.filter((w) => s.toLowerCase().includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 12).sort((a, b) => a.i - b.i);
        if (hits.length) text = hits.map((h) => h.s).join(" … ");
      }
      const truncated = text.length > max;
      return { text: `${title ? `Title: ${stripHtml(title)}\n` : ""}URL: ${u.href}\n\n${text.slice(0, max)}${truncated ? `\n\n[truncated at ${max} characters of ${text.length}]` : ""}` };
    } catch (e) {
      return { error: e.name === "AbortError" ? "no response in time" : e.cause?.code || e.message };
    } finally { clearTimeout(timer); }
  },

  // Deterministic arithmetic — a claim's numbers get recomputed rather than trusted (PRD §4 `arithmetic`).
  async calculate({ expression }) {
    const r = safeCalc(String(expression));
    return r.error ? { error: r.error } : { text: `${expression} = ${r.value}` };
  },

  // Quote from the documents the user attached to this session. Same bytes for every seat.
  async read_context({ query }, { context }) {
    if (!context || !String(context).trim()) return { error: "no context documents are attached to this session" };
    const text = String(context);
    const max = 6000;
    if (!query) return { text: text.length > max ? `${text.slice(0, max)}\n\n[${text.length} characters total — pass a query to search the rest]` : text };
    const terms = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const paras = text.split(/\n\s*\n/);
    const hits = paras.map((p, i) => ({ i, p, n: terms.filter((w) => p.toLowerCase().includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 8).sort((a, b) => a.i - b.i);
    if (!hits.length) return { text: `nothing in the attached documents matches "${query}"` };
    return { items: hits.map((h) => ({ passage: h.p.trim().slice(0, 1200), paragraph: `¶${h.i + 1}` })), count: hits.length };
  },

  // House procedure for a kind of question — identical for all seats (PRD §10).
  async read_skill({ name }, { skills }) {
    const s = (skills || []).find((x) => x.name === name);
    if (!s) return { error: `unknown skill "${name}"${skills?.length ? ` — available: ${skills.map((x) => x.name).join(", ")}` : ""}` };
    return { text: `# ${s.name}\n${s.description}\n\n${s.body}` };
  },
};

function isPrivateHost(h) {
  h = h.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  return h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("[");
}

export { safeCalc };
