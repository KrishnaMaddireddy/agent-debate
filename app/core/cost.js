// Tokens and money. Browser-safe. Prices are USD per 1M tokens: { in, out, cachedIn?, source }.
// A price of null means unknown — shown as "?" and, when a spending cap is set, refused before
// the run starts (a cap that cannot see a model's cost protects nothing).

/** Tokens from characters when a provider reports no usage: ~4 chars per token, rounded up. */
export const estimateTokens = (chars) => Math.ceil((Number(chars) || 0) / 4);

/** USD for one call's usage at a price; null when the price is unknown. */
export function costOf(usage, price) {
  if (!price || price.in == null || price.out == null || !usage) return null;
  const cached = Math.min(usage.cached || 0, usage.input || 0);
  const fresh = (usage.input || 0) - cached;
  const cachedRate = price.cachedIn != null ? price.cachedIn : price.in;
  return (fresh * price.in + cached * cachedRate + (usage.output || 0) * price.out) / 1e6;
}

/** The most one call could cost: the whole prompt uncached (+20% for the estimate) and the full ceiling. */
export function worstCaseCost(promptChars, maxTokens, price, growth = 1) {
  if (!price || price.in == null || price.out == null) return null;
  return (Math.ceil(estimateTokens(promptChars) * 1.2) * price.in + (maxTokens || 0) * growth * price.out) / 1e6;
}

export const priceKey = (provider, model) => `${provider}|${model}`;
export const isFree = (price) => Boolean(price) && price.in === 0 && price.out === 0;

/** "$0.0042", "$1.20", "<$0.0001", "?" */
export function fmtUsd(v) {
  if (v == null || Number.isNaN(v)) return "?";
  if (v === 0) return "$0";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}
export const fmtTokens = (n) => (n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Totals from a record's outputs: { total:{input,output,usd,unknown,estimated,calls}, by:{ id: {...} } }. */
export function usageTotals(outputs = []) {
  const blank = () => ({ input: 0, output: 0, usd: 0, unknown: 0, estimated: 0, calls: 0, ms: 0 });
  const total = blank(), by = {};
  for (const o of outputs) {
    if (!o.usage) continue;
    const row = (by[o.model] ||= blank());
    for (const t of [total, row]) {
      t.input += o.usage.input || 0;
      t.output += o.usage.output || 0;
      t.calls += 1;
      t.ms += o.ms || 0;
      if (o.usage.estimated) t.estimated += 1;
      if (o.cost == null) t.unknown += 1; else t.usd += o.cost;
    }
  }
  return { total, by };
}

/**
 * Before the run: how many calls, and what they could cost. `plan` is what the console knows —
 * analysts [{provider, model}], rounds, docChars, question, ceilings {answer, critique, rebuttal, memo,
 * intent} and the reader/writer. Typical assumes a model writes ~40% of its ceiling.
 */
export function estimateRun(plan, prices) {
  const n = plan.analysts.length;
  const rounds = n >= 2 ? plan.rounds : 0;
  const base = (plan.docChars || 0) + (plan.question?.length || 0) + 7000; // instructions, schema, reading
  const answerChars = 6000; // one analyst's answer as the others see it
  const calls = [];
  const add = (who, chars, ceiling) => calls.push({ who, chars, ceiling });
  if (plan.expand && plan.reader) add(plan.reader, base, plan.ceilings.intent);
  for (const a of plan.analysts) add(a, base, plan.ceilings.answer);
  for (let r = 0; r < rounds; r++) for (const a of plan.analysts) { add(a, base + n * answerChars, plan.ceilings.critique); add(a, base + 3 * answerChars, plan.ceilings.rebuttal); }
  if (plan.writer) add(plan.writer, base + n * answerChars * 2, plan.ceilings.memo);
  let worst = 0, typical = 0;
  const unknown = new Set();
  for (const c of calls) {
    const p = prices[priceKey(c.who.provider, c.who.model)];
    const ceiling = Math.min(32000, Math.max(c.ceiling, p?.floor || 0));
    const w = worstCaseCost(c.chars, ceiling, p);
    if (w == null) { unknown.add(`${c.who.provider} · ${c.who.model}`); continue; }
    worst += w;
    typical += (Math.ceil(estimateTokens(c.chars)) * p.in + ceiling * 0.4 * p.out) / 1e6;
  }
  return { calls: calls.length, worst, typical, unknown: [...unknown] };
}
