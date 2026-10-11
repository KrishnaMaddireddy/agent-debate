// Agent Debate — local server. Zero dependencies: node:http, node:fs.
//
// Serves the console (app/ui) and the engine modules it imports (app/core), runs debates in-process
// and streams their events over SSE, and owns every piece of config I/O. It holds your API keys, so:
//   • it binds to 127.0.0.1 unless HOST says otherwise;
//   • it answers only requests whose Host is that loopback name (DNS-rebinding guard);
//   • a mutating request from a web page must come from this origin (a page elsewhere cannot spend your keys);
//   • no response ever contains a key.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PATHS, ROOT, loadEnv, envFileForWrites, setEnvVar, ENV_NAME, ensureProvidersFile, loadProviders, saveProviders, publicProvider,
  liveModels, modelCache, chat, resolveModel, toolCatalog, toolsFile, allSkills, publicSkills, suggestSkills, loadPersonas, probeLocalRuntimes, envSet, pricesFor, warmLivePrices } from "./config.js";
import { ADAPTERS } from "./adapters.js";
import { publicTools, runTool, stripHtml } from "./tools.js";
import { loadMcp, saveMcp, listTools as listMcpTools, forgetTools, checkUrl as checkMcpUrl, resolveHeaders, resolveUrl } from "./mcp.js";
import { listPlugins, setPluginEnabled, enabledContributions } from "./plugins.js";
import { startRun, stopRun, listRuns, streamRun, readRecord, deleteRun, runFile, runEvents, RUN_ID_RE, LEGACY_ID_RE, isLive, allRecords } from "./runs.js";
import { scorecard } from "../core/scorecard.js";
import { reportHtml } from "./report-html.js";
import { mimeFor } from "../core/files.js";
import { DEFAULT_BUDGET } from "../core/tools-protocol.js";
import { MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS_RAISED } from "../core/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "..");

export function version() {
  try { return fs.readFileSync(path.join(ROOT, "VERSION.txt"), "utf8").split("\n")[0].trim(); } catch { return "dev"; }
}

// ---------------------------------------------------------------- tiny HTTP helpers

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": isBuf || typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(payload);
}

