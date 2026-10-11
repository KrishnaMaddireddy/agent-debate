// The debate engine (PRD §7). Emits events; everything else — the record, the report, the console
// panels — is a pure function of those events (record.js). Browser-safe: the server, the CLI and
// the claude.ai artifact all run this same file.
//
// env = {
//   call({phase, round, letter, provider, model, system, user, maxTokens, signal})
//        → Promise<{text, reasoningText?, truncated?, fromReasoning?}>
//   callTool({letter, name, args, signal}) → Promise<{items?, text?, data?, count?, error?}>
//        (may also return usage {input, output, cached?} and servedModel; usage is estimated when absent)
//   emit(event)          — every event, as it happens
//   signal               — AbortSignal; Stop aborts in-flight calls and ends the run as "stopped"
// }

import { extractJson, hasShape, isPlaceholder, isEnumCopy, cleanStrings, looksLikeChainOfThought, clampInt } from "./json.js";
import {
  LETTERS, BASES, ROOT_CAUSES, VERDICTS, INTENT_KEYS, ARTIFACT_KEYS, CRITIQUE_KEYS, REBUTTAL_KEYS,
  intentPrompt, answerPrompt, critiquePrompt, rebuttalPrompt, memoPrompt, MEMO_RETRY_SYSTEM, repairPrompt,
  artifactView, answerTokens, critiqueTokens, rebuttalTokens, MEMO_TOKENS, INTENT_TOKENS,
} from "./prompts.js";
import { turnBudget, parseToolCalls, toolResultsBlock, BUDGET_SPENT, TOOL_SYNTAX_NOTE, formatToolResult, overBudget, paidCalls, FREE_TOOLS } from "./tools-protocol.js";
import { extractFiles } from "./files.js";
import { auditContext, auditArtifact, auditClaim, auditFlags, groundingOf } from "./audit.js";
import { snapshot, normRef, verdictTally, rootCauseTally, movementLog, towards, compareSnapshots, pct } from "./metrics.js";
import { wordCount, clip, normText } from "./text.js";
import { reduceEvents } from "./record.js";
import { costOf, worstCaseCost, estimateTokens, priceKey, fmtUsd } from "./cost.js";

export const MODEL_COLORS = ["#5aa9ff", "#f0883e", "#3fb950", "#d2a8ff", "#e3b341", "#56d4dd"];
export const MAX_CONTEXT_CHARS = 200_000;
export const MAX_CONTEXT_CHARS_RAISED = 800_000;
export const LARGE_CONTEXT_WARN = 60_000;

// ---------------------------------------------------------------- options

export function normaliseRunOptions(o = {}) {
  const question = String(o.question ?? "").trim();
  if (!question) throw new Error("question is required");
  if (question.length > 20000) throw new Error("question is longer than 20,000 characters — attach it as a document instead");
  const rawModels = Array.isArray(o.models) ? o.models : [];
  if (!rawModels.length) throw new Error("at least one model is required");
  if (rawModels.length > LETTERS.length) throw new Error(`at most ${LETTERS.length} models`);
  const models = rawModels.map((m, i) => ({
    letter: LETTERS[i],
    provider: String(m.provider ?? ""),
    model: String(m.model ?? ""),
    type: m.type || null,
    label: String(m.label || `${m.providerLabel || m.provider} · ${m.model}`),
    color: MODEL_COLORS[i],
  }));
  const deliverable = o.deliverable === "files" ? "files" : "answer";
  const cap = o.allowLargeContext ? MAX_CONTEXT_CHARS_RAISED : MAX_CONTEXT_CHARS;
  const docs = (Array.isArray(o.docs) ? o.docs : []).filter((d) => d && String(d.text ?? "").trim()).map((d, i) => ({
    id: `D${i + 1}`, name: String(d.name || `document ${i + 1}`).slice(0, 120), text: String(d.text), words: wordCount(d.text), chars: String(d.text).length,
  }));
  const chars = docs.reduce((n, d) => n + d.chars, 0);
  if (chars > cap) throw new Error(`attached documents total ${chars.toLocaleString("en-US")} characters, above the ${cap.toLocaleString("en-US")} limit${o.allowLargeContext ? "" : " — raise it knowingly with allowLargeContext"}. Every model receives every byte, every phase.`);
  const tools = (Array.isArray(o.tools) ? o.tools : []).filter((t) => t && t.name && !["read_skill", "read_context"].includes(t.name));
  const budget = deliverable === "files" ? 0 : turnBudget(tools);
  const rounds = models.length < 2 ? 0 : clampInt(o.rounds ?? 1, 0, 3, 1);
  const pickRole = (spec, role, dflt) => {
    if (spec === "none") return "none";
    if (typeof spec === "string" && LETTERS.includes(spec.toUpperCase()) && models.some((m) => m.letter === spec.toUpperCase())) return { letter: spec.toUpperCase() };
    if (spec && typeof spec === "object" && spec.provider && spec.model) return { role, provider: String(spec.provider), model: String(spec.model), type: spec.type || null, label: String(spec.label || `${spec.provider} · ${spec.model}`) };
    return dflt;
  };
  const firstFast = models.find((m) => m.type !== "cli") || models[0];
  const prices = {};
  for (const [k, v] of Object.entries(o.prices && typeof o.prices === "object" ? o.prices : {})) {
    if (v && Number.isFinite(Number(v.in)) && Number.isFinite(Number(v.out)) && Number(v.in) >= 0 && Number(v.out) >= 0) prices[k] = { in: Number(v.in), out: Number(v.out), ...(Number.isFinite(Number(v.cachedIn)) && v.cachedIn != null ? { cachedIn: Number(v.cachedIn) } : {}), ...(Number(v.floor) > 0 ? { floor: Number(v.floor) } : {}), source: String(v.source || "") };
  }
  const capRaw = o.budgetUsd ?? o.spendCap;
  const spendCap = capRaw == null || capRaw === "" || Number(capRaw) === 0 ? null : Number(capRaw);
  if (spendCap != null && !(spendCap > 0 && spendCap <= 1000)) throw new Error("the spending cap must be between $0 and $1000");
  return {
    question, deliverable, docs, docChars: chars, models, rounds,
    autoStop: o.autoStop !== false,
    expand: o.expand !== false,
    expander: pickRole(o.expander, "reader", { letter: firstFast.letter }),
    synthesizer: pickRole(o.synthesizer, "writer", "auto"),
    persona: o.persona && o.persona.name ? { name: String(o.persona.name), lens: String(o.persona.lens || ""), standards: cleanStrings(o.persona.standards), emphasize: cleanStrings(o.persona.emphasize), avoid: cleanStrings(o.persona.avoid) } : null,
    skills: (Array.isArray(o.skills) ? o.skills : []).filter((s) => s && s.name && s.body).map((s) => ({ name: String(s.name), description: String(s.description || ""), body: String(s.body) })),
    tools: deliverable === "files" ? [] : tools,
    budget,
    verifyBudget: budget ? Math.min(2, budget) : 0,
    prices, spendCap,
  };
}

