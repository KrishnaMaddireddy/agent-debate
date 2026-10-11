// Core units: text, JSON guards, calculator, tool protocol, files, audit, metrics. Every test imports
// the REAL module (CLAUDE.md: test the real block, never a copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normText, numbersIn, numberMatches, contentTokens, jaccard, opposed, itemKey } from "../app/core/text.js";
import { extractJson, hasShape, isPlaceholder, isEnumCopy, cleanStrings, looksLikeChainOfThought, clampInt } from "../app/core/json.js";
import { safeCalc } from "../app/core/calc.js";
import { parseToolCalls, turnBudget, formatToolResult, toolsBlock, overBudget } from "../app/core/tools-protocol.js";
import { extractFiles, inlineSiblings, zipStore, mimeFor } from "../app/core/files.js";
import { auditContext, auditClaim, groundingOf, auditFlags, isGrounded } from "../app/core/audit.js";
import { clusterClaims, snapshot, normRef, verdictTally, rootCauseTally, movementLog, towards, compareSnapshots } from "../app/core/metrics.js";

// ---------------------------------------------------------------- text
test("normText folds quotes, dashes, spaces and case", () => {
  assert.equal(normText("“Hello”  —  World’s END"), '"hello" - world\'s end');
});
test("numbersIn reads commas, decimals and percents", () => {
  assert.deepEqual(numbersIn("1,200 people, 13% more, 2.5x and -4").map((n) => n.value), [1200, 13, 2.5, -4]);
  assert.equal(numbersIn("13%")[0].percent, true);
});
test("numberMatches is percent-aware with 1% tolerance", () => {
  assert.ok(numberMatches(0.15, numbersIn("15%")));
  assert.ok(numberMatches(180.9, numbersIn("180")));
  assert.ok(!numberMatches(200, numbersIn("180")));
});
test("contentTokens drops stop words and stems", () => {
  const t = contentTokens("The workers were increasing productivity by 13%");
  assert.ok(t.has("worker") && t.has("increas") && t.has("#13") && !t.has("the"));
});
test("opposed: negation parity and antonym pairs", () => {
  assert.ok(opposed("Remote work increases productivity", "Remote work does not increase productivity"));
  assert.ok(opposed("costs are higher", "costs are lower"));
  assert.ok(!opposed("costs are higher in cities", "in cities costs are higher"));
});
test("itemKey keeps tickers, normalises names", () => {
  assert.equal(itemKey("NVDA"), "NVDA");
  assert.equal(itemKey("The Great Gatsby"), itemKey("great gatsby"));
  // Live (DeepSeek, rev 14): the same three cities, one analyst annotating each with its rank.
  for (const n of ["Austin — first", "1. Austin", "#1 Austin", "Austin (1200 sign-ups)", "Austin: highest demand", "First: Austin", "Austin - first"]) assert.equal(itemKey(n), "austin", n);
  assert.equal(itemKey("Hewlett-Packard"), itemKey("hewlett packard"));
  assert.equal(itemKey("Rock - Paper"), "rock");
});

// ---------------------------------------------------------------- JSON guards
test("extractJson picks the object with the expected keys, through prose and fences", () => {
  const o = extractJson('Sure! {"note":1}\n```json\n{"position":"yes","claims":[{"id":"c1"}]}\n```', ["position", "claims"]);
  assert.equal(o.position, "yes");
});
test("extractJson rejects the inner fragment of a truncated reply (shape guard)", () => {
  const cut = '{"position":"long answer","claims":[{"id":"c1","text":"a"},{"id":"c2","text":"b"';
  const o = extractJson(cut, ["position", "claims"]);
  assert.ok(!hasShape(o, ["position", "claims"]), "an inner claim object must not pass as an artifact");
});
test("extractJson repairs trailing commas and smart quotes", () => {
  assert.equal(extractJson('{"a": 1, "b": [1,2,],}', ["a"]).b.length, 2);
});
test("template-copy guards", () => {
  assert.ok(isPlaceholder("<one checkable statement>"));
  assert.ok(isPlaceholder("..."));
  assert.ok(!isPlaceholder("a real sentence"));
  assert.ok(isEnumCopy("quote|arithmetic|tool"));
  assert.ok(isEnumCopy("one of: accept, reject"));
  assert.deepEqual(cleanStrings(["<assumption>", "real", "…", { a: "x" }]), ["real", "x"]);
});
test("chain of thought is detected", () => {
  assert.ok(looksLikeChainOfThought("Let me work through this. Wait — no."));
  assert.ok(looksLikeChainOfThought("## Memo\nFine. Hmm, but"));
  assert.ok(!looksLikeChainOfThought("## Where they agree\nBoth cite the study."));
});
test("clampInt leaves null as null (a missing confidence is not 0)", () => {
  assert.equal(clampInt(null, 0, 100, null), null);
  assert.equal(clampInt("", 0, 100, null), null);
  assert.equal(clampInt("140", 0, 100, null), 100);
});

