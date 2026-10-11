// Configuration: paths, .env, providers (opt-in), keys, live model lists, skills, personas and the
// tool catalog. The file shapes are exactly those of rev 6–13, so an existing local/ keeps working.
import fs from "node:fs";
import { MOCK_MODELS } from "../core/mock-models.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, DEFAULT_TIMEOUT_MS, cliAvailable, callTimeoutMs } from "./adapters.js";
import { loadTools, publicTools, envSet, SEARCH_PROVIDERS_PATH } from "./tools.js";
import { loadMcp, mcpToolCatalog } from "./mcp.js";
import { enabledContributions } from "./plugins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
// Your config lives in local/ (or DEBATE_CONFIG_DIR — the tests point it at a temp copy so they
// never touch the real files, or read the real keys).
const CONFIG_DIR = process.env.DEBATE_CONFIG_DIR ? path.resolve(process.env.DEBATE_CONFIG_DIR) : path.join(ROOT, "local");

export const PATHS = {
  root: ROOT,
  config: CONFIG_DIR,
  skills: process.env.DEBATE_SKILLS_DIR ? path.resolve(process.env.DEBATE_SKILLS_DIR) : path.join(ROOT, "skills"),
  personas: process.env.DEBATE_PERSONAS_DIR ? path.resolve(process.env.DEBATE_PERSONAS_DIR) : path.join(ROOT, "personas"),
  providers: path.join(CONFIG_DIR, "providers.json"),
  providersExample: path.join(ROOT, "local", "providers.json.example"),
  tools: path.join(CONFIG_DIR, "tools.json"),
  toolsExample: path.join(ROOT, "local", "tools.json.example"),
  searchProviders: SEARCH_PROVIDERS_PATH,
  mcp: path.join(CONFIG_DIR, "mcp.json"),
  plugins: process.env.DEBATE_PLUGINS_DIR ? path.resolve(process.env.DEBATE_PLUGINS_DIR) : path.join(ROOT, "plugins"),
  pluginState: path.join(CONFIG_DIR, "plugins.json"),
  runs: path.join(CONFIG_DIR, "runs"),
  // With DEBATE_CONFIG_DIR set only that dir's .env is read: a test that reads whoever's keys are
  // on the machine is not a test (rev 12).
  envCandidates: process.env.DEBATE_CONFIG_DIR ? [path.join(CONFIG_DIR, ".env")] : [path.join(CONFIG_DIR, ".env"), path.join(ROOT, ".env")],
};

// ---------------------------------------------------------------- .env (no dependency)

export function loadEnv() {
  const loaded = [];
  for (const envPath of PATHS.envCandidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    loaded.push(envPath);
  }
  return loaded;
}

export function envFileForWrites() { return PATHS.envCandidates.find((p) => fs.existsSync(p)) || PATHS.envCandidates[0]; }

