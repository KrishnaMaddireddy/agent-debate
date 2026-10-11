#!/usr/bin/env node
// The same engine from a terminal. Writes the run to local/runs/ exactly as the console does, so it
// shows up in the console's history and can be replayed there.
//
//   node app/cli.js --question "Should we adopt X?" --model deepseek/deepseek-chat --model claude/sonnet \
//        [--rounds 1] [--context proposal.md --context numbers.pdf] [--persona cautious-cfo]
//        [--skills auto | --skills evaluate-evidence,policy-tradeoffs] [--tools web_search,fetch_url]
//        [--files] [--expander A | provider/model] [--synthesizer A | provider/model | none]
//        [--no-expand] [--no-auto-stop] [--allow-large-context] [--budget 0.50] [--out report.md] [--html report.html] [--json] [--quiet]
//   node app/cli.js --scorecard [--include-mock] [--json]      how each model has done across your saved runs
import fs from "node:fs";
import path from "node:path";
import { loadEnv, ensureProvidersFile, loadProviders } from "./server/config.js";
import { runOptionsFrom } from "./server/server.js";
import { startRun } from "./server/runs.js";
import { chat } from "./server/config.js";
import { runTool } from "./server/tools.js";
import { renderReport } from "./core/record.js";
import { pdfText } from "./server/pdf-text.js";

function parseArgs(argv) {
  const a = { models: [], context: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x == null) throw new Error(`${k} needs a value`); return x; };
    if (k === "--question" || k === "-q") a.question = v();
    else if (k === "--model" || k === "-m") a.models.push(v());
    else if (k === "--models") a.models.push(...v().split(",").map((s) => s.trim()).filter(Boolean));
    else if (k === "--rounds") a.rounds = Number(v());
    else if (k === "--context" || k === "-c") a.context.push(v());
    else if (k === "--persona") a.persona = v();
    else if (k === "--skills") a.skills = v();
    else if (k === "--tools") a.tools = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--expander") a.expander = v();
    else if (k === "--synthesizer") a.synthesizer = v();
    else if (k === "--out") a.out = v();
    else if (k === "--html") a.html = v();
    else if (k === "--budget") a.budget = Number(v());
    else if (k === "--help" || k === "-h") a.flags.add("help");
    else if (k.startsWith("--")) a.flags.add(k.slice(2));
    else if (!a.question) a.question = k;
    else throw new Error(`unexpected argument "${k}"`);
  }
  return a;
}

const role = (s) => {
  if (!s) return undefined;
  if (s === "none" || /^[A-F]$/i.test(s)) return s.toUpperCase() === "NONE" ? "none" : s.toUpperCase();
  const [provider, ...rest] = s.split("/");
  return { provider, model: rest.join("/") };
};

