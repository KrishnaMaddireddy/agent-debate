// The centre column: one card per thing that happened, in the order it happened. Every card is a
// pure function of (events, record) so a live run and a replay render identically.
import { esc, linkify, mdToHtml } from "./dom.js";
import { isGrounded } from "../core/audit.js";
import { pct } from "../core/metrics.js";
import { inlineSiblings } from "../core/files.js";
import { fmtUsd, fmtTokens } from "../core/cost.js";

const colorOf = (rec, L) => rec.config?.models?.find((m) => m.letter === L)?.color || "#8b949e";
export const whoPill = (rec, L) => `<span class="who" style="background:${colorOf(rec, L)}" title="Analyst ${esc(L)}">${esc(L)}</span>`;
const labelOf = (rec, L) => rec.config?.models?.find((m) => m.letter === L)?.label || L;
const byLabel = (rec, by) => (!by ? "—" : by.letter ? `${whoPill(rec, by.letter)} ${esc(labelOf(rec, by.letter))}` : `${esc(by.label || `${by.provider} · ${by.model}`)} <span class="faint">(did not debate)</span>`);
const markOf = (st) => (!st ? `<span class="faint">·</span>` : isGrounded(st) ? `<span class="ok" title="${esc(st)}">✓</span>` : st === "unverifiable" ? `<span class="faint" title="not checkable">·</span>` : `<span class="bad" title="${esc(st)}">✕</span>`);
const promptBtn = (phase, L, round) => `<button class="link" data-prompt="${esc(phase)}|${esc(L)}|${round ?? 0}" title="Show exactly what was sent, and what came back">prompt</button>`;
const text = (s) => linkify(esc(s));

/** What one card's calls used: "$0.0021 · 6.1k tok", from the outputs recorded for that phase. */
function costPill(rec, phase, L, round) {
  const outs = rec.outputs.filter((o) => o.phase === phase && String(o.model) === String(L) && (round == null || (o.round ?? 0) === round) && o.usage);
  if (!outs.length) return "";
  const tok = outs.reduce((n, o) => n + o.usage.input + o.usage.output, 0);
  const known = outs.filter((o) => o.cost != null);
  const usd = known.reduce((n, o) => n + o.cost, 0);
  const est = outs.some((o) => o.usage.estimated);
  return `<span class="pill faint" title="${outs.length} call${outs.length === 1 ? "" : "s"} · ${outs.reduce((n, o) => n + o.usage.input, 0).toLocaleString()} tokens in, ${outs.reduce((n, o) => n + o.usage.output, 0).toLocaleString()} out${est ? " (estimated from length — the provider reported none)" : ""}">${known.length ? `${fmtUsd(usd)} · ` : ""}${fmtTokens(tok)} tok</span>`;
}

function kvRow(k, v) { return `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>`; }

function configCard(rec) {
  const c = rec.config;
  const who = (spec, fallback) => spec === "none" ? "none" : spec === "auto" ? fallback : spec?.letter ? `${whoPill(rec, spec.letter)} ${esc(labelOf(rec, spec.letter))}` : spec ? `${esc(spec.label)} <span class="faint">(did not debate)</span>` : fallback;
  return `<div class="h"><b>Run configuration</b></div>
    <div class="qblock">${esc(c.question)}</div>
    ${kvRow("mode", c.rounds ? `debate · ${c.rounds} round${c.rounds === 1 ? "" : "s"}${c.autoStop ? " · auto-stop" : ""}` : "independent answers only")}
    ${kvRow("analysts", c.models.map((m) => `${whoPill(rec, m.letter)} ${esc(m.label)}`).join("<br>"))}
    ${kvRow("deliverable", c.deliverable === "files" ? "files" : "answer with claims")}
    ${kvRow("judging lens", c.persona ? esc(c.persona.name) : `<span class="faint">none — each states its own standards</span>`)}
    ${kvRow("house skills", c.skills?.length ? esc(c.skills.join(", ")) : `<span class="faint">none</span>`)}
    ${kvRow("tools", c.tools?.length ? `${esc(c.tools.map((t) => t.name + (t.provider ? ` via ${t.provider}` : "")).join(", "))} · ${c.budget} call${c.budget === 1 ? "" : "s"} each` : `<span class="faint">none</span>`)}
    ${kvRow("documents", c.docs?.length ? c.docs.map((d) => `${esc(d.id)} ${esc(d.name)} <span class="faint">${d.words} words</span>`).join("<br>") : `<span class="faint">none — quotes cannot be grounded</span>`)}
    ${kvRow("question reading", c.expand ? who(c.expander, "first API model") : `<span class="faint">off</span>`)}
    ${kvRow("memo writer", who(c.synthesizer, "first analyst"))}
    ${kvRow("spending cap", c.spend_cap != null ? `${fmtUsd(c.spend_cap)} <span class="faint">· checked before every call</span>` : `<span class="faint">none</span>`)}`;
}

