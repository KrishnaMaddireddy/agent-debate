#!/usr/bin/env node
// Ten questions of different kinds through the whole pipeline — server options, engine, audit, diff,
// memo, run files — each with the checks that kind of question should pass. Writes
// docs/TEST_MATRIX_QUESTIONS.md.
//
//   node tests/matrix.mjs                         mock models, temporary config dir (free, deterministic)
//   node tests/matrix.mjs --live deepseek/deepseek-chat,claude/sonnet
//                                                 the same ten questions against models YOU enabled in
//                                                 Settings; refused before any call otherwise. Metered
//                                                 providers bill you: roughly 10 × (1 + 3n) calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const liveArg = argv.includes("--live") ? argv[argv.indexOf("--live") + 1] : null;
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",").map(Number) : null;
if (!liveArg) process.env.DEBATE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ad-matrix-"));

const { loadEnv, ensureProvidersFile, chat } = await import("../app/server/config.js");
const { runOptionsFrom } = await import("../app/server/server.js");
const { startRun } = await import("../app/server/runs.js");
const { runTool } = await import("../app/server/tools.js");
loadEnv();
ensureProvidersFile();

const live = liveArg ? liveArg.split(",").map((s) => { const [provider, ...r] = s.split("/"); return { provider, model: r.join("/") }; }) : null;
const pick = (mocks) => (live ? mocks.map((_, i) => live[i % live.length]) : mocks.map((model) => ({ provider: "mock", model })));

const BUDGET = "The pilot budget is 450000 dollars. Each city costs 150000 dollars to launch, so the budget covers three cities. Austin had 1200 waitlist sign-ups and Denver had 800 sign-ups last year. Boise had 300.";
const POLICY = "Section 4.2: Remote employees may work from any country for up to 30 days per calendar year. Section 4.3: Work from a country without a company entity requires written approval from Legal at least 14 days in advance.";
const CODE = "function median(xs) {\n  const s = xs.sort();\n  const m = Math.floor(s.length / 2);\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}";

const ok = (cond, msg) => (cond ? null : msg);
const grounded = (rec) => Object.values(rec.artifacts).reduce((n, a) => n + (a.grounding?.verified || 0), 0);
const claims = (rec) => Object.values(rec.artifacts).reduce((n, a) => n + (a.grounding?.total || 0), 0);
const common = (rec) => [
  ok(rec.status === "done", `status ${rec.status}`),
  ok(rec.intent?.expansion?.reading, "no intent reading"),
  ok(rec.final?.compare?.headline, "no post-debate headline"),
  ok(rec.synthesis?.memo, `no memo${rec.synthesis?.error ? `: ${rec.synthesis.error}` : ""}`),
];

const CASES = [
  { kind: "decision from a document, with arithmetic", question: "Which 3 cities should we pilot in first?", mocks: ["mock-1", "mock-alt"], rounds: 1, docs: [{ name: "budget.md", text: BUDGET }],
    expect: (r) => [ok(grounded(r) > 0, "no claim was grounded against the document")] },
  { kind: "open question, no documents, three analysts", question: "Is remote work better for junior engineers than office work?", mocks: ["mock-1", "mock-alt", "mock-3"], rounds: 2,
    expect: (r) => [ok(Object.keys(r.artifacts).length === 3, "not all three answered"), ok(r.final.snapshot.clusters.length > 0, "no claim clusters")] },
  { kind: "policy reading with a lens", question: "Can an employee work from Portugal for 3 weeks without approval?", mocks: ["mock-2", "mock-alt"], rounds: 1, docs: [{ name: "policy.md", text: POLICY }], persona: "security-reviewer",
    expect: (r) => [ok(/security reviewer/i.test(r.config.persona?.name || ""), "persona not applied"), ok(r.prompts.filter((p) => p.phase !== "intent").every((p) => /security reviewer/i.test(p.system + p.user)), "lens missing from a prompt")] },
  { kind: "code review", question: "Is this median function correct for arrays of numbers?", mocks: ["mock-1", "mock-3"], rounds: 1, docs: [{ name: "median.js", text: CODE }], skills: ["technical-review"],
    expect: (r) => [ok(r.config.skills?.some((s) => (s.name || s) === "technical-review"), "skill not recorded in config")] },
  { kind: "a fabricating analyst is caught by the audit", question: "How many sign-ups did Austin have?", mocks: ["mock-1", "mock-liar"], rounds: 1, docs: [{ name: "budget.md", text: BUDGET }],
    expect: (r) => { const liar = Object.values(r.artifacts).find((a) => (a.artifact.claims || []).some((c) => /fabricated/.test(c.audit?.status || ""))); return [ok(liar, "no fabricated quote was flagged")]; } },
  { kind: "absent analysts are excluded, not counted as disagreement", question: "Should a small team adopt a monorepo?", mocks: ["mock-1", "mock-empty", "mock-fail", "mock-2"], rounds: 1,
    expect: (r) => [ok(Object.keys(r.absent).length === 2, `absent: ${Object.keys(r.absent).join(",") || "none"}`), ok(r.gate?.present?.length === 2, "gate did not keep the two who answered")] },
  { kind: "misbehaving formats: template copy, prose, reasoning channel; the reading falls back", question: "Is a four-day work week good for productivity?", mocks: ["mock-template", "mock-prose", "mock-reasoning"], rounds: 1,
    expect: (r) => [ok(r.template_copies.length > 0, "template copy not detected"), ok(r.intent?.fallback_from, "the reading did not fall back to the next analyst"), ok(r.retries.length > 0, "no JSON repair attempted"), ok(Object.values(r.artifacts).some((a) => a.notes.some((n) => /reasoning channel/.test(n))), "reasoning channel not recovered")] },
  { kind: "tools: calculator, a greedy caller and a DSML caller", question: "What is 17.5% of 2,340,000 and is it above 400,000?", mocks: ["mock-greedy", "mock-dsml"], rounds: 0, tools: ["calculate"],
    expect: (r) => { const calls = Object.values(r.tools).flat(); return [ok(calls.length > 0, "no tool ran"), ok(Object.values(r.tools).every((l) => l.length <= 12), "turn budget exceeded")]; } },
  { kind: "files deliverable", question: "A one-page site announcing the pilot, with a chart", mocks: ["mock-svg", "mock-2"], rounds: 1, deliverable: "files",
    expect: (r) => [ok(Object.values(r.current).some((a) => (a.files || []).length > 0), "no files produced")] },
  { kind: "memo writer that leaks its reasoning is retried", question: "Should we raise prices by 10% next quarter?", mocks: ["mock-1", "mock-alt"], rounds: 3, synthesizer: { provider: "mock", model: "mock-cot" },
    expect: (r) => [ok(r.memo_retry || r.synthesis?.flag, "chain-of-thought memo not caught"), ok(r.final.rounds_run <= 3, "ran past the round limit")] },
];

