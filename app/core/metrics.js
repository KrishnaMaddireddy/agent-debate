// Code-computed facts (PRD §7 "Code, between phases" and "Code, post-debate"). Never asks a model;
// never lets a model grade itself. Browser-safe.

import { contentTokens, jaccard, itemKey, opposed } from "./text.js";
import { groundingOf } from "./audit.js";

// Two claims from different analysts are "the same claim" when their content tokens overlap by at
// least this much, and — when both state numbers — they share one. Start conservative (PRD §16):
// a missed match costs an agenda row; a false match silently hides a disagreement.
export const CLAIM_MATCH = 0.5;
export const MOVE_EPSILON = 0.05;

const numTokens = (set) => [...set].filter((t) => t.startsWith("#"));

export function claimsMatch(a, b) {
  if (jaccard(a, b) < CLAIM_MATCH) return false;
  // Numbers must agree: every number of the claim that states fewer appears in the other. Sharing
  // a year is not agreement when one says 12 percent and the other 30.
  const na = numTokens(a), nb = numTokens(b);
  if (!na.length || !nb.length) return true;
  const [small, big] = na.length <= nb.length ? [na, nb] : [nb, na];
  return small.every((x) => big.includes(x));
}

/** Cluster claims across analysts (union-find; only claims of different analysts are joined). */
export function clusterClaims(letters, artifacts) {
  const nodes = [];
  for (const L of letters) for (const c of artifacts[L]?.claims || []) nodes.push({ ref: `${L}:${c.id}`, letter: L, text: c.text, sig: contentTokens(c.text) });
  // Opposites never join, even through a third claim: a cluster is checked as a whole before a merge.
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].letter === nodes[j].letter) continue;
      if (!claimsMatch(nodes[i].sig, nodes[j].sig) || opposed(nodes[i].text, nodes[j].text)) continue;
      const ri = find(i), rj = find(j);
      if (ri === rj) continue;
      const a = nodes.filter((_, k) => find(k) === ri), b = nodes.filter((_, k) => find(k) === rj);
      if (a.some((x) => b.some((y) => x.letter === y.letter || opposed(x.text, y.text)))) continue;
      parent[ri] = rj;
    }
  }
  const groups = new Map();
  nodes.forEach((n, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); });
  let k = 0;
  return [...groups.values()].map((ms) => {
    const ls = [...new Set(ms.map((m) => m.letter))].sort();
    return { id: `k${++k}`, members: ms.map((m) => m.ref), letters: ls, text: ms[0].text, shared: letters.length > 1 && ls.length === letters.length };
  });
}

export function pairsOf(letters) {
  const out = [];
  for (let i = 0; i < letters.length; i++) for (let j = i + 1; j < letters.length; j++) out.push([letters[i], letters[j]]);
  return out;
}

export function positionSimilarity(a, b) {
  return jaccard(contentTokens(a || ""), contentTokens(b || ""));
}

function itemsSnapshot(letters, artifacts) {
  const sets = {};
  let any = false;
  for (const L of letters) {
    const names = (artifacts[L]?.items || []).map((i) => (typeof i === "string" ? i : i?.name)).filter(Boolean);
    if (names.length) any = true;
    const m = new Map();
    for (const n of names) if (!m.has(itemKey(n))) m.set(itemKey(n), n);
    sets[L] = m;
  }
  if (!any) return null;
  const votes = new Map();
  for (const L of letters) for (const [k, n] of sets[L]) { if (!votes.has(k)) votes.set(k, { name: n, by: [] }); votes.get(k).by.push(L); }
  const all = [...votes.values()];
  const N = letters.length;
  const only = {};
  for (const L of letters) only[L] = all.filter((v) => v.by.length === 1 && v.by[0] === L).map((v) => v.name);
  const pairwise = pairsOf(letters).map(([a, b]) => {
    const A = new Set(sets[a].keys()), B = new Set(sets[b].keys());
    return { a, b, overlap: jaccard(A, B) };
  });
  const consensus = all.filter((v) => v.by.length === N).map((v) => v.name);
  return {
    consensus,
    majority: N > 2 ? all.filter((v) => v.by.length > N / 2 && v.by.length < N).map((v) => ({ name: v.name, by: v.by })) : [],
    only,
    pairwise,
    union: all.length,
    rate: all.length ? consensus.length / all.length : 0,
    counts: Object.fromEntries(letters.map((L) => [L, sets[L].size])),
  };
}