function intentCard(rec) {
  const x = rec.intent.expansion;
  const li = (a) => (a?.length ? `<ul>${a.map((s) => `<li>${text(s)}</li>`).join("")}</ul>` : `<div class="faint" style="margin:2px 0 6px">none</div>`);
  return `<div class="h"><b>Intent, as read</b> <span class="faint">· by ${byLabel(rec, rec.intent.by)} · shared by every analyst</span></div>${rec.intent.fallback_from ? `<div class="note">${byLabel(rec, rec.intent.fallback_from.by)} was asked first and returned nothing usable — ${esc(rec.intent.fallback_from.error)}</div>` : ""}
    <div style="margin:4px 0 8px"><span class="faint">asked:</span> ${esc(rec.intent.ask)}</div>
    <div style="margin:0 0 6px"><b>${esc(x.reading)}</b></div>
    ${x.sub_questions?.length ? `<div class="muted">sub-questions</div><ul>${x.sub_questions.map((q) => `<li><span class="faint">${esc(q.id)}</span> ${esc(q.text)}</li>`).join("")}</ul>` : ""}
    <div class="muted">testable</div>${li(x.testable)}
    <div class="muted">not testable — will be said, not pretended</div>${li(x.not_testable)}
    ${x.proxies?.length ? `<div class="muted">proxies</div>${li(x.proxies)}` : ""}
    ${x.gates?.length ? `<div class="muted">gates</div>${li(x.gates)}` : ""}
    ${x.terms?.length ? `<div class="muted">terms</div>${li(x.terms)}` : ""}
    ${x.count || x.horizon ? `<div class="faint">${x.count ? `count from the ask: <b>${x.count}</b>` : ""}${x.count && x.horizon ? " · " : ""}${x.horizon ? `horizon: ${esc(x.horizon)}` : ""}</div>` : ""}
    ${x.caveat ? `<div class="echo" style="margin-top:7px">${esc(x.caveat)}</div>` : ""}`;
}

function claimLi(L, c, { fresh = false } = {}) {
  const st = c.audit?.status;
  const finding = st && !isGrounded(st) && st !== "unverifiable";
  const ev = c.evidence ? `<details data-d="ev-${L}-${c.id}"><summary class="faint">evidence</summary><div class="ev-text">${c.basis === "quote" ? `“${esc(c.evidence)}”${c.source ? ` <span class="faint">— ${esc(c.source)}</span>` : ""}` : esc(c.evidence)}${c.audit?.detail ? `<div class="faint">code: ${esc(c.audit.detail)}</div>` : ""}</div></details>` : "";
  return `<li${fresh ? ' class="fresh"' : ""}><span class="mark">${markOf(st)}</span><span class="ref">${esc(L)}:${esc(c.id)}</span><div>${c.load_bearing ? `<span class="lb" title="load-bearing: the position falls without it">★</span> ` : ""}<span class="basis ${esc(c.basis)}">${esc(c.basis)}</span>${text(c.text)}${finding ? `<div class="flag" style="margin:3px 0 0">${esc(st.replace(/_/g, " "))} — ${esc(c.audit.detail)}</div>` : ""}${ev}</div></li>`;
}

