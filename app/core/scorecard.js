// The model scorecard: how each model has behaved across your runs, computed by code from the saved
// run records. No model grades another here — every number is a count of something that happened.
// Browser-safe (the claude.ai page computes it from the runs it keeps).

import { isGrounded } from "./audit.js";

const FINDINGS = ["fabricated_quote", "miscomputed", "unsourced_operands", "tool_mismatch", "missing_tool_result", "failed_tool"];

const blank = (key, m) => ({
  key, provider: m.provider, model: m.model, label: m.label,
  seats: 0, runs: new Set(), answered: 0, absent: 0, absentReasons: {},
  claims: 0, checkableClaims: 0, grounded: 0, loadBearing: 0, loadBearingUngrounded: 0,
  findings: Object.fromEntries(FINDINGS.map((f) => [f, 0])),
  peer: { accept: 0, reject: 0, unresolved: 0 },
  gave: { accept: 0, reject: 0, unresolved: 0 }, owed: 0, answeredAgenda: 0,
  rebuttals: 0, moved: 0, changed: 0, withdrawn: 0, added: 0,
  divergences: { evidence: 0, interpretation: 0, values: 0 },
  repairs: 0, templateCopies: 0, laterFailures: 0, truncated: 0,
  memos: 0, memoChainOfThought: 0,
  calls: 0, ms: 0, usd: 0, pricedRuns: 0, tokensIn: 0, tokensOut: 0,
  confidence: [],
});