/** Everything code can say about a set of answers at one moment. */
export function snapshot(letters, artifacts, { files = false } = {}) {
  const similarity = pairsOf(letters).map(([a, b]) => ({ a, b, value: positionSimilarity(artifacts[a]?.position, artifacts[b]?.position) }));
  const simAvg = similarity.length ? similarity.reduce((n, p) => n + p.value, 0) / similarity.length : null;
  const base = {
    present: [...letters],
    similarity: { avg: simAvg, pairwise: similarity },
    confidence: Object.fromEntries(letters.map((L) => [L, artifacts[L]?.confidence ?? null])),
  };
  if (files) {
    base.files = Object.fromEntries(letters.map((L) => [L, { count: (artifacts[L]?.files || []).length, bytes: (artifacts[L]?.files || []).reduce((n, f) => n + (f.bytes || 0), 0), names: (artifacts[L]?.files || []).map((f) => f.name) }]));
    return base;
  }
  const clusters = clusterClaims(letters, artifacts);
  const shared = clusters.filter((c) => c.shared);
  const pairwise = pairsOf(letters).map(([a, b]) => {
    const either = clusters.filter((c) => c.letters.includes(a) || c.letters.includes(b));
    const both = either.filter((c) => c.letters.includes(a) && c.letters.includes(b));
    return { a, b, overlap: either.length ? both.length / either.length : 0, shared: both.length };
  });
  const agenda = {};
  for (const L of letters) {
    agenda[L] = clusters.filter((c) => !c.letters.includes(L)).flatMap((c) => c.members);
  }
  return {
    ...base,
    clusters,
    overlap: { shared: shared.length, total: clusters.length, ratio: clusters.length ? shared.length / clusters.length : 0, pairwise },
    agenda,
    items: itemsSnapshot(letters, artifacts),
    grounding: Object.fromEntries(letters.map((L) => [L, groundingOf(artifacts[L]?.claims || [])])),
  };
}

/** Normalise a claim reference the way critics write it: "B:c2", "b c2", "B-c2", "B.c2", "(B) c2". */
export function normRef(s, letters) {
  const str = String(s ?? "").trim();
  // Exact forms: "B:c2", "B c2", "(B) c2", "b.c2". Live models also copy the agenda row whole —
  // "B:c4 — Denver had 800 waitlist sign-ups" — so a reference at the start of longer text counts too.
  const m = str.match(/^\(?([A-Fa-f])\)?\s*[:.\-/ ]?\s*(c\d+)$/) || str.match(/^\(?([A-Fa-f])\)?\s*[:.]\s*(c\d+)\b/);
  if (!m) return null;
  const L = m[1].toUpperCase();
  return letters.includes(L) ? `${L}:${m[2].toLowerCase()}` : null;
}

/** Latest verdict per (critic, claim) across rounds → per-claim tally and status. */
export function verdictTally(critiqueEvents, letters, artifacts, clusters = []) {
  const sharedRefs = new Set(clusters.filter((c) => c.shared).flatMap((c) => c.members));
  const latest = new Map();
  for (const ev of critiqueEvents) {
    for (const v of ev.critique?.verdicts || []) {
      if (!v.ref || v.ref.startsWith(`${ev.model}:`)) continue;
      latest.set(`${ev.model}|${v.ref}`, v.verdict);
    }
  }
  const byClaim = {};
  for (const [key, verdict] of latest) {
    const [critic, ref] = key.split("|");
    (byClaim[ref] ||= { accept: [], reject: [], unresolved: [] })[verdict]?.push(critic);
  }
  const refs = letters.flatMap((L) => (artifacts[L]?.claims || []).map((c) => `${L}:${c.id}`));
  const status = { shared: [], endorsed: [], contested: [], unresolved: [], unjudged: [] };
  for (const ref of refs) {
    const t = byClaim[ref];
    if (!t) (sharedRefs.has(ref) ? status.shared : status.unjudged).push(ref);
    else if (t.reject.length) status.contested.push(ref);
    else if (t.accept.length) status.endorsed.push(ref);
    else status.unresolved.push(ref);
  }
  return { byClaim, ...Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v])), counts: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v.length])) };
}