// ---------------------------------------------------------------- calculator
test("safeCalc evaluates without eval", () => {
  assert.equal(safeCalc("(1450-1200)/1200").value, 0.208333333333);
  assert.equal(safeCalc("1,200 * 15%").value, 180);
  assert.equal(safeCalc("2^10").value, 1024);
  assert.equal(safeCalc("1.5k + 2m").value, 2001500);
  assert.ok(safeCalc("process.exit()").error);
  assert.ok(safeCalc("1/0").error);
});

// ---------------------------------------------------------------- tool protocol
test("parseToolCalls reads JSON lines and provider dialects", () => {
  assert.deepEqual(parseToolCalls('{"tool":"web_search","args":{"query":"x"}}\n{"tool":"calculate","args":{"expression":"1+1"}}').map((c) => c.tool), ["web_search", "calculate"]);
  assert.equal(parseToolCalls('<tool_call>{"name":"web_search","arguments":"{\\"query\\":\\"q\\"}"}</tool_call>')[0].args.query, "q");
  assert.equal(parseToolCalls('<｜DSML｜invoke name="web_search"><｜DSML｜parameter name="query" string="true">abc</｜DSML｜parameter></｜DSML｜invoke>')[0].args.query, "abc");
  assert.deepEqual(parseToolCalls('{"position":"an answer, not a call","claims":[]}'), []);
  assert.deepEqual(parseToolCalls("plain prose"), []);
});
test("turn budget is the sum of the selected tools, capped at 12", () => {
  assert.equal(turnBudget([{ name: "a", budget_per_turn: 1 }, { name: "b", budget_per_turn: 3 }]), 4);
  assert.equal(turnBudget(Array.from({ length: 9 }, (_, i) => ({ name: `t${i}`, budget_per_turn: 3 }))), 12);
  assert.ok(overBudget([{ name: "a", budget_per_turn: 1 }], [{ call: { tool: "a" } }], "a"));
});
test("tool results carry ledger ids", () => {
  const s = formatToolResult("T3", { tool: "web_search", args: { query: "x" } }, { items: [{ title: "A", url: "https://a" }], count: 1 });
  assert.match(s, /^\[T3\] web_search/);
  assert.match(toolsBlock([{ name: "web_search", args: { query: "q" }, description: "d" }], 3), /"evidence":"<that id>"/);
});

