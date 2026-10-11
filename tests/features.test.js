// rev 15: the spending cap and meter, the model scorecard, the shareable page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDebate } from "../app/core/engine.js";
import { reduceEvents, renderReport, costLine } from "../app/core/record.js";
import { mockReply } from "../app/core/mock-models.js";
import { costOf, worstCaseCost, estimateRun, fmtUsd, estimateTokens } from "../app/core/cost.js";
import { scorecard, scorecardMarkdown } from "../app/core/scorecard.js";
import { reportPage, cssFromIndexHtml } from "../app/ui/export.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "The pilot budget is 450000 dollars. Each city costs 150000 dollars to launch, so the budget covers three cities. Austin had 1200 waitlist sign-ups and Denver had 800 sign-ups last year.";
const M = (...ids) => ids.map((model) => ({ provider: "mock", model }));
const price = (inp, out) => ({ in: inp, out, source: "test" });
const pricesFor = (ids, p) => Object.fromEntries(ids.map((id) => [`mock|${id}`, p]));

async function run(opts, envOver = {}) {
  const events = [];
  const calls = [];
  const rec = await runDebate({ question: "Which 3 cities should we pilot in first?", docs: [{ name: "memo.md", text: DOC }], ...opts }, {
    call: async (r) => { calls.push(r); const out = await mockReply({ model: r.model, system: r.system, user: r.user, signal: r.signal }); return envOver.usage ? { ...out, usage: envOver.usage(r, out) } : out; },
    callTool: async () => ({ error: "no tools" }),
    emit: (e) => events.push(e),
    ...envOver,
  });
  return { rec, events, calls };
}

// ---------------------------------------------------------------- arithmetic of money

test("cost: cached input at its own rate, unknown price is null, formatting", () => {
  assert.equal(costOf({ input: 1_000_000, output: 1_000_000 }, price(0.3, 1.2)), 1.5);
  assert.ok(Math.abs(costOf({ input: 1_000_000, output: 0, cached: 500_000 }, { in: 0.3, out: 1.2, cachedIn: 0.006 }) - 0.153) < 1e-9);
  assert.equal(costOf({ input: 10, output: 10 }, null), null);
  assert.equal(worstCaseCost(4000, 1000, price(1, 2)), (1200 * 1 + 1000 * 2) / 1e6, "prompt estimate +20%, full ceiling");
  assert.equal(worstCaseCost(4000, 1000, price(1, 2), 3), (1200 + 3000 * 2) / 1e6, "a retry at twice the ceiling is three ceilings in all");
  assert.deepEqual([fmtUsd(0), fmtUsd(0.00004), fmtUsd(0.0042), fmtUsd(0.42), fmtUsd(12.5), fmtUsd(null)], ["$0", "<$0.0001", "$0.0042", "$0.420", "$12.50", "?"]);
  assert.equal(estimateTokens(10), 3);
});

test("estimate: calls counted as the engine makes them; unknown prices named; free is free", () => {
  const plan = { analysts: [{ provider: "p", model: "a" }, { provider: "p", model: "b" }], rounds: 1, question: "q", docChars: 4000, expand: true, reader: { provider: "p", model: "a" }, writer: { provider: "p", model: "a" }, ceilings: { answer: 4000, critique: 2000, rebuttal: 2500, memo: 4000, intent: 2500 } };
  const e = estimateRun(plan, { "p|a": price(1, 1), "p|b": price(0, 0) });
  assert.equal(e.calls, 1 + 2 + 4 + 1);
  assert.deepEqual(e.unknown, []);
  assert.ok(e.typical > 0 && e.worst > e.typical);
  const u = estimateRun(plan, { "p|a": price(1, 1) });
  assert.deepEqual(u.unknown, ["p · b"]);
  const free = estimateRun(plan, { "p|a": price(0, 0), "p|b": price(0, 0) });
  assert.equal(free.worst, 0);
});

// ---------------------------------------------------------------- the cap in the engine

