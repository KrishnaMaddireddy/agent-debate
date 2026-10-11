// Deterministic stand-in analysts for tests, demos and dry runs. No network. They read the REAL
// prompts (phase markers, documents, agenda rows, questions put to them) and answer in the
// protocol's shapes, so a mock run exercises prompt construction, parsing, every guard, the audit
// and the metrics end to end. Browser-safe.
//
// Model ids select behaviour:
//   mock-1, mock-2      cooperative analysts arguing FOR (mock-2 picks slightly different evidence)
//   mock-alt            argues AGAINST; changes its mind in round 1 (withdraws a claim, adds one)
//   mock-3              undecided / mixed
//   mock-liar           fabricates a quote and miscomputes a number
//   mock-empty          returns nothing                → absent
//   mock-fail           throws                          → absent (phase 1) / fail-soft later
//   mock-template       copies the schema placeholders  → absent / rows dropped
//   mock-prose          answers in prose; repairs to JSON when asked
//   mock-reasoning      leaves the answer in the reasoning channel
//   mock-cot            writes chain of thought instead of a memo
//   mock-greedy         keeps calling tools past its budget
//   mock-dsml           calls tools in DeepSeek's DSML dialect
//   mock-slow           waits 4 s per call (for Stop)
//   mock-svg            files deliverable with a page and an SVG chart
import { MARK } from "./prompts.js";

export const MOCK_MODELS = ["mock-1", "mock-2", "mock-alt", "mock-3", "mock-liar", "mock-empty", "mock-fail", "mock-template", "mock-prose", "mock-reasoning", "mock-cot", "mock-greedy", "mock-dsml", "mock-slow", "mock-svg"];

const POOL = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "November"];
const WAIT = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
});