export function filesView(L, files, ui, { url } = {}) {
  if (!files?.length) return "";
  if (ui.static) {
    // A page with no script: every file is there, previews first, code folded.
    return `<div class="files">${files.map((f, i) => {
      const prev = /\.(html?|svg)$/i.test(f.name);
      return `<details ${i === 0 ? "open" : ""}><summary>${esc(f.name)} <span class="faint">${f.bytes} bytes</span></summary>
        ${prev ? `<iframe sandbox="allow-scripts" title="${esc(f.name)} preview" srcdoc="${esc(/\.svg$/i.test(f.name) ? `<!doctype html><body style="margin:0">${f.content}</body>` : inlineSiblings(f, files))}"></iframe>` : ""}
        <details><summary class="faint">code</summary><pre>${esc(f.content)}</pre></details></details>`;
    }).join("")}</div>`;
  }
  const cur = files.find((f) => f.name === ui.fileTab[L]) || files.find((f) => /\.html?$/i.test(f.name)) || files[0];
  const mode = ui.fileMode[L] || (/\.(html?|svg)$/i.test(cur.name) ? "preview" : "code");
  const previewable = /\.(html?|svg)$/i.test(cur.name);
  const body = mode === "preview" && previewable
    ? `<iframe sandbox="allow-scripts" title="${esc(cur.name)} preview" srcdoc="${esc(/\.svg$/i.test(cur.name) ? `<!doctype html><body style="margin:0">${cur.content}</body>` : inlineSiblings(cur, files))}"></iframe>`
    : `<pre>${esc(cur.content)}</pre>`;
  return `<div class="files">
    <div class="tabs">${files.map((f) => `<button class="chip ${f.name === cur.name ? "on" : ""}" data-file="${esc(L)}|${esc(f.name)}">${esc(f.name)} <span class="faint">${f.bytes}b</span></button>`).join("")}
      <span style="flex:1"></span>
      ${previewable ? `<span class="seg"><button data-fmode="${esc(L)}|preview" aria-pressed="${mode === "preview"}">preview</button><button data-fmode="${esc(L)}|code" aria-pressed="${mode !== "preview"}">code</button></span>` : ""}
      <button data-fdl="${esc(L)}|${esc(cur.name)}">download</button><button data-fzip="${esc(L)}">all (.zip)</button>${cur.url || url ? `<a href="${esc(cur.url || url)}" target="_blank" rel="noopener">open ↗</a>` : ""}</div>
    ${body}</div>`;
}

