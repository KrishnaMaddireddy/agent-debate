// The grounding audit (PRD §4) — the general-purpose replacement for Model Bridge's echo line.
// Every claim declares a basis; code checks the basis against the documents, the calculator and the
// model's own tool ledger. Nothing here asks a model anything. Browser-safe.

import { safeCalc } from "./calc.js";
import { normText, numbersIn, numbersAndWordsIn, numberMatches } from "./text.js";

export const QUOTE_MIN_CHARS = 20;
const SMALL_CONSTANTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 24, 30, 52, 60, 100, 360, 365, 1000, 1e6, 1e9];

/** Everything a run's audit needs, prepared once: normalised documents and the numbers they state. */
export function auditContext({ docs = [], question = "" } = {}) {
  return {
    docs: docs.map((d) => ({ id: d.id, raw: String(d.text || ""), norm: normText(d.text) })),
    question: String(question || ""),
    baseNumbers: numbersIn([question, ...docs.map((d) => d.text)].join("\n")),
  };
}

export function isGrounded(status) { return typeof status === "string" && status.startsWith("verified"); }

/** ledger: this model's tool results, [{ref, tool, args, text, error}]. */
export function auditClaim(claim, ctx, ledger = []) {
  const basis = claim.basis;
  const ev = String(claim.evidence ?? "").trim();
  if (basis === "quote") return auditQuote(claim, ev, ctx);
  if (basis === "arithmetic") return auditArithmetic(claim, ev, ctx, ledger);
  if (basis === "tool") return auditTool(claim, ev, ledger);
  return { status: "unverifiable", detail: basis === "knowledge" ? "background knowledge — not checked" : "the analyst's own inference — not checked" };
}

function auditQuote(claim, ev, ctx) {
  const quote = ev.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (!ctx.docs.length) return { status: "no_documents", detail: "a quote needs an attached document, and none was attached" };
  // A short quote is checkable when it carries a number ("Denver 800"): the figure is the point.
  if (quote.length < QUOTE_MIN_CHARS && !(quote.length >= 8 && /\d/.test(quote))) return { status: "too_short", detail: `a quote needs at least ${QUOTE_MIN_CHARS} characters to be checkable` };
  const wanted = claim.source ? ctx.docs.filter((d) => d.id === String(claim.source).toUpperCase()) : [];
  const order = [...wanted, ...ctx.docs.filter((d) => !wanted.includes(d))];
  for (const d of order) if (d.raw.includes(quote)) return { status: "verified", doc: d.id, detail: auditNote(claim, d) };
  const nq = normText(quote);
  for (const d of order) if (d.norm.includes(nq)) return { status: "verified_normalised", doc: d.id, detail: `matches after normalising spacing, quotes and case${auditNote(claim, d) ? `; ${auditNote(claim, d)}` : ""}` };
  const parts = nq.split(/\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*/).map((p) => p.trim()).filter((p) => p.length >= 8);
  if (parts.length > 1 && parts.join("").length >= QUOTE_MIN_CHARS) {
    for (const d of order) {
      let at = 0, ok = true;
      for (const p of parts) { const i = d.norm.indexOf(p, at); if (i < 0) { ok = false; break; } at = i + p.length; }
      if (ok) return { status: "verified_elided", doc: d.id, detail: `${parts.length} fragments found in order` };
    }
  }
  return { status: "fabricated_quote", detail: "the quoted passage does not appear in any attached document" };
}

function auditNote(claim, d) {
  return claim.source && String(claim.source).toUpperCase() !== d.id ? `found in ${d.id}, not ${claim.source}` : "";
}