// ---------------------------------------------------------------- files
test("extractFiles names, sanitises and de-duplicates", () => {
  const { files, prose } = extractFiles("Approach.\n```html file=index.html\n<p>a</p>\n```\n```css file=../../etc/passwd.css\nx\n```\n```html\n<p>b</p>\n```");
  assert.deepEqual(files.map((f) => f.name), ["index.html", "etc/passwd.css", "index-2.html"]);
  assert.equal(prose, "Approach.");
});
test("inlineSiblings turns sibling references into data URLs", () => {
  const files = [{ name: "index.html", content: '<img src="chart.svg">' }, { name: "chart.svg", content: "<svg/>" }];
  assert.match(inlineSiblings(files[0], files), /data:image\/svg\+xml;base64,/);
});
test("zipStore writes a valid stored zip", () => {
  const z = zipStore([{ name: "a.txt", content: "hello" }]);
  assert.equal(z[0], 0x50); assert.equal(z[1], 0x4b);
  assert.equal(new DataView(z.buffer).getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(mimeFor("x.svg"), "image/svg+xml");
});

// ---------------------------------------------------------------- audit
const DOC = "Remote work was studied in 2021 across 1200 employees. The study found that remote workers completed 13 percent more calls than office workers.";
const ctx = auditContext({ docs: [{ id: "D1", text: DOC }], question: "Is remote work productive?" });
test("quote: exact, normalised, elided, fabricated, too short, no documents", () => {
  assert.equal(auditClaim({ basis: "quote", evidence: "remote workers completed 13 percent more calls" }, ctx).status, "verified");
  assert.equal(auditClaim({ basis: "quote", evidence: "REMOTE  workers completed 13 percent more calls" }, ctx).status, "verified_normalised");
  assert.equal(auditClaim({ basis: "quote", evidence: "Remote work was studied in 2021 … completed 13 percent more calls" }, ctx).status, "verified_elided");
  assert.equal(auditClaim({ basis: "quote", evidence: "remote workers were twice as productive overall" }, ctx).status, "fabricated_quote");
  assert.equal(auditClaim({ basis: "quote", evidence: "more calls" }, ctx).status, "too_short");
  // Live (DeepSeek, rev 14): short quotes that carry a figure — "Denver 800" — are checked, not refused.
  assert.equal(auditClaim({ basis: "quote", evidence: "1200 employees" }, ctx).status, "verified");
  assert.equal(auditClaim({ basis: "quote", evidence: "1300 employees" }, ctx).status, "fabricated_quote");
  assert.equal(auditClaim({ basis: "quote", evidence: "remote workers completed 13 percent more calls" }, auditContext({})).status, "no_documents");
});
test("arithmetic: recomputed, miscomputed, unsourced operands, unparseable", () => {
  assert.equal(auditClaim({ basis: "arithmetic", text: "That is 156 more calls per 1200 staff.", evidence: "1200 * 13%" }, ctx).status, "verified");
  assert.equal(auditClaim({ basis: "arithmetic", text: "That is 200.", evidence: "1200 * 13%" }, ctx).status, "miscomputed");
  assert.equal(auditClaim({ basis: "arithmetic", text: "It gives 4077.", evidence: "3000 + 1077" }, ctx).status, "unsourced_operands");
  assert.equal(auditClaim({ basis: "arithmetic", text: "x", evidence: "rm -rf /" }, ctx).status, "unparseable");
  assert.equal(auditClaim({ basis: "arithmetic", text: "half the staff", evidence: "1200 / 2 = 600" }, ctx).status, "verified");
  // Live (DeepSeek, rev 14): the result written as a word, and several computations on one line.
  const pilot = auditContext({ docs: [{ id: "D1", text: "The pilot budget is 450000 dollars. Each city costs 150000 dollars to launch." }] });
  assert.equal(auditClaim({ basis: "arithmetic", text: "The 450000 budget at 150000 each covers exactly three cities.", evidence: "450000 / 150000" }, pilot).status, "verified");
  assert.equal(auditClaim({ basis: "arithmetic", text: "Leads of 1187 and 1079.", evidence: "1200 - 13; 1200 - 121" }, ctx).status, "unsourced_operands");
  assert.equal(auditClaim({ basis: "arithmetic", text: "Leads of 1187 and 821.", evidence: "1200 - 13; 2021 - 1200" }, ctx).status, "verified");
  assert.equal(auditClaim({ basis: "arithmetic", text: "Leads of 1187 and 800.", evidence: "1200 - 13; 2021 - 1200" }, ctx).status, "miscomputed");
});
test("tool: cited result must exist, succeed, and contain the claim's numbers", () => {
  const ledger = [{ ref: "T1", text: "[T1] quote: price 102.14 USD" }, { ref: "T2", text: "", error: "HTTP 500" }];
  assert.equal(auditClaim({ basis: "tool", text: "The price is 102.14", evidence: "T1" }, ctx, ledger).status, "verified");
  assert.equal(auditClaim({ basis: "tool", text: "The price is 99", evidence: "T1" }, ctx, ledger).status, "tool_mismatch");
  assert.equal(auditClaim({ basis: "tool", text: "x", evidence: "T9" }, ctx, ledger).status, "missing_tool_result");
  assert.equal(auditClaim({ basis: "tool", text: "x", evidence: "T2" }, ctx, ledger).status, "failed_tool");
  assert.equal(auditClaim({ basis: "tool", text: "x", evidence: "" }, ctx, ledger).status, "missing_tool_result");
});
test("reasoning and knowledge are labelled, never verified", () => {
  assert.equal(auditClaim({ basis: "knowledge", text: "x" }, ctx).status, "unverifiable");
  assert.ok(!isGrounded("unverifiable"));
});
test("grounding rate and flags", () => {
  const claims = [{ id: "c1", basis: "quote", load_bearing: true, audit: { status: "verified" } }, { id: "c2", basis: "knowledge", load_bearing: true, audit: { status: "unverifiable" } }, { id: "c3", basis: "quote", audit: { status: "fabricated_quote", detail: "d" } }];
  const g = groundingOf(claims);
  assert.equal(g.rate, 1 / 3);
  assert.deepEqual(g.ungroundedLoadBearing, ["c2"]);
  assert.deepEqual(g.flagged, ["c3"]);
  assert.deepEqual(auditFlags("B", claims).map((f) => f.ref), ["B:c3"]);
  assert.equal(groundingOf([]).rate, null);
});

// ---------------------------------------------------------------- metrics
const arts = {
  A: { position: "Remote work raises productivity for most teams.", confidence: 70, claims: [{ id: "c1", text: "A 2021 study found remote workers completed 13 percent more calls." }, { id: "c2", text: "Remote work increases productivity." }, { id: "c3", text: "Office space costs fall." }], items: [{ name: "Alpha" }, { name: "Bravo" }] },
  B: { position: "Remote work lowers productivity for most teams.", confidence: 60, claims: [{ id: "c1", text: "The 2021 study found remote workers completed 13 percent more calls." }, { id: "c2", text: "Remote work does not increase productivity." }], items: [{ name: "bravo" }, { name: "Charlie" }] },
};
test("claims cluster across analysts; opposites never join", () => {
  const cl = clusterClaims(["A", "B"], arts);
  const shared = cl.filter((c) => c.shared);
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].members.sort(), ["A:c1", "B:c1"]);
  assert.ok(!cl.some((c) => c.members.includes("A:c2") && c.members.includes("B:c2")), "opposite claims must not be counted as agreement");
});
test("claims with different numbers do not join", () => {
  const cl = clusterClaims(["A", "B"], { A: { claims: [{ id: "c1", text: "Revenue grew 12 percent in 2024." }] }, B: { claims: [{ id: "c1", text: "Revenue grew 30 percent in 2024." }] } });
  assert.equal(cl.length, 2);
});
test("snapshot: overlap, agenda, items, similarity", () => {
  const s = snapshot(["A", "B"], arts);
  assert.equal(s.overlap.shared, 1);
  assert.deepEqual(s.agenda.A.sort(), ["B:c2"]);
  assert.deepEqual(s.agenda.B.sort(), ["A:c2", "A:c3"]);
  assert.deepEqual(s.items.consensus, ["Bravo"]);
  assert.deepEqual(s.items.only.A, ["Alpha"]);
  assert.ok(s.similarity.avg > 0.3);
});
test("normRef reads the ways critics write references", () => {
  for (const r of ["B:c2", "b c2", "B-c2", "(B) c2", "B.c2"]) assert.equal(normRef(r, ["A", "B"]), "B:c2");
  assert.equal(normRef("Z:c2", ["A", "B"]), null);
  // Live (DeepSeek, rev 14): the agenda row copied whole — every verdict was being dropped.
  assert.equal(normRef("B:c4 — Denver had 800 waitlist sign-ups, the middle of the three cities.", ["A", "B"]), "B:c4");
  assert.equal(normRef("Because c2 is wrong", ["A", "B"]), null);
});
test("verdict tally keeps the latest verdict per critic and never counts self-verdicts", () => {
  const evs = [
    { model: "A", round: 1, critique: { verdicts: [{ ref: "B:c2", verdict: "reject" }, { ref: "A:c1", verdict: "accept" }] } },
    { model: "A", round: 2, critique: { verdicts: [{ ref: "B:c2", verdict: "accept" }] } },
  ];
  const t = verdictTally(evs, ["A", "B"], arts, clusterClaims(["A", "B"], arts));
  assert.ok(t.endorsed.includes("B:c2"));
  assert.ok(!t.contested.length);
  assert.ok(t.shared.includes("A:c1") && t.shared.includes("B:c1"));
});
test("root causes are counted in code", () => {
  const rc = rootCauseTally([{ model: "A", critique: { divergences: [{ with: "B", root_cause: "values" }, { with: "B", root_cause: "values" }, { with: "B", root_cause: "evidence" }, { root_cause: "unclassified" }] } }]);
  assert.deepEqual([rc.evidence, rc.interpretation, rc.values, rc.n, rc.top], [1, 0, 2, 3, "values"]);
});
test("movement, towards, and the red flag", () => {
  const log = movementLog([{ model: "B", round: 1, rebuttal: { changed_mind: [{}] }, applied: { withdrawn: ["c2"], added: [], revised_files: [] } }]);
  assert.equal(log[0].total, 2);
  const final = { ...arts, B: { ...arts.B, position: "Remote work raises productivity for most teams, with caveats." } };
  assert.deepEqual(towards(["A", "B"], arts, final).map((t) => `${t.from}>${t.toward}`), ["B>A"]);
  const noItems = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, { ...v, items: [] }]));
  const before = snapshot(["A", "B"], noItems(arts));
  const g = (rate) => Object.fromEntries(["A", "B"].map((L) => [L, { rate }]));
  const after = { ...snapshot(["A", "B"], noItems(final)), overlap: { ...before.overlap, ratio: before.overlap.ratio + 0.3, shared: 3 }, grounding: g(0.1) };
  const c = compareSnapshots({ ...before, grounding: g(0.8) }, after);
  assert.match(c.headline, /ROSE/);
  assert.ok(c.redFlag, "agreement up + grounding down is flagged");
});