/** Every provider/model a run may call: analysts, plus a reader or writer that is not an analyst. */
export function participants(cfg) {
  const out = cfg.models.map((m) => ({ provider: m.provider, model: m.model }));
  for (const r of [cfg.expander, cfg.synthesizer]) if (r && typeof r === "object" && r.provider) out.push({ provider: r.provider, model: r.model });
  return out;
}

export function publicConfig(cfg) {
  const who = (r) => (r === "none" || r === "auto" ? r : r?.letter ? { letter: r.letter } : { role: r.role, provider: r.provider, model: r.model, label: r.label });
  return {
    question: cfg.question, deliverable: cfg.deliverable, rounds: cfg.rounds, autoStop: cfg.autoStop, expand: cfg.expand,
    models: cfg.models.map(({ letter, label, provider, model, type, color }) => ({ letter, label, provider, model, type, color })),
    docs: cfg.docs.map(({ id, name, words, chars, text }) => ({ id, name, words, chars, text })),
    expander: who(cfg.expander), synthesizer: who(cfg.synthesizer),
    persona: cfg.persona, skills: cfg.skills.map((s) => s.name), tools: cfg.tools.map((t) => ({ name: t.name, provider: t.providerLabel || t.provider || null, mcp: t.mcp || null })),
    budget: cfg.budget, verifyBudget: cfg.verifyBudget,
    spend_cap: cfg.spendCap,
    prices: Object.fromEntries(participants(cfg).map((p) => [priceKey(p.provider, p.model), cfg.prices[priceKey(p.provider, p.model)] || null])),
  };
}

// ---------------------------------------------------------------- parsing and normalising replies

function parseIntentReply(text) {
  const o = extractJson(text, INTENT_KEYS);
  if (!o || typeof o.reading !== "string" || !o.reading.trim() || isPlaceholder(o.reading)) return null;
  const subs = (Array.isArray(o.sub_questions) ? o.sub_questions : []).map((q, i) => (typeof q === "string" ? { id: `q${i + 1}`, text: q } : { id: /^q\d+$/i.test(String(q?.id || "")) ? String(q.id).toLowerCase() : `q${i + 1}`, text: String(q?.text ?? q?.question ?? "") }))
    .filter((q) => q.text.trim() && !isPlaceholder(q.text)).slice(0, 6);
  const str = (v, n) => (typeof v === "string" && v.trim() && !isPlaceholder(v) && !/^null$/i.test(v.trim()) ? v.trim().slice(0, n) : null);
  const count = clampInt(o.count, 1, 100, null);
  return {
    reading: o.reading.trim().slice(0, 800),
    sub_questions: subs,
    testable: cleanStrings(o.testable).slice(0, 12),
    not_testable: cleanStrings(o.not_testable).slice(0, 12),
    proxies: cleanStrings(o.proxies).slice(0, 12),
    gates: cleanStrings(o.gates).slice(0, 4),
    terms: cleanStrings(o.terms).slice(0, 12),
    count: Number.isInteger(Number(o.count)) && Number(o.count) >= 1 ? count : null,
    horizon: str(o.horizon, 60),
    caveat: str(o.caveat, 400),
  };
}

/** Normalise claims; returns {claims, copies} where copies counts rows dropped as template copies. */
function normaliseClaims(list, { startAt = 1, taken = new Set() } = {}) {
  const claims = [], seen = new Set(taken);
  let copies = 0, next = startAt;
  for (const raw of Array.isArray(list) ? list.slice(0, 30) : []) {
    // A bare claim id ("c3") is a reference, not a proposition: dropped.
    if (!raw || typeof raw !== "object") { if (typeof raw === "string" && raw.trim() && !isPlaceholder(raw) && !/^\s*(?:[A-F]\s*:\s*)?c\d+\s*$/i.test(raw)) claims.push({ text: raw.trim(), basis: "reasoning", evidence: "", source: "", load_bearing: false }); continue; }
    const text = String(raw.text ?? raw.claim ?? "").trim();
    if (!text || isPlaceholder(text)) { copies++; continue; }
    let basis = String(raw.basis ?? "").trim().toLowerCase();
    let basisNote = null;
    if (isEnumCopy(basis)) { copies++; continue; }
    if (!BASES.includes(basis)) { basisNote = basis ? `declared "${basis}"` : "no basis declared"; basis = "reasoning"; }
    let evidence = String(raw.evidence ?? "").trim();
    if (isPlaceholder(evidence)) evidence = "";
    const source = isPlaceholder(raw.source) ? "" : String(raw.source ?? "").trim().toUpperCase().replace(/^DOC(UMENT)?\s*/, "D").slice(0, 8);
    let id = String(raw.id ?? "").trim().toLowerCase();
    if (!/^c\d+$/.test(id) || seen.has(id)) { while (seen.has(`c${next}`)) next++; id = `c${next}`; }
    seen.add(id);
    const c = { id, text: text.slice(0, 1200), basis, evidence: evidence.slice(0, 2000), source, load_bearing: raw.load_bearing === true || String(raw.load_bearing).toLowerCase() === "true" };
    if (basisNote) c.basis_note = basisNote;
    claims.push(c);
  }
  for (const c of claims) if (!c.id) { while (seen.has(`c${next}`)) next++; c.id = `c${next}`; seen.add(c.id); }
  return { claims, copies };
}