function auditArithmetic(claim, ev, ctx, ledger) {
  if (!ev) return { status: "unparseable", detail: "no expression given" };
  // One evidence line may hold several computations: "1200 - 800; 1200 - 300" — each is checked.
  const parts = ev.split(/\s*(?:;|\n)\s*/).map((x) => x.trim()).filter(Boolean);
  const values = [], exprs = [];
  for (const part of parts) {
    const [lhs, ...rhs] = part.split("=");
    // Typeset operators as models write them: − (U+2212), – and — as minus; × and · as times; ÷ as divide.
    const expr = lhs.replace(/[−–—]/g, "-").replace(/÷/g, "/").replace(/(\d)\s*[x×·]\s*(?=[\d(])/gi, "$1*").replace(/[$€£¥]/g, "").trim();
    const r = safeCalc(expr);
    if (r.error) return { status: "unparseable", detail: `cannot evaluate "${expr}": ${r.error}` };
    const value = Number(r.value);
    // The stated result: after "=" when the analyst wrote one, else anywhere in the claim, digits or words.
    const stated = rhs.length ? numbersAndWordsIn(rhs.join("=")) : numbersAndWordsIn(claim.text);
    if (!stated.length) return { status: "no_stated_result", detail: `computes to ${fmtNum(value)}, but the claim states no number to check` };
    if (!numberMatches(value, stated)) return { status: "miscomputed", detail: `${parts.length > 1 ? `"${expr}" ` : ""}computes to ${fmtNum(value)}; the claim says ${stated.map((n) => n.raw).join(", ")}` };
    values.push(value); exprs.push(expr);
  }
  const bag = [...ctx.baseNumbers, ...numbersIn(ledger.map((l) => l.text || "").join("\n"))];
  const missing = numbersIn(exprs.join(" ")).filter((n) => !SMALL_CONSTANTS.includes(Math.abs(n.value)) && !bag.some((b) => numberMatches(n.value, [b]) || numberMatches(b.value, [n])));
  if (missing.length) return { status: "unsourced_operands", detail: `computes correctly, but ${[...new Set(missing.map((n) => n.raw))].join(", ")} appear${missing.length === 1 ? "s" : ""} in no document, question or tool result` };
  return { status: "verified", detail: `recomputed: ${values.map(fmtNum).join(", ")}` };
}

function auditTool(claim, ev, ledger) {
  const refs = [...new Set((ev.match(/\bT\d+\b/gi) || []).map((s) => s.toUpperCase()))];
  if (!refs.length) return { status: "missing_tool_result", detail: "cites no tool result id (T1, T2, …)" };
  const hits = refs.map((ref) => ledger.find((l) => l.ref === ref)).filter(Boolean);
  if (!hits.length) return { status: "missing_tool_result", detail: `${refs.join(", ")} ${refs.length === 1 ? "is" : "are"} not in this analyst's tool ledger` };
  const ok = hits.filter((h) => !h.error);
  if (!ok.length) return { status: "failed_tool", detail: `${hits.map((h) => h.ref).join(", ")} returned an error` };
  const claimNums = numbersIn(claim.text.replace(/\bT\d+\b/gi, " "));
  if (claimNums.length) {
    const found = numbersIn(ok.map((h) => h.text || "").join("\n"));
    if (!claimNums.some((n) => found.some((f) => numberMatches(n.value, [f]) || numberMatches(f.value, [n])))) {
      return { status: "tool_mismatch", detail: `none of the claim's numbers (${claimNums.map((n) => n.raw).join(", ")}) appear in ${ok.map((h) => h.ref).join(", ")}` };
    }
  }
  return { status: "verified", detail: `supported by ${ok.map((h) => h.ref).join(", ")}` };
}

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))));

/** Audit every claim of an artifact in place; returns the artifact. */
export function auditArtifact(artifact, ctx, ledger) {
  for (const c of artifact.claims || []) c.audit = auditClaim(c, ctx, ledger);
  return artifact;
}

/** Grounding summary for a set of claims. rate is null when there are no claims. */
export function groundingOf(claims = []) {
  const byStatus = {}, byBasis = {};
  let verified = 0;
  const ungroundedLoadBearing = [], flagged = [];
  for (const c of claims) {
    const st = c.audit?.status || "unaudited";
    byStatus[st] = (byStatus[st] || 0) + 1;
    byBasis[c.basis] = (byBasis[c.basis] || 0) + 1;
    if (isGrounded(st)) verified++;
    else {
      if (c.load_bearing) ungroundedLoadBearing.push(c.id);
      if (!["unverifiable", "unaudited"].includes(st)) flagged.push(c.id);
    }
  }
  return { total: claims.length, verified, rate: claims.length ? verified / claims.length : null, byStatus, byBasis, ungroundedLoadBearing, flagged };
}

/** Audit rows that are findings (not merely "unverifiable"), as {ref, status, detail}. */
export function auditFlags(letter, claims = []) {
  return claims
    .filter((c) => c.audit && !isGrounded(c.audit.status) && c.audit.status !== "unverifiable")
    .map((c) => ({ ref: `${letter}:${c.id}`, status: c.audit.status, detail: c.audit.detail }));
}
