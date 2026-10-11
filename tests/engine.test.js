// The protocol end to end, with the deterministic mock analysts reading the real prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDebate, normaliseRunOptions } from "../app/core/engine.js";
import { reduceEvents, renderReport } from "../app/core/record.js";
import { mockReply } from "../app/core/mock-models.js";
import { MARK } from "../app/core/prompts.js";

const DOC = "The pilot budget is 450000 dollars. Each city costs 150000 dollars to launch, so the budget covers three cities. Austin had 1200 waitlist sign-ups and Denver had 800 sign-ups last year.";
const M = (...ids) => ids.map((model) => ({ provider: "mock", model }));

async function run(opts, envOver = {}) {
  const events = [];
  const rec = await runDebate({ question: "Which 3 cities should we pilot in first?", docs: [{ name: "memo.md", text: DOC }], ...opts }, {
    call: (r) => mockReply({ model: r.model, system: r.system, user: r.user, signal: r.signal }),
    callTool: async () => ({ error: "no tools in this test" }),
    emit: (e) => events.push(e),
    ...envOver,
  });
  return { rec, events, types: events.map((e) => e.type), prompts: events.filter((e) => e.type === "prompt") };
}

test("a full debate: every phase, in order, and a clean report", async () => {
  const { rec, types } = await run({ models: M("mock-1", "mock-alt", "mock-liar"), rounds: 2 });
  assert.equal(rec.status, "done");
  const order = ["run_started", "intent", "artifact", "gate", "diff", "critique", "rebuttal", "round_end", "diff_final", "synthesis", "done"];
  let at = -1;
  for (const t of order) { const i = types.indexOf(t, at + 1); assert.ok(i > at, `${t} out of order`); at = i; }
  assert.equal(rec.rounds.length, 2);
  assert.ok(rec.synthesis.memo.includes("## Where they agree"));
  const md = renderReport(rec);
  for (const h of ["## Run configuration", "## Intent, as read", "## Participation", "## Code-computed diff", "## Round 1", "## Post-debate diff", "## Joint memo", "## Final answers", "## Appendix"]) assert.ok(md.includes(h), `report lacks ${h}`);
});

test("phase 1 is independent and symmetric: identical user prompts, nobody sees anybody", async () => {
  const { prompts } = await run({ models: M("mock-1", "mock-2", "mock-alt"), rounds: 1 });
  const p1 = prompts.filter((p) => p.phase === "answer");
  assert.equal(p1.length, 3);
  assert.equal(new Set(p1.map((p) => p.user)).size, 1, "every analyst must receive byte-identical material");
  for (const p of p1) assert.ok(!/ANSWER OF ANALYST/.test(p.user + p.system), "no answer of another analyst in phase 1");
  const strip = (s) => s.replace(/You are Analyst [A-F],[^\n]*?The others are [A-F, ]+\./, "");
  assert.equal(new Set(p1.map((p) => strip(p.system))).size, 1, "system prompts differ only in the identity line");
});

test("phase 1 runs concurrently", async () => {
  let inFlight = 0, peak = 0;
  await run({ models: M("mock-1", "mock-2", "mock-alt"), rounds: 0 }, {
    call: async (r) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((z) => setTimeout(z, 20)); inFlight--; return mockReply({ model: r.model, system: r.system, user: r.user }); },
  });
  assert.equal(peak, 3);
});

test("the shared reading reaches every analyst and the memo writer", async () => {
  const { prompts, rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 1 });
  assert.ok(rec.intent?.expansion?.reading);
  for (const p of prompts.filter((x) => x.phase !== "intent")) assert.ok(p.user.includes("THE QUESTION, AS READ"), `${p.phase} prompt lacks the shared reading`);
  assert.equal(rec.intent.expansion.count, 3, "the stated count is read from the question");
});

