// The run record and the report are pure functions of the event list. A live run, a replayed run,
// the JSON record and the markdown report therefore cannot disagree. Browser-safe.

import { pct } from "./metrics.js";
import { isGrounded } from "./audit.js";
import { usageTotals, fmtUsd, fmtTokens } from "./cost.js";

export function reduceEvents(events) {
  const rec = {
    status: "running", started: null, finished: null, duration_ms: null,
    config: null, intent: null, intent_error: null,
    phases: [], prompts: [], outputs: [], tools: {}, artifacts: {}, absent: {}, gate: null,
    retries: [], template_copies: [], failures: [],
    diff: null, rounds: [], auto_stop: null, final: null, synthesis: null, memo_retry: null,
    error: null, stopped_in: null, stopped_reason: null, budget_stop: null, current: {}, usage: null,
  };
  const roundOf = (n) => { let r = rec.rounds.find((x) => x.round === n); if (!r) { r = { round: n, critiques: {}, rebuttals: {}, moves: null, by: null }; rec.rounds.push(r); rec.rounds.sort((a, b) => a.round - b.round); } return r; };
  for (const ev of events || []) {
    switch (ev.type) {
      case "run_started": rec.started = ev.t; rec.config = ev.config; break;
      case "intent": rec.intent = { ask: ev.ask, by: ev.by, expansion: ev.expansion, fallback_from: ev.fallback_from || null }; break;
      case "intent_failed": rec.intent_error = { by: ev.by, error: ev.error }; break;
      case "phase": rec.phases.push({ n: ev.n, name: ev.name, round: ev.round ?? null, t: ev.t }); break;
      case "prompt": rec.prompts.push({ phase: ev.phase, round: ev.round, model: ev.model, system: ev.system, user: ev.user, max_tokens: ev.max_tokens, t: ev.t }); break;
      case "model_output": rec.outputs.push({ phase: ev.phase, round: ev.round, model: ev.model, ms: ev.ms, chars: ev.chars, truncated: ev.truncated, from_reasoning: ev.from_reasoning, text: ev.text, t: ev.t, usage: ev.usage || null, cost: ev.cost ?? null, served_model: ev.served_model || null }); break;
      case "tool_result": (rec.tools[ev.model] ||= []).push({ ref: ev.ref, name: ev.name, args: ev.args, error: ev.error, count: ev.count, text: ev.text, phase: ev.phase, round: ev.round }); break;
      case "json_retry": rec.retries.push({ phase: ev.phase, round: ev.round ?? null, model: ev.model, truncated: ev.truncated, head: ev.head }); break;
      case "template_copy": rec.template_copies.push({ model: ev.model, phase: ev.phase, round: ev.round ?? null, field: ev.field, rows: ev.rows ?? null }); break;
      case "artifact": rec.artifacts[ev.model] = { artifact: ev.artifact, grounding: ev.grounding, notes: ev.notes || [], tool_calls: ev.tool_calls || 0 }; rec.current[ev.model] = ev.artifact; break;
      case "absent": rec.absent[ev.model] = ev.reason; break;
      case "model_failed": rec.failures.push({ model: ev.model, phase: ev.phase, round: ev.round ?? null, error: ev.error }); break;
      case "gate": rec.gate = { present: ev.present, absent: ev.absent, note: ev.note }; break;
      case "diff": rec.diff = ev.snapshot; break;
      case "critique": roundOf(ev.round).critiques[ev.model] = { critique: ev.critique, coverage: ev.coverage, failed: Boolean(ev.failed), error: ev.error || null }; break;
      case "rebuttal": roundOf(ev.round).rebuttals[ev.model] = { rebuttal: ev.rebuttal, applied: ev.applied, failed: Boolean(ev.failed), error: ev.error || null, received_count: ev.received_count }; if (ev.artifact_after) rec.current[ev.model] = ev.artifact_after; break;
      case "round_end": { const r = roundOf(ev.round); r.moves = ev.moves; r.by = ev.by; break; }
      case "auto_stop": rec.auto_stop = { after_round: ev.after_round, skipped: ev.skipped }; break;
      case "diff_final": rec.final = { snapshot: ev.snapshot, compare: ev.compare, verdicts: ev.verdicts, root_causes: ev.root_causes, movement: ev.movement, towards: ev.towards, rounds_run: ev.rounds_run, auto_stopped: ev.auto_stopped }; if (ev.finals) Object.assign(rec.current, ev.finals); break;
      case "memo_retry": rec.memo_retry = { reason: ev.reason }; break;
      case "synthesis": rec.synthesis = { by: ev.by, memo: ev.memo, flag: ev.flag || null, error: ev.error || null }; break;
      case "stopped": rec.stopped_in = ev.phase; rec.stopped_reason = ev.reason || "stop"; break;
      case "budget_stop": rec.budget_stop = { cap: ev.cap, spent: ev.spent, in_flight: ev.in_flight, needed: ev.needed, phase: ev.phase, model: ev.model }; break;
      case "crash": rec.error = { phase: ev.phase, message: ev.message, stack: ev.stack }; break;
      case "done": rec.status = ev.status; rec.finished = ev.t; rec.duration_ms = rec.started ? ev.t - rec.started : null; break;
      default: break;
    }
  }
  rec.usage = usageTotals(rec.outputs);
  return rec;
}