export const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
export function setEnvVar(name, value) {
  if (!ENV_NAME.test(name)) throw new Error(`Bad variable name "${name}"`);
  if (typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Bad value");
  const file = envFileForWrites();
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  let found = false;
  const out = lines.map((l) => (re.test(l) ? ((found = true), value === "" ? null : `${name}=${value}`) : l)).filter((l) => l !== null);
  if (!found && value !== "") { if (out.length && out.at(-1) !== "") out.push(""); out.push(`${name}=${value}`); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  if (value === "") delete process.env[name]; else process.env[name] = value;
  modelCache.clear();
  return file;
}

// ---------------------------------------------------------------- providers (opt-in)

const LOOKS_LIKE_KEY = /^(sk-|sk_|AIza|xai-|gsk_|or-|ak-)|.{40,}/;
const cliCache = new Map();
function cliOk(cmd) { if (!cliCache.has(cmd)) cliCache.set(cmd, cliAvailable(cmd)); return cliCache.get(cmd); }

export function ensureProvidersFile() {
  if (!fs.existsSync(PATHS.providers) && fs.existsSync(PATHS.providersExample)) {
    fs.mkdirSync(path.dirname(PATHS.providers), { recursive: true });
    fs.copyFileSync(PATHS.providersExample, PATHS.providers);
    return true;
  }
  return false;
}

export function loadProviders() {
  if (!fs.existsSync(PATHS.providers)) throw new Error(`${path.relative(ROOT, PATHS.providers)} is missing — copy local/providers.json.example to it (it is git-ignored on purpose).`);
  const cfg = JSON.parse(fs.readFileSync(PATHS.providers, "utf8"));
  if (!cfg.providers || Array.isArray(cfg.providers)) throw new Error(`${path.relative(ROOT, PATHS.providers)} has the wrong shape — expected {"default":{…},"providers":{id:{…}}} (see local/providers.json.example).`);
  for (const [id, p] of Object.entries(cfg.providers)) {
    p.id = id;
    if (p.keyEnv && LOOKS_LIKE_KEY.test(p.keyEnv)) throw new Error(`providers.${id}.keyEnv looks like a key, not a variable name. Keys belong in .env.`);
    // "hasKey" = this provider can be called: a key in .env, no key needed, or (cli) the binary is on PATH.
    p.hasKey = p.type === "mock" || (p.type === "cli" ? cliOk(p.command || "claude") : !p.keyEnv || envSet(p.keyEnv));
    // Opt-in: a provider must be switched on before any model call can reach it. Mock is always on.
    p.enabled = p.type === "mock" ? true : p.enabled === true;
    // Mock models are free and built in: every behaviour is offered whatever an older file listed.
    if (p.type === "mock") p.models = [...new Set([...(p.models || []).map((m) => (typeof m === "string" ? m : m.id)), ...MOCK_MODELS])];
  }
  return cfg;
}

export function saveProviders(cfg) {
  const clean = { _comment: cfg._comment, default: cfg.default, ...(cfg.defaultBudgetUsd != null ? { defaultBudgetUsd: cfg.defaultBudgetUsd } : {}), providers: {} };
  for (const [id, p] of Object.entries(cfg.providers)) { const { id: _i, hasKey: _h, ...rest } = p; if (rest.enabled !== true) delete rest.enabled; clean.providers[id] = rest; }
  fs.writeFileSync(PATHS.providers, JSON.stringify(clean, null, 2) + "\n");
}

export const publicProvider = (p) => {
  const { id, label, type, models, hasKey, enabled, keyEnv, tokenFloor, temperature, timeoutMs, baseUrl, command, local, thinking } = p;
  const list = (models || []).map((m) => (typeof m === "string" ? m : m.id));
  return { id, label, type, models: list, hasKey, enabled, keyEnv: keyEnv || null, tokenFloor, temperature, timeoutMs, baseUrl, command, local: Boolean(local), thinking: thinking || null,
    prices: Object.fromEntries(list.map((m) => { const pr = priceFor(p, m); return [m, pr ? { ...pr, floor: effectiveFloor(p) } : null]; })) };
};

// ---------------------------------------------------------------- prices (USD per 1M tokens)

const LIST_PRICES = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, "prices.json"), "utf8")); } catch { return { hosts: {} }; } })();
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const isLocalHost = (u) => /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/.test(hostOf(u));

/**
 * The price a run is charged for a model, or null when unknown. In order: your price in
 * providers.json → free (mock, the subscription CLI, a keyless local server) → the dated list-price
 * table → a live list price the provider publishes (OpenRouter), once its model list has been fetched.
 */
export function priceFor(p, model) {
  const mine = p.prices?.[model];
  if (mine && Number.isFinite(Number(mine.in)) && Number.isFinite(Number(mine.out))) return { in: Number(mine.in), out: Number(mine.out), ...(mine.cachedIn != null ? { cachedIn: Number(mine.cachedIn) } : {}), source: "your price" };
  if (p.type === "mock") return { in: 0, out: 0, source: "free (mock)" };
  if (p.type === "cli") return { in: 0, out: 0, source: "your subscription" };
  if (!p.keyEnv && isLocalHost(p.baseUrl)) return { in: 0, out: 0, source: "local model" };
  const host = LIST_PRICES.hosts?.[hostOf(p.baseUrl)];
  const listed = host?.models?.[model];
  if (listed) return { in: listed.in, out: listed.out, ...(listed.cachedIn != null ? { cachedIn: listed.cachedIn } : {}), source: host.source };
  const live = modelCache.get(p.id)?.prices?.[model];
  if (live) return live;
  return null;
}