function normaliseItems(list) {
  return (Array.isArray(list) ? list : []).slice(0, 50).map((i) => (typeof i === "string" ? { name: i } : { name: String(i?.name ?? i?.item ?? ""), why: typeof i?.why === "string" ? i.why : "", claims: Array.isArray(i?.claims) ? i.claims.map(String).filter((x) => /^c\d+$/i.test(x)) : [] }))
    .filter((i) => i.name.trim() && !isPlaceholder(i.name));
}

function parseArtifactReply(text) {
  const o = extractJson(text, ARTIFACT_KEYS);
  // An answer states a position. An object without one is a fragment — an item, a claim — of a reply
  // whose outer object did not parse (live, rev 15: an item's ["c3","c6"] was read as the claims).
  // Returning null sends the reply for one repair instead of accepting the fragment.
  if (!o || typeof o.position !== "string" || !o.position.trim()) return o && isPlaceholder(o.position) ? { copy: true } : null;
  const position = o.position.trim();
  if (isPlaceholder(position)) return { copy: true };
  const { claims, copies } = normaliseClaims(o.claims);
  const subs = {};
  if (o.sub_answers && typeof o.sub_answers === "object" && !Array.isArray(o.sub_answers)) {
    for (const [k, v] of Object.entries(o.sub_answers)) if (!isPlaceholder(k) && typeof v === "string" && v.trim() && !isPlaceholder(v)) subs[k.toLowerCase()] = v.trim();
  }
  return {
    artifact: {
      position: position || "(no position stated)",
      confidence: clampInt(o.confidence, 0, 100, null),
      claims,
      items: normaliseItems(o.items),
      assumptions: cleanStrings(o.assumptions).slice(0, 12),
      counter_considerations: cleanStrings(o.counter_considerations).slice(0, 8),
      what_would_change_my_mind: cleanStrings(o.what_would_change_my_mind).slice(0, 8),
      sub_answers: subs,
    },
    copies,
  };
}

const letterOf = (v, letters) => {
  const m = String(v ?? "").toUpperCase().match(/\b([A-F])\b/);
  return m && letters.includes(m[1]) ? m[1] : null;
};

function parseCritiqueReply(text, me, letters) {
  const o = extractJson(text, CRITIQUE_KEYS);
  if (!o || !CRITIQUE_KEYS.some((k) => k in o)) return null;
  const others = letters.filter((x) => x !== me);
  const solo = others.length === 1 ? others[0] : null;
  let copies = 0;
  const divergences = [];
  for (const d of Array.isArray(o.divergences) ? o.divergences : []) {
    if (!d || typeof d !== "object") continue;
    const rc = String(d.root_cause ?? "").trim().toLowerCase();
    if (isEnumCopy(rc) || (isPlaceholder(d.topic) && isPlaceholder(d.detail))) { copies++; continue; }
    const topic = String(d.topic ?? "").trim();
    if (!topic || isPlaceholder(topic)) { copies++; continue; }
    const w = letterOf(d.with ?? d.analyst ?? "", others) || solo;
    divergences.push({ with: w, topic, mine: String(d.mine ?? ""), theirs: String(d.theirs ?? ""), root_cause: ROOT_CAUSES.includes(rc) ? rc : "unclassified", detail: String(d.detail ?? "") });
  }
  const verdicts = [];
  const seenRef = new Set();
  for (const v of Array.isArray(o.verdicts) ? o.verdicts : Array.isArray(o.their_claims_verdict) ? o.their_claims_verdict : []) {
    if (!v || typeof v !== "object") continue;
    const verdict = String(v.verdict ?? "").trim().toLowerCase();
    if (isEnumCopy(verdict)) { copies++; continue; }
    if (!VERDICTS.includes(verdict)) continue;
    let raw = String(v.claim ?? v.ref ?? v.claim_id ?? "").trim();
    if (v.model && !/[:\s.-]/.test(raw)) raw = `${v.model}:${raw}`;
    let ref = normRef(raw, letters);
    if (!ref && solo && /^c\d+$/i.test(raw)) ref = `${solo}:${raw.toLowerCase()}`;
    if (!ref || ref.startsWith(`${me}:`) || seenRef.has(ref)) continue;
    seenRef.add(ref);
    verdicts.push({ ref, verdict, why: String(v.why ?? "") });
  }
  const questions = (Array.isArray(o.questions) ? o.questions : []).map((q) => (typeof q === "string" ? { to: solo, question: q } : { to: letterOf(q?.to, others) || solo, question: String(q?.question ?? "") }))
    .filter((q) => q.question.trim() && !isPlaceholder(q.question)).slice(0, 3);
  return { critique: { agreements: cleanStrings(o.agreements).slice(0, 12), divergences, verdicts, questions }, copies };
}