test("usage: reported tokens are used and priced; missing usage is estimated and marked", async () => {
  const { rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 1, prices: pricesFor(["mock-1", "mock-alt"], price(1, 2)) }, { usage: (r) => (r.model === "mock-1" ? { input: 1000, output: 500 } : null) });
  const a = rec.outputs.filter((o) => o.model === "A" && o.phase === "answer")[0];
  assert.deepEqual([a.usage.input, a.usage.output, a.usage.estimated, a.cost], [1000, 500, false, (1000 + 1000) / 1e6]);
  const b = rec.outputs.find((o) => o.model === "B");
  assert.equal(b.usage.estimated, true, "no usage from the provider → estimated from length, and said so");
  assert.ok(b.cost > 0);
  assert.ok(rec.usage.total.calls === rec.outputs.length && rec.usage.total.estimated > 0);
  assert.match(costLine(rec), /^\$0\.\d+ · .* tokens in, .* out · \d+ calls \(\d+ estimated from length\)$/);
  assert.match(renderReport(rec), /## Cost[\s\S]*\| who \| calls \|/);
});

test("the cap is checked BEFORE a call, against its worst case: nothing is ever spent past it", async () => {
  const p = price(50, 50); // expensive enough that a cap of $1 fits only a few calls
  const { rec, events, calls } = await run({ models: M("mock-1", "mock-alt"), rounds: 2, autoStop: false, prices: pricesFor(["mock-1", "mock-alt"], p), budgetUsd: 1 });
  assert.equal(rec.status, "stopped");
  assert.equal(rec.stopped_reason, "spending cap");
  const stop = events.find((e) => e.type === "budget_stop");
  assert.ok(stop, "a budget_stop event names the call that was not made");
  assert.ok(stop.spent + stop.in_flight + stop.needed > 1);
  assert.ok(rec.usage.total.usd <= 1, `spent ${rec.usage.total.usd}`);
  assert.equal(calls.length, rec.prompts.length, "every prompt recorded is a call made; the refused one never went out");
  assert.ok(events.findIndex((e) => e.type === "budget_stop") > events.findLastIndex((e) => e.type === "prompt"), "no call starts after the cap stops the run");
  assert.match(renderReport(rec), /stopped during .* by the spending cap/);
});

test("concurrent calls reserve their worst case: phase 1 cannot overshoot by running in parallel", async () => {
  // Each answer call's worst case ≈ $0.19 here; a $0.45 cap fits the reading and two answers, not three.
  const p = price(10, 40);
  const { rec, calls } = await run({ models: M("mock-1", "mock-2", "mock-alt"), rounds: 1, prices: pricesFor(["mock-1", "mock-2", "mock-alt"], p), budgetUsd: 0.45 });
  assert.equal(rec.stopped_reason, "spending cap");
  assert.ok(calls.filter((c) => c.phase === "answer").length < 3, "the third concurrent answer was refused before it started");
  assert.ok(rec.usage.total.usd <= 0.45);
});

test("the reasoning retry is offered only when the cap has room for it", async () => {
  const seen = [];
  await run({ models: M("mock-1"), rounds: 0, expand: false, prices: pricesFor(["mock-1"], price(1, 1)), budgetUsd: 100 }, { call: async (r) => { seen.push(r.maxGrowth); return mockReply(r); } });
  assert.ok(seen.every((g) => g === 2), "ample cap → retry allowed");
  const tight = [];
  await run({ models: M("mock-1"), rounds: 0, expand: false, synthesizer: "none", prices: pricesFor(["mock-1"], price(1, 10)), budgetUsd: 0.07 }, { call: async (r) => { tight.push(r.maxGrowth); return mockReply(r); } });
  assert.deepEqual(tight, [1], "one ceiling fits, three do not → no growth");
});