async function readBody(req, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, "request too large"); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw bad("body is not JSON"); }
}

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".png": "image/png" };
function serveStatic(res, base, rel) {
  const f = path.resolve(base, "." + path.posix.normalize("/" + rel));
  if (!f.startsWith(base + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return false;
  res.writeHead(200, { "content-type": STATIC_TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(fs.readFileSync(f));
  return true;
}

// ---------------------------------------------------------------- run options from a request

/** Turn a request body into engine options, refusing anything the operator has not switched on. */
export async function runOptionsFrom(b) {
  const question = String(b.question ?? b.prompt ?? "").trim();
  if (!question) throw bad("question is required");
  const cfg = loadProviders();
  const models = (Array.isArray(b.models) ? b.models : []).map((m) => {
    const p = resolveModel(cfg, m.provider, m.model);
    return { provider: m.provider, model: m.model, type: p.type, providerLabel: p.label, label: m.label || `${p.label} · ${m.model}` };
  });
  if (!models.length) throw bad("pick at least one model");
  if (models.length > 6) throw bad("at most six models");
  const role = (spec) => {
    if (!spec || spec === "auto") return undefined;
    if (spec === "none" || typeof spec === "string") return spec;
    const p = resolveModel(cfg, spec.provider, spec.model);
    return { provider: spec.provider, model: spec.model, type: p.type, label: `${p.label} · ${spec.model}` };
  };
  const catalog = await toolCatalog();
  const toolNames = Array.isArray(b.tools) ? b.tools : [];
  for (const n of toolNames) if (!catalog[n]) throw bad(`unknown tool "${n}"`);
  const tools = publicTools(catalog).filter((t) => toolNames.includes(t.name) && t.available);
  const skillsAll = allSkills();
  const skillNames = b.skills === "auto" ? suggestSkills(question, skillsAll) : Array.isArray(b.skills) ? b.skills : [];
  for (const n of skillNames) if (!skillsAll.some((s) => s.name === n)) throw bad(`unknown skill "${n}"`);
  let persona = null;
  if (b.persona) {
    persona = typeof b.persona === "object" ? b.persona : loadPersonas().find((p) => p.id === b.persona || p.name === b.persona);
    if (!persona) throw bad(`unknown persona "${b.persona}"`);
  }
  const docs = (Array.isArray(b.docs) ? b.docs : []).map((d) => ({ name: String(d?.name || "document"), text: String(d?.text || "") })).filter((d) => d.text.trim());
  // Spending: prices for every model the run may call, and the cap (the request's, else your default).
  const roles = [role(b.expander), role(b.synthesizer)].filter((r) => r && typeof r === "object");
  const prices = await pricesFor(cfg, [...models, ...roles]);
  const capRaw = b.budgetUsd !== undefined ? b.budgetUsd : cfg.defaultBudgetUsd;
  const budgetUsd = capRaw == null || capRaw === "" || Number(capRaw) === 0 ? null : Number(capRaw);
  if (budgetUsd != null && !(budgetUsd > 0 && budgetUsd <= 1000)) throw bad("budgetUsd must be between 0 and 1000 (0 or null for no cap)");
  if (budgetUsd != null) {
    const unpriced = [...new Set([...models, ...roles].filter((m) => !prices[`${m.provider}|${m.model}`]).map((m) => `${m.provider} · ${m.model}`))];
    if (unpriced.length) throw bad(`a spending cap of $${budgetUsd} is set, but there is no price for ${unpriced.join(", ")} — set one in Settings › Providers, or run without a cap`);
  }
  return {
    question, models, docs, tools, persona,
    skills: skillsAll.filter((s) => skillNames.includes(s.name)),
    rounds: b.rounds, deliverable: b.deliverable, autoStop: b.autoStop, expand: b.expand,
    expander: role(b.expander), synthesizer: role(b.synthesizer), allowLargeContext: b.allowLargeContext === true,
    prices, budgetUsd,
    _catalog: catalog,
  };
}

function runEnv(catalog, log) {
  return {
    call: async ({ provider, model, system, user, maxTokens, signal, phase, letter, role, maxGrowth }) => {
      const t0 = Date.now();
      try {
        const r = await chat({ provider, model, system, messages: [{ role: "user", content: user }], maxTokens, signal, maxGrowth });
        log(`call ${phase} ${letter || role} ${provider}/${model} ok ${Date.now() - t0}ms ${r.text.length}ch${r.truncated ? " TRUNCATED" : ""}`);
        return r;
      } catch (e) {
        log(`call ${phase} ${letter || role} ${provider}/${model} FAIL ${Date.now() - t0}ms ${e.message}`);
        throw e;
      }
    },
    callTool: ({ name, args }) => runTool(catalog, name, args, { ctx: {} }),
    log,
  };
}

// ---------------------------------------------------------------- the app

export function createServer({ log = () => {}, host = process.env.HOST || "127.0.0.1" } = {}) {
  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]", host]);
  let port = 0;

  const mcpPublic = async (s) => {
    const { missing } = resolveHeaders(s);
    const urlVars = resolveUrl(s);
    const vars = [...new Set([...Object.values(s.headers || {}), s.url].flatMap((v) => String(v).match(/\$\{([A-Z0-9_]+)\??\}/g) || []).map((v) => v.replace(/[${}?]/g, "")))];
    const out = { id: s.id, label: s.label, url: s.url, enabled: s.enabled, allow: s.allow, budget_per_turn: s.budget_per_turn, timeoutMs: s.timeoutMs, headerVars: vars, missingEnv: [...new Set([...missing, ...urlVars.missing])], tools: [], error: null };
    if (!s.enabled) return out;
    try { out.tools = (await listMcpTools(s)).map((t) => t.name); } catch (e) { out.error = e.message; }
    return out;
  };

  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)").replace(/\*$/, "(?<rest>.*)")}$`), fn });

  // ---- config the console needs
  on("GET", "/api/version", () => ({ version: version() }));
  on("GET", "/api/config", async () => {
    const cfg = loadProviders();
    await warmLivePrices(cfg);
    const mcpErrors = [];
    const catalog = await toolCatalog({ mcpErrors });
    return {
      version: version(),
      default: cfg.default,
      providers: Object.values(cfg.providers).filter((p) => p.enabled).map((p) => { const { id, label, type, models, hasKey, prices } = publicProvider(p); return { id, label, type, models, hasKey, prices }; }),
      defaultBudgetUsd: cfg.defaultBudgetUsd ?? null,
      personas: loadPersonas().map(({ id, name, lens }) => ({ id, name, lens })),
      skills: publicSkills(allSkills()),
      tools: publicTools(catalog),
      mcpErrors,
      limits: { maxContextChars: MAX_CONTEXT_CHARS, maxContextCharsRaised: MAX_CONTEXT_CHARS_RAISED },
    };
  });
  on("GET", "/api/skills", (req, _m, url) => {
    const skills = allSkills();
    return { skills: publicSkills(skills), suggested: url.searchParams.get("question") ? suggestSkills(url.searchParams.get("question"), skills) : [] };
  });
  on("GET", "/api/personas", () => ({ personas: loadPersonas() }));

  // ---- settings
  on("GET", "/api/settings", async () => {
    const cfg = loadProviders();
    await warmLivePrices(cfg);
    const toolsRaw = JSON.parse(fs.readFileSync(toolsFile(), "utf8"));
    const presets = fs.existsSync(PATHS.searchProviders) ? JSON.parse(fs.readFileSync(PATHS.searchProviders, "utf8")) : {};
    const backends = Object.entries(presets).filter(([k]) => !k.startsWith("_")).map(([id, p]) => {
      const vars = [...new Set((JSON.stringify(p.http || {}).match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g) || []).map((m) => m.slice(2, -1)).filter((v) => v !== "query"))];
      return { id, label: p.label || id, vars, ready: vars.every(envSet) };
    });
    return {
      default: cfg.default,
      defaultBudgetUsd: cfg.defaultBudgetUsd ?? null,
      providers: Object.values(cfg.providers).map(publicProvider),
      tools: publicTools(await toolCatalog()).map((t) => ({ ...t, use: toolsRaw[t.name]?.use || null })),
      backends,
      envFile: path.relative(ROOT, envFileForWrites()),
      configDir: path.relative(ROOT, PATHS.config) || ".",
    };
  });
  on("PUT", "/api/settings/providers", async (req) => {
    const b = await readBody(req);
    const cfg = loadProviders();
    for (const [id, patch] of Object.entries(b.providers || {})) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw bad(`Bad provider id "${id}"`);
      if (patch.remove === true) { if (cfg.default?.provider === id) throw bad("Cannot remove the default provider"); delete cfg.providers[id]; continue; }
      const p = cfg.providers[id] || (patch.type ? { type: patch.type, label: patch.label || id, baseUrl: patch.baseUrl, keyEnv: patch.keyEnv || null, models: [] } : null);
      if (!p) throw bad(`Unknown provider "${id}"`);
      if (!ADAPTERS[p.type]) throw bad(`No adapter for type "${p.type}"`);
      if (patch.models) { if (!Array.isArray(patch.models) || !patch.models.every((m) => typeof m === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(m))) throw bad(`Bad models for ${id}`); p.models = [...new Set(patch.models)]; }
      for (const k of ["label", "baseUrl", "command"]) if (typeof patch[k] === "string") p[k] = patch[k];
      if (typeof patch.enabled === "boolean") { if (!patch.enabled && cfg.default?.provider === id) throw bad("Cannot disable the default provider — pick another default first"); p.enabled = patch.enabled; }
      if (patch.keyEnv !== undefined) { if (patch.keyEnv && !ENV_NAME.test(patch.keyEnv)) throw bad(`Bad keyEnv for ${id}`); p.keyEnv = patch.keyEnv || null; }
      if (patch.thinking !== undefined) { if (patch.thinking && !["enabled", "disabled"].includes(patch.thinking)) throw bad("thinking is enabled | disabled | empty"); if (patch.thinking) p.thinking = patch.thinking; else delete p.thinking; }
      if (patch.prices !== undefined) {
        if (!patch.prices || typeof patch.prices !== "object") throw bad(`Bad prices for ${id}`);
        const ok = (x) => x === undefined || x === null || x === "" || (Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) <= 1000);
        for (const [m, v] of Object.entries(patch.prices)) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(m)) throw bad(`Bad model id "${m}"`);
          if (v === null) { if (p.prices) delete p.prices[m]; continue; }
          if (!v || !ok(v.in) || !ok(v.out) || !ok(v.cachedIn) || v.in === "" || v.out === "" || v.in == null || v.out == null) throw bad(`A price for ${m} needs "in" and "out" in USD per 1M tokens, 0–1000`);
          (p.prices ||= {})[m] = { in: Number(v.in), out: Number(v.out), ...(v.cachedIn !== undefined && v.cachedIn !== null && v.cachedIn !== "" ? { cachedIn: Number(v.cachedIn) } : {}) };
        }
        if (p.prices && !Object.keys(p.prices).length) delete p.prices;
      }
      for (const k of ["tokenFloor", "temperature", "timeoutMs"]) if (patch[k] !== undefined) { if (patch[k] === null || patch[k] === "") delete p[k]; else { const n = Number(patch[k]); if (!Number.isFinite(n)) throw bad(`Bad ${k} for ${id}`); p[k] = n; } }
      cfg.providers[id] = p;
    }
    if (b.defaultBudgetUsd !== undefined) {
      const v = b.defaultBudgetUsd;
      if (v === null || v === "" || Number(v) === 0) delete cfg.defaultBudgetUsd;
      else if (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1000) cfg.defaultBudgetUsd = Number(v);
      else throw bad("defaultBudgetUsd must be between 0 and 1000");
    }
    if (b.default) {
      const d = cfg.providers[b.default.provider];
      if (!d) throw bad(`Default provider "${b.default.provider}" does not exist`);
      if (d.enabled !== true && d.type !== "mock") throw bad(`Enable "${b.default.provider}" before making it the default`);
      cfg.default = { provider: b.default.provider, model: String(b.default.model || d.models?.[0] || "") };
    }
    saveProviders(cfg);
    modelCache.clear();
    log("settings: providers saved");
    const fresh = loadProviders();
    return { ok: true, default: fresh.default, defaultBudgetUsd: fresh.defaultBudgetUsd ?? null, providers: Object.values(fresh.providers).map(publicProvider) };
  });
  on("PUT", "/api/settings/tools", async (req) => {
    const b = await readBody(req);
    const raw = JSON.parse(fs.readFileSync(toolsFile(), "utf8"));
    for (const [name, patch] of Object.entries(b.tools || {})) {
      if (!raw[name]) throw bad(`Unknown tool "${name}" (only tools in tools.json can be edited here)`);
      if (patch.budget_per_turn !== undefined) { const n = Number(patch.budget_per_turn); if (!Number.isInteger(n) || n < 1 || n > 10) throw bad("budget_per_turn must be 1–10"); raw[name].budget_per_turn = n; }
      if (patch.use !== undefined) { if (patch.use && !(Array.isArray(raw[name].providers) && raw[name].providers.includes(patch.use))) throw bad(`"${patch.use}" is not a backend of ${name}`); if (patch.use) raw[name].use = patch.use; else delete raw[name].use; }
    }
    fs.writeFileSync(PATHS.tools, JSON.stringify(raw, null, 2) + "\n");
    log("settings: tools saved");
    return { ok: true, tools: publicTools(await toolCatalog()) };
  });
  on("POST", "/api/settings/keys", async (req) => {
    const { name, value } = await readBody(req);
    const cfg = loadProviders();
    const known = new Set(Object.values(cfg.providers).map((p) => p.keyEnv).filter(Boolean));
    const contrib = enabledContributions(PATHS.plugins, PATHS.pluginState);
    const sources = [PATHS.searchProviders, toolsFile(), PATHS.mcp, ...contrib.toolFiles.map((f) => f.file), ...contrib.mcpFiles.map((f) => f.file)];
    const src = sources.filter((f) => f && fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const m of src.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\??\}/g)) if (m[1] !== "query") known.add(m[1]);
    if (!known.has(name)) throw bad(`"${name}" is not a key any provider, tool or MCP server uses`);
    const f = setEnvVar(name, String(value ?? "").trim());
    log(`settings: key ${name} ${value ? "set" : "cleared"} → ${path.relative(ROOT, f)}`);
    return { ok: true, name, set: envSet(name), envFile: path.relative(ROOT, f) };
  });
  on("GET", "/api/models/:provider", async (req, m, url) => {
    const cfg = loadProviders();
    const p = cfg.providers[m.provider];
    if (!p) throw new HttpError(404, `Unknown provider "${m.provider}"`);
    const lm = await liveModels(p, { force: url.searchParams.get("refresh") === "1" });
    return { provider: p.id, configured: p.models || [], live: lm.models, error: lm.error, fetchedAt: lm.at };
  });

  // ---- attachments
  on("POST", "/api/extract", async (req) => {
    const { name = "file", data } = await readBody(req);
    if (typeof data !== "string" || !data) throw bad("no data");
    const buf = Buffer.from(data, "base64");
    if (buf.length > 25 * 1024 * 1024) throw bad("file larger than 25 MB");
    const ext = String(name).split(".").pop().toLowerCase();
    let text, note = "";
    if (ext === "pdf" || buf.subarray(0, 5).toString() === "%PDF-") {
      const { pdfText } = await import("./pdf-text.js");
      const r = pdfText(buf);
      text = r.pages.map((p, i) => `[page ${i + 1}]\n${p}`).join("\n\n");
      note = r.note;
      if (!r.pages.length) throw bad(`${name}: ${r.note}`);
    } else if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"].includes(ext)) {
      throw bad("images cannot be attached — every model receives the same text, and images are not text. Describe the image in the question, or attach a document.");
    } else if (["docx", "xlsx", "pptx", "doc", "xls", "ppt"].includes(ext)) {
      throw bad(`${ext} is not supported yet — export it as PDF, text or CSV first`);
    } else {
      if (buf.subarray(0, 8000).includes(0)) throw bad("binary file — only text-like files and PDFs can be attached");
      text = buf.toString("utf8").replace(/^﻿/, "");
      if (ext === "html" || ext === "htm") text = stripHtml(text);
    }
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    log(`extract ${name} ${buf.length}b → ${words} words ${note}`);
    return { ok: true, name, words, chars: text.trim().length, note, text: text.trim() };
  });

  // ---- MCP servers and plugins
  on("GET", "/api/mcp", async () => ({ servers: await Promise.all(Object.values(loadMcp(PATHS.mcp)).map(mcpPublic)), file: path.relative(ROOT, PATHS.mcp) }));
  on("PUT", "/api/mcp/:id", async (req, m) => {
    const id = String(m.id);
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw bad("server ids are lower_snake_case");
    const servers = loadMcp(PATHS.mcp);
    const patch = await readBody(req);
    if (patch.remove) { delete servers[id]; forgetTools(id); saveMcp(servers, PATHS.mcp); return { ok: true, removed: id }; }
    const cur = servers[id] || { id, label: id, url: "", headers: {}, enabled: false, allow: null, budget_per_turn: DEFAULT_BUDGET, timeoutMs: 20000 };
    if (patch.url !== undefined) { checkMcpUrl(String(patch.url)); cur.url = String(patch.url); forgetTools(id); }
    if (patch.label !== undefined) cur.label = String(patch.label).slice(0, 60) || id;
    if (patch.headers !== undefined) { if (!patch.headers || typeof patch.headers !== "object") throw bad("headers must be an object"); cur.headers = patch.headers; forgetTools(id); }
    if (patch.enabled !== undefined) cur.enabled = patch.enabled === true;
    if (patch.allow !== undefined) cur.allow = Array.isArray(patch.allow) && patch.allow.length ? patch.allow.map(String) : null;
    for (const k of ["budget_per_turn", "timeoutMs"]) if (patch[k] !== undefined) { const n = Number(patch[k]); if (!Number.isFinite(n) || n <= 0) throw bad(`Bad ${k}`); cur[k] = n; }
    if (!cur.url) throw bad("url is required");
    servers[id] = cur;
    saveMcp(servers, PATHS.mcp);
    log(`mcp ${id} ${cur.enabled ? "enabled" : "saved"} → ${cur.url}`);
    return { ok: true, server: await mcpPublic(loadMcp(PATHS.mcp)[id]) };
  });
  on("POST", "/api/mcp/:id/test", async (_req, m) => {
    const s = loadMcp(PATHS.mcp)[String(m.id)];
    if (!s) throw bad("unknown server");
    forgetTools(s.id);
    const tools = await listMcpTools(s, { fresh: true });
    return { ok: true, count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description, args: t.args })) };
  });
  on("GET", "/api/plugins", () => ({ plugins: listPlugins(PATHS.plugins, PATHS.pluginState).map(({ dir, skillsDir, toolsFile: _t, mcpFile, ...p }) => p), dir: path.relative(ROOT, PATHS.plugins) }));
  on("POST", "/api/plugins/:id/enable", async (req, m) => {
    const b = await readBody(req);
    const p = setPluginEnabled(String(m.id), b.enabled !== false, { dir: PATHS.plugins, stateFile: PATHS.pluginState });
    forgetTools();
    log(`plugin ${p.id} ${p.enabled ? "enabled" : "disabled"}`);
    const { dir, skillsDir, toolsFile: _t, mcpFile, ...pub } = p;
    return { ok: true, plugin: pub };
  });
  on("GET", "/api/local-runtimes", async () => ({ runtimes: await probeLocalRuntimes() }));
  on("POST", "/api/local-runtimes/:id/enable", async (_req, m) => {
    const rt = (await probeLocalRuntimes()).find((r) => r.id === m.id);
    if (!rt) throw new HttpError(404, "unknown runtime");
    if (!rt.running) throw new HttpError(409, `${rt.label} is not running (${rt.error}). ${rt.hint}`);
    const cfg = loadProviders();
    const id = rt.providerId || rt.id;
    const prev = cfg.providers[id] || {};
    cfg.providers[id] = { ...prev, type: "openai", label: prev.label || rt.label, baseUrl: prev.baseUrl || rt.baseUrl, keyEnv: null, models: rt.models.length ? rt.models : prev.models || [], enabled: true, local: true };
    saveProviders(cfg); modelCache.clear();
    log(`local runtime ${id} enabled with ${rt.models.length} models`);
    return { ok: true, provider: publicProvider(loadProviders().providers[id]), models: rt.models };
  });

  // ---- tools (direct call, for Settings › test)
  on("POST", "/api/tool", async (req) => {
    const { name, args } = await readBody(req);
    if (typeof name !== "string" || (args != null && typeof args !== "object")) throw bad("{name, args}");
    return runTool(await toolCatalog(), name, args || {}, { ctx: {} });
  });

  // ---- runs
  on("POST", "/api/runs", async (req) => {
    const opts = await runOptionsFrom(await readBody(req));
    const { _catalog, ...engineOpts } = opts;
    const { id } = startRun(engineOpts, { ...runEnv(_catalog, log), log });
    log(`run ${id} started: ${engineOpts.models.map((m) => `${m.provider}/${m.model}`).join(" vs ")}`);
    return { id };
  });
  // Synchronous: start, wait, return the record (for scripts, n8n, another agent).
  on("POST", "/api/run", async (req) => {
    const b = await readBody(req);
    const opts = await runOptionsFrom(b);
    const { _catalog, ...engineOpts } = opts;
    const { id, done } = startRun(engineOpts, { ...runEnv(_catalog, log), log });
    const { record } = await done;
    const { prompts, outputs, ...lean } = record;
    return { ok: record.status === "done", id, record: b.full ? record : lean, report: `/api/runs/${id}/report.md` };
  });
  on("GET", "/api/runs", () => ({ runs: listRuns() }));
  on("GET", "/api/scorecard", (req, _m, url) => scorecard(allRecords(), { includeMock: url.searchParams.get("mock") === "1" }));
  on("GET", "/api/runs/:id", (_req, m) => {
    if (!RUN_ID_RE.test(m.id)) throw bad("bad run id");
    const r = readRecord(m.id);
    if (!r) throw new HttpError(404, "no such run");
    return r;
  });
  on("GET", "/api/runs/:id/events", (_req, m, _url, res) => {
    if (!RUN_ID_RE.test(m.id)) throw bad("bad run id");
    if (!streamRun(m.id, res)) throw new HttpError(404, "no such run");
    return undefined; // streamed
  });
  on("GET", "/api/runs/:id/report.md", (_req, m, _url, res) => {
    if (!RUN_ID_RE.test(m.id) && !LEGACY_ID_RE.test(m.id)) throw bad("bad run id");
    const f = path.join(PATHS.runs, `${m.id}.md`);
    if (!fs.existsSync(f)) throw new HttpError(404, isLive(m.id) ? "the report is written when the run ends" : "no report");
    send(res, 200, fs.readFileSync(f, "utf8"), { "content-type": "text/markdown; charset=utf-8" });
    return undefined;
  });
  on("GET", "/api/runs/:id/report.html", (_req, m, url, res) => {
    if (!RUN_ID_RE.test(m.id)) throw bad("bad run id");
    if (isLive(m.id)) throw new HttpError(409, "the page is made when the run ends");
    const html = reportHtml(m.id, { prompts: url.searchParams.get("prompts") !== "0", documents: url.searchParams.get("documents") !== "0", version: version() });
    if (html == null) throw new HttpError(404, "no such run");
    send(res, 200, html, {
      "content-type": "text/html; charset=utf-8",
      // The page has no script of its own; previews of generated files run sandboxed and offline.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'self' data: blob:; script-src 'none'",
      ...(url.searchParams.get("download") === "1" ? { "content-disposition": `attachment; filename="agent-debate-${m.id}.html"` } : {}),
    });
    return undefined;
  });
  on("POST", "/api/runs/:id/stop", (_req, m) => ({ ok: stopRun(m.id) }));
  on("DELETE", "/api/runs/:id", (_req, m) => {
    if (!RUN_ID_RE.test(m.id) && !LEGACY_ID_RE.test(m.id)) throw bad("bad run id");
    const n = deleteRun(m.id);
    log(`run ${m.id} deleted (${n} entries)`);
    return { ok: true, removed: n };
  });
  on("GET", "/api/runs/:id/files/:letter/*", (_req, m, _url, res) => {
    if (!RUN_ID_RE.test(m.id)) throw bad("bad run id");
    const f = runFile(m.id, m.letter, m.rest);
    if (!f) throw new HttpError(404, "no such file");
    res.writeHead(200, { "content-type": mimeFor(f), "cache-control": "no-store", "content-security-policy": "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'" });
    res.end(fs.readFileSync(f));
    return undefined;
  });

  // ---- request handling
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      const hostName = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!allowedHosts.has(hostName)) throw new HttpError(403, "unexpected Host header");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
        const o = (() => { try { return new URL(req.headers.origin); } catch { return null; } })();
        if (!o || !allowedHosts.has(o.hostname) || Number(o.port || 80) !== port) throw new HttpError(403, "cross-origin request refused");
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (url.pathname === "/" || url.pathname === "/index.html") return serveStatic(res, path.join(APP, "ui"), "index.html") || send(res, 404, "missing ui");
        if (url.pathname === "/favicon.ico") return send(res, 204, "");
        if (url.pathname.startsWith("/ui/") && serveStatic(res, path.join(APP, "ui"), url.pathname.slice(4))) return;
        if (url.pathname.startsWith("/core/") && serveStatic(res, path.join(APP, "core"), url.pathname.slice(6))) return;
        return send(res, 404, "not found");
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const out = await r.fn(req, m.groups || {}, url, res);
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return;
      }
      throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      const status = e.status || (/not enabled|Unknown provider|not in its configured list|not set in \.env|is required|at most|pick at least/.test(e.message) ? 400 : 500);
      send(res, status, { error: e.message });
    }
  });
  server.on("listening", () => { port = server.address().port; });
  return server;
}

// ---------------------------------------------------------------- main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  if (ensureProvidersFile()) console.log(`created ${path.relative(ROOT, PATHS.providers)} from the example — switch providers on in Settings`);
  try { loadProviders(); } catch (e) { console.error(e.message); process.exit(1); }
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const server = createServer({ log, host });
  server.listen(port, host, () => log(`agent-debate ${version()} → http://${host === "0.0.0.0" ? "localhost" : host}:${port}   (config: ${path.relative(ROOT, PATHS.config) || "."}/)`));
}