function parseRebuttalReply(text) {
  const o = extractJson(text, REBUTTAL_KEYS);
  if (!o || !REBUTTAL_KEYS.some((k) => k in o)) return null;
  let copies = 0;
  const changed = [];
  for (const c of Array.isArray(o.changed_mind) ? o.changed_mind : []) {
    if (!c || typeof c !== "object") continue;
    const topic = String(c.topic ?? c.symbol_or_topic ?? "").trim(), to = String(c.to ?? "").trim();
    if (!topic || isPlaceholder(topic) || !to || isPlaceholder(to)) { copies++; continue; }
    changed.push({ topic, from: String(c.from ?? ""), to, because: String(c.because ?? "") });
  }
  const answers = (Array.isArray(o.answers) ? o.answers : []).map((a) => (typeof a === "string" ? { answer: a } : { to: a?.to ? String(a.to) : undefined, question: a?.question ? String(a.question) : undefined, answer: String(a?.answer ?? "") }))
    .filter((a) => a.answer.trim() && !isPlaceholder(a.answer));
  const finalPosition = typeof o.final_position === "string" && !isPlaceholder(o.final_position) ? o.final_position.trim() : "";
  return {
    rebuttal: {
      answers,
      changed_mind: changed,
      stand_by: cleanStrings(o.stand_by).slice(0, 12),
      withdrawn_claims: (Array.isArray(o.withdrawn_claims) ? o.withdrawn_claims : []).map((x) => String(x).toLowerCase().replace(/^[a-f]:/, "")).filter((x) => /^c\d+$/.test(x)),
      new_claims: Array.isArray(o.new_claims) ? o.new_claims : [],
      final_position: finalPosition,
      final_confidence: clampInt(o.final_confidence, 0, 100, null),
      final_items: (Array.isArray(o.final_items) ? o.final_items : []).map((x) => (typeof x === "string" ? x : x?.name)).filter((x) => typeof x === "string" && x.trim() && !isPlaceholder(x)),
    },
    copies,
  };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const stopError = () => Object.assign(new Error("stopped"), { stopped: true });
const isStop = (e) => Boolean(e?.stopped || e?.name === "AbortError" || e?.code === "cancelled");

// ---------------------------------------------------------------- the run

export async function runDebate(options, env = {}) {
  const events = [];
  // Events are snapshots: the engine keeps mutating its working state (a rebuttal edits the current
  // answer), and an event that held a live reference would silently rewrite history.
  const emit = (type, data = {}) => {
    const ev = JSON.parse(JSON.stringify({ t: Date.now(), type, ...data }));
    events.push(ev);
    try { env.emit?.(ev); } catch { /* a listener's failure is not the run's */ }
    return ev;
  };
  let cfg;
  try { cfg = normaliseRunOptions(options); }
  catch (e) { emit("crash", { phase: "setup", message: e.message }); emit("done", { status: "error" }); return reduceEvents(events); }

  const signal = env.signal;
  const aborted = () => Boolean(signal?.aborted);
  const checkStop = () => { if (aborted() || st.budgetHit) throw stopError(); };
  const files = cfg.deliverable === "files";
  const actx = auditContext({ docs: cfg.docs, question: cfg.question });
  const st = { phase: "setup", intent: null, ledgers: {}, initial: {}, current: {}, present: [], critiques: [], rebuttals: [], spent: 0, reserved: 0, budgetHit: null };
  for (const m of cfg.models) st.ledgers[m.letter] = [];
  const byLetter = Object.fromEntries(cfg.models.map((m) => [m.letter, m]));

  if (cfg.spendCap != null) {
    const unpriced = [...new Set(participants(cfg).filter((p) => !cfg.prices[priceKey(p.provider, p.model)]).map((p) => `${p.provider} · ${p.model}`))];
    if (unpriced.length) { emit("crash", { phase: "setup", message: `a spending cap of ${fmtUsd(cfg.spendCap)} is set, but there is no price for ${unpriced.join(", ")} — set one in Settings › Providers, or run without a cap` }); emit("done", { status: "error" }); return reduceEvents(events); }
  }
  emit("run_started", { config: publicConfig(cfg) });
  let status = "done";

  // ---- one model call, with its prompt and output recorded as events (PRD lesson 6: show the prompts)
  async function callModel(who, phase, round, { system, user, maxTokens }) {
    checkStop();
    const id = who.letter || who.role;
    const price = cfg.prices[priceKey(who.provider, who.model)] || null;
    const promptChars = system.length + user.length;
    // The spending cap is checked BEFORE the call, against the most this call could cost (whole prompt,
    // full ceiling), with every in-flight call's worst case already reserved. A reasoning model's
    // automatic retry at twice the ceiling is allowed only when that larger worst case also fits.
    let reserve = 0, growth = 2;
    if (cfg.spendCap != null) {
      // The provider's own floor (a reasoning model's minimum) can raise the real ceiling above ours.
      const ceiling = Math.min(32000, Math.max(maxTokens, price?.floor || 0));
      reserve = worstCaseCost(promptChars, ceiling, price, 1) || 0;
      if (st.spent + st.reserved + reserve > cfg.spendCap + 1e-9) {
        st.budgetHit = { cap: cfg.spendCap, spent: st.spent, in_flight: st.reserved, needed: reserve, phase, model: id };
        emit("budget_stop", st.budgetHit);
        throw stopError();
      }
      const withRetry = worstCaseCost(promptChars, ceiling, price, 3) || 0;
      if (st.spent + st.reserved + withRetry <= cfg.spendCap) reserve = withRetry; else growth = 1;
      st.reserved += reserve;
    }
    emit("prompt", { phase, round, model: id, system, user, max_tokens: maxTokens });
    const t0 = Date.now();
    let r;
    try {
      r = await env.call({ phase, round, letter: who.letter || null, role: who.role || null, provider: who.provider, model: who.model, system, user, maxTokens, signal, maxGrowth: growth });
    } catch (e) {
      st.reserved -= reserve;
      if (aborted() || isStop(e)) throw stopError();
      throw e;
    }
    st.reserved -= reserve;
    const out = typeof r === "string" ? { text: r } : { text: String(r?.text ?? ""), reasoningText: String(r?.reasoningText ?? ""), truncated: Boolean(r?.truncated), fromReasoning: Boolean(r?.fromReasoning) };
    const u = r && typeof r === "object" ? r.usage : null;
    const usage = u && (u.input != null || u.output != null)
      ? { input: Number(u.input) || 0, output: Number(u.output) || 0, ...(u.cached ? { cached: Number(u.cached) } : {}), estimated: false }
      : { input: estimateTokens(promptChars), output: estimateTokens(out.text.length + (out.reasoningText?.length || 0)), estimated: true };
    const cost = costOf(usage, price);
    if (cost != null) st.spent += cost;
    emit("model_output", { phase, round, model: id, ms: Date.now() - t0, chars: out.text.length, truncated: out.truncated || false, from_reasoning: out.fromReasoning || false, text: out.text, reasoning: out.reasoningText ? clip(out.reasoningText, 20000) : undefined, usage, cost, served_model: r?.servedModel && r.servedModel !== who.model ? String(r.servedModel) : undefined });
    return out;
  }

  // ---- a phase turn with the tool loop (phase 1, and rebuttals with the verification budget)
  async function workTurn(m, phase, round, p, maxTokens, budget) {
    const L = m.letter;
    const exchanges = [];
    let final = budget === 0, nudged = false, last = null;
    for (let iter = 0; iter < budget * 2 + 6; iter++) {
      const user = p.user + toolResultsBlock(exchanges) + (final && budget ? BUDGET_SPENT : "") + (nudged && !budget ? TOOL_SYNTAX_NOTE : "");
      last = await callModel(m, phase, round, { system: p.system, user, maxTokens });
      const calls = parseToolCalls(last.text);
      if (!calls.length) return { ...last, exchanges };
      if (final) {
        if (!nudged) { nudged = true; continue; }
        return { ...last, exchanges };
      }
      for (const c of calls) {
        if (paidCalls(exchanges) >= budget && !FREE_TOOLS.has(c.tool)) { final = true; break; }
        const ref = `T${st.ledgers[L].length + 1}`;
        const t = cfg.tools.find((x) => x.name === c.tool);
        let result;
        if (!t) result = { error: `unknown tool "${c.tool}" — available: ${cfg.tools.map((x) => x.name).join(", ")}` };
        else if (overBudget(cfg.tools, exchanges, c.tool)) result = { error: `${c.tool} has used its calls for this phase` };
        else {
          emit("tool_call", { model: L, phase, round, ref, name: c.tool, args: c.args });
          try { result = await env.callTool({ letter: L, name: c.tool, args: c.args, signal }); }
          catch (e) { if (aborted() || isStop(e)) throw stopError(); result = { error: e.message }; }
        }
        const text = formatToolResult(ref, c, result);
        const row = { ref, tool: c.tool, args: c.args, text, error: result?.error || null, count: result?.count ?? null, phase, round };
        st.ledgers[L].push(row);
        exchanges.push({ ref, call: c, result, text });
        emit("tool_result", { model: L, phase, round, ref, name: c.tool, args: c.args, error: row.error, count: row.count, text: clip(text, 7000) });
        checkStop();
      }
      if (paidCalls(exchanges) >= budget) final = true;
    }
    return { ...last, exchanges };
  }

  const ledgerText = (L) => st.ledgers[L].map((l) => clip(l.text, 1500)).join("\n\n");

  // ---- phase 0
  async function phaseIntent() {
    const first = cfg.expander.letter ? byLetter[cfg.expander.letter] : cfg.expander;
    // One fallback: if the chosen reader returns nothing usable, the next analyst on a different model
    // reads the question instead — every later prompt is better with a reading than without one.
    const next = cfg.models.find((m) => m.provider !== first.provider || m.model !== first.model);
    const byOf = (who) => ({ letter: who.letter || null, role: who.role || null, label: who.label, provider: who.provider, model: who.model });
    st.phase = "intent";
    emit("phase", { n: 0, name: "question reading" });
    const p = intentPrompt(cfg);
    const errors = [];
    for (const who of next ? [first, next] : [first]) {
      try {
        let r = await callModel(who, "intent", 0, { ...p, maxTokens: INTENT_TOKENS });
        let x = parseIntentReply(r.text) || (r.reasoningText ? parseIntentReply(r.reasoningText) : null);
        if (!x) {
          emit("json_retry", { phase: "intent", model: who.letter || who.role, chars: r.text.length, truncated: r.truncated, head: clip(r.text, 300) });
          r = await callModel(who, "intent", 0, { system: `${p.system}\n\nYour previous reply was not a JSON object. Output ONLY the JSON object now — no prose, no code fences, no preamble.`, user: p.user, maxTokens: INTENT_TOKENS * 2 });
          x = parseIntentReply(r.text) || (r.reasoningText ? parseIntentReply(r.reasoningText) : null);
        }
        if (!x) throw new Error(`returned no usable reading (${r.truncated ? "cut off at the token ceiling" : "finished"}, ${r.text.length} characters)`);
        st.intent = x;
        emit("intent", { ask: cfg.question, by: byOf(who), expansion: x, ...(errors.length ? { fallback_from: errors[0] } : {}) });
        return;
      } catch (e) {
        if (isStop(e)) throw e;
        errors.push({ by: byOf(who), error: e.message });
      }
    }
    emit("intent_failed", { by: errors.at(-1).by, error: errors.map((x) => `${x.by.label}: ${x.error}`).join(" · ") });
  }

  // ---- phase 1
  function absent(L, reason) {
    emit("absent", { model: L, reason });
    return null;
  }

  async function phaseAnswer(m) {
    const L = m.letter;
    const p = answerPrompt(cfg, m, { intent: st.intent });
    let r;
    try { r = await workTurn(m, "answer", 0, p, answerTokens(cfg, st.intent), cfg.budget); }
    catch (e) {
      if (isStop(e)) throw e;
      emit("model_failed", { model: L, phase: "answer", error: e.message });
      return absent(L, `failed: ${e.message}`);
    }
    let art, viaReasoning = false;
    if (files) {
      let got = extractFiles(r.text);
      if (!got.files.length && r.reasoningText) { got = extractFiles(r.reasoningText); viaReasoning = got.files.length > 0; }
      if (!got.files.length) return absent(L, r.truncated ? "cut off at the token ceiling before any file closed" : r.text.trim() ? "answered in prose — no named files" : "returned an empty response");
      art = { position: got.prose.split(/\n\s*\n/)[0]?.trim().slice(0, 1500) || "(no description)", confidence: null, files: got.files };
    } else {
      let parsed = parseArtifactReply(r.text);
      if ((!parsed || parsed.copy) && r.reasoningText) { const fromR = parseArtifactReply(r.reasoningText); if (fromR && !fromR.copy) viaReasoning = true; parsed = fromR || parsed; }
      if (!parsed && (r.text.trim() || r.reasoningText)) {
        emit("json_retry", { phase: "answer", model: L, chars: r.text.length, truncated: r.truncated, head: clip(r.text, 300) });
        try {
          const rr = await callModel(m, "answer", 0, { ...repairPrompt("answer", r.text || r.reasoningText, { ledgerText: ledgerText(L) }), maxTokens: answerTokens(cfg, st.intent) });
          parsed = parseArtifactReply(rr.text) || (rr.reasoningText ? parseArtifactReply(rr.reasoningText) : null);
        } catch (e) { if (isStop(e)) throw e; }
      }
      if (parsed?.copy) { emit("template_copy", { model: L, phase: "answer", field: "position" }); return absent(L, "copied the answer template instead of answering"); }
      if (!parsed) return absent(L, r.truncated ? "cut off at the token ceiling before the answer closed" : r.text.trim() ? "replied, but not with a usable answer (no JSON after one repair request)" : "returned an empty response");
      if (parsed.copies) emit("template_copy", { model: L, phase: "answer", field: "claims", rows: parsed.copies });
      art = parsed.artifact;
      auditArtifact(art, actx, st.ledgers[L]);
    }
    const notes = [];
    if (viaReasoning) notes.push("the answer was left in the reasoning channel and recovered from there");
    if (st.intent?.count && !files) {
      if (art.items.length > st.intent.count) notes.push(`listed ${art.items.length} items; the question asked for ${st.intent.count}`);
      else if (art.items.length < st.intent.count) notes.push(`listed ${art.items.length} of the ${st.intent.count} items asked for`);
    }
    st.initial[L] = clone(art);
    st.current[L] = art;
    emit("artifact", { model: L, artifact: art, grounding: files ? null : groundingOf(art.claims), notes, tool_calls: st.ledgers[L].length });
    return art;
  }

  // ---- phase 2
  const claimByRef = (ref) => { const [L, id] = ref.split(":"); return (st.current[L]?.claims || []).find((c) => c.id === id); };

  async function phaseCritique(m, round, snap) {
    const L = m.letter;
    const others = st.present.filter((x) => x !== L);
    const owed = files ? [] : (snap.agenda[L] || []).filter((ref) => claimByRef(ref));
    const agenda = owed.map((ref) => { const c = claimByRef(ref); return { ref, text: c.text, basis: c.basis, audit: c.audit?.status || "unaudited" }; });
    const flags = files ? [] : st.present.flatMap((x) => auditFlags(x, st.current[x].claims));
    const p = critiquePrompt(cfg, m, { intent: st.intent, round, mine: artifactView(st.current[L]), theirs: others.map((o) => ({ letter: o, view: artifactView(st.current[o]) })), agenda, flags });
    const record = (critique, extra = {}) => {
      const answered = new Set(critique.verdicts.map((v) => v.ref));
      const coverage = { owed, answered: owed.filter((x) => answered.has(x)), missed: owed.filter((x) => !answered.has(x)) };
      const ev = { model: L, round, critique, coverage, ...extra };
      emit("critique", ev);
      st.critiques.push(ev);
    };
    try {
      const r = await callModel(m, "critique", round, { ...p, maxTokens: critiqueTokens(agenda.length, files) });
      let parsed = parseCritiqueReply(r.text, L, st.present) || (r.reasoningText ? parseCritiqueReply(r.reasoningText, L, st.present) : null);
      if (!parsed && (r.text.trim() || r.reasoningText)) {
        emit("json_retry", { phase: "critique", round, model: L, chars: r.text.length, truncated: r.truncated, head: clip(r.text, 300) });
        const rr = await callModel(m, "critique", round, { ...repairPrompt("critique", r.text || r.reasoningText), maxTokens: critiqueTokens(agenda.length, files) });
        parsed = parseCritiqueReply(rr.text, L, st.present);
      }
      if (!parsed) throw new Error(r.text.trim() ? "no usable critique JSON after one repair request" : "empty response");
      if (parsed.copies) emit("template_copy", { model: L, phase: "critique", round, field: "divergences/verdicts", rows: parsed.copies });
      record(parsed.critique);
    } catch (e) {
      if (isStop(e)) throw e;
      emit("model_failed", { model: L, phase: "critique", round, error: e.message });
      record({ agreements: [], divergences: [], verdicts: [], questions: [] }, { failed: true, error: e.message });
    }
  }

  // ---- phase 3
  function applyRebuttal(L, rb, revisedFiles) {
    const art = st.current[L];
    const before = { position: art.position, confidence: art.confidence };
    const applied = { withdrawn: [], added: [], revised_files: [], confidence_before: art.confidence ?? null };
    if (!files) {
      const ids = new Set(art.claims.map((c) => c.id));
      applied.withdrawn = [...new Set(rb.withdrawn_claims.filter((id) => ids.has(id)))];
      art.claims = art.claims.filter((c) => !applied.withdrawn.includes(c.id));
      const maxId = [...ids].reduce((n, id) => Math.max(n, Number(id.slice(1)) || 0), 0);
      const { claims } = normaliseClaims(rb.new_claims.map((c) => ({ ...c, id: "" })), { startAt: maxId + 1, taken: ids });
      for (const c of claims) { c.audit = auditClaim(c, actx, st.ledgers[L]); c.added_round = rb._round; }
      art.claims.push(...claims);
      applied.added = claims;
      if (rb.final_items.length && (art.items.length || st.intent?.count)) {
        const prev = new Map(art.items.map((i) => [normText(i.name), i]));
        art.items = rb.final_items.map((n) => prev.get(normText(n)) || { name: n });
      }
    } else if (revisedFiles.length) {
      const byName = new Map(art.files.map((f) => [f.name, f]));
      for (const f of revisedFiles) { byName.set(f.name, f); applied.revised_files.push(f.name); }
      art.files = [...byName.values()];
    }
    if (rb.final_position) art.position = rb.final_position;
    if (rb.final_confidence != null) art.confidence = rb.final_confidence;
    applied.confidence_after = art.confidence ?? null;
    applied.position_changed = normText(before.position) !== normText(art.position);
    return applied;
  }

  async function phaseRebuttal(m, round) {
    const L = m.letter;
    const crits = st.critiques.filter((c) => c.round === round && c.model !== L);
    const received = {
      divergences: crits.flatMap((c) => c.critique.divergences.filter((d) => d.with === L || d.with == null).map((d) => ({ ...d, from: c.model }))),
      verdicts: crits.flatMap((c) => c.critique.verdicts.filter((v) => v.ref.startsWith(`${L}:`)).map((v) => ({ claim: v.ref, verdict: v.verdict, why: v.why, from: c.model }))),
      questions: crits.flatMap((c) => c.critique.questions.filter((q) => q.to === L || q.to == null).map((q) => ({ question: q.question, from: c.model }))),
    };
    const n = received.divergences.length + received.verdicts.length + received.questions.length;
    const flags = files ? [] : auditFlags(L, st.current[L].claims);
    const p = rebuttalPrompt(cfg, m, { intent: st.intent, round, mine: artifactView(st.current[L]), received, flags, budget: cfg.verifyBudget });
    try {
      const r = await workTurn(m, "rebuttal", round, p, rebuttalTokens(n, files), cfg.verifyBudget);
      let parsed = parseRebuttalReply(r.text) || (r.reasoningText ? parseRebuttalReply(r.reasoningText) : null);
      if (!parsed && (r.text.trim() || r.reasoningText)) {
        emit("json_retry", { phase: "rebuttal", round, model: L, chars: r.text.length, truncated: r.truncated, head: clip(r.text, 300) });
        const rr = await callModel(m, "rebuttal", round, { ...repairPrompt("rebuttal", r.text || r.reasoningText, { ledgerText: ledgerText(L) }), maxTokens: rebuttalTokens(n, files) });
        parsed = parseRebuttalReply(rr.text);
      }
      if (!parsed) throw new Error(r.text.trim() ? "no usable rebuttal JSON after one repair request" : "empty response");
      if (parsed.copies) emit("template_copy", { model: L, phase: "rebuttal", round, field: "changed_mind", rows: parsed.copies });
      parsed.rebuttal._round = round;
      const applied = applyRebuttal(L, parsed.rebuttal, files ? extractFiles(r.text).files : []);
      delete parsed.rebuttal._round;
      const ev = { model: L, round, rebuttal: parsed.rebuttal, applied, received_count: n, artifact_after: clone(st.current[L]) };
      emit("rebuttal", ev);
      st.rebuttals.push(ev);
    } catch (e) {
      if (isStop(e)) throw e;
      emit("model_failed", { model: L, phase: "rebuttal", round, error: e.message });
      const ev = { model: L, round, rebuttal: null, failed: true, error: e.message, applied: { withdrawn: [], added: [], revised_files: [], kept: true }, received_count: n, artifact_after: clone(st.current[L]) };
      emit("rebuttal", ev);
      st.rebuttals.push(ev);
    }
  }

  // ---- phase 4
  async function phaseMemo(finalData) {
    if (cfg.synthesizer === "none") return;
    const who = cfg.synthesizer === "auto" ? byLetter[st.present[0]] : cfg.synthesizer.letter ? byLetter[cfg.synthesizer.letter] : cfg.synthesizer;
    const by = { letter: who.letter || null, role: who.role || null, label: who.label, provider: who.provider, model: who.model };
    st.phase = "memo";
    emit("phase", { n: 4, name: "joint memo" });
    const lastRound = Math.max(0, ...st.critiques.map((c) => c.round));
    const p = memoPrompt(cfg, {
      intent: st.intent,
      facts: memoFacts(finalData),
      finals: st.present.map((L) => ({ letter: L, view: artifactView(st.current[L]) })),
      critiques: st.critiques.filter((c) => c.round === lastRound && !c.failed).map((c) => ({ letter: c.model, critique: c.critique })),
      rebuttals: st.rebuttals.filter((r) => r.round === lastRound && r.rebuttal).map((r) => ({ letter: r.model, rebuttal: { answers: r.rebuttal.answers, changed_mind: r.rebuttal.changed_mind, stand_by: r.rebuttal.stand_by } })),
    });
    try {
      let r = await callModel(who, "memo", 0, { ...p, maxTokens: MEMO_TOKENS });
      let memo = r.text.trim(), flag = null;
      if (!memo || looksLikeChainOfThought(memo) || r.fromReasoning || r.truncated) {
        emit("memo_retry", { model: who.letter || who.role, reason: !memo ? "empty" : r.truncated ? "cut off" : "chain of thought" });
        const r2 = await callModel(who, "memo", 0, { system: MEMO_RETRY_SYSTEM, user: p.user, maxTokens: MEMO_TOKENS * 2 });
        const t2 = r2.text.trim();
        if (t2 && !looksLikeChainOfThought(t2) && !r2.fromReasoning) memo = t2;
        else { memo = t2 || memo || r.reasoningText; flag = "chain_of_thought"; }
      }
      if (!memo) throw new Error("empty memo");
      emit("synthesis", { by, memo, flag });
    } catch (e) {
      if (isStop(e)) throw e;
      emit("model_failed", { model: who.letter || who.role, phase: "memo", error: e.message });
      emit("synthesis", { by, memo: null, error: e.message });
    }
  }

  function memoFacts(fd) {
    const out = [];
    const lbl = (L) => `${L} (${byLetter[L].label})`;
    out.push(`Analysts who answered: ${st.present.map(lbl).join(", ") || "none"}.`);
    const gone = cfg.models.filter((m) => !st.present.includes(m.letter));
    if (gone.length) out.push(`Absent (produced nothing usable — not a disagreement): ${gone.map((m) => `${m.letter} — ${fd.absent[m.letter] || "absent"}`).join("; ")}.`);
    out.push(`Rounds of critique and rebuttal run: ${fd.rounds_run} of ${cfg.rounds} requested${fd.auto_stopped ? " (auto-stopped: a round changed nobody's mind)" : ""}.`);
    const c = fd.compare;
    if (files) {
      out.push(`Position similarity (content-word overlap of the approach paragraphs): ${pct(c.similarity.before)} before → ${pct(c.similarity.after)} after.`);
      for (const L of st.present) out.push(`${L} delivered ${(st.current[L].files || []).map((f) => `${f.name} (${f.bytes} bytes)`).join(", ")}.`);
      return out;
    }
    out.push(`Headline: ${c.headline}.`);
    out.push(`Claims shared by every analyst (code clustering): ${c.overlap.sharedBefore} before → ${c.overlap.sharedAfter} after; share of all claim clusters ${pct(c.overlap.before)} → ${pct(c.overlap.after)}.`);
    if (c.items) out.push(`Items every analyst listed: before [${c.items.before.join(", ") || "none"}] → after [${c.items.after.join(", ") || "none"}].`);
    out.push(`Position similarity: ${pct(c.similarity.before)} → ${pct(c.similarity.after)}.`);
    const g = fd.snapshot.grounding;
    out.push(`Grounding rate (claims whose quote, arithmetic or tool citation code verified ÷ all claims): ${st.present.map((L) => `${L} ${pct(fd.before.grounding[L]?.rate)} → ${pct(g[L]?.rate)}`).join("; ")}.`);
    const lb = st.present.flatMap((L) => (g[L]?.ungroundedLoadBearing || []).map((id) => { const cl = st.current[L].claims.find((x) => x.id === id); return `${L}:${id} (${cl?.basis}) "${clip(cl?.text, 120)}"`; }));
    out.push(lb.length ? `Ungrounded load-bearing claims: ${lb.join("; ")}.` : "No load-bearing claim is ungrounded.");
    const flags = st.present.flatMap((L) => auditFlags(L, st.current[L].claims));
    if (flags.length) out.push(`Audit findings: ${flags.map((f) => `${f.ref} ${f.status} — ${f.detail}`).join("; ")}.`);
    if (fd.verdicts) out.push(`Verdicts on claims (latest per critic): shared by all without dispute ${fd.verdicts.counts.shared}, endorsed ${fd.verdicts.counts.endorsed}, contested ${fd.verdicts.counts.contested}${fd.verdicts.contested.length ? ` [${fd.verdicts.contested.join(", ")}]` : ""}, unresolved ${fd.verdicts.counts.unresolved}, never judged ${fd.verdicts.counts.unjudged}.`);
    const rc = fd.root_causes;
    if (rc.n) out.push(`Root causes of the divergences raised: evidence ${rc.evidence}, interpretation ${rc.interpretation}, values ${rc.values}.`);
    const gaps = st.critiques.filter((x) => x.coverage.missed.length);
    if (gaps.length) out.push(`Went unargued (on an analyst's agenda, no verdict given): ${gaps.map((x) => `${x.model} round ${x.round}: ${x.coverage.missed.join(", ")}`).join("; ")}.`);
    if (fd.movement.length) out.push(`Movement per round: ${fd.movement.map((r) => `round ${r.round}: ${Object.entries(r.by).map(([L, x]) => `${L} ${x.changed} changed, ${x.withdrawn} withdrawn, ${x.added} added`).join(", ")}`).join(" | ")}.`);
    if (fd.towards.length) out.push(`Moved toward another analyst's initial position: ${fd.towards.map((t) => `${t.from} → ${t.toward}`).join(", ")}.`);
    if (c.redFlag) out.push(`RED FLAG: ${c.redFlag}`);
    return out;
  }

  // ---- the protocol
  try {
    if (cfg.expand) await phaseIntent();
    checkStop();
    st.phase = "answer";
    emit("phase", { n: 1, name: "independent answers" });
    await Promise.allSettled(cfg.models.map((m) => phaseAnswer(m)));
    checkStop();

    // Participation gate (PRD lesson 2): silence is not a position.
    st.present = cfg.models.map((m) => m.letter).filter((L) => st.current[L]);
    const absentReasons = {};
    for (const ev of events) if (ev.type === "absent") absentReasons[ev.model] = ev.reason;
    if (!st.present.length) {
      status = "failed";
      emit("gate", { present: [], absent: absentReasons, note: "No analyst produced a usable answer — there is nothing to compare." });
    } else {
      emit("gate", { present: st.present, absent: absentReasons, note: st.present.length < 2 && cfg.rounds > 0 ? "Fewer than two analysts answered, so there is no one to debate — the run goes straight to the memo." : null });
      const before = snapshot(st.present, st.current, { files });
      emit("diff", { snapshot: before });

      let roundsRun = 0, autoStopped = false;
      if (st.present.length >= 2) {
        for (let round = 1; round <= cfg.rounds; round++) {
          const snap = round === 1 ? before : snapshot(st.present, st.current, { files });
          st.phase = "critique";
          emit("phase", { n: 2, name: "cross-critique", round });
          await Promise.allSettled(st.present.map((L) => phaseCritique(byLetter[L], round, snap)));
          checkStop();
          st.phase = "rebuttal";
          emit("phase", { n: 3, name: "rebuttal", round });
          await Promise.allSettled(st.present.map((L) => phaseRebuttal(byLetter[L], round)));
          checkStop();
          const log = movementLog(st.rebuttals.filter((r) => r.round === round))[0] || { by: {}, total: 0 };
          emit("round_end", { round, moves: log.total, by: log.by, of_rounds: cfg.rounds });
          roundsRun = round;
          if (cfg.autoStop && log.total === 0 && round < cfg.rounds) {
            autoStopped = true;
            emit("auto_stop", { after_round: round, skipped: cfg.rounds - round });
            break;
          }
        }
      }
      const after = snapshot(st.present, st.current, { files });
      const finalData = {
        snapshot: after,
        before,
        compare: compareSnapshots(before, after, { files }),
        verdicts: files ? null : verdictTally(st.critiques, st.present, st.current, after.clusters),
        root_causes: rootCauseTally(st.critiques),
        movement: movementLog(st.rebuttals),
        towards: towards(st.present, st.initial, st.current),
        rounds_run: roundsRun,
        auto_stopped: autoStopped,
        absent: absentReasons,
      };
      emit("diff_final", { ...finalData, before: undefined, finals: Object.fromEntries(st.present.map((L) => [L, st.current[L]])) });
      checkStop();
      await phaseMemo(finalData);
    }
  } catch (e) {
    if (isStop(e) || aborted() || st.budgetHit) { status = "stopped"; emit("stopped", { phase: st.phase, reason: st.budgetHit ? "spending cap" : "stop" }); }
    else { status = "error"; emit("crash", { phase: st.phase, message: e.message, stack: String(e.stack || "").split("\n").slice(0, 6).join("\n") }); }
  }
  emit("done", { status });
  return reduceEvents(events);
}