test("participation gate: empty, failing and template-copying models are absent, not disagreeing", async () => {
  const { rec, types } = await run({ models: M("mock-1", "mock-empty", "mock-fail", "mock-template", "mock-alt"), rounds: 1 });
  assert.deepEqual(Object.keys(rec.absent).sort(), ["B", "C", "D"]);
  assert.match(rec.absent.B, /empty/);
  assert.match(rec.absent.C, /mock provider down/);
  assert.match(rec.absent.D, /template/);
  assert.deepEqual(rec.gate.present, ["A", "E"]);
  assert.ok(types.includes("template_copy"));
  assert.deepEqual(rec.diff.present, ["A", "E"], "absent analysts are excluded from the maths");
  assert.equal(rec.status, "done");
});

test("prose is repaired once; a reasoning channel is read without a paid retry", async () => {
  const { rec } = await run({ models: M("mock-prose", "mock-reasoning"), rounds: 0 });
  assert.ok(rec.artifacts.A && rec.artifacts.B);
  assert.deepEqual(rec.retries.map((r) => r.model), ["A"]);
  assert.match(rec.artifacts.A.artifact.position, /Recovered from my own prose/);
});

test("nobody answers → failed, and nothing is computed from silence", async () => {
  const { rec, types } = await run({ models: M("mock-empty", "mock-fail"), rounds: 1 });
  assert.equal(rec.status, "failed");
  assert.ok(!types.includes("diff") && !types.includes("synthesis"));
});

test("one analyst answering: no debate, memo still written", async () => {
  const { rec, types } = await run({ models: M("mock-1", "mock-empty"), rounds: 2 });
  assert.equal(rec.status, "done");
  assert.ok(!types.includes("critique"));
  assert.match(rec.gate.note, /no one to debate/);
  assert.ok(rec.synthesis.memo);
});

test("auto-stop ends the rounds when nobody moves", async () => {
  const { rec, types } = await run({ models: M("mock-1", "mock-alt"), rounds: 3 });
  assert.ok(types.includes("auto_stop"));
  assert.equal(rec.final.rounds_run, 2);
  assert.equal(rec.rounds[0].moves > 0, true);
  assert.equal(rec.rounds[1].moves, 0);
});

test("rebuttal: own answer attached, only what was said TO it, withdrawn and new claims applied and audited", async () => {
  const { rec, prompts } = await run({ models: M("mock-1", "mock-alt", "mock-3"), rounds: 1 });
  const rb = prompts.filter((p) => p.phase === "rebuttal");
  const B = rb.find((p) => p.model === "B");
  assert.match(B.user, /YOUR CURRENT ANSWER \(Analyst B\)/);
  assert.match(B.system, /"mine" is the CRITIC's view/);
  for (const p of rb) for (const m of p.user.matchAll(/^\s+- from Analyst ([A-F]): (.*)$/gm)) assert.match(m[2], new RegExp(`Analyst ${p.model}\\?`), `${p.model} received a question meant for someone else`);
  const reb = rec.rounds[0].rebuttals.B;
  assert.equal(reb.applied.withdrawn.length, 1);
  assert.equal(reb.applied.added.length, 1);
  assert.equal(reb.applied.added[0].audit.status, "verified", "a new quote claim is audited like any other");
  assert.ok(!rec.current.B.claims.some((c) => c.id === reb.applied.withdrawn[0]));
  assert.equal(rec.current.B.confidence, 55);
  assert.equal(rec.current.A.confidence, 70, "a rebuttal without final_confidence keeps the old one");
});

test("round 2 critiques the CURRENT answers, not the phase-1 ones", async () => {
  const { prompts } = await run({ models: M("mock-1", "mock-alt"), rounds: 2, autoStop: false });
  const r2 = prompts.find((p) => p.phase === "critique" && p.round === 2 && p.model === "A");
  assert.match(r2.user, /on reflection the answer is mixed/);
});

test("critique and rebuttal failures are fail-soft", async () => {
  const { rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 1 }, {
    call: (r) => {
      if (r.phase === "critique" && r.letter === "A") throw new Error("critic down");
      if (r.phase === "rebuttal" && r.letter === "B") throw new Error("rebutter down");
      return mockReply({ model: r.model, system: r.system, user: r.user });
    },
  });
  assert.equal(rec.status, "done");
  assert.ok(rec.rounds[0].critiques.A.failed);
  assert.ok(rec.rounds[0].rebuttals.B.failed);
  assert.equal(rec.current.B.position, rec.artifacts.B.artifact.position, "a failed rebuttal keeps the position");
  assert.ok(rec.synthesis.memo);
});

