// The claude.ai artifact host. Same console, same engine — but the engine runs in the page, and the
// models are Claude, reached through the claude.ai `sample` capability on the viewer's own account
// (tiers: default, complex, quick). Falls back to a chat artifact's window.claude.complete, then to
// the classic artifact fetch. The mock analysts stay available so the page can be tried at no cost.
import { runDebate } from "../app/core/engine.js";
import { reduceEvents } from "../app/core/record.js";
import { mockReply } from "../app/core/mock-models.js";
import { safeCalc } from "../app/core/calc.js";
import { ARTIFACT_DATA } from "./artifact-data.js";
import { scorecard } from "../app/core/scorecard.js";

const TIERS = ["default", "complex", "quick"];
const CLASSIC_MODEL = { default: "claude-sonnet-4-6", complex: "claude-opus-4-6", quick: "claude-haiku-4-5" };
const hasUse = typeof window !== "undefined" && typeof window.claude?.use === "function";
const samplePromise = hasUse ? window.claude.use("sample").catch(() => null) : Promise.resolve(null);
const downloadsPromise = hasUse ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
const abortErr = () => Object.assign(new Error("stopped"), { name: "AbortError" });

async function callClaude({ model, system, user, maxTokens, signal }) {
  const tier = TIERS.includes(model) ? model : "default";
  const sample = await samplePromise;
  if (sample) {
    try {
      // sample has no system role: the instructions lead the prompt, then the material.
      const r = await sample(`${system}\n\n==========\n\n${user}`, { modelTier: tier, cache: false, signal });
      return { text: r.text, truncated: Boolean(r.truncated), tier: r.modelTierApplied };
    } catch (e) {
      if (e?.code === "cancelled" || signal?.aborted) throw abortErr();
      const hint = { not_granted: "the page was not allowed to use Claude — allow it when asked", rate_limited: "Claude's usage limit or rate limit was reached — try again later", sampling_disabled: "Claude is not available for this account", prompt_too_large: "the prompt is larger than 256 KB — attach less" }[e?.code];
      throw new Error(`Claude (${tier}): ${hint || e?.message || e?.code || "failed"}`);
    }
  }
  if (typeof window.claude?.complete === "function") {
    if (signal?.aborted) throw abortErr();
    return { text: String(await window.claude.complete(`${system}\n\n==========\n\n${user}`)) };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: CLASSIC_MODEL[tier], max_tokens: Math.min(8000, maxTokens || 4000), system, messages: [{ role: "user", content: user }] }),
  }).catch((e) => { if (signal?.aborted) throw abortErr(); throw new Error(`Claude is not reachable from this page (${e.message}). Open it in claude.ai, or use the mock analysts.`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude ${res.status}: ${data?.error?.message || "request failed"}`);
  return { text: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"), truncated: data.stop_reason === "max_tokens" };
}

// Nothing here is billed per token: Claude runs on the viewer's plan, the mocks on nothing.
const PLAN = { in: 0, out: 0, source: "your Claude plan" };
const FREE = { in: 0, out: 0, source: "free (mock)" };
const MOCKS = ["mock-1", "mock-2", "mock-3", "mock-alt", "mock-liar", "mock-svg"];

const CALC_TOOL = { name: "calculate", description: "Evaluate an arithmetic expression exactly: + - * / ^ %, parentheses, sqrt, round, min, max, ln, log; 1.5k / 2m / 3b suffixes.", args: { expression: "the arithmetic expression" }, budget_per_turn: 3, available: true, category: "compute", missingEnv: [] };

const runs = new Map();
const store = {
  get(k, d) { try { const v = localStorage.getItem(`ad.art.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ad.art.${k}`, JSON.stringify(v)); return true; } catch { return false; } },
};
// Keep the last few finished runs in this browser, so a reload does not lose them.
for (const r of store.get("runs", [])) runs.set(r.id, { events: r.events, listeners: new Set(), ctrl: null, status: r.status, started: r.started, question: r.question });
function persist() {
  const done = [...runs.entries()].filter(([, e]) => e.status !== "running").sort((a, b) => b[1].started - a[1].started).slice(0, 6);
  let keep = done.map(([id, e]) => ({ id, events: e.events, status: e.status, started: e.started, question: e.question }));
  while (keep.length && !store.set("runs", keep)) keep = keep.slice(0, -1);
}

function suggest(question) {
  const text = ` ${String(question || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ")} `;
  return ARTIFACT_DATA.skills.filter((s) => s.topics.some((t) => text.includes(` ${t} `) || text.includes(` ${t}s `))).map((s) => s.name);
}

window.__AD_SAVE__ = async (data, filename, type) => {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const d = await downloadsPromise;
  if (d) { try { await d.save({ filename, data: blob }); } catch { /* the viewer declined */ } return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
};

window.__AD_HOST__ = {
  kind: "artifact",
  followSystemTheme: true,
  canSettings: false,
  intro: `<p><b>Ask one question of several Claude models.</b> Each answers alone first, with every claim labelled by what supports it — a quote from your documents, a calculation, or its own reasoning or knowledge.</p>
    <p>Then they critique each other, answer the critiques, and declare final positions. Code, not a model, measures what they agreed on, what they could prove, and who changed their mind.</p>
    <p>The analysts are Claude's three tiers — <b>default</b>, <b>complex</b> and <b>quick</b> — on your own Claude usage; the first call asks your permission. The <b>mock</b> analysts cost nothing and show how a run works. The local app adds any provider, web search, MCP tools and PDFs.</p>`,
  async config() {
    return {
      version: ARTIFACT_DATA.version,
      default: { provider: "claude", model: "default" },
      providers: [
        { id: "claude", label: "Claude", type: "claude", models: TIERS, hasKey: true, prices: Object.fromEntries(TIERS.map((t) => [t, PLAN])) },
        { id: "mock", label: "Mock (no usage)", type: "mock", models: MOCKS, hasKey: true, prices: Object.fromEntries(MOCKS.map((m) => [m, FREE])) },
      ],
      personas: ARTIFACT_DATA.personas.map(({ id, name, lens }) => ({ id, name, lens })),
      skills: ARTIFACT_DATA.skills.map(({ name, description, topics }) => ({ name, description, topics })),
      tools: [CALC_TOOL],
      limits: { maxContextChars: 150000, maxContextCharsRaised: 220000 },
    };
  },
  suggestSkills: async (q) => suggest(q),
  async extract(file) {
    if (/\.pdf$/i.test(file.name)) throw new Error("this page cannot read PDF text — copy the text and use Paste text, or use the local app");
    if (/^(image|audio|video)\//.test(file.type)) throw new Error("only text can be attached — every model receives the same text");
    const text = (await file.text()).replace(/^﻿/, "");
    return { name: file.name, text, words: text.trim().split(/\s+/).filter(Boolean).length };
  },
  async startRun(body) {
    if (!String(body.question || "").trim()) throw new Error("question is required");
    const label = (p, m) => (p === "claude" ? `Claude · ${m}` : `Mock · ${m}`);
    const models = (body.models || []).map((m) => ({ provider: m.provider, model: m.model, type: m.provider, label: label(m.provider, m.model) }));
    if (!models.length) throw new Error("pick at least one model");
    const role = (v) => (v && typeof v === "object" ? { ...v, type: v.provider, label: label(v.provider, v.model) } : v);
    const opts = {
      question: body.question, models, rounds: body.rounds, deliverable: body.deliverable, docs: body.docs,
      persona: ARTIFACT_DATA.personas.find((p) => p.id === body.persona) || null,
      skills: ARTIFACT_DATA.skills.filter((s) => (body.skills || []).includes(s.name)),
      tools: (body.tools || []).includes("calculate") ? [CALC_TOOL] : [],
      expand: body.expand, expander: role(body.expander), synthesizer: role(body.synthesizer), autoStop: body.autoStop, allowLargeContext: body.allowLargeContext,
      prices: Object.fromEntries([...models, ...[role(body.expander), role(body.synthesizer)].filter((r) => r && typeof r === "object")].map((m) => [`${m.provider}|${m.model}`, m.provider === "claude" ? PLAN : FREE])),
    };
    const now = new Date();
    const id = `run-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-")}-${Math.random().toString(36).slice(2, 6)}`;
    const entry = { events: [], listeners: new Set(), ctrl: new AbortController(), status: "running", started: Date.now(), question: body.question };
    runs.set(id, entry);
    runDebate(opts, {
      signal: entry.ctrl.signal,
      call: (r) => (r.provider === "mock" ? mockReply({ model: r.model, system: r.system, user: r.user, signal: r.signal }) : callClaude(r)),
      callTool: async ({ name, args }) => { if (name !== "calculate") return { error: `no tool "${name}" on this page` }; const r = safeCalc(String(args?.expression ?? Object.values(args || {})[0] ?? "")); return r.error ? { error: r.error } : { text: `${args.expression} = ${r.value}` }; },
      emit: (ev) => { entry.events.push(ev); for (const l of entry.listeners) l.onEvent(ev); },
    }).then((rec) => {
      entry.status = rec.status;
      for (const l of entry.listeners) l.onEnd();
      entry.listeners.clear();
      persist();
    });
    return { id };
  },
  subscribe(id, onEvent, onEnd) {
    const e = runs.get(id);
    if (!e) { setTimeout(onEnd, 0); return () => {}; }
    const l = { onEvent, onEnd };
    queueMicrotask(() => {
      for (const ev of e.events) onEvent(ev);
      if (e.status !== "running") onEnd(); else e.listeners.add(l);
    });
    return () => e.listeners.delete(l);
  },
  async stop(id) { runs.get(id)?.ctrl?.abort(); return { ok: true }; },
  async listRuns() {
    return [...runs.entries()].map(([id, e]) => {
      const rec = e.status === "running" ? null : reduceEvents(e.events);
      const cfg = e.events[0]?.config;
      return { id, status: e.status, started: e.started, question: e.question, live: e.status === "running", models: (cfg?.models || []).map((m) => ({ letter: m.letter, label: m.label, color: m.color })), headline: rec?.final?.compare?.headline || null, red_flag: Boolean(rec?.final?.compare?.redFlag) };
    }).sort((a, b) => b.started - a.started);
  },
  async deleteRun(id) { if (runs.get(id)?.status === "running") throw new Error("stop the run first"); runs.delete(id); persist(); return { ok: true }; },
  reportUrl: () => null,
  async scorecard(includeMock) {
    return scorecard([...runs.entries()].filter(([, e]) => e.status !== "running").map(([id, e]) => ({ id, ...reduceEvents(e.events) })), { includeMock });
  },
};