function artifactCard(rec, L, entry, ui) {
  const a = entry.artifact;
  const g = entry.grounding;
  const files = rec.config.deliverable === "files";
  return `<div class="h">${whoPill(rec, L)}<b>${esc(labelOf(rec, L))}</b><span class="faint">answer</span>
      ${a.confidence != null ? `<span class="pill">confidence ${a.confidence}</span>` : ""}
      ${g ? `<span class="pill" title="claims whose quote, arithmetic or tool citation code verified">${g.verified}/${g.total} grounded</span>` : ""}
      ${entry.tool_calls ? `<span class="pill">${entry.tool_calls} tool call${entry.tool_calls === 1 ? "" : "s"}</span>` : ""}
      <span class="grow"></span>${costPill(rec, "answer", L, 0)}${promptBtn("answer", L, 0)}</div>
    <div class="position">${text(a.position)}</div>
    ${files ? filesView(L, a.files, ui) : `<ul class="claims">${(a.claims || []).map((c) => claimLi(L, c)).join("")}</ul>`}
    ${a.items?.length ? `<div style="margin-top:7px"><span class="muted">items:</span> ${a.items.map((i) => `<span class="pill" title="${esc(i.why || "")}">${esc(i.name)}</span>`).join(" ")}</div>` : ""}
    ${(entry.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join("")}
    ${!files && (a.assumptions?.length || a.counter_considerations?.length || a.what_would_change_my_mind?.length || Object.keys(a.sub_answers || {}).length) ? `<details data-d="more-${L}" style="margin-top:6px"><summary>assumptions, counter-case, sub-answers</summary>
      ${a.assumptions?.length ? `<div class="muted">assumptions</div><ul>${a.assumptions.map((s) => `<li>${text(s)}</li>`).join("")}</ul>` : ""}
      ${a.counter_considerations?.length ? `<div class="muted">best case against</div><ul>${a.counter_considerations.map((s) => `<li>${text(s)}</li>`).join("")}</ul>` : ""}
      ${a.what_would_change_my_mind?.length ? `<div class="muted">would change its mind</div><ul>${a.what_would_change_my_mind.map((s) => `<li>${text(s)}</li>`).join("")}</ul>` : ""}
      ${Object.keys(a.sub_answers || {}).length ? `<div class="muted">sub-answers</div><ul>${Object.entries(a.sub_answers).map(([k, v]) => `<li><span class="faint">${esc(k)}</span> ${text(v)}</li>`).join("")}</ul>` : ""}
    </details>` : ""}`;
}

const VMARK = { accept: `<span class="ok">✓</span>`, reject: `<span class="bad">✕</span>`, unresolved: `<span class="warn">?</span>` };

function critiqueCard(rec, L, round, cr) {
  const c = cr.critique;
  return `<div class="h">${whoPill(rec, L)}<b>critique</b><span class="faint">round ${round}</span>
      <span class="pill">${c.divergences.length} divergence${c.divergences.length === 1 ? "" : "s"}</span><span class="pill">${c.verdicts.length} verdict${c.verdicts.length === 1 ? "" : "s"}</span>
      ${cr.coverage?.owed?.length ? `<span class="pill ${cr.coverage.missed.length ? "warn" : ""}" title="claims on its agenda that got a verdict">agenda ${cr.coverage.answered.length}/${cr.coverage.owed.length}</span>` : ""}
      <span class="grow"></span>${costPill(rec, "critique", L, round)}${promptBtn("critique", L, round)}</div>
    ${cr.failed ? `<div class="flag">Critique failed (${esc(cr.error || "")}) — counted as an empty critique; the run continues.</div>` : ""}
    ${c.agreements.length ? `<div class="muted">agrees: ${c.agreements.map(text).join(" · ")}</div>` : ""}
    ${c.divergences.length ? `<ul class="divs">${c.divergences.map((d) => `<li>vs ${d.with ? whoPill(rec, d.with) : "all"} <b>${esc(d.topic)}</b> <span class="rc ${esc(d.root_cause)}">${esc(d.root_cause)}</span>
      <div class="muted" style="font-size:12px">theirs: ${text(d.theirs)}</div><div style="font-size:12px">${esc(L)}: ${text(d.mine)}</div>${d.detail ? `<div class="faint" style="font-size:12px">${text(d.detail)}</div>` : ""}</li>`).join("")}</ul>` : ""}
    ${c.verdicts.length ? `<div class="verdicts">${c.verdicts.map((v) => `<span class="pill" title="${esc(v.why)}">${VMARK[v.verdict] || ""} ${esc(v.ref)}</span>`).join("")}</div>` : ""}
    ${cr.coverage?.missed?.length ? `<div class="note">went unargued: ${esc(cr.coverage.missed.join(", "))}</div>` : ""}
    ${c.questions.length ? `<div style="margin-top:6px">${c.questions.map((q) => `<div>? ${q.to ? `to ${whoPill(rec, q.to)}` : "to all"} ${text(q.question)}</div>`).join("")}</div>` : ""}`;
}