/** Prices for every provider/model a run uses, fetching a live list (cached 10 min) where that is the only source. */
export async function pricesFor(cfg, pairs) {
  const out = {};
  for (const { provider, model } of pairs) {
    const p = cfg.providers[provider];
    if (!p) continue;
    let price = priceFor(p, model);
    if (!price && p.enabled && /openrouter\.ai/.test(p.baseUrl || "")) { await liveModels(p); price = priceFor(p, model); }
    // The cap must see the real ceiling: the provider's floors can raise it above the engine's.
    out[`${provider}|${model}`] = price ? { ...price, floor: effectiveFloor(p) } : null;
  }
  return out;
}

/** Fill the live price lists (OpenRouter publishes one; reading it is free) for enabled providers, cached 10 min. */
export async function warmLivePrices(cfg) {
  await Promise.all(Object.values(cfg.providers).filter((p) => p.enabled && /openrouter\.ai/.test(p.baseUrl || "") && !modelCache.get(p.id)).map((p) => liveModels(p).catch(() => null)));
}

function effectiveFloor(p) {
  let f = Number(p.tokenFloor) || 0;
  if (p.thinking === "enabled" || p.thinking === "required") f = Math.max(f, THINKING_TOKEN_FLOOR);
  return Math.min(MAX_TOKENS_CAP, f);
}

// ---------------------------------------------------------------- live model lists

export const modelCache = new Map();
const MODEL_TTL_MS = 10 * 60_000;
const CLI_MODELS = ["sonnet", "opus", "haiku"];

