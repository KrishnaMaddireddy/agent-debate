// The right column: numbers computed by code from the run's record. Nothing here is written by a
// model; the heading says so, as in Model Bridge.
import { esc } from "./dom.js";
import { pct, rootCauseTally, pairsOf } from "../core/metrics.js";
import { whoPill } from "./feed.js";
import { fmtUsd, fmtTokens } from "../core/cost.js";

const card = (title, src, body) => `<div class="card"><h3>${esc(title)} <span class="src">— ${esc(src)}</span></h3>${body}</div>`;
const bar = (x, color) => `<div class="bar"><i style="width:${Math.round((x || 0) * 100)}%;${color ? `background:${color}` : ""}"></i></div>`;
const labelOf = (rec, L) => rec.config?.models?.find((m) => m.letter === L)?.label || L;
const colorOf = (rec, L) => rec.config?.models?.find((m) => m.letter === L)?.color;

export function renderPanels(rec) {
  if (!rec?.config) return `<div class="card"><h3>Computed here <span class="src">— by code, from the run's events; never written by a model</span></h3><div class="faint">Panels appear as the run produces answers.</div></div>`;
  const out = [];
  const models = rec.config.models;
  const files = rec.config.deliverable === "files";
  const present = rec.gate?.present || Object.keys(rec.artifacts);

  // Participation
  out.push(card("Participation", "a model that produced nothing is absent, not in disagreement", models.map((m) => {
    const L = m.letter;
    const st = rec.absent[L] ? `<span class="bad">absent</span> <span class="faint">${esc(rec.absent[L])}</span>` : rec.artifacts[L] ? `<span class="ok">answered</span>` : rec.status === "running" ? `<span class="faint">working…</span>` : rec.stopped_reason === "spending cap" ? `<span class="warn">not run — spending cap</span>` : rec.stopped_in ? `<span class="faint">not run — stopped</span>` : `<span class="faint">—</span>`;
    const fails = rec.failures.filter((f) => f.model === L && f.phase !== "answer");
    return `<div class="prow">${whoPill(rec, L)}<div><div class="plabel" title="${esc(m.label)}">${esc(m.label)}</div><div style="font-size:11.5px">${st}${fails.length ? ` <span class="warn" title="${esc(fails.map((f) => `${f.phase}: ${f.error}`).join("\n"))}">· ${fails.length} later phase${fails.length === 1 ? "" : "s"} failed</span>` : ""}</div></div></div>`;
  }).join("")));
  // Cost
  const u = rec.usage;
  if (u?.total?.calls) {
    const cap = rec.config.spend_cap;
    const t = u.total;
    const rows = Object.entries(u.by).map(([id, x]) => `<div class="kv"><span>${/^[A-F]$/.test(id) ? whoPill(rec, id) : esc(id)} <span class="faint">${x.calls} call${x.calls === 1 ? "" : "s"}</span></span><span>${x.unknown === x.calls ? "?" : fmtUsd(x.usd)} <span class="faint">${fmtTokens(x.input)} in · ${fmtTokens(x.output)} out${x.estimated ? " · est." : ""}</span></span></div>`).join("");
    out.push(card("Cost", "provider-reported tokens × the price used for the run", `
      <div class="big" style="margin-bottom:4px">${t.unknown === t.calls ? "cost unknown" : fmtUsd(t.usd)}${t.unknown && t.unknown < t.calls ? ` <span class="faint" style="font-size:12px">+ ${t.unknown} unpriced call${t.unknown === 1 ? "" : "s"}</span>` : ""}</div>
      ${cap != null ? `<div class="kv"><span>spending cap</span><span>${fmtUsd(cap)}</span></div>${bar(Math.min(1, t.usd / cap), t.usd / cap > 0.8 ? "var(--warn)" : null)}` : ""}
      ${rows}
      <div class="faint" style="font-size:11px;margin-top:4px">${fmtTokens(t.input)} tokens in · ${fmtTokens(t.output)} out${t.estimated ? ` · ${t.estimated} call${t.estimated === 1 ? "" : "s"} estimated from length` : ""}. Subscription and mock calls cost $0 per token.</div>
      ${rec.budget_stop ? `<div class="flag">stopped by the cap before ${esc(rec.budget_stop.model)} ${esc(rec.budget_stop.phase)}</div>` : ""}`));
  }

  if (!rec.diff) return out.join("");

  // Grounding
  if (!files) {
    const d = rec.diff, f = rec.final?.snapshot;
    const noDocs = !rec.config.docs?.length && !rec.config.tools?.length;
    out.push(card("Grounding", "claims whose quote, arithmetic or tool citation code verified", present.map((L) => {
      const g0 = d.grounding[L] || {}, g1 = f?.grounding?.[L];
      const g = g1 || g0;
      const flagged = (rec.current[L]?.claims || []).filter((c) => c.audit && !/^verified/.test(c.audit.status) && c.audit.status !== "unverifiable");
      return `<div style="margin:6px 0">${whoPill(rec, L)} <b>${pct(g.rate)}</b> <span class="faint">${g.verified}/${g.total} claims${g1 && g0.rate !== g1.rate ? ` · was ${pct(g0.rate)}` : ""}</span>${bar(g.rate, colorOf(rec, L))}
        ${flagged.map((c) => `<div class="flag" style="margin:2px 0">${esc(L)}:${esc(c.id)} ${esc(c.audit.status.replace(/_/g, " "))}</div>`).join("")}
        ${(g.ungroundedLoadBearing || []).length ? `<div class="faint" style="font-size:11px">ungrounded load-bearing: ${esc(g.ungroundedLoadBearing.map((id) => `${L}:${id}`).join(", "))}</div>` : ""}</div>`;
    }).join("") + (noDocs ? `<div class="note">No documents and no tools: quotes cannot be grounded, so a low rate here is by construction — not a verdict on the models.</div>` : "")));
  }

  // Agreement
  const c = rec.final?.compare;
  if (files) {
    const s0 = rec.diff.similarity.avg, s1 = rec.final?.snapshot?.similarity?.avg;
    out.push(card("Agreement", "content-word overlap of the approach paragraphs", `<div class="kv"><span>approach similarity</span><span>${pct(s0)}${s1 != null && rec.rounds.length ? ` → <b>${pct(s1)}</b>` : ""}</span></div>
      ${present.map((L) => `<div class="kv"><span>${whoPill(rec, L)} files</span><span>${esc((rec.current[L]?.files || []).map((x) => x.name).join(", "))}</span></div>`).join("")}`));
  } else {
    const d = rec.diff, f = rec.final;
    const after = f?.snapshot;
    const rows = [
      ["claims everyone made", `${d.overlap.shared}/${d.overlap.total} (${pct(d.overlap.ratio)})`, after && rec.rounds.length ? `${after.overlap.shared}/${after.overlap.total} (${pct(after.overlap.ratio)})` : null],
      ["position similarity", pct(d.similarity.avg), after && rec.rounds.length ? pct(after.similarity.avg) : null],
    ];
    if (d.items || after?.items) rows.push(["items everyone listed", String(d.items?.consensus.length ?? 0), after && rec.rounds.length ? String(after.items?.consensus.length ?? 0) : null]);
    out.push(card("Agreement", "clustered in code; before → after the debate", `
      ${c ? `<div class="big" style="margin-bottom:6px">${esc(c.headline)}</div>` : ""}
      ${rows.map(([k, b, a]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(b)}${a != null ? ` → <b>${esc(a)}</b>` : ""}</span></div>`).join("")}
      ${f?.verdicts ? `<div class="kv"><span>verdicts on claims</span><span><span class="ok">${f.verdicts.counts.shared + f.verdicts.counts.endorsed} agreed</span> · <span class="bad">${f.verdicts.counts.contested} contested</span> · <span class="warn">${f.verdicts.counts.unresolved} unresolved</span></span></div>` : ""}
      ${f?.verdicts?.contested?.length ? `<div class="faint" style="font-size:11px;margin-top:3px">contested: ${esc(f.verdicts.contested.join(", "))}</div>` : ""}
      ${d.items ? `<div style="margin-top:6px"><span class="muted">everyone:</span> ${(after?.items || d.items).consensus.map((s) => `<span class="pill">${esc(s)}</span>`).join(" ") || `<span class="faint">none</span>`}</div>
        ${present.map((L) => ((after?.items || d.items).only[L] || []).length ? `<div style="margin-top:3px">${whoPill(rec, L)} only: ${(after?.items || d.items).only[L].map((s) => `<span class="pill">${esc(s)}</span>`).join(" ")}</div>` : "").join("")}` : ""}
      ${c?.redFlag ? `<div class="flag">⚠ ${esc(c.redFlag)}</div>` : ""}`));

    // Pairwise
    if (present.length >= 2) {
      const snap = after && rec.rounds.length ? after : d;
      const cell = (a, b) => { if (a === b) return `<td class="faint">—</td>`; const p = snap.overlap.pairwise.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a)); return `<td>${pct(p?.overlap)}</td>`; };
      out.push(card("Pairwise claim overlap", after && rec.rounds.length ? "after the debate" : "independent answers", `<table class="mx"><tr><th></th>${present.map((L) => `<th>${whoPill(rec, L)}</th>`).join("")}</tr>${present.map((a) => `<tr><th>${whoPill(rec, a)}</th>${present.map((b) => cell(a, b)).join("")}</tr>`).join("")}</table>`));
    }
  }

  // Root causes (live, from the critiques so far)
  const crits = rec.rounds.flatMap((r) => Object.entries(r.critiques).map(([model, x]) => ({ model, critique: x.critique })));
  if (crits.length) {
    const rc = rootCauseTally(crits);
    const max = Math.max(1, rc.evidence, rc.interpretation, rc.values);
    const advice = !rc.n ? "No divergences were raised." : rc.top === "evidence" ? "Mostly EVIDENCE — they rely on different facts. Attach the source that would settle it, or give them a tool that can." : rc.top === "interpretation" ? "Mostly INTERPRETATION — same facts, different inference. Look at the reasoning, not the sources." : "Mostly VALUES — they agree on the facts and weigh them differently. A judging lens would make the weights explicit.";
    out.push(card("Why they disagreed", "root causes of the divergences, counted in code", ["evidence", "interpretation", "values"].map((k) => `<div class="hbar"><span class="rc ${k}" style="justify-self:start">${k}</span>${bar(rc[k] / max)}<span>${rc[k]}</span></div>`).join("") + `<div class="faint" style="font-size:11.5px;margin-top:5px">${esc(advice)}</div>`));
  }

  // Agenda coverage
  if (!files && crits.length) {
    out.push(card("Agenda coverage", "every claim without a counterpart is owed a verdict", rec.rounds.map((r) => Object.entries(r.critiques).map(([L, x]) => x.coverage?.owed?.length ? `<div class="kv"><span>r${r.round} ${whoPill(rec, L)}</span><span>${x.coverage.answered.length}/${x.coverage.owed.length}${x.coverage.missed.length ? ` <span class="warn">· ${x.coverage.missed.length} unargued</span>` : ` <span class="ok">✓</span>`}</span></div>` : "").join("")).join("") || `<div class="faint">No agenda — every claim had a counterpart.</div>`));
  }

  // Movement
  const rebs = rec.rounds.filter((r) => Object.keys(r.rebuttals).length);
  if (rebs.length) {
    const any = rebs.some((r) => (r.moves || 0) > 0);
    out.push(card("Movement", "changed minds, withdrawn and added claims, per round", rebs.map((r) => `<div class="kv"><span>round ${r.round}</span><span>${Object.entries(r.rebuttals).map(([L, x]) => { const n = (x.rebuttal?.changed_mind.length || 0) + (x.applied?.withdrawn?.length || 0) + (x.applied?.added?.length || 0) + (x.applied?.revised_files?.length || 0); return `${whoPill(rec, L)} ${n}`; }).join(" ")}</span></div>`).join("")
      + (rec.final?.towards?.length ? `<div style="margin-top:5px">${rec.final.towards.map((t) => `${whoPill(rec, t.from)} moved toward ${whoPill(rec, t.toward)}'s starting position`).join("<br>")}</div>` : "")
      + (rec.auto_stop ? `<div class="faint" style="margin-top:4px">auto-stopped after round ${rec.auto_stop.after_round}</div>` : "")
      + (!any && rec.status !== "running" ? `<div class="note">Nobody changed their mind — monologues, not a debate. The disagreement is real, or the question needs evidence none of them has.</div>` : "")));
  }

  // Guards
  const guards = rec.retries.length + rec.template_copies.length + rec.failures.length;
  if (guards) {
    out.push(card("Guards that fired", "the harness catching a model, not the model failing silently", [
      ...rec.retries.map((r) => `<div>${whoPill(rec, r.model)} JSON repair · ${esc(r.phase)}${r.round ? ` r${r.round}` : ""}${r.truncated ? " · was cut off" : ""}</div>`),
      ...rec.template_copies.map((t) => `<div>${whoPill(rec, t.model)} template copy dropped · ${esc(t.phase)}</div>`),
      ...rec.failures.map((f) => `<div>${/^[A-F]$/.test(f.model) ? whoPill(rec, f.model) : esc(f.model)} failed · ${esc(f.phase)}${f.round ? ` r${f.round}` : ""} <span class="faint">${esc(String(f.error).slice(0, 140))}</span></div>`),
    ].join("")));
  }
  return out.join("");
}

export { pairsOf };