function readContext(file) {
  const buf = fs.readFileSync(file);
  if (/\.pdf$/i.test(file) || buf.subarray(0, 5).toString() === "%PDF-") {
    const r = pdfText(buf);
    if (!r.pages.length) throw new Error(`${file}: ${r.note}`);
    return r.pages.map((p, i) => `[page ${i + 1}]\n${p}`).join("\n\n");
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.flags.has("scorecard")) {
    const { allRecords } = await import("./server/runs.js");
    const { scorecard, scorecardMarkdown } = await import("./core/scorecard.js");
    const card = scorecard(allRecords(), { includeMock: a.flags.has("include-mock") });
    process.stdout.write(a.flags.has("json") ? JSON.stringify(card, null, 1) : `${scorecardMarkdown(card)}\n`);
    return;
  }
  if (a.flags.has("help") || !a.question) {
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(a.question ? 0 : 1);
  }
  loadEnv();
  ensureProvidersFile();
  const cfg = loadProviders();
  if (!a.models.length) {
    const d = cfg.default;
    if (!d) throw new Error("no --model given and no default provider");
    a.models.push(`${d.provider}/${d.model}`, `${d.provider}/${d.model}`);
  }
  const body = {
    question: a.question,
    models: a.models.map((s) => { const [provider, ...rest] = s.split("/"); return { provider, model: rest.join("/") }; }),
    rounds: a.rounds ?? 1,
    deliverable: a.flags.has("files") ? "files" : "answer",
    docs: a.context.map((f) => ({ name: path.basename(f), text: readContext(f) })),
    persona: a.persona,
    skills: a.skills === "auto" ? "auto" : a.skills ? a.skills.split(",").map((s) => s.trim()) : [],
    tools: a.tools || [],
    expand: !a.flags.has("no-expand"),
    autoStop: !a.flags.has("no-auto-stop"),
    expander: role(a.expander),
    synthesizer: role(a.synthesizer),
    allowLargeContext: a.flags.has("allow-large-context"),
    ...(a.budget != null ? { budgetUsd: a.budget } : {}),
  };
  const { _catalog, ...opts } = await runOptionsFrom(body);
  const quiet = a.flags.has("quiet") || a.flags.has("json");
  const say = (s) => { if (!quiet) process.stderr.write(`${s}\n`); };
  const t0 = Date.now();
  const clock = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  const onEvent = (ev) => {
    if (ev.type === "phase") say(`${clock()}  ── phase ${ev.n}: ${ev.name}${ev.round ? ` (round ${ev.round})` : ""}`);
    else if (ev.type === "intent") say(`${clock()}  read as: ${ev.expansion.reading}`);
    else if (ev.type === "intent_failed") say(`${clock()}  question reading failed: ${ev.error} — continuing without`);
    else if (ev.type === "tool_call") say(`${clock()}  ${ev.model} ${ev.ref} ${ev.name}(${JSON.stringify(ev.args).slice(0, 80)})`);
    else if (ev.type === "artifact") say(`${clock()}  ${ev.model} answered${ev.grounding ? ` — ${ev.grounding.total} claims, ${ev.grounding.verified} grounded` : ""}`);
    else if (ev.type === "absent") say(`${clock()}  ${ev.model} ABSENT — ${ev.reason}`);
    else if (ev.type === "critique") say(`${clock()}  ${ev.model} critique: ${ev.critique.divergences.length} divergence(s), ${ev.critique.verdicts.length} verdict(s)${ev.coverage.missed.length ? `, ${ev.coverage.missed.length} unargued` : ""}`);
    else if (ev.type === "rebuttal") say(`${clock()}  ${ev.model} rebuttal: ${ev.rebuttal ? `${ev.rebuttal.changed_mind.length} changed, ${ev.applied.withdrawn.length} withdrawn, ${ev.applied.added.length} added` : "failed — position kept"}`);
    else if (ev.type === "auto_stop") say(`${clock()}  auto-stop after round ${ev.after_round}: nobody moved`);
    else if (ev.type === "diff_final") say(`${clock()}  ${ev.compare.headline}${ev.compare.redFlag ? `  ⚠ ${ev.compare.redFlag}` : ""}`);
    else if (ev.type === "model_failed") say(`${clock()}  ${ev.model} failed in ${ev.phase}: ${ev.error}`);
    else if (ev.type === "crash") say(`${clock()}  CRASH: ${ev.message}`);
    else if (ev.type === "budget_stop") say(`${clock()}  SPENDING CAP: $${ev.spent.toFixed(4)} spent; the next call could cost up to $${ev.needed.toFixed(4)} — over the $${ev.cap} cap, so the run stops here`);
  };
  const { id, done } = startRun(opts, {
    onEvent,
    call: ({ provider, model, system, user, maxTokens, signal, maxGrowth }) => chat({ provider, model, system, messages: [{ role: "user", content: user }], maxTokens, signal, maxGrowth }),
    callTool: ({ name, args }) => runTool(_catalog, name, args, { ctx: {} }),
  });
  process.on("SIGINT", async () => { const { stopRun } = await import("./server/runs.js"); stopRun(id); });
  const { record } = await done;
  const report = renderReport(record);
  if (a.out) fs.writeFileSync(a.out, report);
  if (a.html) { const { reportHtml } = await import("./server/report-html.js"); fs.writeFileSync(a.html, reportHtml(id)); }
  if (a.flags.has("json")) process.stdout.write(JSON.stringify({ id, ...record }, null, 1));
  else if (!a.out) process.stdout.write(report);
  const { costLine } = await import("./core/record.js");
  say(`${clock()}  ${record.status} · ${costLine(record)} · run ${id} · report ${a.out || `local/runs/${id}.md`}`);
  process.exit(record.status === "done" ? 0 : record.status === "stopped" ? 130 : 2);
}

main().catch((e) => { console.error(`agent-debate: ${e.message}`); process.exit(1); });