/** Root-cause tally of every divergence in every critique — counted in code (Model Bridge left it to the memo). */
export function rootCauseTally(critiqueEvents) {
  const total = { evidence: 0, interpretation: 0, values: 0 };
  const byPair = {};
  for (const ev of critiqueEvents) {
    for (const d of ev.critique?.divergences || []) {
      if (!(d.root_cause in total)) continue;
      total[d.root_cause]++;
      const key = [ev.model, d.with].filter(Boolean).sort().join("–");
      (byPair[key] ||= { evidence: 0, interpretation: 0, values: 0 })[d.root_cause]++;
    }
  }
  const n = total.evidence + total.interpretation + total.values;
  const top = n ? Object.entries(total).sort((a, b) => b[1] - a[1])[0][0] : null;
  return { ...total, n, top, byPair };
}

/** Per round, per analyst: what changed. */
export function movementLog(rebuttalEvents) {
  const rounds = {};
  for (const ev of rebuttalEvents) {
    const r = (rounds[ev.round] ||= {});
    r[ev.model] = {
      changed: (ev.rebuttal?.changed_mind || []).length,
      withdrawn: (ev.applied?.withdrawn || []).length,
      added: (ev.applied?.added || []).length,
      revised_files: (ev.applied?.revised_files || []).length,
      confidence: [ev.applied?.confidence_before ?? null, ev.applied?.confidence_after ?? null],
      position_changed: Boolean(ev.applied?.position_changed),
    };
  }
  return Object.entries(rounds).map(([round, by]) => ({ round: Number(round), by, total: Object.values(by).reduce((n, x) => n + x.changed + x.withdrawn + x.added + x.revised_files, 0) }));
}

/** Who moved toward whom: A's final position is closer to B's initial one than A's initial was. */
export function towards(letters, initial, final) {
  const out = [];
  for (const a of letters) for (const b of letters) {
    if (a === b) continue;
    const before = positionSimilarity(initial[a]?.position, initial[b]?.position);
    const after = positionSimilarity(final[a]?.position, initial[b]?.position);
    if (after - before >= MOVE_EPSILON) out.push({ from: a, toward: b, before, after });
  }
  return out;
}

const avgOf = (xs) => { const v = xs.filter((x) => typeof x === "number"); return v.length ? v.reduce((n, x) => n + x, 0) / v.length : null; };

/** The post-debate comparison: before → after, and the red flag (PRD §15). */
export function compareSnapshots(before, after, { files = false } = {}) {
  const d = (x, y) => (x == null || y == null ? null : y - x);
  const out = {
    similarity: { before: before.similarity.avg, after: after.similarity.avg, delta: d(before.similarity.avg, after.similarity.avg) },
  };
  if (files) { out.agreement = out.similarity; out.headline = headlineFor(out.similarity.delta, "position similarity"); return out; }
  out.overlap = { before: before.overlap.ratio, after: after.overlap.ratio, delta: d(before.overlap.ratio, after.overlap.ratio), sharedBefore: before.overlap.shared, sharedAfter: after.overlap.shared };
  if (before.items || after.items) out.items = { before: before.items?.consensus || [], after: after.items?.consensus || [], delta: (after.items?.consensus.length || 0) - (before.items?.consensus.length || 0) };
  const gB = avgOf(before.present.map((L) => before.grounding[L]?.rate)), gA = avgOf(after.present.map((L) => after.grounding[L]?.rate));
  out.grounding = { before: gB, after: gA, delta: d(gB, gA) };
  const agreeDelta = out.items ? (out.items.delta > 0 ? 1 : out.items.delta < 0 ? -1 : 0) * Math.max(MOVE_EPSILON, Math.abs(out.overlap.delta || 0)) : out.overlap.delta;
  out.headline = out.items ? headlineFor(out.items.delta ? Math.sign(out.items.delta) : 0, "items agreed by everyone", out.items.delta) : headlineFor(out.overlap.delta, "shared claims");
  out.redFlag = (agreeDelta ?? 0) >= MOVE_EPSILON && (out.grounding.delta ?? 0) <= -MOVE_EPSILON
    ? "Agreement rose while grounding fell: the analysts converged on claims that are less supported than the ones they started with. Treat the consensus with suspicion."
    : null;
  return out;
}

function headlineFor(delta, what, count) {
  if (delta == null) return "not measurable";
  if (count != null) return count > 0 ? `agreement ROSE: ${count} more ${what}` : count < 0 ? `agreement FELL: ${-count} fewer ${what}` : `agreement did not move (${what})`;
  if (delta >= MOVE_EPSILON) return `agreement ROSE (${what} +${Math.round(delta * 100)} pts)`;
  if (delta <= -MOVE_EPSILON) return `agreement FELL (${what} ${Math.round(delta * 100)} pts)`;
  return `agreement did not move (${what})`;
}

export const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