function rebuttalCard(rec, L, round, rb) {
  const r = rb.rebuttal;
  const ap = rb.applied || {};
  const moved = r ? r.changed_mind.length + (ap.withdrawn?.length || 0) + (ap.added?.length || 0) + (ap.revised_files?.length || 0) : 0;
  return `<div class="h">${whoPill(rec, L)}<b>rebuttal</b><span class="faint">round ${round}</span>
      <span class="pill ${moved ? "" : "faint"}">${moved ? `${moved} change${moved === 1 ? "" : "s"}` : "stands by"}</span>
      ${ap.confidence_before != null && ap.confidence_after != null && ap.confidence_before !== ap.confidence_after ? `<span class="pill">confidence ${ap.confidence_before} → ${ap.confidence_after}</span>` : ""}
      <span class="grow"></span>${costPill(rec, "rebuttal", L, round)}${promptBtn("rebuttal", L, round)}</div>
    ${rb.failed ? `<div class="flag">Rebuttal failed (${esc(rb.error || "")}) — its position is kept as it was.</div>` : ""}
    ${r ? `${r.changed_mind.map((c) => `<div class="echo" style="margin:4px 0">changed: <b>${esc(c.topic)}</b> — ${text(c.from)} → ${text(c.to)} <span class="faint">because ${text(c.because)}</span></div>`).join("")}
      ${ap.withdrawn?.length ? `<div>withdrew ${ap.withdrawn.map((id) => `<code>${esc(L)}:${esc(id)}</code>`).join(" ")}</div>` : ""}
      ${ap.added?.length ? `<div class="muted" style="margin-top:4px">new claims</div><ul class="claims">${ap.added.map((c) => claimLi(L, c, { fresh: true })).join("")}</ul>` : ""}
      ${ap.revised_files?.length ? `<div>revised files: ${ap.revised_files.map((n) => `<code>${esc(n)}</code>`).join(" ")}</div>` : ""}
      ${ap.position_changed ? `<div style="margin-top:5px"><span class="muted">position now:</span> ${text(r.final_position)}</div>` : ""}
      ${r.answers.length || r.stand_by.length ? `<details data-d="rb-${L}-${round}" style="margin-top:5px"><summary>${r.answers.length} answer${r.answers.length === 1 ? "" : "s"}${r.stand_by.length ? `, stands by ${r.stand_by.length}` : ""}</summary>
        ${r.answers.map((a) => `<div>→ ${a.to ? whoPill(rec, a.to) : ""} ${a.question ? `<span class="faint">${esc(a.question)}</span> ` : ""}${text(a.answer)}</div>`).join("")}
        ${r.stand_by.map((s) => `<div>stands by: ${text(s)}</div>`).join("")}</details>` : ""}` : ""}`;
}

function memoCard(rec) {
  const s = rec.synthesis;
  if (!s.memo) return `<div class="h"><b>Joint memo</b></div><div class="note">No memo — ${esc(s.error || "the writer failed")}. The code-computed panels are the product; the memo is prose on top.</div>`;
  return `<div class="h"><b>Joint memo</b><span class="faint">· by ${byLabel(rec, s.by)}</span><span class="grow"></span>${costPill(rec, "memo", s.by?.letter || "writer", null)}${promptBtn("memo", s.by?.letter || "writer", 0)}</div>
    ${s.flag === "chain_of_thought" ? `<div class="flag"><b>This is not a finished memo.</b> The writer returned its reasoning instead of prose — twice. Read it as notes; the computed panels are the reliable part.</div>` : ""}
    <div class="memo-body">${mdToHtml(s.memo)}</div>`;
}

