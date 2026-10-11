// Reading JSON out of model replies, and the guards that decide whether what came back is work.
// Browser-safe.

/**
 * The best-scoring JSON object in a reply.
 *
 * Models wrap JSON in prose, fences, or both, and a reply cut at the token ceiling leaves the outer
 * object unclosed while inner objects parse fine. So every `{` is a candidate; a candidate scores
 * 1000 per expected top-level key it carries, plus its key count. A caller then checks the shape
 * (`hasShape`) — an inner fragment of a truncated artifact is not the artifact (Model Bridge
 * rev 463: a 20-item answer cut mid-list was accepted as a one-item answer, and the retry never fired).
 */
export function extractJson(text, expectKeys = []) {
  const s = String(text ?? "").replace(/```(?:json|JSON|javascript)?[ \t]*\n?/g, "").replace(/```/g, "")
    // A string value opened with " and closed with ' at the end of its line (live, DeepSeek rev 15:
    // "evidence": "…last year.',). A raw newline is never legal inside a JSON string, so this cannot
    // touch valid JSON — and left alone it shifts every brace after it.
    .replace(/(:\s*"(?:[^"\\\n]|\\.)*)'(\s*[,}\]]?[ \t]*\r?\n)/g, '$1"$2');
  let best = null, bestScore = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = matchingBrace(s, i);
    if (end < 0) continue;
    const obj = parseLenient(s.slice(i, end + 1));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const score = expectKeys.filter((k) => k in obj).length * 1000 + Object.keys(obj).length;
    if (score > bestScore) { best = obj; bestScore = score; }
    i = end; // objects inside this one score lower on the top-level keys; skip them
  }
  return best;
}

function matchingBrace(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseLenient(src) {
  try { return JSON.parse(src); } catch { /* try the common repairs */ }
  const fixed = src
    .replace(/[“”]/g, '"')          // smart quotes around keys and strings
    .replace(/,\s*([}\]])/g, "$1")           // trailing commas
    .replace(/:\s*(true|false)\s*\|\s*(true|false)/g, ": $1"); // "true|false" left as a value
  try { return JSON.parse(fixed); } catch { return null; }
}

export function hasShape(o, required) {
  return Boolean(o && typeof o === "object" && required.some((k) => {
    const v = o[k];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : v != null;
  }));
}

// ---------- template-copy guards ----------
// Hand a model a filled example and it copies it (Model Bridge lesson 1: a pick called "AAA",
// queries ["echo line"]). Prompts therefore carry TYPE DESCRIPTIONS in angle brackets, and anything
// that comes back still wearing them is a copy, not an answer.

const ANGLE_RE = /^\s*<[^<>]{2,240}>\s*$/;

export function isPlaceholder(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return ANGLE_RE.test(s) || /^(\.{2,}|…+)$/.test(s);
}

/** An enum returned as the prompt wrote it: "quote|arithmetic|tool" or "one of: accept, reject". */
export function isEnumCopy(v) {
  const s = String(v ?? "");
  return /\|/.test(s) || /^one of\b/i.test(s.trim());
}

export function cleanStrings(list) {
  return (Array.isArray(list) ? list : list == null ? [] : [list])
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? Object.values(x).filter((v) => typeof v === "string").join(" — ") : String(x)))
    .map((x) => x.trim())
    .filter((x) => x && !isPlaceholder(x));
}

// ---------- chain of thought ----------
// A reasoning model asked for a memo sometimes returns its thinking ("Let me work through this…
// Wait — … Hmm"). Model Bridge published that as the deliverable once (rev 439). Detect, re-ask,
// and if it happens again label it rather than present it as a memo.
export function looksLikeChainOfThought(t) {
  const s = String(t ?? "");
  return /^\s*(let me|okay[,.]|ok[,.]|alright[,.]|first[,.]|i need to|i should|i'll start|i will start|wait[—,.-]|hmm)/i.test(s)
    || /\bWait —|\bHmm\b|let me re-read|I must report|Let me (check|think|reconsider|recount|look)/i.test(s.slice(0, 4000));
}

export function clampInt(v, lo, hi, dflt = null) {
  if (v == null || (typeof v === "string" && !v.trim()) || typeof v === "boolean") return dflt;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