/** One line for a run's cost: "$0.0123 · 41k tokens in, 9.2k out · 14 calls" (with caveats). */
export function costLine(rec) {
  const t = rec.usage?.total;
  if (!t || !t.calls) return "no calls";
  const cap = rec.config?.spend_cap;
  const money = t.unknown === t.calls ? "cost unknown" : `${fmtUsd(t.usd)}${t.unknown ? ` + ${t.unknown} call${t.unknown === 1 ? "" : "s"} at an unknown price` : ""}`;
  return `${money} · ${fmtTokens(t.input)} tokens in, ${fmtTokens(t.output)} out · ${t.calls} call${t.calls === 1 ? "" : "s"}${t.estimated ? ` (${t.estimated} estimated from length)` : ""}${cap != null ? ` · cap ${fmtUsd(cap)}` : ""}`;
}

// ---------------------------------------------------------------- markdown report

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const secs = (ms) => (ms == null ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const AUDIT_MARK = (st) => (!st ? "" : isGrounded(st) ? "✓" : st === "unverifiable" ? "·" : "✕");

export function modelLabel(rec, L) {
  const m = rec.config?.models?.find((x) => x.letter === L);
  return m ? `${L} · ${m.label}` : String(L);
}

function roleLabel(rec, by) {
  if (!by) return "—";
  if (by.letter) return `Analyst ${modelLabel(rec, by.letter)}`;
  return `${by.label || `${by.provider} · ${by.model}`} (did not debate)`;
}

export function renderReport(rec) {
  const c = rec.config || { models: [], docs: [] };
  const L = (x) => modelLabel(rec, x);
  const files = c.deliverable === "files";
  const out = [];
  out.push(`# Agent Debate — ${when(rec.started)}`, "");
  if (rec.status !== "done") out.push(`> **Status: ${rec.status}**${rec.stopped_in ? ` — stopped during ${rec.stopped_in}${rec.stopped_reason === "spending cap" && rec.budget_stop ? ` by the spending cap: ${fmtUsd(rec.budget_stop.spent)} spent, ${fmtUsd(rec.budget_stop.in_flight)} in flight, and the next call (${rec.budget_stop.model}, ${rec.budget_stop.phase}) could cost up to ${fmtUsd(rec.budget_stop.needed)} against a cap of ${fmtUsd(rec.budget_stop.cap)}` : ""}` : ""}${rec.error ? ` — ${rec.error.message}` : ""}. Everything below is what finished before that.`, "");

  // Run configuration
  out.push("## Run configuration", "", "| | |", "|---|---|");
  out.push(`| question | ${esc(c.question)} |`);
  out.push(`| mode | ${files ? "files deliverable" : "answer with claims"} · ${c.rounds ? `debate, ${c.rounds} round${c.rounds === 1 ? "" : "s"} requested${c.autoStop ? ", auto-stop on" : ""}` : "independent answers only (no debate rounds)"} |`);
  out.push(`| analysts | ${c.models.map((m) => `${m.letter} · ${esc(m.label)} (\`${m.provider}/${m.model}\`)`).join("<br>")} |`);
  out.push(`| judging lens | ${c.persona ? `${esc(c.persona.name)} — ${esc(c.persona.lens)}` : "none — each analyst states its own standards"} |`);
  out.push(`| house skills | ${c.skills?.length ? c.skills.join(", ") : "none"} |`);
  out.push(`| tools | ${c.tools?.length ? `${c.tools.map((t) => `${t.name}${t.provider ? ` via ${t.provider}` : ""}`).join(", ")} · ${c.budget} call(s) per analyst in phase 1, ${c.verifyBudget} per rebuttal` : "none — documents and background knowledge only"} |`);
  out.push(`| documents | ${c.docs?.length ? c.docs.map((d) => `${d.id} ${esc(d.name)} (${d.words} words)`).join("; ") : "none — quotes cannot be grounded, so the grounding rate is 0 by construction unless tools or arithmetic are used"} |`);
  out.push(`| question reading | ${c.expand ? (rec.intent ? roleLabel(rec, rec.intent.by) : rec.intent_error ? `failed (${esc(rec.intent_error.error)})` : "—") : "off"} |`);
  out.push(`| memo writer | ${rec.synthesis?.by ? roleLabel(rec, rec.synthesis.by) : c.synthesizer === "none" ? "none" : "—"} |`);
  out.push(`| started · finished | ${when(rec.started)} · ${when(rec.finished)} (${secs(rec.duration_ms)}) |`);
  out.push(`| cost | ${esc(costLine(rec))} |`, "");

  // Intent, as read
  const x = rec.intent?.expansion;
  if (x) {
    out.push("## Intent, as read", "", `*by ${roleLabel(rec, rec.intent.by)} · shared by every analyst${rec.intent.fallback_from ? ` · ${roleLabel(rec, rec.intent.fallback_from.by)} was asked first and failed: ${rec.intent.fallback_from.error}` : ""}*`, "", `asked: ${rec.intent.ask}`, "", `**${x.reading}**`, "");
    const sec = (title, list) => { if (list?.length) out.push(`**${title}**`, ...list.map((s) => `- ${s}`), ""); };
    if (x.sub_questions?.length) out.push("**Sub-questions**", ...x.sub_questions.map((q) => `- ${q.id}: ${q.text}`), "");
    sec("Testable", x.testable);
    sec("Not testable — will be said, not pretended", x.not_testable);
    sec("Proxies", x.proxies);
    sec("Gates", x.gates);
    sec("Terms", x.terms);
    if (x.count || x.horizon) out.push(`*${[x.count ? `count from the ask: ${x.count}` : "", x.horizon ? `horizon: ${x.horizon}` : ""].filter(Boolean).join(" · ")}*`, "");
    if (x.caveat) out.push(`> ${x.caveat}`, "");
  } else if (rec.intent_error) {
    out.push("## Intent, as read", "", `_No shared reading — ${rec.intent_error.error}. Each analyst read the question itself._`, "");
  }

  // Participation
  const present = rec.gate?.present || Object.keys(rec.artifacts);
  out.push("## Participation", "");
  for (const m of c.models) out.push(`- **${L(m.letter)}** — ${rec.absent[m.letter] ? `ABSENT: ${rec.absent[m.letter]}` : rec.artifacts[m.letter] ? `answered${rec.artifacts[m.letter].tool_calls ? ` (${rec.artifacts[m.letter].tool_calls} tool calls)` : ""}` : "no answer"}`);
  if (Object.keys(rec.absent).length) out.push("", "> An analyst that produced nothing did not disagree — it was absent. Absent analysts are excluded from every number below.");
  if (rec.gate?.note) out.push("", `> ${rec.gate.note}`);
  out.push("");

  // Before-debate diff
  const d = rec.diff;
  if (d) {
    out.push("## Code-computed diff — independent answers (objective)", "");
    if (!files) {
      out.push("| analyst | confidence | claims | grounded | grounding rate | flagged | ungrounded load-bearing |", "|---|---|---|---|---|---|---|");
      for (const P of present) {
        const g = d.grounding[P] || {};
        out.push(`| ${esc(L(P))} | ${d.confidence[P] ?? "—"} | ${g.total ?? 0} | ${g.verified ?? 0} | ${pct(g.rate)} | ${(g.flagged || []).map((id) => `${P}:${id}`).join(", ") || "—"} | ${(g.ungroundedLoadBearing || []).map((id) => `${P}:${id}`).join(", ") || "—"} |`);
      }
      out.push("");
      out.push(`- Claims made by every analyst (code clustering, content-word overlap ≥ 50%): **${d.overlap.shared}** of ${d.overlap.total} claim clusters (${pct(d.overlap.ratio)}).`);
      if (d.overlap.pairwise.length > 1 || present.length === 2) out.push(`- Pairwise claim overlap: ${d.overlap.pairwise.map((p) => `${p.a}/${p.b} **${pct(p.overlap)}**`).join(" · ")}`);
      if (d.items) {
        out.push(`- Items listed by every analyst: ${d.items.consensus.length ? d.items.consensus.map((s) => `**${s}**`).join(", ") : "none"}${d.items.majority.length ? `; by a majority: ${d.items.majority.map((m) => `${m.name} (${m.by.join("")})`).join(", ")}` : ""}.`);
        for (const P of present) if (d.items.only[P]?.length) out.push(`- Only ${L(P)}: ${d.items.only[P].join(", ")}`);
      }
      out.push(`- Position similarity (content words): ${d.similarity.pairwise.map((p) => `${p.a}/${p.b} ${pct(p.value)}`).join(" · ") || "—"}`);
      const agendaN = present.reduce((n, P) => n + (d.agenda[P]?.length || 0), 0);
      out.push(`- The debate's agenda: ${agendaN} claim(s) made by one analyst with no counterpart in another's answer — each is owed a verdict.`);
    } else {
      for (const P of present) out.push(`- ${L(P)}: ${(d.files?.[P]?.names || []).join(", ")} (${d.files?.[P]?.bytes || 0} bytes)`);
      out.push(`- Approach similarity: ${d.similarity.pairwise.map((p) => `${p.a}/${p.b} ${pct(p.value)}`).join(" · ") || "—"}`);
    }
    out.push("");
  }

  // Rounds
  for (const r of rec.rounds) {
    out.push(`## Round ${r.round} — critique and rebuttal`, "");
    for (const P of Object.keys(r.critiques)) {
      const cr = r.critiques[P];
      out.push(`### ${L(P)} — critique${cr.failed ? " (FAILED — counted as an empty critique)" : ""}`, "");
      if (cr.critique.agreements.length) out.push(`Agrees: ${cr.critique.agreements.join("; ")}`, "");
      for (const dv of cr.critique.divergences) out.push(`- vs ${dv.with || "all"} · **${dv.topic}** [${dv.root_cause}] — theirs: ${dv.theirs} · mine: ${dv.mine}${dv.detail ? ` · ${dv.detail}` : ""}`);
      if (cr.critique.verdicts.length) out.push("", `Verdicts: ${cr.critique.verdicts.map((v) => `${v.ref} ${v.verdict.toUpperCase()}`).join(", ")}`);
      if (cr.coverage?.owed?.length) out.push("", `Agenda coverage: ${cr.coverage.answered.length}/${cr.coverage.owed.length}${cr.coverage.missed.length ? ` — ⚠ went unargued: ${cr.coverage.missed.join(", ")}` : ""}`);
      for (const q of cr.critique.questions) out.push(`- ? to ${q.to || "all"}: ${q.question}`);
      out.push("");
    }
    for (const P of Object.keys(r.rebuttals)) {
      const rb = r.rebuttals[P];
      out.push(`### ${L(P)} — rebuttal${rb.failed ? " (FAILED — position kept)" : ""}`, "");
      if (rb.rebuttal) {
        for (const ch of rb.rebuttal.changed_mind) out.push(`- CHANGED: **${ch.topic}** — ${ch.from} → ${ch.to} (because ${ch.because})`);
        for (const s of rb.rebuttal.stand_by) out.push(`- stands by: ${s}`);
        if (rb.applied?.withdrawn?.length) out.push(`- withdrew: ${rb.applied.withdrawn.map((id) => `${P}:${id}`).join(", ")}`);
        for (const nc of rb.applied?.added || []) out.push(`- new claim ${P}:${nc.id} [${nc.basis} ${AUDIT_MARK(nc.audit?.status)} ${nc.audit?.status || ""}] ${nc.text}`);
        if (rb.applied?.revised_files?.length) out.push(`- revised files: ${rb.applied.revised_files.join(", ")}`);
        if (rb.applied?.confidence_before != null && rb.applied?.confidence_after != null && rb.applied.confidence_before !== rb.applied.confidence_after) out.push(`- confidence ${rb.applied.confidence_before} → ${rb.applied.confidence_after}`);
        for (const a of rb.rebuttal.answers) out.push(`- answers${a.to ? ` ${a.to}` : ""}: ${a.answer}`);
      }
      out.push("");
    }
    if (r.moves != null) out.push(`_Round ${r.round}: ${r.moves} change(s) of position._`, "");
  }
  if (rec.auto_stop) out.push(`> Auto-stopped after round ${rec.auto_stop.after_round}: the round changed nobody's mind, and more rounds buy drift, not agreement (${rec.auto_stop.skipped} round(s) not run).`, "");

  // Post-debate
  const f = rec.final;
  if (f && rec.rounds.length) {
    out.push("## Post-debate diff", "");
    out.push(`- **${f.compare.headline}**`);
    if (!files) {
      out.push(`- Claims shared by every analyst: ${f.compare.overlap.sharedBefore} → ${f.compare.overlap.sharedAfter} (${pct(f.compare.overlap.before)} → ${pct(f.compare.overlap.after)} of clusters)`);
      if (f.compare.items) out.push(`- Items every analyst lists: [${f.compare.items.before.join(", ") || "none"}] → [${f.compare.items.after.join(", ") || "none"}]`);
      out.push(`- Position similarity: ${pct(f.compare.similarity.before)} → ${pct(f.compare.similarity.after)}`);
      out.push(`- Grounding rate (mean): ${pct(f.compare.grounding.before)} → ${pct(f.compare.grounding.after)}`);
      if (f.verdicts) out.push(`- Verdicts on claims: ${f.verdicts.counts.shared} shared by all · ${f.verdicts.counts.endorsed} endorsed · ${f.verdicts.counts.contested} contested${f.verdicts.contested.length ? ` (${f.verdicts.contested.join(", ")})` : ""} · ${f.verdicts.counts.unresolved} unresolved · ${f.verdicts.counts.unjudged} never judged`);
    } else out.push(`- Approach similarity: ${pct(f.compare.similarity.before)} → ${pct(f.compare.similarity.after)}`);
    if (f.root_causes.n) out.push(`- Why they disagreed (root causes, counted in code): evidence **${f.root_causes.evidence}** · interpretation **${f.root_causes.interpretation}** · values **${f.root_causes.values}**`);
    out.push(`- Rounds run: ${f.rounds_run} of ${c.rounds}${f.auto_stopped ? " (auto-stopped)" : ""}`);
    if (f.movement.length) out.push(`- Movement per round: ${f.movement.map((m) => `r${m.round}: ${Object.entries(m.by).map(([P, v]) => `${P} ${v.changed + v.withdrawn + v.added + v.revised_files}`).join(", ")}`).join(" · ")}`);
    if (f.towards.length) out.push(`- Moved toward another's starting position: ${f.towards.map((t) => `${t.from} → ${t.toward}`).join(", ")}`);
    else if (f.rounds_run) out.push("- Nobody's final position moved measurably toward another analyst's starting position.");
    if (f.compare.redFlag) out.push("", `> ⚠ **${f.compare.redFlag}**`);
    out.push("");
  }

  // Memo
  if (rec.synthesis) {
    out.push(`## Joint memo — by ${roleLabel(rec, rec.synthesis.by)}`, "");
    if (rec.synthesis.flag === "chain_of_thought") out.push("> **This is not a finished memo.** The writer returned its internal reasoning instead of prose — twice. Read it as working notes; the code-computed sections above are the reliable part of this report.", "");
    out.push(rec.synthesis.memo ? rec.synthesis.memo.replace(/^#\s/m, "### ") : `_No memo — ${rec.synthesis.error}. The code-computed sections above are the product; the memo is prose on top._`, "");
  }

  // Final answers
  const cur = rec.current || {};
  if (present.length) {
    out.push("## Final answers", "");
    for (const P of present) {
      const a = cur[P]; if (!a) continue;
      out.push(`### ${L(P)}${a.confidence != null ? ` — confidence ${a.confidence}` : ""}`, "", a.position, "");
      if (!files) {
        for (const cl of a.claims || []) out.push(`- ${AUDIT_MARK(cl.audit?.status)} \`${P}:${cl.id}\` [${cl.basis}${cl.load_bearing ? ", load-bearing" : ""}] ${cl.text}${cl.audit && !isGrounded(cl.audit.status) && cl.audit.status !== "unverifiable" ? ` — **${cl.audit.status}**: ${cl.audit.detail}` : ""}`);
        if (a.items?.length) out.push("", `Items: ${a.items.map((i) => i.name).join(", ")}`);
        if (a.assumptions?.length) out.push("", `Assumptions: ${a.assumptions.join("; ")}`);
      } else for (const fl of a.files || []) out.push(`- \`${fl.name}\` (${fl.bytes} bytes)`);
      out.push("");
    }
  }

  // Cost
  if (rec.usage?.total?.calls) {
    out.push("## Cost", "", `${costLine(rec)}.`, "", "| who | calls | tokens in | tokens out | cost | price (USD per 1M in / out) | time in calls |", "|---|---|---|---|---|---|---|");
    const priceOf = (id) => {
      const m = c.models.find((x) => x.letter === id);
      const spec = m || [c.expander, c.synthesizer].find((r) => r && r.role === id);
      const p = spec ? c.prices?.[`${spec.provider}|${spec.model}`] : null;
      return p ? `${p.in} / ${p.out}${p.source ? ` (${p.source})` : ""}` : "unknown";
    };
    for (const [id, u] of Object.entries(rec.usage.by)) out.push(`| ${esc(/^[A-F]$/.test(id) ? L(id) : id)} | ${u.calls} | ${fmtTokens(u.input)} | ${fmtTokens(u.output)} | ${u.unknown === u.calls ? "?" : fmtUsd(u.usd)}${u.estimated ? " (est.)" : ""} | ${esc(priceOf(id))} | ${secs(u.ms)} |`);
    const served = [...new Set(rec.outputs.filter((o) => o.served_model).map((o) => `${o.model} → ${o.served_model}`))];
    if (served.length) out.push("", `Served by a different model than requested: ${served.join(", ")}.`);
    out.push("");
  }

  // Appendix
  out.push("---", "", "## Appendix — artifacts, critiques, rebuttals and tool ledgers", "");
  for (const m of c.models) {
    const P = m.letter;
    if (!rec.artifacts[P] && !rec.absent[P]) continue;
    const initial = rec.artifacts[P]?.artifact;
    const strip = (a) => (a && a.files ? { ...a, files: a.files.map((fl) => ({ name: fl.name, bytes: fl.bytes })) } : a);
    out.push(`### ${L(P)}`, "", "```json", JSON.stringify({
      initial: strip(initial) || null,
      final: strip(cur[P]) || null,
      critiques: rec.rounds.map((r) => r.critiques[P] ? { round: r.round, ...r.critiques[P] } : null).filter(Boolean),
      rebuttals: rec.rounds.map((r) => r.rebuttals[P] ? { round: r.round, rebuttal: r.rebuttals[P].rebuttal, applied: r.rebuttals[P].applied } : null).filter(Boolean),
      tool_ledger: (rec.tools[P] || []).map((t) => ({ ref: t.ref, tool: t.name, args: t.args, error: t.error, count: t.count })),
    }, null, 2), "```", "");
  }
  if (rec.retries.length || rec.template_copies.length || rec.failures.length) {
    out.push("### Guards that fired", "");
    for (const r of rec.retries) out.push(`- JSON repair requested from ${r.model} (${r.phase}${r.round ? ` r${r.round}` : ""})${r.truncated ? " — reply was cut off" : ""}`);
    for (const t of rec.template_copies) out.push(`- Template copy from ${t.model} (${t.phase}, ${t.field}${t.rows ? `, ${t.rows} row(s)` : ""}) — dropped`);
    for (const fl of rec.failures) out.push(`- ${fl.model} failed in ${fl.phase}${fl.round ? ` r${fl.round}` : ""}: ${fl.error}`);
    out.push("");
  }
  out.push("### Prompts as sent", "", `${rec.prompts.length} model calls. Every prompt is in the run's event log (\`runs/<id>.jsonl\`, \`type: "prompt"\`) and in the console under each card.`, "");
  return out.join("\n");
}