export async function liveModels(p, { fetchImpl = fetch, force = false } = {}) {
  const hit = modelCache.get(p.id);
  if (!force && hit && Date.now() - hit.at < MODEL_TTL_MS) return hit;
  let entry, livePrices = null;
  try {
    let models = [];
    if (p.type === "mock") models = p.models || [];
    else if (p.type === "cli") models = CLI_MODELS;
    else if (!p.hasKey && p.keyEnv) throw new Error(`${p.keyEnv} is not set`);
    else {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const key = p.keyEnv ? process.env[p.keyEnv] : undefined;
        let url, headers = { ...(p.extraHeaders || {}) };
        if (p.type === "anthropic") { url = `${p.baseUrl || "https://api.anthropic.com"}/v1/models?limit=100`; headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
        else if (p.type === "gemini") { url = `${p.baseUrl || "https://generativelanguage.googleapis.com"}/v1beta/models?pageSize=200`; headers["x-goog-api-key"] = key; }
        else { url = `${p.baseUrl}/models`; if (key) headers.authorization = `Bearer ${key}`; }
        const res = await fetchImpl(url, { headers, signal: ctrl.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
        const data = JSON.parse(text);
        const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
        models = list.map((m) => (typeof m === "string" ? m : m.id || m.name || "")).map((s) => s.replace(/^models\//, "")).filter(Boolean);
        // OpenRouter publishes a price per token with its list; keep it, per 1M tokens.
        for (const m of list) if (m && typeof m === "object" && m.id && m.pricing && m.pricing.prompt != null && m.pricing.completion != null) {
          const pin = Number(m.pricing.prompt) * 1e6, pout = Number(m.pricing.completion) * 1e6;
          if (Number.isFinite(pin) && Number.isFinite(pout) && pin >= 0 && pout >= 0) (livePrices ||= {})[m.id] = { in: +pin.toFixed(6), out: +pout.toFixed(6), ...(m.pricing.input_cache_read != null ? { cachedIn: +(Number(m.pricing.input_cache_read) * 1e6).toFixed(6) } : {}), source: "OpenRouter list price (live)" };
        }
        if (p.type === "gemini") models = models.filter((m) => /gemini/.test(m));
      } finally { clearTimeout(timer); }
    }
    entry = { at: Date.now(), models: [...new Set(models)].sort(), error: null, prices: livePrices };
  } catch (e) {
    entry = { at: Date.now(), models: [], error: e.name === "AbortError" ? "no response within 15s" : e.message };
  }
  modelCache.set(p.id, entry);
  return entry;
}

// ---------------------------------------------------------------- one model call

export const MAX_TOKENS_CAP = 32000;
export const THINKING_TOKEN_FLOOR = 16000;

/** Resolve a {provider, model} pair a run may use — or throw the reason it may not. */
export function resolveModel(cfg, provider, model) {
  const p = cfg.providers[provider];
  if (!p) throw new Error(`Unknown provider "${provider}"`);
  if (!p.enabled) throw new Error(`${p.label} is not enabled — turn it on in Settings › Providers first`);
  if (!ADAPTERS[p.type]) throw new Error(`No adapter for type "${p.type}"`);
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(model)) throw new Error(`Bad model id "${model}"`);
  if (Array.isArray(p.models) && p.models.length && !p.models.includes(model)) {
    const live = modelCache.get(p.id);
    if (!live || live.error || !live.models.includes(model)) throw new Error(`${p.label}: model "${model}" is not in its configured list — add it in Settings › Providers`);
  }
  if (p.keyEnv && !envSet(p.keyEnv)) throw new Error(`${p.label}: ${p.keyEnv} is not set in .env (or still a placeholder)`);
  if (p.type === "cli" && !cliOk(p.command || "claude")) throw new Error(`${p.label}: "${p.command || "claude"}" is not installed or not on PATH — install Claude Code and log in once, then restart the server`);
  return p;
}

export async function chat({ provider, model, system, messages, maxTokens, signal, maxGrowth }) {
  const cfg = loadProviders();
  const p = resolveModel(cfg, provider, model);
  if (typeof system !== "string" || !Array.isArray(messages) || !messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")) {
    throw new Error("Bad request: system must be a string and messages [{role:user|assistant, content:string}]");
  }
  // Ceilings are the engine's (a function of the mandate); floors are the provider's — a reasoning
  // model spends tokens before it answers. The prompt stays identical for every model.
  let tokens = Math.max(Number(maxTokens) || 3000, Number(p.tokenFloor) || 0);
  if (p.thinking === "enabled" || p.thinking === "required") tokens = Math.max(tokens, THINKING_TOKEN_FLOOR);
  tokens = Math.min(MAX_TOKENS_CAP, tokens);
  return ADAPTERS[p.type]({
    baseUrl: p.baseUrl, apiKey: p.keyEnv ? process.env[p.keyEnv] : undefined, model, system, messages, maxTokens: tokens,
    temperature: p.temperature, timeoutMs: p.type === "cli" ? Number(p.timeoutMs) || Math.max(DEFAULT_TIMEOUT_MS, callTimeoutMs(tokens)) : callTimeoutMs(tokens, p.timeoutMs),
    extraHeaders: p.extraHeaders, thinking: p.thinking, reasoningApi: p.reasoningApi, reasoningEffort: p.reasoningEffort,
    command: p.command, extraArgs: p.extraArgs, signal, maxGrowth,
  });
}

// ---------------------------------------------------------------- tools, skills, personas

export function toolsFile() { return fs.existsSync(PATHS.tools) ? PATHS.tools : PATHS.toolsExample; }

/** Every tool an analyst may be offered: tools.json + enabled plugins + enabled MCP servers. */
export async function toolCatalog({ fetchImpl, mcpErrors } = {}) {
  const out = loadTools(toolsFile(), PATHS.searchProviders);
  const contrib = enabledContributions(PATHS.plugins, PATHS.pluginState);
  for (const { id, file } of contrib.toolFiles) {
    for (const [name, t] of Object.entries(loadTools(file, PATHS.searchProviders))) if (!out[name]) out[name] = { ...t, plugin: id };
  }
  const servers = { ...loadMcp(PATHS.mcp) };
  for (const { id, file } of contrib.mcpFiles) for (const [sid, srv] of Object.entries(loadMcp(file))) if (!servers[sid]) servers[sid] = { ...srv, plugin: id };
  Object.assign(out, await mcpToolCatalog(servers, { fetchImpl, onError: (s, e) => mcpErrors?.push({ server: s.id, error: e.message }) }));
  // Skills are inlined into every brief now, and documents travel in the prompt: these two house
  // tools have nothing left to do for an analyst.
  delete out.read_skill; delete out.read_context;
  return out;
}

export function loadSkills(dir = PATHS.skills) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = d.isDirectory() ? path.join(dir, d.name, "SKILL.md") : /\.md$/i.test(d.name) ? path.join(dir, d.name) : null;
    if (!file || !fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const fm = {}; if (m) for (const line of m[1].split("\n")) { const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2].trim(); }
    const name = (fm.name || d.name.replace(/\.md$/i, "")).trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) continue;
    const topics = (fm.topics || "").replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    out.push({ name, description: fm.description || "", topics, body: (m ? m[2] : raw).trim(), file: path.relative(ROOT, file) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function allSkills() {
  const out = loadSkills();
  const seen = new Set(out.map((s) => s.name));
  for (const { id, dir } of enabledContributions(PATHS.plugins, PATHS.pluginState).skillDirs) for (const sk of loadSkills(dir)) if (!seen.has(sk.name)) { seen.add(sk.name); out.push({ ...sk, plugin: id }); }
  return out;
}
export const publicSkills = (skills) => skills.map(({ name, description, topics, file, body, plugin }) => ({ name, description, topics, file, plugin: plugin || null, words: body.split(/\s+/).filter(Boolean).length }));
export function suggestSkills(question, skills) {
  const text = ` ${String(question || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ")} `;
  return skills.filter((s) => s.topics.some((t) => text.includes(` ${t} `) || text.includes(` ${t}s `))).map((s) => s.name);
}

/** personas/*.json: {name, lens, standards[], emphasize[], avoid[]} — one judging lens per run. */
export function loadPersonas(dir = PATHS.personas) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith("_")).sort()) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!p.name || !p.lens) continue;
      out.push({ id: f.replace(/\.json$/, ""), name: String(p.name), lens: String(p.lens), standards: p.standards || [], emphasize: p.emphasize || [], avoid: p.avoid || [] });
    } catch { /* a broken persona file is skipped, not fatal */ }
  }
  return out;
}