/** Feed items: [{key, cls, html}] in event order. */
export function feedItems(events, rec, ui) {
  const items = [];
  if (!rec.config) return items;
  const push = (key, cls, html) => items.push({ key, cls, html });
  let pi = 0;
  const roundTotal = rec.config.rounds;
  for (const ev of events) {
    switch (ev.type) {
      case "run_started": push("cfg", "ev", configCard(rec)); break;
      case "intent": push("intent", "ev intent", intentCard(rec)); break;
      case "intent_failed": push("intent", "ev warn", `<div class="h"><b>Intent, as read</b></div><div class="note">No shared reading — ${esc(ev.error)}. Each analyst reads the question itself.</div>`); break;
      case "phase": push(`ph-${pi++}`, "phase", `phase ${ev.n} · ${esc(ev.name)}${ev.round ? ` · round ${ev.round} of ${roundTotal}` : ""}`); break;
      case "tool_result": push(`tool-${ev.model}-${ev.ref}`, "ev tool", `${whoPill(rec, ev.model)} <b>${esc(ev.ref)}</b> ${esc(ev.name)} <span class="faint">${esc(JSON.stringify(ev.args).slice(0, 90))}</span> → ${ev.error ? `<span class="bad">${esc(ev.error)}</span>` : ev.count != null ? `${ev.count} result${ev.count === 1 ? "" : "s"}` : "ok"}
        <details data-d="tr-${ev.model}-${ev.ref}"><summary class="faint">result</summary><pre style="white-space:pre-wrap;margin:4px 0 0;font-size:11px">${text(ev.text || "")}</pre></details>`); break;
      case "artifact": push(`art-${ev.model}`, "ev", artifactCard(rec, ev.model, rec.artifacts[ev.model], ui)); break;
      case "absent": push(`abs-${ev.model}`, "ev bad", `<div class="h">${whoPill(rec, ev.model)}<b>${esc(labelOf(rec, ev.model))}</b><span class="pill bad">absent</span><span class="grow"></span>${promptBtn("answer", ev.model, 0)}</div><div>${esc(ev.reason)}</div><div class="faint" style="margin-top:3px">An analyst that produced nothing did not disagree — it is excluded from every number.</div>`); break;
      case "json_retry": push(`jr-${ev.model}-${ev.phase}-${ev.round || 0}`, "ev tool", `${whoPill(rec, ev.model)} replied without the JSON this pipeline reads${ev.truncated ? " (cut off at the ceiling)" : ""} — asked once to convert its own reply.`); break;
      case "template_copy": push(`tc-${ev.model}-${ev.phase}-${ev.round || 0}`, "ev warn", `${whoPill(rec, ev.model)} copied the template's placeholders (${esc(ev.phase)}, ${esc(ev.field)}${ev.rows ? `, ${ev.rows} row${ev.rows === 1 ? "" : "s"}` : ""}) — dropped. A copied placeholder is not a position.`); break;
      case "gate": if (ev.note) push("gate", "ev warn", `<div class="note" style="margin:0">${esc(ev.note)}</div>`); break;
      case "diff": {
        const d = rec.diff;
        const files = rec.config.deliverable === "files";
        push("diff", "ev", `<div class="h"><b>Code-computed diff</b><span class="faint">· independent answers, before anyone saw anyone</span></div>
          ${files ? `<div>approach similarity ${d.similarity.avg == null ? "—" : pct(d.similarity.avg)}</div>` : `<div><b>${d.overlap.shared}</b> of ${d.overlap.total} claims made by every analyst (${pct(d.overlap.ratio)}) · agenda ${Object.values(d.agenda).reduce((n, a) => n + a.length, 0)} claim${Object.values(d.agenda).reduce((n, a) => n + a.length, 0) === 1 ? "" : "s"} owed a verdict${d.items ? ` · items everyone listed: ${d.items.consensus.length ? esc(d.items.consensus.join(", ")) : "none"}` : ""}</div>`}`);
        break;
      }
      case "critique": push(`crit-${ev.round}-${ev.model}`, "ev", critiqueCard(rec, ev.model, ev.round, rec.rounds.find((r) => r.round === ev.round).critiques[ev.model])); break;
      case "rebuttal": push(`reb-${ev.round}-${ev.model}`, "ev", rebuttalCard(rec, ev.model, ev.round, rec.rounds.find((r) => r.round === ev.round).rebuttals[ev.model])); break;
      case "round_end": push(`re-${ev.round}`, "phase", `round ${ev.round} of ${ev.of_rounds} done · ${ev.moves} change${ev.moves === 1 ? "" : "s"} of position`); break;
      case "auto_stop": push("autostop", "ev warn", `Auto-stopped after round ${ev.after_round}: that round changed nobody's mind. More rounds buy drift, not agreement.`); break;
      case "diff_final": {
        const f = rec.final;
        const present = rec.gate?.present || [];
        push("final", "ev", `<div class="h"><b>${rec.rounds.length ? "After the debate" : "Independent answers compared"}</b></div><div class="big">${esc(rec.rounds.length ? f.compare.headline : `${present.length} answer${present.length === 1 ? "" : "s"}, no debate rounds`)}</div>
          ${f.compare.redFlag ? `<div class="flag">⚠ ${esc(f.compare.redFlag)}</div>` : ""}
          ${rec.rounds.length ? present.map((L) => { const a = rec.current[L]; return a ? `<details data-d="final-${L}" style="margin-top:5px"><summary>${whoPill(rec, L)} final position${a.confidence != null ? ` · confidence ${a.confidence}` : ""}</summary><div class="position">${text(a.position)}</div>${rec.config.deliverable === "files" ? filesView(L, a.files, ui) : `<ul class="claims">${(a.claims || []).map((c) => claimLi(L, c)).join("")}</ul>`}</details>` : ""; }).join("") : ""}
          <div class="faint" style="margin-top:5px">The numbers are in the panels on the right.</div>`);
        break;
      }
      case "memo_retry": push("memoretry", "ev tool", `memo writer ${ev.reason === "chain of thought" ? "returned its reasoning instead of a memo" : `returned ${esc(ev.reason)}`} — asked once more.`); break;
      case "synthesis": push("memo", "ev memo", memoCard(rec)); break;
      case "model_failed": if (ev.phase !== "answer") push(`fail-${ev.model}-${ev.phase}-${ev.round || 0}`, "ev tool", `${ev.model && /^[A-F]$/.test(ev.model) ? whoPill(rec, ev.model) : esc(ev.model)} <span class="warn">failed in ${esc(ev.phase)}${ev.round ? ` (round ${ev.round})` : ""}:</span> ${esc(ev.error)}`); break;
      case "budget_stop": push("budgetstop", "ev warn", `<div class="h"><b>Spending cap reached</b></div><div>${fmtUsd(ev.spent)} spent${ev.in_flight ? ` and ${fmtUsd(ev.in_flight)} in flight` : ""}. The next call — ${/^[A-F]$/.test(ev.model) ? whoPill(rec, ev.model) : esc(ev.model)} ${esc(ev.phase)} — could cost up to ${fmtUsd(ev.needed)}, which would pass the ${fmtUsd(ev.cap)} cap, so it was not made.</div><div class="faint" style="margin-top:3px">Raise the cap or use fewer rounds or cheaper models to finish this kind of run.</div>`); break;
      case "stopped": push("stopped", "ev warn", ev.reason === "spending cap" ? `<b>Stopped by the spending cap</b> during ${esc(ev.phase)}. Everything above is kept and saved.` : `<b>Stopped</b> during ${esc(ev.phase)}. Everything above is kept and saved.`); break;
      case "crash": push("crash", "ev bad", `<b>The run crashed</b> during ${esc(ev.phase)}: ${esc(ev.message)}`); break;
      default: break;
    }
  }
  return items;
}
