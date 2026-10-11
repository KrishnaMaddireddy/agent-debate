// The console. Talks to a host (the local server, or the claude.ai artifact's in-page host), renders
// the run from its event stream with the SAME reducer the server uses for the saved record.
import { $, $$, esc, fmtTime, fmtDuration, saveBlob, store } from "./dom.js";
import { serverHost } from "./host-server.js";
import { feedItems, whoPill } from "./feed.js";
import { renderPanels } from "./panels.js";
import { openSettings } from "./settings.js";
import { reduceEvents, renderReport } from "../core/record.js";
import { zipStore, mimeFor } from "../core/files.js";
import { MODEL_COLORS } from "../core/engine.js";
import { estimateRun, fmtUsd, fmtTokens, priceKey } from "../core/cost.js";
import { reportPage } from "./export.js";
import { scorecardMarkdown } from "../core/scorecard.js";
import { answerTokens, critiqueTokens, rebuttalTokens, MEMO_TOKENS, INTENT_TOKENS } from "../core/prompts.js";

const host = window.__AD_HOST__ || serverHost;
const S = {
  cfg: null,
  form: {
    question: store.get("question", ""), docs: [], analysts: store.get("analysts", null), rounds: store.get("rounds", 1),
    deliverable: store.get("deliverable", "answer"), persona: store.get("persona", ""), skillsOn: new Set(), skillsOff: new Set(), suggested: new Set(),
    tools: new Set(store.get("tools", ["web_search"])), toolsTouched: store.get("toolsTouched", false),
    expander: store.get("expander", "auto"), synthesizer: store.get("synthesizer", "auto"), autoStop: store.get("autoStop", true), largeCtx: false,
    cap: store.get("cap", null), // null: use the configured default; "": no cap
  },
  view: { id: null, events: [], unsub: null, rec: null },
  liveId: null,
  ui: { fileTab: {}, fileMode: {} },
  runs: [],
  frame: 0,
};

// ================================================================ boot
{ const t = store.get("theme", null); if (t) document.documentElement.dataset.theme = t; else if (!host.followSystemTheme) document.documentElement.dataset.theme = "dark"; }
$("#themeBtn").onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); const t = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; store.set("theme", t); };
$("#settingsBtn").hidden = !host.canSettings;
$("#settingsBtn").onclick = () => openSettings({ host, openModal, onChanged: () => loadConfig() });
$("#scoreBtn").hidden = !host.scorecard;
$("#scoreBtn").onclick = () => showScorecard(false);
$("#modalClose").onclick = closeModal;
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
if (host.intro) $("#emptyState").innerHTML = host.intro;
setupRails();
setupForm();
loadConfig().then(() => loadHistory());
setInterval(() => { if (!S.liveId) loadHistory(); }, 20000);
setInterval(tickStatus, 1000);

function openModal(title, html, tools = "") {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modalTools").innerHTML = tools;
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; $("#modalBody").innerHTML = ""; }

async function loadConfig() {
  try {
    S.cfg = await host.config();
    $("#rev").textContent = S.cfg.version ? ` ${S.cfg.version.split(" ")[0] === "rev" ? S.cfg.version.split(" — ")[0] : S.cfg.version}` : "";
    reconcileAnalysts();
    renderForm();
  } catch (e) {
    $("#formErr").textContent = `Could not load the configuration: ${e.message}`;
  }
}

// ================================================================ the form

const enabledModels = () => (S.cfg?.providers || []).flatMap((p) => (p.models || []).map((m) => ({ provider: p.id, model: m, label: `${p.label} · ${m}`, providerLabel: p.label, type: p.type, hasKey: p.hasKey })));
const findModel = (provider, model) => enabledModels().find((x) => x.provider === provider && x.model === model);

function reconcileAnalysts() {
  const all = enabledModels().filter((m) => m.hasKey);
  let list = (S.form.analysts || []).filter((a) => findModel(a.provider, a.model));
  if (!list.length) {
    const d = S.cfg?.default;
    const first = (d && findModel(d.provider, d.model)) || all.find((m) => m.type !== "mock") || all[0];
    const second = all.find((m) => first && m.provider !== first.provider && m.type !== "mock") || all.find((m) => first && m.model !== first.model) || first;
    list = [first, second].filter(Boolean).map(({ provider, model }) => ({ provider, model }));
  }
  S.form.analysts = list;
  store.set("analysts", list);
}

