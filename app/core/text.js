// Text utilities shared by the audit and the metrics. Browser-safe: no node: imports.
//
// Every top-level name in app/core is unique across the folder: build/artifact.js inlines the
// modules into one script, and a duplicate name would silently shadow another module's helper.

export const STOPWORDS = new Set(("a an the and or but if then than that this these those of to in on at by for with from as is are was were be been being " +
  "it its they them their we our you your he she his her not no nor so do does did done have has had having will would can could should may might " +
  "must shall also very more most much many such only just about into over under between after before because while which who whom whose what when " +
  "where why how all any each every some other another both either neither there here out up down off again further once same own too s t don").split(" "));

/** Normalise for comparison: unicode compatibility form, straight quotes, plain dashes, one space, lower case. */
export function normText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A crude, predictable stemmer: enough to match "workers"/"worker", "increased"/"increase". */
export function stemWord(w) {
  if (w.length <= 4 || /^\d/.test(w)) return w;
  for (const [suf, rep] of [["ies", "y"], ["ing", ""], ["edly", ""], ["ed", ""], ["es", ""], ["ly", ""], ["s", ""]]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length) + rep;
  }
  return w;
}

const NUM_RE = /(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?%)?/g;

/** Numbers stated in a text, as values. "1,200" → 1200, "13%" → 13 (percent flagged separately). */
export function numbersIn(s) {
  const out = [];
  for (const m of String(s ?? "").matchAll(NUM_RE)) {
    const raw = m[0];
    const v = Number(raw.replace(/[,%\s]/g, ""));
    if (Number.isFinite(v)) out.push({ value: v, percent: /%/.test(raw), raw });
  }
  return out;
}

const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, dozen: 12, half: 0.5, twice: 2, double: 2, triple: 3 };
/** Numbers in digits plus small numbers written as words ("three cities", "twice as many"). */
export function numbersAndWordsIn(s) {
  const out = numbersIn(s);
  for (const m of String(s ?? "").toLowerCase().matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozen|half|twice|double|triple)\b/g)) out.push({ value: NUMBER_WORDS[m[1]], percent: false, raw: m[1] });
  return out;
}

/** Does `v` match one of the stated numbers (1% relative or 0.01 absolute; 0.15 matches 15%)? */
export function numberMatches(v, stated) {
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.01);
  return stated.some((n) => close(v, n.value) || (n.percent && close(v * 100, n.value)) || close(Math.round(v * 100) / 100, n.value));
}

/** Content tokens: lower case, stop words out, stemmed; numbers kept as their plain value. */
export function contentTokens(s) {
  const out = new Set();
  for (const n of numbersIn(s)) out.add(`#${n.value}`);
  for (const w of normText(s).replace(NUM_RE, " ").split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stemWord(w));
  }
  return out;
}

// Polarity: two claims that differ only in a negation or an antonym are opposites, not the same
// claim — "remote work increases productivity" vs "… does not increase …". Token overlap alone
// would call them shared and report agreement where there is disagreement.
const NEGATIONS = new Set(["not", "no", "never", "none", "cannot", "without", "neither", "nor", "isn't", "aren't", "doesn't", "don't", "didn't", "won't", "wouldn't", "can't", "fails", "fail", "lack", "lacks"]);
export const ANTONYMS = [["increase", "decrease"], ["rise", "fall"], ["more", "less"], ["more", "fewer"], ["higher", "lower"], ["positive", "negative"], ["better", "worse"], ["gain", "loss"], ["benefit", "harm"], ["benefit", "cost"], ["support", "oppose"], ["effective", "ineffective"], ["safe", "unsafe"], ["strong", "weak"], ["above", "below"], ["success", "failure"], ["efficient", "inefficient"], ["productive", "unproductive"], ["outweigh", "outweighed"], ["improve", "worsen"], ["larger", "smaller"], ["overvalued", "undervalued"], ["bullish", "bearish"], ["true", "false"], ["legal", "illegal"], ["likely", "unlikely"]];

export function polarity(s) {
  const words = normText(s).split(/[^a-z']+/).filter(Boolean);
  const neg = words.filter((w) => NEGATIONS.has(w) || w.endsWith("n't")).length % 2;
  const stems = new Set(words.map(stemWord));
  return { neg, stems };
}

/** True when two statements look like opposites: odd negation parity, or one side of an antonym pair each. */
export function opposed(a, b) {
  const pa = polarity(a), pb = polarity(b);
  if (pa.neg !== pb.neg) return true;
  return ANTONYMS.some(([x, y]) => {
    const [sx, sy] = [stemWord(x), stemWord(y)];
    return (pa.stems.has(sx) && !pa.stems.has(sy) && pb.stems.has(sy) && !pb.stems.has(sx)) || (pa.stems.has(sy) && !pa.stems.has(sx) && pb.stems.has(sx) && !pb.stems.has(sy));
  });
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function wordCount(s) {
  return String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Normalise an item name ("The Great Gatsby", "great gatsby") for list overlap. */
export function itemKey(name) {
  // Live models annotate names with their rank or a gloss — "Austin — first", "2. Boise (no permit)" —
  // which made identical picks count as different items. The key is the name alone.
  const s = String(name ?? "").trim()
    .replace(/^(?:#?\d{1,2}[.):]|#\d{1,2}|\(\d{1,2}\)|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*[:.\-–—])\s+/i, "")
    .replace(/\s+[—–-]\s+.*$/, "").replace(/\s*:\s+.*$/, "").replace(/\s*\([^)]*\)\s*$/, "").trim() || String(name ?? "").trim();
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return s; // a ticker or code stays as written
  return normText(s).replace(/^(the|a|an) /, "").replace(/[^a-z0-9]+/g, " ").trim();
}