/** records: reduced run records (the saved <id>.json). Returns { rows, runs, skipped }. */
export function scorecard(records, { includeMock = false } = {}) {
  const rows = new Map();
  let used = 0, skipped = 0;
  for (const rec of records) {
    const c = rec?.config;
    if (!c?.models?.length || rec.status === "running") { skipped++; continue; }
    used++;
    const runId = rec.id || `${rec.started}`;
    const checkable = Boolean(c.docs?.length || c.tools?.length);
    for (const m of c.models) {
      if (!includeMock && m.provider === "mock") continue;
      const L = m.letter;
      // A seat counts only if phase 1 finished for it: a run stopped (by you or the spending cap)
      // before a model answered says nothing about that model.
      if (!rec.artifacts?.[L] && !rec.absent?.[L]) continue;
      const key = `${m.provider}/${m.model}`;
      const r = rows.get(key) || blank(key, m);
      rows.set(key, r);
      r.seats++; r.runs.add(runId);
      if (rec.absent?.[L]) { r.absent++; const why = String(rec.absent[L]).split(/[:—(]/)[0].trim().slice(0, 60); r.absentReasons[why] = (r.absentReasons[why] || 0) + 1; }
      const art = rec.artifacts?.[L]?.artifact;
      if (art) {
        r.answered++;
        if (art.confidence != null) r.confidence.push(art.confidence);
        for (const cl of art.claims || []) {
          r.claims++;
          const st = cl.audit?.status;
          if (checkable) { r.checkableClaims++; if (isGrounded(st)) r.grounded++; }
          if (FINDINGS.includes(st)) r.findings[st]++;
          if (cl.load_bearing) { r.loadBearing++; if (!isGrounded(st)) r.loadBearingUngrounded++; }
        }
      }
      // Verdicts: the latest each critic gave on each claim, across rounds.
      const latest = new Map();
      for (const round of rec.rounds || []) for (const [critic, cr] of Object.entries(round.critiques || {})) {
        for (const v of cr.critique?.verdicts || []) latest.set(`${critic}|${v.ref}`, v.verdict);
        if (critic === L) { r.owed += cr.coverage?.owed?.length || 0; r.answeredAgenda += cr.coverage?.answered?.length || 0; for (const d of cr.critique?.divergences || []) if (r.divergences[d.root_cause] != null) r.divergences[d.root_cause]++; }
      }
      for (const [k, verdict] of latest) {
        const [critic, ref] = k.split("|");
        if (ref.startsWith(`${L}:`) && critic !== L && r.peer[verdict] != null) r.peer[verdict]++;
        if (critic === L && !ref.startsWith(`${L}:`) && r.gave[verdict] != null) r.gave[verdict]++;
      }
      for (const round of rec.rounds || []) {
        const rb = round.rebuttals?.[L];
        if (!rb) continue;
        r.rebuttals++;
        const ch = rb.rebuttal?.changed_mind?.length || 0, wd = rb.applied?.withdrawn?.length || 0, ad = rb.applied?.added?.length || 0;
        r.changed += ch; r.withdrawn += wd; r.added += ad;
        if (ch + wd + ad + (rb.applied?.revised_files?.length || 0) > 0) r.moved++;
      }
      r.repairs += (rec.retries || []).filter((x) => x.model === L).length;
      r.templateCopies += (rec.template_copies || []).filter((x) => x.model === L).length;
      r.laterFailures += (rec.failures || []).filter((x) => x.model === L && x.phase !== "answer").length;
      r.truncated += (rec.outputs || []).filter((o) => o.model === L && o.truncated).length;
      if (rec.synthesis?.by?.letter === L) { r.memos++; if (rec.synthesis.flag === "chain_of_thought") r.memoChainOfThought++; }
      const u = rec.usage?.by?.[L];
      if (u) {
        r.calls += u.calls; r.ms += u.ms; r.tokensIn += u.input; r.tokensOut += u.output;
        if (u.unknown < u.calls) { r.usd += u.usd; r.pricedRuns++; }
      }
    }
  }
  const out = [...rows.values()].map((r) => {
    const ratio = (a, b) => (b ? a / b : null);
    const judged = r.peer.accept + r.peer.reject + r.peer.unresolved;
    return {
      key: r.key, provider: r.provider, model: r.model, label: r.label,
      runs: r.runs.size, seats: r.seats, answered: r.answered, absent: r.absent, absentReasons: r.absentReasons,
      participation: ratio(r.answered, r.seats),
      claims: r.claims, claimsPerAnswer: ratio(r.claims, r.answered),
      grounding: ratio(r.grounded, r.checkableClaims), checkableClaims: r.checkableClaims,
      findings: r.findings, findingRate: ratio(Object.values(r.findings).reduce((a, b) => a + b, 0), r.claims),
      loadBearingUngrounded: r.loadBearingUngrounded, loadBearing: r.loadBearing,
      peerAccept: ratio(r.peer.accept, judged), peerReject: ratio(r.peer.reject, judged), peerJudged: judged, peer: r.peer,
      gave: r.gave, agendaCoverage: ratio(r.answeredAgenda, r.owed), owed: r.owed,
      movedRate: ratio(r.moved, r.rebuttals), rebuttals: r.rebuttals, changed: r.changed, withdrawn: r.withdrawn, added: r.added,
      divergences: r.divergences,
      repairs: r.repairs, templateCopies: r.templateCopies, laterFailures: r.laterFailures, truncated: r.truncated,
      memos: r.memos, memoChainOfThought: r.memoChainOfThought,
      avgConfidence: r.confidence.length ? Math.round(r.confidence.reduce((a, b) => a + b, 0) / r.confidence.length) : null,
      usdPerAnswer: r.pricedRuns ? r.usd / r.pricedRuns : null, usd: r.usd,
      secondsPerCall: r.calls ? r.ms / r.calls / 1000 : null, calls: r.calls, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      fewRuns: r.runs.size < 5,
    };
  }).sort((a, b) => b.seats - a.seats || a.key.localeCompare(b.key));
  return { rows: out, runs: used, skipped };
}

/** The scorecard as a markdown table, for the CLI and for docs. */
export function scorecardMarkdown(card) {
  const p = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const lines = [
    `# Model scorecard — ${card.runs} run${card.runs === 1 ? "" : "s"}`,
    "",
    "Counted by code from saved runs; no model graded another. *Grounded* counts only runs with documents or tools, where a claim can be checked. *Accepted / rejected by peers* is the latest verdict each other analyst gave on this model's claims. *Moved* is the share of its rebuttals that changed, withdrew or added something.",
    "",
    "| model | seats | answered | grounded | audit findings | accepted by peers | rejected by peers | moved | JSON repairs | $ per answer | s per call |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...card.rows.map((r) => `| ${r.label}${r.fewRuns ? " *" : ""} | ${r.seats} | ${p(r.participation)} | ${p(r.grounding)} | ${Object.values(r.findings).reduce((a, b) => a + b, 0)} of ${r.claims} | ${p(r.peerAccept)} | ${p(r.peerReject)} | ${p(r.movedRate)} | ${r.repairs} | ${r.usdPerAnswer == null ? "—" : `$${r.usdPerAnswer.toFixed(4)}`} | ${r.secondsPerCall == null ? "—" : r.secondsPerCall.toFixed(1)} |`),
    "",
    card.rows.some((r) => r.fewRuns) ? "\\* fewer than 5 runs — read as anecdote, not a rate." : "",
  ];
  return lines.join("\n");
}