function setupForm() {
  const q = $("#question");
  q.value = S.form.question;
  const grow = () => { q.style.height = "auto"; q.style.height = `${Math.min(window.innerHeight * 0.35, q.scrollHeight + 2)}px`; };
  let t;
  q.addEventListener("input", () => { S.form.question = q.value; store.set("question", q.value); grow(); renderPreflight(); clearTimeout(t); t = setTimeout(suggest, 400); });
  setTimeout(grow, 0);
  $("#attachBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = async (e) => {
    for (const f of e.target.files) {
      try {
        const r = await host.extract(f);
        S.form.docs.push({ name: r.name || f.name, text: r.text, words: r.words, note: r.note });
      } catch (err) { $("#formErr").textContent = `${f.name}: ${err.message}`; }
    }
    e.target.value = "";
    renderDocs(); renderPreflight();
  };
  $("#pasteBtn").onclick = () => { $("#pasteBox").hidden = false; $("#pasteText").focus(); };
  $("#pasteCancel").onclick = () => { $("#pasteBox").hidden = true; };
  $("#pasteAdd").onclick = () => {
    const text = $("#pasteText").value.trim();
    if (!text) return;
    S.form.docs.push({ name: $("#pasteName").value.trim() || `pasted-${S.form.docs.length + 1}.txt`, text, words: text.split(/\s+/).length });
    $("#pasteText").value = ""; $("#pasteName").value = ""; $("#pasteBox").hidden = true;
    renderDocs(); renderPreflight();
  };
  $("#addAnalyst").onclick = () => {
    if (S.form.analysts.length >= 6) return;
    const all = enabledModels().filter((m) => m.hasKey);
    const used = new Set(S.form.analysts.map((a) => `${a.provider}|${a.model}`));
    const next = all.find((m) => !used.has(`${m.provider}|${m.model}`)) || all[0];
    if (next) S.form.analysts.push({ provider: next.provider, model: next.model });
    store.set("analysts", S.form.analysts);
    renderForm();
  };
  $("#rounds").onchange = (e) => { S.form.rounds = Number(e.target.value); store.set("rounds", S.form.rounds); renderPreflight(); };
  $$("#deliverable button").forEach((b) => (b.onclick = () => { S.form.deliverable = b.dataset.v; store.set("deliverable", S.form.deliverable); renderForm(); }));
  $("#persona").onchange = (e) => { S.form.persona = e.target.value; store.set("persona", S.form.persona); renderForm(); };
  $("#expander").onchange = (e) => { S.form.expander = e.target.value; store.set("expander", e.target.value); renderPreflight(); };
  $("#synthesizer").onchange = (e) => { S.form.synthesizer = e.target.value; store.set("synthesizer", e.target.value); renderPreflight(); };
  $("#autoStop").onchange = (e) => { S.form.autoStop = e.target.checked; store.set("autoStop", e.target.checked); };
  $("#largeCtx").onchange = (e) => { S.form.largeCtx = e.target.checked; renderPreflight(); };
  $("#cap").oninput = (e) => { S.form.cap = e.target.value.trim(); store.set("cap", S.form.cap); renderPreflight(); };
  $("#runBtn").onclick = startRun;
  $("#stopBtn").onclick = async () => { if (!S.liveId) return; $("#stopBtn").disabled = true; try { await host.stop(S.liveId); } catch (e) { $("#formErr").textContent = e.message; } };
  $("#liveBtn").onclick = () => { if (S.liveId) openRun(S.liveId); };
}

async function suggest() {
  if (!S.form.question.trim()) { S.form.suggested = new Set(); renderSkills(); return; }
  try { S.form.suggested = new Set(await host.suggestSkills(S.form.question)); } catch { S.form.suggested = new Set(); }
  renderSkills();
}