const rows = [];
for (const [i, c] of CASES.entries()) {
  if (only && !only.includes(i + 1)) continue;
  const t0 = Date.now();
  let rec, id, err;
  try {
    const synth = live && c.synthesizer ? undefined : c.synthesizer;
    const { _catalog, ...opts } = await runOptionsFrom({ question: c.question, models: pick(c.mocks), rounds: c.rounds, docs: c.docs || [], persona: c.persona, skills: c.skills || [], tools: c.tools || [], deliverable: c.deliverable || "answer", synthesizer: synth });
    const started = startRun(opts, {
      call: ({ provider, model, system, user, maxTokens, signal, maxGrowth }) => chat({ provider, model, system, messages: [{ role: "user", content: user }], maxTokens, signal, maxGrowth }),
      callTool: ({ name, args }) => runTool(_catalog, name, args, { ctx: {} }),
    });
    id = started.id;
    rec = (await started.done).record;
  } catch (e) { err = e.message; }
  const problems = err ? [err] : live ? common(rec).filter(Boolean) : [...common(rec), ...c.expect(rec)].filter(Boolean);
  const files = id ? [".jsonl", ".json", ".md", ".meta.json"].filter((x) => fs.existsSync(path.join(process.env.DEBATE_CONFIG_DIR || path.join(ROOT, "local"), "runs", `${id}${x}`))).length : 0;
  if (id && files < 4) problems.push(`only ${files}/4 run files written`);
  rows.push({ n: i + 1, kind: c.kind, question: c.question, models: pick(c.mocks).map((m) => m.model).join(", "), ok: !problems.length, problems, rec, id, ms: Date.now() - t0 });
  process.stderr.write(`${problems.length ? "FAIL" : "pass"}  ${i + 1}. ${c.kind}${problems.length ? ` — ${problems.join("; ")}` : ""}\n`);
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const passed = rows.filter((r) => r.ok).length;
const lines = [
  `# Ten-question matrix — ${live ? `live: ${liveArg}` : "mock models"}`,
  "",
  `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · **${passed} / ${rows.length} passed** · \`node tests/matrix.mjs${live ? ` --live ${liveArg}` : ""}\``,
  "",
  "| # | kind | question | models | result | grounded | headline | guards |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => {
    const rec = r.rec;
    const guards = rec ? [rec.retries.length && `${rec.retries.length} JSON repair`, rec.template_copies.length && `${rec.template_copies.length} template copy`, Object.keys(rec.absent).length && `${Object.keys(rec.absent).length} absent`, rec.memo_retry && "memo retry", rec.auto_stop && `auto-stop after ${rec.auto_stop.after_round}`].filter(Boolean).join(", ") : "";
    return `| ${r.n} | ${cell(r.kind)} | ${cell(r.question)} | ${cell(r.models)} | ${r.ok ? "pass" : `**FAIL** ${cell(r.problems.join("; "))}`} | ${rec ? `${grounded(rec)}/${claims(rec)}` : ""} | ${cell(rec?.final?.compare?.headline)} | ${cell(guards) || "—"} |`;
  }),
  "",
  "## Intent, as read",
  "",
  ...rows.filter((r) => r.rec?.intent).flatMap((r) => [`**${r.n}. ${cell(r.question)}** — ${cell(r.rec.intent.expansion.reading)}`, ""]),
];
const outFile = path.join(ROOT, "docs", live ? "TEST_MATRIX_LIVE.md" : "TEST_MATRIX_QUESTIONS.md");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join("\n") + "\n");
process.stderr.write(`\n${passed}/${rows.length} passed → ${path.relative(ROOT, outFile)}\n`);
if (!liveArg) fs.rmSync(process.env.DEBATE_CONFIG_DIR, { recursive: true, force: true });
process.exit(passed === rows.length ? 0 : 1);