// ---------------------------------------------------------------- local runtimes (truly free models)

export const LOCAL_RUNTIMES = [
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", hint: "ollama serve · ollama pull qwen3:8b" },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", hint: "LM Studio → Developer → Start server" },
  { id: "vllm", label: "vLLM (local)", baseUrl: "http://127.0.0.1:8000/v1", hint: "vllm serve <model>" },
];
export async function probeLocalRuntimes({ fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const cfg = (() => { try { return loadProviders(); } catch { return { providers: {} }; } })();
  return Promise.all(LOCAL_RUNTIMES.map(async (rt) => {
    const existing = Object.values(cfg.providers).find((p) => p.id === rt.id || (p.baseUrl && p.baseUrl.replace("localhost", "127.0.0.1").replace(/\/$/, "") === rt.baseUrl));
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let running = false, models = [], error = null;
    try {
      const res = await fetchImpl(`${(existing?.baseUrl || rt.baseUrl).replace(/\/$/, "")}/models`, { signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) { const d = JSON.parse(text); models = (Array.isArray(d.data) ? d.data : []).map((m) => m.id || m.name).filter(Boolean).sort(); running = true; }
      else error = `HTTP ${res.status}`;
    } catch (e) { error = e.name === "AbortError" ? "no response" : (e.cause?.code || e.message); }
    finally { clearTimeout(timer); }
    return { ...rt, baseUrl: existing?.baseUrl || rt.baseUrl, running, models, error: running ? null : error, providerId: existing?.id || null, configured: Boolean(existing), enabled: Boolean(existing?.enabled), configuredModels: existing?.models || [] };
  }));
}

export { publicTools, envSet };