function renderForm() {
  if (!S.cfg) return;
  // analysts
  const all = enabledModels();
  const byProv = S.cfg.providers || [];
  $("#analysts").innerHTML = S.form.analysts.map((a, i) => {
    const p = byProv.find((x) => x.id === a.provider);
    return `<div class="analyst" data-i="${i}">
      <span class="who" style="background:${MODEL_COLORS[i]}">${String.fromCharCode(65 + i)}</span>
      <select data-prov aria-label="Provider for analyst ${String.fromCharCode(65 + i)}">${byProv.map((x) => `<option value="${esc(x.id)}" ${x.id === a.provider ? "selected" : ""} ${x.hasKey ? "" : "disabled"}>${esc(x.label)}${x.hasKey ? "" : " (no key)"}</option>`).join("")}</select>
      <select data-model aria-label="Model for analyst ${String.fromCharCode(65 + i)}">${(p?.models || []).map((m) => `<option ${m === a.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
      <button class="link" data-rm title="Remove analyst" aria-label="Remove analyst ${String.fromCharCode(65 + i)}" ${S.form.analysts.length <= 1 ? "disabled" : ""}>×</button></div>`;
  }).join("") || `<div class="note">No provider is switched on. ${host.canSettings ? "Open Settings › Providers and enable one (the mock needs no key)." : ""}</div>`;
  $$("#analysts .analyst").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector("[data-prov]").onchange = (e) => { const p = byProv.find((x) => x.id === e.target.value); S.form.analysts[i] = { provider: p.id, model: p.models[0] }; store.set("analysts", S.form.analysts); renderForm(); };
    row.querySelector("[data-model]").onchange = (e) => { S.form.analysts[i].model = e.target.value; store.set("analysts", S.form.analysts); renderForm(); };
    row.querySelector("[data-rm]").onclick = () => { S.form.analysts.splice(i, 1); store.set("analysts", S.form.analysts); renderForm(); };
  });
  $("#addAnalyst").disabled = S.form.analysts.length >= 6 || !all.length;
  const dup = new Set(), seen = new Set();
  for (const a of S.form.analysts) { const k = `${a.provider}|${a.model}`; if (seen.has(k)) dup.add(k); seen.add(k); }
  $("#analystNote").textContent = S.form.analysts.length < 2 ? "one analyst: no debate, just an audited answer" : dup.size ? "the same model twice measures its variance, not a difference between models" : `${S.form.analysts.length} analysts — everyone critiques everyone`;
  // rounds, deliverable
  $("#rounds").value = String(S.form.rounds);
  $$("#deliverable button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === S.form.deliverable)));
  // persona
  const personas = S.cfg.personas || [];
  $("#persona").innerHTML = `<option value="">none — each model states its own standards</option>${personas.map((p) => `<option value="${esc(p.id)}" ${p.id === S.form.persona ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  const pp = personas.find((p) => p.id === S.form.persona);
  $("#personaHint").textContent = pp ? pp.lens : "A lens applied identically to every model, so differences are between models, not lenses.";
  // expander / synthesizer
  const letters = S.form.analysts.map((_, i) => String.fromCharCode(65 + i));
  const others = all.filter((m) => m.hasKey).map((m) => `<option value="m:${esc(m.provider)}|${esc(m.model)}">${esc(m.label)}</option>`).join("");
  $("#expander").innerHTML = `<option value="auto">auto — first API analyst</option>${letters.map((L) => `<option value="${L}">analyst ${L}</option>`).join("")}<optgroup label="another model">${others}</optgroup><option value="off">off — each reads the question itself</option>`;
  $("#synthesizer").innerHTML = `<option value="auto">auto — first analyst that answered</option>${letters.map((L) => `<option value="${L}">analyst ${L}</option>`).join("")}<optgroup label="a model that did not debate">${others}</optgroup><option value="none">none — code-computed report only</option>`;
  $("#expander").value = [...$("#expander").options].some((o) => o.value === S.form.expander) ? S.form.expander : "auto";
  $("#synthesizer").value = [...$("#synthesizer").options].some((o) => o.value === S.form.synthesizer) ? S.form.synthesizer : "auto";
  $("#autoStop").checked = S.form.autoStop;
  $("#cap").closest(".field").hidden = host.kind === "artifact"; // Claude here runs on the viewer's plan: nothing to cap
  if (document.activeElement !== $("#cap")) $("#cap").value = capValue() ?? "";
  renderDocs();
  renderSkills();
  renderTools();
  renderPreflight();
}

function renderDocs() {
  $("#docs").innerHTML = S.form.docs.map((d, i) => `<span class="chip" title="${esc(d.note || "")}">D${i + 1} ${esc(d.name)} <span class="faint">${d.words}w</span><span class="x" data-rmdoc="${i}" title="remove">×</span></span>`).join("");
  $$("[data-rmdoc]").forEach((x) => (x.onclick = () => { S.form.docs.splice(Number(x.dataset.rmdoc), 1); renderDocs(); renderPreflight(); }));
}

function skillOn(name) { return S.form.skillsOn.has(name) || (S.form.suggested.has(name) && !S.form.skillsOff.has(name)); }
function renderSkills() {
  const skills = S.cfg?.skills || [];
  $("#skillsField").hidden = !skills.length;
  $("#skills").innerHTML = skills.map((s) => `<span class="chip ${skillOn(s.name) ? "on" : ""}" data-skill="${esc(s.name)}" title="${esc(s.description)}" role="button" tabindex="0">${S.form.suggested.has(s.name) ? "✦ " : ""}${esc(s.name)}</span>`).join("");
  $$("[data-skill]").forEach((c) => {
    const toggle = () => { const n = c.dataset.skill; if (skillOn(n)) { S.form.skillsOn.delete(n); S.form.skillsOff.add(n); } else { S.form.skillsOff.delete(n); S.form.skillsOn.add(n); } renderSkills(); };
    c.onclick = toggle; c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  });
}

function renderTools() {
  const tools = S.cfg?.tools || [];
  const files = S.form.deliverable === "files";
  $("#toolsField").hidden = !tools.length || files;
  const groups = {};
  for (const t of tools) (groups[t.mcp ? `MCP · ${t.mcp.server}` : t.plugin ? `plugin · ${t.plugin}` : t.category || "general"] ||= []).push(t);
  $("#tools").innerHTML = Object.entries(groups).map(([g, list]) => `<div class="sec" style="margin-top:6px">${esc(g)}</div>${list.map((t) => `<label class="toolrow"><input type="checkbox" data-tool="${esc(t.name)}" ${S.form.tools.has(t.name) && t.available ? "checked" : ""} ${t.available ? "" : "disabled"}><span><b>${esc(t.name)}</b>${t.providerLabel ? ` <span class="faint">via ${esc(t.providerLabel)}</span>` : ""}${t.available ? "" : ` <span class="warn">needs ${esc((t.missingEnv || []).join(", "))}</span>`}<br><span class="faint" style="font-size:11px">${esc(t.description)}</span></span></label>`).join("")}`).join("");
  $$("[data-tool]").forEach((c) => (c.onchange = () => { if (c.checked) S.form.tools.add(c.dataset.tool); else S.form.tools.delete(c.dataset.tool); store.set("tools", [...S.form.tools]); store.set("toolsTouched", true); renderPreflight(); renderToolsSummary(); }));
  renderToolsSummary();
}
function selectedTools() { const avail = new Set((S.cfg?.tools || []).filter((t) => t.available).map((t) => t.name)); return [...S.form.tools].filter((n) => avail.has(n)); }
function renderToolsSummary() { const n = selectedTools(); $("#toolsSummary").textContent = n.length ? `${n.join(", ")}` : "none — documents and background knowledge only"; }

const CURRENT_INFO = /\b(today|latest|current(ly)?|now|this (week|month|year|quarter)|recent(ly)?|news|price[sd]?|right now|as of|20(2[5-9]|3\d))\b/i;

function renderPreflight() {
  if (!S.cfg) return;
  const n = S.form.analysts.length;
  const rounds = n >= 2 ? S.form.rounds : 0;
  const tools = S.form.deliverable === "files" ? [] : selectedTools();
  const exp = S.form.expander === "off" ? 0 : 1, memo = S.form.synthesizer === "none" ? 0 : 1;
  const calls = exp + n + rounds * 2 * n + memo;
  const per = {};
  for (const a of S.form.analysts) { const k = `${a.provider} · ${a.model}`; per[k] = (per[k] || 0) + 1 + rounds * 2; }
  const words = S.form.docs.reduce((w, d) => w + d.words, 0);
  const chars = S.form.docs.reduce((c, d) => c + d.text.length, 0);
  const limit = S.form.largeCtx ? S.cfg.limits?.maxContextCharsRaised : S.cfg.limits?.maxContextChars;
  const est = estimateRun(planForEstimate(tools), allPrices());
  const cap = capValue();
  const free = est.worst === 0 && !est.unknown.length;
  const money = free ? `<span class="ok">no per-token cost</span>` : est.unknown.length && !est.worst ? `cost unknown` : `<span title="typical: models write about 40% of their ceilings · worst case: every call uses its whole ceiling">typical ${fmtUsd(est.typical)} · worst case ${fmtUsd(est.worst)}${est.unknown.length ? " + unknown" : ""}</span>`;
  $("#preflight").innerHTML = `≈ <b>${calls}</b> model calls · ${money}${cap != null ? ` · cap ${fmtUsd(cap)}` : ""}<br>`
    + `${Object.entries(per).map(([k, v]) => `${v}× ${esc(k)}`).join(" · ")}${exp ? " · 1 reading" : ""}${memo ? " · 1 memo" : ""}${tools.length ? ` · up to ${n * Math.min(12, tools.length * 3)} more in tool loops` : ""}${words ? `<br>${S.form.docs.length} document${S.form.docs.length === 1 ? "" : "s"}, ${words.toLocaleString()} words — sent to every model in every phase` : ""}`;
  const warn = [];
  if (limit && chars > limit) warn.push(`The documents total ${chars.toLocaleString()} characters, above the ${limit.toLocaleString()} limit. Every model receives every byte in every phase — tick "allow documents above the size limit" in Advanced if you mean it.`);
  const hasSearch = (S.cfg.tools || []).some((t) => t.name === "web_search" && t.available);
  if (CURRENT_INFO.test(S.form.question) && hasSearch && !tools.includes("web_search") && S.form.deliverable !== "files") warn.push(`The question asks about current information, but web_search is off — the models will answer from memory. <button class="link" id="wsOn">turn web_search on</button>`);
  if (est.unknown.length) warn.push(`No price is known for ${esc(est.unknown.join(", "))}, so its cost is shown as "?"${cap != null ? " — and a run with a spending cap is refused until you set one" : ""}. ${host.canSettings ? "Set it in Settings › Providers." : ""}`);
  else if (cap != null && est.worst > cap) warn.push(`The worst case (${fmtUsd(est.worst)}) is above the ${fmtUsd(cap)} cap. Most runs use far less than their ceilings, but if this one doesn't, it stops before the call that could go over — and keeps everything that finished.`);
  $("#qWarn").innerHTML = warn.map((w) => `<div class="note">${w}</div>`).join("");
  $("#wsOn")?.addEventListener("click", () => { S.form.tools.add("web_search"); store.set("tools", [...S.form.tools]); renderTools(); renderPreflight(); });
  $("#runBtn").disabled = !S.form.analysts.length || Boolean(S.liveId);
}

function capValue() {
  const v = S.form.cap;
  if (v === "" ) return null;
  if (v == null) return S.cfg?.defaultBudgetUsd ?? (host.kind === "artifact" ? null : 1);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function allPrices() {
  const out = {};
  for (const p of S.cfg?.providers || []) for (const [m, pr] of Object.entries(p.prices || {})) out[priceKey(p.id, m)] = pr;
  return out;
}

function planForEstimate(tools) {
  const analysts = S.form.analysts.map((a) => ({ provider: a.provider, model: a.model }));
  const n = analysts.length;
  const docs = S.form.docs.map((d) => ({ words: d.words || 0 }));
  const pick = (v, dflt) => { const r = roleValue(v); if (r && typeof r === "object") return r; if (typeof r === "string" && /^[A-F]$/.test(r)) return analysts[r.charCodeAt(0) - 65] || dflt; return dflt; };
  const firstApi = S.form.analysts.find((a) => findModel(a.provider, a.model)?.type !== "cli") || analysts[0];
  return {
    analysts, rounds: S.form.rounds, question: S.form.question,
    docChars: S.form.docs.reduce((c, d) => c + d.text.length, 0),
    expand: S.form.expander !== "off", reader: pick(S.form.expander, firstApi),
    writer: S.form.synthesizer === "none" ? null : pick(S.form.synthesizer, analysts[0]),
    ceilings: {
      answer: answerTokens({ deliverable: S.form.deliverable, docs, tools }, null),
      critique: critiqueTokens(10 * Math.max(1, n - 1), S.form.deliverable === "files"),
      rebuttal: rebuttalTokens(2 * Math.max(1, n - 1), S.form.deliverable === "files"),
      memo: MEMO_TOKENS, intent: INTENT_TOKENS,
    },
  };
}

function roleValue(v) {
  if (!v || v === "auto") return undefined;
  if (v === "none" || v === "off") return v === "none" ? "none" : undefined;
  if (v.startsWith("m:")) { const [provider, model] = v.slice(2).split("|"); return { provider, model }; }
  return v;
}

async function startRun() {
  $("#formErr").textContent = "";
  const question = S.form.question.trim();
  if (!question) { $("#formErr").textContent = "Write a question first."; $("#question").focus(); return; }
  const body = {
    question,
    models: S.form.analysts.map((a) => ({ provider: a.provider, model: a.model })),
    rounds: S.form.rounds,
    deliverable: S.form.deliverable,
    docs: S.form.docs.map((d) => ({ name: d.name, text: d.text })),
    persona: S.form.persona || null,
    skills: (S.cfg.skills || []).filter((s) => skillOn(s.name)).map((s) => s.name),
    tools: S.form.deliverable === "files" ? [] : selectedTools(),
    expand: S.form.expander !== "off",
    expander: roleValue(S.form.expander),
    synthesizer: roleValue(S.form.synthesizer),
    autoStop: S.form.autoStop,
    allowLargeContext: S.form.largeCtx,
    budgetUsd: capValue() ?? 0,
  };
  $("#runBtn").disabled = true;
  try {
    const { id } = await host.startRun(body);
    S.liveId = id;
    openRun(id);
    loadHistory();
  } catch (e) {
    $("#formErr").textContent = e.message;
    $("#runBtn").disabled = false;
  }
}

// ================================================================ viewing a run

function openRun(id) {
  S.view.unsub?.();
  S.view = { id, events: [], unsub: null, rec: null };
  S.ui = { fileTab: {}, fileMode: {} };
  $("#feed").innerHTML = "";
  $("#feed").scrollTop = 0;
  const done = () => {
    if (S.liveId === id) { S.liveId = null; loadHistory(); }
    schedule();
  };
  S.view.unsub = host.subscribe(id, (ev) => { S.view.events.push(ev); schedule(); }, done);
  schedule();
  renderHistory();
}

function schedule() {
  if (S.frame) return;
  S.frame = requestAnimationFrame(() => { S.frame = 0; render(); });
}

function render() {
  const rec = reduceEvents(S.view.events);
  S.view.rec = rec;
  patchFeed(feedItems(S.view.events, rec, S.ui));
  const html = renderPanels(rec);
  if ($("#panels").dataset.sig !== html) { $("#panels").innerHTML = html; $("#panels").dataset.sig = html; }
  tickStatus();
  renderDownloads();
  renderPreflight();
}

function patchFeed(items) {
  const feed = $("#feed");
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  const existing = new Map($$(":scope > [data-key]", feed).map((el) => [el.dataset.key, el]));
  let prev = null;
  for (const it of items) {
    let el = existing.get(it.key);
    if (!el) {
      el = document.createElement("div");
      el.dataset.key = it.key;
      el.className = `${it.cls} fresh`;
      el.innerHTML = it.html;
      el._sig = it.html;
      if (prev) prev.after(el); else feed.prepend(el);
    } else {
      existing.delete(it.key);
      if (el._sig !== it.html) {
        const open = new Set($$("details[open][data-d]", el).map((d) => d.dataset.d));
        el.innerHTML = it.html;
        el._sig = it.html;
        for (const d of $$("details[data-d]", el)) if (open.has(d.dataset.d)) d.open = true;
      }
      el.className = it.cls;
      if (prev && prev.nextSibling !== el) prev.after(el);
    }
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  if (nearBottom && S.liveId === S.view.id) feed.scrollTop = feed.scrollHeight;
}

// Clicks inside the feed: prompts, file tabs, downloads.
$("#feed").addEventListener("click", (e) => {
  const t = e.target.closest("[data-prompt],[data-file],[data-fmode],[data-fdl],[data-fzip]");
  if (!t) return;
  const rec = S.view.rec;
  if (t.dataset.prompt) return showPrompt(t.dataset.prompt);
  if (t.dataset.file) { const [L, name] = t.dataset.file.split("|"); S.ui.fileTab[L] = name; S.ui.fileMode[L] = /\.(html?|svg)$/i.test(name) ? "preview" : "code"; return render(); }
  if (t.dataset.fmode) { const [L, mode] = t.dataset.fmode.split("|"); S.ui.fileMode[L] = mode; return render(); }
  const filesOf = (L) => rec.current[L]?.files || rec.artifacts[L]?.artifact?.files || [];
  if (t.dataset.fdl) { const [L, name] = t.dataset.fdl.split("|"); const f = filesOf(L).find((x) => x.name === name); if (f) saveBlob(f.content, name.split("/").pop(), mimeFor(name)); return; }
  if (t.dataset.fzip) { const L = t.dataset.fzip; saveBlob(new Blob([zipStore(filesOf(L).map((f) => ({ name: f.name, content: f.content })))], { type: "application/zip" }), `analyst-${L}-files.zip`, "application/zip"); }
});

function showPrompt(key) {
  const [phase, model, round] = key.split("|");
  const rec = S.view.rec;
  const calls = rec.prompts.map((p, i) => ({ p, i })).filter(({ p }) => p.phase === phase && String(p.model) === model && String(p.round ?? 0) === round);
  const outs = rec.outputs.filter((o) => o.phase === phase && String(o.model) === model && String(o.round ?? 0) === round);
  if (!calls.length) return openModal("Prompt", `<div class="faint">No prompt was recorded for this card.</div>`);
  openModal(`What was sent · ${phase}${Number(round) ? ` round ${round}` : ""} · ${/^[A-F]$/.test(model) ? `analyst ${model}` : model}`,
    calls.map(({ p }, k) => `<div class="sec" style="margin-top:${k ? 14 : 0}px">call ${k + 1} of ${calls.length} · max ${p.max_tokens} tokens</div>
      <details ${k === 0 ? "" : ""}><summary>system (${p.system.length.toLocaleString()} characters)</summary><pre>${esc(p.system)}</pre></details>
      <details open><summary>user (${p.user.length.toLocaleString()} characters)</summary><pre>${esc(p.user)}</pre></details>
      ${outs[k] ? `<details><summary>reply · ${outs[k].chars.toLocaleString()} characters · ${fmtDuration(outs[k].ms)}${outs[k].truncated ? " · <span class='bad'>cut off at the ceiling</span>" : ""}</summary><pre>${esc(outs[k].text)}</pre></details>` : ""}`).join(""));
}

// ================================================================ status, downloads, history

function tickStatus() {
  const rec = S.view.rec;
  const dot = $("#statusDot"), txt = $("#statusText"), el = $("#elapsed");
  const live = S.liveId && S.view.id === S.liveId;
  $("#stopBtn").hidden = !live;
  if (!live) $("#stopBtn").disabled = false;
  $("#viewing").hidden = !S.view.id || !S.liveId || live;
  $("#liveBtn").hidden = !S.liveId || live;
  if (!rec || !rec.config) { dot.className = "dot"; txt.textContent = S.view.id ? "loading…" : "idle"; el.textContent = ""; return; }
  if (!$("#viewing").hidden) $("#viewing").textContent = `Viewing ${fmtTime(rec.started)}`;
  if (rec.status === "running") {
    dot.className = "dot run";
    const lastPhase = rec.phases.at(-1);
    let what = lastPhase ? `phase ${lastPhase.n} · ${lastPhase.name}${lastPhase.round ? ` · round ${lastPhase.round}` : ""}` : "starting";
    if (lastPhase?.n === 1) what += ` · ${Object.keys(rec.artifacts).length + Object.keys(rec.absent).length} of ${rec.config.models.length} answered`;
    if (lastPhase?.n === 2) what += ` · ${Object.keys(rec.rounds.find((r) => r.round === lastPhase.round)?.critiques || {}).length} of ${(rec.gate?.present || []).length} critiques`;
    if (lastPhase?.n === 3) what += ` · ${Object.keys(rec.rounds.find((r) => r.round === lastPhase.round)?.rebuttals || {}).length} of ${(rec.gate?.present || []).length} rebuttals`;
    txt.textContent = what;
    const t = rec.usage?.total;
    el.textContent = ` · ${fmtDuration(Date.now() - rec.started)}${t?.calls && t.unknown < t.calls ? ` · ${fmtUsd(t.usd)}${rec.config.spend_cap != null ? ` of ${fmtUsd(rec.config.spend_cap)}` : ""}` : ""}`;
  } else {
    dot.className = `dot ${rec.status === "done" ? "done" : rec.status === "stopped" ? "stopped" : "fail"}`;
    txt.textContent = rec.status === "done" ? "done" : rec.status === "stopped" ? "stopped" : rec.status === "failed" ? "no analyst answered" : "error";
    const t = rec.usage?.total;
    el.textContent = `${rec.duration_ms != null ? ` · ${fmtDuration(rec.duration_ms)}` : ""}${t?.calls && t.unknown < t.calls ? ` · ${fmtUsd(t.usd)}` : ""}`;
    if (rec.stopped_reason === "spending cap") txt.textContent = "stopped by the spending cap";
  }
}

function renderDownloads() {
  const rec = S.view.rec;
  const box = $("#downloads");
  if (!rec?.config || rec.status === "running") { box.innerHTML = ""; return; }
  const files = rec.config.deliverable === "files";
  const sig = `${S.view.id}|${rec.status}|${files}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = `<button id="dlHtml" title="One self-contained page you can open anywhere or send to anyone">page .html</button><button id="dlMd">report .md</button><button id="dlJson">.json</button>${files ? `<button id="dlZip">all files .zip</button>` : ""}`;
  const stamp = new Date(rec.started || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  $("#dlMd").onclick = () => saveBlob(renderReport(S.view.rec), `agent-debate-${stamp}.md`, "text/markdown");
  $("#dlHtml").onclick = () => {
    const r = S.view.rec;
    const nDocs = r.config.docs?.length || 0;
    openModal("Save the run as a page", `<p style="margin-top:0">One HTML file with every card and panel from this run. It has no script and loads nothing from the internet, so it opens anywhere — send it, attach it, or publish it.</p>
      <label class="row" style="margin:6px 0"><input type="checkbox" id="exPrompts" checked> include every prompt and raw reply <span class="faint">(${r.prompts.length} calls)</span></label>
      ${nDocs ? `<label class="row" style="margin:6px 0"><input type="checkbox" id="exDocs" checked> include the attached document${nDocs === 1 ? "" : "s"} <span class="faint">(${r.config.docs.map((d) => esc(d.name)).join(", ")})</span></label>` : ""}
      <div class="note">Whoever opens the page sees what you include. Leave the documents out if they are private — the claims that quote them still show the quoted words.</div>
      <div class="row" style="margin-top:10px"><button class="go" id="exSave">Save page</button></div>`);
    $("#exSave").onclick = () => {
      const html = reportPage({ record: r, events: S.view.events, css: document.querySelector("style")?.textContent || "", prompts: $("#exPrompts").checked, documents: $("#exDocs") ? $("#exDocs").checked : true, version: S.cfg?.version || "" });
      saveBlob(html, `agent-debate-${stamp}.html`, "text/html");
      closeModal();
    };
  };
  $("#dlJson").onclick = () => saveBlob(JSON.stringify({ id: S.view.id, ...S.view.rec }, null, 1), `agent-debate-${stamp}.json`, "application/json");
  $("#dlZip")?.addEventListener("click", () => {
    const r = S.view.rec;
    const entries = Object.entries(r.current).flatMap(([L, a]) => (a.files || []).map((f) => ({ name: `${L}/${f.name}`, content: f.content })));
    saveBlob(new Blob([zipStore(entries)], { type: "application/zip" }), `agent-debate-${stamp}-files.zip`, "application/zip");
  });
}

async function loadHistory() {
  try { S.runs = await host.listRuns(); } catch { S.runs = []; }
  if (!S.liveId) { const live = S.runs.find((r) => r.live || r.status === "running"); if (live) { S.liveId = live.id; if (!S.view.id) openRun(live.id); } }
  renderHistory();
}

function renderHistory() {
  const el = $("#hist");
  if (!S.runs.length) { el.innerHTML = `<div class="faint">No runs yet.</div>`; return; }
  el.innerHTML = S.runs.map((r) => `<div class="row" style="gap:4px;flex-wrap:nowrap">
    <button class="item ${r.id === S.view.id ? "active" : ""}" data-open="${esc(r.id)}" ${r.legacy ? `data-legacy="1"` : ""}>
      <div class="q">${esc(r.question || "(no question)")}</div>
      <div class="meta"><i class="dot ${r.status === "running" ? "run" : r.status === "done" ? "done" : r.status === "stopped" ? "stopped" : "fail"}"></i>${fmtTime(r.started)}
        ${(r.models || []).map((m, i) => `<span class="who" style="background:${m.color || MODEL_COLORS[i]};width:15px;height:15px;font-size:9.5px" title="${esc(m.label)}">${esc(m.letter)}</span>`).join("")}
        ${r.legacy ? `<span class="pill">rev ≤13 panel</span>` : r.headline ? `<span>${esc(r.headline)}</span>` : ""}${r.red_flag ? `<span class="bad">⚠</span>` : ""}${r.cost && r.cost.unknown < r.cost.calls ? `<span title="${r.cost.calls} calls · ${fmtTokens(r.cost.input)} in · ${fmtTokens(r.cost.output)} out">${fmtUsd(r.cost.usd)}</span>` : ""}${r.stopped_reason === "spending cap" ? `<span class="warn">cap</span>` : ""}</div>
    </button><button class="link" data-del="${esc(r.id)}" title="Delete this run" aria-label="Delete run" ${r.status === "running" ? "disabled" : ""}>×</button></div>`).join("");
  $$("[data-open]", el).forEach((b) => (b.onclick = () => {
    if (b.dataset.legacy) { const url = host.reportUrl?.(b.dataset.open); if (url) window.open(url, "_blank", "noopener"); return; }
    openRun(b.dataset.open);
  }));
  $$("[data-del]", el).forEach((b) => (b.onclick = async () => {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "delete?"; setTimeout(() => { b.dataset.confirm = ""; b.textContent = "×"; }, 3000); return; }
    try { await host.deleteRun(b.dataset.del); if (S.view.id === b.dataset.del) { S.view.unsub?.(); S.view = { id: null, events: [], unsub: null, rec: null }; $("#feed").innerHTML = ""; $("#panels").innerHTML = renderPanels(null); $("#downloads").innerHTML = ""; tickStatus(); } loadHistory(); }
    catch (e) { $("#formErr").textContent = e.message; }
  }));
}

// ================================================================ the scorecard

async function showScorecard(includeMock) {
  openModal("Model scorecard", `<div class="faint">Counting…</div>`);
  let card;
  try { card = await host.scorecard(includeMock); } catch (e) { $("#modalBody").innerHTML = `<div class="flag">${esc(e.message)}</div>`; return; }
  const p = (x) => (x == null ? `<span class="faint">—</span>` : `${Math.round(x * 100)}%`);
  const n = (r) => Object.values(r.findings).reduce((a, b) => a + b, 0);
  const cols = [
    ["model", (r) => `${esc(r.label)}${r.fewRuns ? ` <span class="warn" title="fewer than 5 runs — an anecdote, not a rate">*</span>` : ""}`, "the provider and model", (r) => r.label],
    ["seats", (r) => r.seats, "seats taken across your runs (two copies of one model in one run count twice)", (r) => r.seats],
    ["answered", (r) => p(r.participation), "share of seats where it produced a usable answer (the rest were absent)", (r) => r.participation],
    ["grounded", (r) => `${p(r.grounding)} <span class="faint">${r.checkableClaims ? `of ${r.checkableClaims}` : ""}</span>`, "claims whose quote, arithmetic or tool citation code verified — only in runs with documents or tools", (r) => r.grounding],
    ["audit findings", (r) => `${n(r) ? `<span class="bad">${n(r)}</span>` : "0"} <span class="faint">of ${r.claims}</span>`, "fabricated quotes, miscomputed or unsourced arithmetic, tool mismatches", (r) => r.findingRate],
    ["accepted", (r) => p(r.peerAccept), "of its claims the other analysts judged, the share they accepted (latest verdict each)", (r) => r.peerAccept],
    ["rejected", (r) => p(r.peerReject), "of its claims the other analysts judged, the share they rejected", (r) => r.peerReject],
    ["agenda", (r) => p(r.agendaCoverage), "of the claims it owed a verdict on as a critic, the share it judged", (r) => r.agendaCoverage],
    ["moved", (r) => p(r.movedRate), "share of its rebuttals that changed its mind, withdrew or added a claim", (r) => r.movedRate],
    ["repairs", (r) => r.repairs + r.templateCopies, "JSON repairs and template copies — the harness catching a format slip", (r) => r.repairs + r.templateCopies],
    ["$ / answer", (r) => (r.usdPerAnswer == null ? `<span class="faint">—</span>` : fmtUsd(r.usdPerAnswer)), "average spend per run it took part in (priced calls only)", (r) => r.usdPerAnswer],
    ["s / call", (r) => (r.secondsPerCall == null ? `<span class="faint">—</span>` : r.secondsPerCall.toFixed(1)), "average seconds per model call", (r) => r.secondsPerCall],
  ];
  let sortBy = 1, desc = true;
  const draw = () => {
    const rows = [...card.rows].sort((a, b) => { const x = cols[sortBy][3](a), y = cols[sortBy][3](b); const c = x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0; return desc ? -c : c; });
    $("#modalBody").innerHTML = `<div class="faint" style="margin-bottom:8px">${card.runs} saved run${card.runs === 1 ? "" : "s"}, counted by code. No model graded another: every number is a count of something that happened in a run. Click a column to sort.</div>
      ${rows.length ? `<div style="overflow-x:auto"><table class="mx" style="width:100%"><tr>${cols.map(([h, , t], i) => `<th title="${esc(t)}" data-sort="${i}" style="cursor:pointer;white-space:nowrap">${esc(h)}${i === sortBy ? (desc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr>
        ${rows.map((r) => `<tr>${cols.map(([, f], i) => `<td style="${i === 0 ? "text-align:left" : ""}">${f(r)}</td>`).join("")}</tr>`).join("")}</table></div>` : `<div class="note">No runs to count yet${includeMock ? "" : " (mock models are left out)"}.</div>`}
      <div class="row" style="margin-top:10px"><label class="row"><input type="checkbox" id="scMock" ${includeMock ? "checked" : ""}> include mock models</label><span style="flex:1"></span><button id="scMd">save as .md</button></div>
      <div class="hint">Rates from a handful of runs are anecdotes. Same-model pairs measure a model's variance, not a difference between models. Grounding counts only runs where something could be checked.</div>`;
    $$("[data-sort]").forEach((th) => (th.onclick = () => { const i = Number(th.dataset.sort); if (i === sortBy) desc = !desc; else { sortBy = i; desc = true; } draw(); }));
    $("#scMock").onchange = (e) => showScorecard(e.target.checked);
    $("#scMd").onclick = () => saveBlob(scorecardMarkdown(card), "agent-debate-scorecard.md", "text/markdown");
  };
  draw();
}

// ================================================================ resizable columns (as in Model Bridge)

function setupRails() {
  const wrap = $("#wrap");
  const saved = store.get("cols", null);
  if (saved) { wrap.style.setProperty("--c1", `${saved.c1}px`); wrap.style.setProperty("--c3", `${saved.c3}px`); }
  const drag = (rail, which) => {
    rail.addEventListener("pointerdown", (e) => {
      rail.classList.add("drag"); rail.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (which === "c1") wrap.style.setProperty("--c1", `${Math.max(250, Math.min(600, ev.clientX))}px`);
        else wrap.style.setProperty("--c3", `${Math.max(260, Math.min(720, window.innerWidth - ev.clientX))}px`);
      };
      const up = () => {
        rail.classList.remove("drag"); rail.removeEventListener("pointermove", move); rail.removeEventListener("pointerup", up);
        store.set("cols", { c1: parseInt(getComputedStyle(wrap).getPropertyValue("--c1")) || 340, c3: parseInt(getComputedStyle(wrap).getPropertyValue("--c3")) || 360 });
      };
      rail.addEventListener("pointermove", move); rail.addEventListener("pointerup", up);
    });
    rail.addEventListener("dblclick", () => { wrap.style.removeProperty("--c1"); wrap.style.removeProperty("--c3"); store.set("cols", null); });
  };
  drag($("#rail1"), "c1");
  drag($("#rail2"), "c3");
}

export { S };