test("the memo: chain of thought is re-asked, then labelled; a failed memo still ships the report", async () => {
  const cot = await run({ models: M("mock-1", "mock-alt"), rounds: 0, synthesizer: { provider: "mock", model: "mock-cot" } });
  assert.equal(cot.rec.synthesis.flag, "chain_of_thought");
  assert.ok(cot.types.includes("memo_retry"));
  assert.match(renderReport(cot.rec), /This is not a finished memo/);
  assert.equal(cot.rec.synthesis.by.role, "writer", "a writer that did not debate is recorded as such");
  const failed = await run({ models: M("mock-1", "mock-alt"), rounds: 0, synthesizer: { provider: "mock", model: "mock-fail" } });
  assert.equal(failed.rec.status, "done");
  assert.equal(failed.rec.synthesis.memo, null);
  assert.match(renderReport(failed.rec), /No memo/);
});

test("the reading falls back to the next analyst once, then fails soft", async () => {
  const fb = await run({ models: M("mock-1", "mock-alt"), rounds: 0, expander: { provider: "mock", model: "mock-template" } });
  assert.equal(fb.rec.intent.by.letter, "A", "the first analyst read it instead");
  assert.match(fb.rec.intent.fallback_from.error, /no usable reading/);
  assert.match(renderReport(fb.rec), /was asked first and failed/);
  const { rec, prompts } = await run({ models: M("mock-empty", "mock-1"), rounds: 0, expander: { provider: "mock", model: "mock-template" } });
  assert.ok(rec.intent_error);
  assert.equal(prompts.filter((p) => p.phase === "intent").length, 4, "two readers, each with one repair — no more");
  assert.equal(rec.status, "done");
  assert.ok(!prompts.find((p) => p.phase === "answer").user.includes("THE QUESTION, AS READ"));
});

test("Stop aborts in-flight calls and keeps what finished", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 150);
  const t0 = Date.now();
  const { rec } = await run({ models: M("mock-1", "mock-slow"), rounds: 1, expand: false }, { signal: ctrl.signal });
  assert.equal(rec.status, "stopped");
  assert.ok(Date.now() - t0 < 2000, "stop must not wait for the slow call");
  assert.equal(rec.stopped_in, "answer");
});

test("a persona reaches every analyst identically, in every phase", async () => {
  const persona = { name: "Cautious CFO", lens: "Judge by cash impact.", standards: ["Quantify costs"] };
  const { prompts, rec } = await run({ models: M("mock-1", "mock-alt"), rounds: 1, persona, autoStop: false });
  for (const p of prompts.filter((p) => p.phase !== "intent")) assert.match(p.system + p.user, /JUDGING LENS — Cautious CFO/, `${p.phase} prompt lacks the lens`);
  assert.deepEqual([...new Set(prompts.map((p) => p.phase))].sort(), ["answer", "critique", "intent", "memo", "rebuttal"]);
  assert.equal(rec.config.persona.name, "Cautious CFO");
  const none = await run({ models: M("mock-1"), rounds: 0 });
  assert.match(none.prompts.find((p) => p.phase === "answer").system, /write the standards you are judging by into "assumptions"/);
});

test("tools: ledger ids, verified tool claims, budgets, dialects", async () => {
  const tools = [{ name: "web_search", description: "search", args: { query: "the query" }, budget_per_turn: 2 }];
  const callTool = async ({ name, args }) => ({ items: [{ title: `Result for ${args.query}`, url: "https://example.org/1" }], count: 1 });
  const { rec } = await run({ models: M("mock-1", "mock-greedy", "mock-dsml"), rounds: 1, tools }, { callTool });
  assert.equal(rec.tools.A.length, 1);
  assert.equal(rec.tools.A[0].ref, "T1");
  assert.equal(rec.artifacts.A.artifact.claims.find((c) => c.basis === "tool").audit.status, "verified");
  assert.ok(rec.tools.B.filter((t) => t.phase === "answer" && !t.error).length <= 2, "the budget holds against a greedy model");
  assert.ok(rec.artifacts.B, "a greedy model still answers after its budget is spent");
  assert.equal(rec.tools.C[0].args.query !== undefined, true, "DSML dialect parsed as a real call");
});