const docsOf = (u) => [...String(u).matchAll(/<<<(D\d+) "[^"]*" \(\d+ words\)\n([\s\S]*?)\n\1>>>/g)].map((m) => ({ id: m[1], text: m[2] }));
const questionOf = (u) => (String(u).match(/QUESTION \(verbatim\): "([\s\S]*?)"(?:\n|$)/) || String(u).match(/The question, verbatim: "([\s\S]*?)"(?:\n|$)/) || [, "the question"])[1];
const letterOf = (s) => (String(s).match(/You are Analyst ([A-F])/) || [, "A"])[1];
const topicOf = (q) => q.replace(/[?."]/g, "").split(/\s+/).filter((w) => w.length > 3 && !/^(does|should|would|could|what|which|when|where|whether|make|makes|there|their|about|with|from|than|that|this|these|those|most|more)$/i.test(w)).slice(0, 3).join(" ").toLowerCase() || "the proposal";
const sentencesOf = (t) => String(t).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 30);
const numbersOfDocs = (docs) => docs.flatMap((d) => [...d.text.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((m) => Number(m[0]))).filter((n) => n > 1);

function stanceOf(model) {
  if (/alt/.test(model)) return "against";
  if (/mock-3/.test(model)) return "mixed";
  return "for";
}
const STANCE_WORDS = {
  for: "positive: the benefits clearly outweigh the costs",
  against: "negative: the costs clearly outweigh the benefits",
  mixed: "mixed: benefits and costs roughly balance",
};

function intentReply(user) {
  const q = questionOf(user);
  const count = (q.match(/\b(?:top|which|best|list|name|pick)\s+(\d{1,2})\b/i) || q.match(/\b(\d{1,2})\s+(?:items|books|tools|ideas|options|names|cities|places)\b/i) || [])[1];
  const future = /\b(will|likely|future|next|forecast|predict)\b/i.test(q);
  return JSON.stringify({
    reading: `Whether ${topicOf(q)} holds up, judged on the evidence available here.`,
    sub_questions: [{ id: "q1", text: `What does the evidence say about ${topicOf(q)}?` }, { id: "q2", text: "What are the main costs and risks?" }],
    testable: ["What the attached documents state", "Arithmetic on figures the documents give"],
    not_testable: future ? ["Anything about what will happen next — no evidence here holds the future"] : ["Private facts about the asker's situation"],
    proxies: future ? ["Recent trend in the figures the documents give"] : [],
    gates: [],
    terms: [`${topicOf(q)} — read in its ordinary sense`],
    count: count ? Number(count) : null,
    horizon: /next month/i.test(q) ? "one month" : null,
    caveat: "A confident argument is not the same as a settled question.",
  });
}

function answerArtifact(model, system, user) {
  const L = letterOf(system);
  const q = questionOf(user);
  const topic = topicOf(q);
  const stance = stanceOf(model);
  const docs = docsOf(user);
  const sents = docs.flatMap((d) => sentencesOf(d.text).map((s) => ({ id: d.id, s })));
  const nums = numbersOfDocs(docs);
  const results = [...String(user).matchAll(/^\[(T\d+)\] /gm)].map((m) => m[1]);
  const claims = [];
  let n = 0;
  const add = (c) => claims.push({ id: `c${++n}`, source: "", evidence: "", load_bearing: false, ...c });
  if (sents.length) {
    add({ text: `The documents state: ${sents[0].s}`, basis: "quote", evidence: sents[0].s, source: sents[0].id, load_bearing: true });
    const own = sents[Math.min(sents.length - 1, model === "mock-2" ? 2 : stance === "against" ? 1 : stance === "mixed" ? 3 : 1)];
    if (own && own !== sents[0]) add({ text: `A second passage matters here: ${own.s}`, basis: "quote", evidence: own.s, source: own.id });
  }
  if (model === "mock-liar") {
    add({ text: `The documents say ${topic} doubles productivity overnight.`, basis: "quote", evidence: "This passage was never in any attached document at all, anywhere.", source: "D1", load_bearing: true });
    add({ text: "The total comes to 999.", basis: "arithmetic", evidence: "2 + 2" });
  }
  if (nums.length >= 2 && model !== "mock-liar") {
    const [a, b] = nums;
    add({ text: `The difference between the two figures is ${Math.round((b - a) * 100) / 100}.`, basis: "arithmetic", evidence: `${b} - ${a}` });
  }
  if (results.length) add({ text: `The search results bear on ${topic}.`, basis: "tool", evidence: results[0] });
  add({ text: `On balance the effect of ${topic} is ${stance === "for" ? "positive for most people" : stance === "against" ? "negative for most people" : "mixed across groups"}.`, basis: "knowledge", load_bearing: true });
  add({ text: stance === "for" ? `The benefits of ${topic} outweigh its costs.` : stance === "against" ? `The costs of ${topic} outweigh its benefits.` : `The costs and benefits of ${topic} roughly balance.`, basis: "reasoning", load_bearing: true });
  const count = Number((String(user).match(/Number of items asked for: (\d+)/) || [])[1]) || 0;
  const offset = stance === "against" ? 3 : model === "mock-2" ? 1 : 0;
  const items = count ? POOL.slice(offset, offset + count).map((name) => ({ name, why: `fits ${topic}`, claims: ["c1"] })) : [];
  const subs = Object.fromEntries([...String(user).matchAll(/^\s+- (q\d+): /gm)].map((m) => [m[1], `Answer to ${m[1]} from Analyst ${L}.`]));
  return {
    position: `Analyst ${L}: the answer on ${topic} is ${STANCE_WORDS[stance]}.`,
    confidence: stance === "for" ? 70 : stance === "against" ? 60 : 50,
    claims, items,
    assumptions: ["Judged on the attached evidence first, background knowledge second."],
    counter_considerations: [stance === "for" ? "The costs may be larger for some groups." : "Some groups clearly benefit."],
    what_would_change_my_mind: ["A controlled study with the opposite result."],
    sub_answers: subs,
  };
}

function critiqueReply(model, system, user) {
  const me = letterOf(system);
  const round = Number((system.match(/round (\d+)/) || [, 1])[1]);
  const others = [...String(user).matchAll(/ANSWER OF ANALYST ([A-F]):\n(\{[^\n]*\})/g)].map((m) => { let v = {}; try { v = JSON.parse(m[2]); } catch { /* keep empty */ } return { letter: m[1], view: v }; });
  const stanceIn = (t) => (/positive/.test(t) ? "for" : /negative/.test(t) ? "against" : "mixed");
  const mine = stanceOf(model);
  const agenda = [...String(user).matchAll(/^\s+- ([A-F]:c\d+) — "([\s\S]*?)" \[basis: (\w+); audit: ([\w_]+)\]$/gm)].map((m) => ({ ref: m[1], basis: m[3], audit: m[4] }));
  const verdicts = agenda.map((a) => {
    const other = others.find((o) => o.letter === a.ref[0]);
    const same = other && stanceIn(other.view.position || "") === mine;
    const verdict = /^verified/.test(a.audit) ? "accept" : /fabricated|miscomputed|missing|mismatch|failed|unsourced|too_short|no_documents|no_stated/.test(a.audit) ? "reject" : same ? "accept" : mine === "mixed" ? "unresolved" : "reject";
    return { claim: a.ref, verdict, why: `${verdict === "accept" ? "Consistent with" : "Not supported by"} what I found (audit: ${a.audit}).` };
  });
  const causes = ["evidence", "interpretation", "values"];
  const divergences = others.filter((o) => stanceIn(o.view.position || o.view.approach || "") !== mine).map((o, i) => ({
    with: o.letter, topic: "overall direction", mine: STANCE_WORDS[mine], theirs: o.view.position || o.view.approach || "", root_cause: causes[("ABCDEF".indexOf(me) + i + round) % 3], detail: "We weigh the same costs differently.",
  }));
  if (/Judge them against the question/.test(system) && others.length) divergences.push({ with: others[0].letter, topic: "print styles", mine: "needed", theirs: "absent", root_cause: "values", detail: "One page has no print stylesheet." });
  const agreements = others.filter((o) => stanceIn(o.view.position || "") === mine).map((o) => `Analyst ${o.letter} and I agree on the direction.`);
  const q = others.find((o) => stanceIn(o.view.position || o.view.approach || "") !== mine);
  return JSON.stringify({ agreements, divergences, verdicts, questions: q ? [{ to: q.letter, question: `What evidence would change your view, Analyst ${q.letter}?` }] : [] });
}

function rebuttalReply(model, system, user) {
  const me = letterOf(system);
  const round = Number((system.match(/round (\d+)/) || [, 1])[1]);
  const docs = docsOf(user);
  const qs = [...String(user).matchAll(/^\s+- from Analyst ([A-F]): (.*)$/gm)].map((m) => ({ to: m[1], question: m[2], answer: "A controlled study would; I cite the documents where I can." }));
  const files = /revise them: write the JSON first/.test(system);
  const current = (() => { const m = String(user).match(/YOUR CURRENT ANSWER \(Analyst [A-F]\):\n(\{[^\n]*\})/); try { return JSON.parse(m[1]); } catch { return {}; } })();
  if (model === "mock-alt" && round === 1) {
    const know = (current.claims || []).find((c) => c.basis === "knowledge");
    const sent = docs.flatMap((d) => sentencesOf(d.text).map((s) => ({ id: d.id, s })))[0];
    const body = {
      answers: qs,
      changed_mind: [{ topic: "overall direction", from: "negative", to: "mixed", because: "The shared quote is stronger evidence than I allowed." }],
      stand_by: ["The costs are real for some groups."],
      withdrawn_claims: know ? [know.id] : [],
      new_claims: sent ? [{ text: `The documents also note: ${sent.s}`, basis: "quote", evidence: sent.s, source: sent.id, load_bearing: false }] : [],
      final_position: `Analyst ${me}: on reflection the answer is mixed, leaning positive: the benefits may outweigh the costs for most people.`,
      final_confidence: 55,
      final_items: [],
    };
    return JSON.stringify(body);
  }
  if (files && model === "mock-2" && round === 1) {
    return `${JSON.stringify({ answers: qs, changed_mind: [{ topic: "print styles", from: "none", to: "added", because: "A reviewer asked for them." }], stand_by: [], withdrawn_claims: [], new_claims: [], final_position: "Same page, now with print styles.", final_confidence: null, final_items: [] })}\n\n\`\`\`html file=index.html\n<!doctype html><html><head><meta charset="utf-8"><title>Revised</title><style>@media print{header{border:0}}</style></head><body><h1>Revised page</h1></body></html>\n\`\`\``;
  }
  return JSON.stringify({ answers: qs, changed_mind: [], stand_by: ["My position stands on the evidence I cited."], withdrawn_claims: [], new_claims: [], final_position: "", final_confidence: null, final_items: [] });
}

function memoReply(model, user) {
  if (model === "mock-cot") return "Let me think about this carefully. Wait — first I need to check the facts. Hmm.";
  const facts = (String(user).match(/CODE-COMPUTED FACTS[^\n]*\n([\s\S]*?)\n\n/) || [, ""])[1].split("\n").length;
  return `## Where they agree\nThe analysts share the quoted evidence.\n\n## Where they still disagree\nThe overall direction [values].\n\n## What moved during the debate\nSee the code-computed diff (${facts} facts supplied).\n\n## Claims to treat with care\nEvery ungrounded load-bearing claim listed in the facts.\n\n## Open questions\nWhat a controlled study would show.`;
}

function filesReply(model, user) {
  const q = questionOf(user);
  if (model === "mock-svg") return `A page plus a chart.\n\n\`\`\`html file=index.html\n<!doctype html><html><head><meta charset="utf-8"><title>With chart</title></head><body><h1>Alex Example</h1><img src="chart.svg" alt="chart" width="320"></body></html>\n\`\`\`\n\n\`\`\`svg file=chart.svg\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="#eef"/><rect x="10" y="20" width="200" height="20" fill="#36c"/></svg>\n\`\`\``;
  const accent = /alt/.test(model) ? "#9A2F2F" : "#1E7A57";
  return `A single-column page for "${q.slice(0, 40)}" with the title as the hero.\n\n\`\`\`html file=index.html\n<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${model}</title><style>body{font-family:system-ui;margin:0}header{padding:32px;border-bottom:4px solid ${accent}}</style></head>\n<body><header><h1>${q.slice(0, 60).replace(/</g, "&lt;")}</h1></header><main style="padding:32px"><p>Made by ${model}.</p></main></body></html>\n\`\`\``;
}

function templateCopy(text) {
  const m = String(text).match(/\{"(?:position|agreements|answers|reading)"[\s\S]*$/);
  return m ? m[0].replace(/:\s*<([^>]*)>/g, ':"<$1>"').split(/\n\n/)[0] : "{}";
}

/** One mock model call. Returns {text, reasoningText?, truncated?}. */
export async function mockReply({ model = "mock-1", system = "", user = "", signal } = {}) {
  if (model === "mock-slow") await WAIT(4000, signal);
  if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  if (model === "mock-fail") throw new Error("mock provider down");
  if (model === "mock-empty") return { text: "" };
  if (system.startsWith(MARK.repair)) {
    if (/"reading"/.test(user.slice(0, 1500))) return { text: intentReply(user) };
    if (/Required shape[\s\S]{0,200}"agreements"/.test(user)) return { text: JSON.stringify({ agreements: ["Recovered from prose."], divergences: [], verdicts: [], questions: [] }) };
    if (/Required shape[\s\S]{0,200}"answers"/.test(user)) return { text: JSON.stringify({ answers: [], changed_mind: [], stand_by: ["Recovered from prose."], withdrawn_claims: [], new_claims: [], final_position: "", final_confidence: null, final_items: [] }) };
    if (model === "mock-template") return { text: templateCopy(user) };
    return { text: JSON.stringify({ position: "Recovered from my own prose: the benefits outweigh the costs, with caveats.", confidence: 55, claims: [{ id: "c1", text: "My prose argued the benefits outweigh the costs.", basis: "reasoning", evidence: "", source: "", load_bearing: true }], items: [], assumptions: [], counter_considerations: [], what_would_change_my_mind: [], sub_answers: {} }) };
  }
  if (model === "mock-template" && !system.startsWith(MARK.memo)) return { text: templateCopy(system) };
  if (system.startsWith(MARK.intent)) return { text: intentReply(user) };
  if (system.startsWith(MARK.answer)) {
    if (/Your deliverable is one or more FILES/.test(system)) return { text: model === "mock-empty-files" ? "Prose only." : filesReply(model, user) };
    const offered = String(user).match(/=== TOOLS[^\n]*\n- ([a-z0-9_.]+)\(/);
    const calls = (String(user).match(/^\[T\d+\] /gm) || []).length;
    if (offered && (calls === 0 || (model === "mock-greedy" && !/budget for this phase is spent/.test(user)))) {
      if (model === "mock-dsml") return { text: `<｜DSML｜function_calls><｜DSML｜invoke name="${offered[1]}"><｜DSML｜parameter name="query" string="true">${topicOf(questionOf(user))}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>` };
      return { text: JSON.stringify({ tool: offered[1], args: offered[1] === "calculate" ? { expression: "6*7" } : offered[1] === "fetch_url" ? { url: "https://example.org/mock" } : { query: `${topicOf(questionOf(user))} evidence ${calls + 1}` } }) };
    }
    const art = answerArtifact(model, system, user);
    if (model === "mock-prose") return { text: `(Analyst ${letterOf(system)}) I think the benefits outweigh the costs, but I will not write JSON.` };
    if (model === "mock-reasoning") return { text: "", reasoningText: `Thinking... ${JSON.stringify(art)}` };
    return { text: `Here is my answer.\n${JSON.stringify(art)}` };
  }
  if (system.startsWith(MARK.critique)) return { text: critiqueReply(model, system, user) };
  if (system.startsWith(MARK.rebuttal)) return { text: rebuttalReply(model, system, user) };
  if (system.startsWith(MARK.memo)) return { text: memoReply(model, user) };
  return { text: `[${model}] ${user.slice(0, 80)}` };
}