test("a cap with an unpriced model is refused before any call; no cap means no refusal", async () => {
  const { rec, calls } = await run({ models: M("mock-1", "mock-alt"), rounds: 0, prices: pricesFor(["mock-1"], price(1, 1)), budgetUsd: 1 });
  assert.equal(rec.status, "error");
  assert.match(rec.error.message, /no price for mock · mock-alt/);
  assert.equal(calls.length, 0);
  const ok = await run({ models: M("mock-1", "mock-alt"), rounds: 0, prices: pricesFor(["mock-1"], price(1, 1)) });
  assert.equal(ok.rec.status, "done");
  assert.ok(ok.rec.outputs.some((o) => o.model === "B" && o.cost === null), "unknown price → cost null, never a guess");
});

test("replay: the cost survives reduce(events) exactly", async () => {
  const { rec, events } = await run({ models: M("mock-1", "mock-alt"), rounds: 1, prices: pricesFor(["mock-1", "mock-alt"], price(1, 2)) });
  assert.deepEqual(reduceEvents(events).usage, rec.usage);
});

// ---------------------------------------------------------------- the scorecard

test("scorecard: counted from records — absences, audit findings, peer verdicts, movement", async () => {
  const runs = [];
  for (const models of [M("mock-1", "mock-alt", "mock-liar"), M("mock-1", "mock-alt", "mock-empty"), M("mock-2", "mock-alt")]) {
    const { rec } = await run({ models, rounds: 1, autoStop: false, prices: pricesFor(["mock-1", "mock-2", "mock-alt", "mock-liar", "mock-empty"], price(1, 2)) });
    runs.push({ id: `r${runs.length}`, ...rec });
  }
  assert.deepEqual(scorecard(runs).rows, [], "mock models are left out unless asked");
  const card = scorecard(runs, { includeMock: true });
  const row = (m) => card.rows.find((r) => r.model === m);
  assert.equal(card.runs, 3);
  assert.equal(row("mock-alt").seats, 3);
  assert.equal(row("mock-empty").participation, 0);
  assert.ok(row("mock-liar").findings.fabricated_quote + row("mock-liar").findings.miscomputed > 0, "the liar's audit findings are counted");
  assert.equal(row("mock-1").findings.fabricated_quote, 0);
  assert.ok(row("mock-alt").movedRate > 0, "mock-alt changes its mind in round 1");
  assert.ok(row("mock-1").peerJudged > 0, "others' verdicts on its claims are counted");
  assert.ok(row("mock-1").grounding > 0, "documents attached → grounding counted");
  assert.ok(row("mock-1").usdPerAnswer > 0 && row("mock-1").secondsPerCall >= 0);
  assert.ok(row("mock-1").fewRuns);
  assert.match(scorecardMarkdown(card), /\| mock · mock-alt|\| Mock · mock-alt|mock-alt/);
});

test("scorecard: a seat stopped before it answered is not counted against the model", async () => {
  const { rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 1, prices: pricesFor(["mock-1", "mock-alt"], price(10, 40)), budgetUsd: 0.3 });
  assert.equal(rec.stopped_reason, "spending cap");
  const card = scorecard([rec], { includeMock: true });
  for (const r of card.rows) assert.equal(r.participation, 1, `${r.model} answered every seat it was given`);
  assert.ok(card.rows.length < 2, "the analyst the cap kept from answering has no seat");
});

test("scorecard: grounding counts only runs where a claim could be checked", async () => {
  const { rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 0, docs: [] });
  const card = scorecard([rec], { includeMock: true });
  assert.equal(card.rows[0].grounding, null);
  assert.equal(card.rows[0].checkableClaims, 0);
});

// ---------------------------------------------------------------- the shareable page

const CSS = cssFromIndexHtml(fs.readFileSync(path.join(ROOT, "app", "ui", "index.html"), "utf8"));