test("files deliverable: files parsed, critiqued, revised in a rebuttal", async () => {
  const { rec } = await run({ question: "Build a one-page site for the pilot", models: M("mock-1", "mock-2"), rounds: 1, deliverable: "files" });
  assert.equal(rec.status, "done");
  assert.equal(rec.artifacts.A.artifact.files[0].name, "index.html");
  assert.deepEqual(rec.rounds[0].rebuttals.B.applied.revised_files, ["index.html"]);
  assert.match(rec.current.B.files[0].content, /Revised page/);
  assert.match(rec.artifacts.B.artifact.files[0].content, /Made by mock-2/, "the phase-1 record keeps the original");
  assert.match(renderReport(rec), /files deliverable/);
});

test("ceilings scale with the mandate", async () => {
  const { prompts } = await run({ models: M("mock-1", "mock-alt", "mock-3"), rounds: 1 });
  const ans = prompts.find((p) => p.phase === "answer").max_tokens;
  const small = await run({ question: "Is this a good idea?", docs: [], models: M("mock-1", "mock-alt"), rounds: 0 });
  assert.ok(ans > small.prompts.find((p) => p.phase === "answer").max_tokens, "a list question with a document gets more room");
  const crit = prompts.filter((p) => p.phase === "critique").map((p) => p.max_tokens);
  assert.ok(Math.max(...crit) > 2000, "critique room grows with the agenda");
});

test("replay: reducing the stored events reproduces the record exactly", async () => {
  const { rec, events } = await run({ models: M("mock-1", "mock-alt"), rounds: 2 });
  assert.deepEqual(reduceEvents(JSON.parse(JSON.stringify(events))), JSON.parse(JSON.stringify(rec)));
});

test("options are validated", () => {
  assert.throws(() => normaliseRunOptions({ question: "", models: M("mock-1") }), /question/);
  assert.throws(() => normaliseRunOptions({ question: "q", models: [] }), /at least one/);
  assert.throws(() => normaliseRunOptions({ question: "q", models: M("a", "b", "c", "d", "e", "f", "g") }), /at most 6/);
  assert.throws(() => normaliseRunOptions({ question: "q", models: M("mock-1"), docs: [{ name: "big", text: "x".repeat(200_001) }] }), /limit/);
  assert.equal(normaliseRunOptions({ question: "q", models: M("mock-1"), rounds: 3 }).rounds, 0, "one analyst cannot debate");
  assert.equal(normaliseRunOptions({ question: "q", models: M("a", "b"), rounds: 9 }).rounds, 3);
});

test("the schemas never carry a filled example: every value is a type description", async () => {
  const P = await import("../app/core/prompts.js");
  for (const name of ["INTENT_SCHEMA", "ARTIFACT_SCHEMA", "CRITIQUE_SCHEMA", "REBUTTAL_SCHEMA", "CLAIM_SCHEMA"]) {
    const values = [...P[name].matchAll(/":\s*("([^"]*)"|<[^>]*>|[^,\[\]{}"\s][^,\]}]*)/g)].map((m) => (m[2] ?? m[1]).trim());
    assert.ok(values.length > 2, name);
    for (const v of values) assert.match(v, /^<.*>$/, `${name} carries a filled value: ${v}`);
  }
});

test("documents reach every phase identically", async () => {
  const { prompts } = await run({ models: M("mock-1", "mock-alt"), rounds: 1 });
  for (const p of prompts.filter((x) => ["answer", "critique", "rebuttal"].includes(x.phase))) assert.ok(p.user.includes("<<<D1"), `${p.phase} ${p.model} lacks the documents`);
});