test("page: one self-contained document — no script, nothing loaded from outside, every card and panel", async () => {
  const { rec, events } = await run({ models: M("mock-1", "mock-alt"), rounds: 1, prices: pricesFor(["mock-1", "mock-alt"], price(1, 2)) });
  const html = reportPage({ record: rec, events, css: CSS, version: "rev 15" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(!/<script/i.test(html), "no script");
  assert.ok(!/(src|href)="https?:/i.test(html.replace(/<a [^>]*>/g, "")), "nothing fetched from the network");
  for (const s of ["Run configuration", "Intent, as read", "Code-computed diff", "Joint memo", "Participation", "Grounding", "Cost", "Every prompt as sent"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('data-prompt="'), "console-only buttons are gone");
  assert.ok(html.length > 10000 && CSS.length > 5000);
});

test("page: prompts and documents can be left out; documents appear once, not in every prompt", async () => {
  const long = Array.from({ length: 30 }, (_, i) => `Note ${i + 1}: ${DOC}`).join("\n");
  const { rec, events } = await run({ models: M("mock-1", "mock-alt"), rounds: 1, docs: [{ name: "private.md", text: long }] });
  const full = reportPage({ record: rec, events, css: "" });
  assert.equal(full.split(long.slice(0, 400)).length - 1, 1, "the document's text appears once, in the Documents section");
  assert.match(full, /full text of D1 is in the Documents section/);
  const lean = reportPage({ record: rec, events, css: "", prompts: false, documents: false });
  assert.ok(!lean.includes("Every prompt as sent"));
  assert.ok(!lean.includes(long.slice(0, 400)), "the private document's text is not in the page");
  assert.match(lean, /not included in this page/);
});

test("page: a files run shows every file as a sandboxed preview, no console buttons", async () => {
  const { rec, events } = await run({ question: "A one-page site", models: M("mock-svg", "mock-2"), rounds: 0, deliverable: "files", docs: [] });
  const html = reportPage({ record: rec, events, css: "" });
  assert.match(html, /<iframe sandbox="allow-scripts"/);
  assert.ok(!/data-fzip|data-fdl|data-file=/.test(html));
});

// ---------------------------------------------------------------- rev 15: what the first live DeepSeek runs taught

test("live: a string closed with the wrong quote no longer derails the whole answer", async () => {
  const { extractJson } = await import("../app/core/json.js");
  const broken = `{"position":"Austin first","claims":[{"id":"c1","text":"Austin leads","basis":"quote","evidence":"Austin had 1200 waitlist sign-ups.',\n "source":"D1"}],"items":[{"name":"Austin","claims":["c1"]}]}`;
  const o = extractJson(broken, ["position", "claims", "items"]);
  assert.equal(o.position, "Austin first");
  assert.equal(o.claims[0].evidence, "Austin had 1200 waitlist sign-ups.");
  assert.equal(extractJson(`{"position":"the founders'","claims":[]}`, ["position"]).position, "the founders'", "a legal apostrophe is left alone");
});

test("live: a fragment with no position is not an answer — it goes for repair; bare claim ids are dropped", async () => {
  let n = 0;
  const { rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 0, expand: false, synthesizer: "none" }, {
    call: async (r) => {
      if (r.phase === "answer" && r.model === "mock-1" && n++ === 0) return { text: `Ranking: {"name":"Austin","why":"demand","claims":["c3","c6"]}` };
      return mockReply(r);
    },
  });
  assert.ok(rec.retries.some((x) => x.model === "A" && x.phase === "answer"), "repair requested");
  assert.ok(rec.artifacts.A.artifact.claims.every((c) => !/^c\d+$/.test(c.text)), "no bare ids as claims");
  const { auditClaim, auditContext } = await import("../app/core/audit.js");
  const ctx = auditContext({ docs: [{ id: "D1", text: "Denver 800 and Boise 300 last year." }] });
  assert.equal(auditClaim({ basis: "arithmetic", text: "Denver leads Boise by 500.", evidence: "800 − 300 = 500" }, ctx).status, "verified", "U+2212 minus");
  assert.equal(auditClaim({ basis: "arithmetic", text: "That is 2.67 times.", evidence: "800 ÷ 300" }, ctx).status, "verified", "÷");
});
