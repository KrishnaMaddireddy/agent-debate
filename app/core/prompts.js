// Every prompt the engine sends. Browser-safe.
//
// Rules this file keeps (PRD §12): typed placeholders only — the angle brackets are TYPE
// DESCRIPTIONS, never values a model could copy; identity anchoring in every phase ("You are
// Analyst B"); one shared reading of the question, handed to everyone including the memo writer;
// everything a model may use travels in the prompt, identically for every model.

import { FILES_RULES } from "./files.js";
import { toolsBlock } from "./tools-protocol.js";
import { clip, wordCount } from "./text.js";

export const LETTERS = ["A", "B", "C", "D", "E", "F"];
export const BASES = ["quote", "arithmetic", "tool", "reasoning", "knowledge"];
export const ROOT_CAUSES = ["evidence", "interpretation", "values"];
export const VERDICTS = ["accept", "reject", "unresolved"];

// Phase markers: plain headings a human reading the prompt understands, and a stable hook for the
// mock adapter and the tests.
export const MARK = {
  intent: "QUESTION READING.",
  answer: "PHASE 1 — INDEPENDENT ANSWER.",
  critique: "PHASE 2 — CROSS-CRITIQUE",
  rebuttal: "PHASE 3 — REBUTTAL",
  memo: "PHASE 4 — JOINT MEMO.",
  repair: "JSON REPAIR.",
};

// ---------------------------------------------------------------- phase 0: the question, as read

export const INTENT_KEYS = ["reading", "sub_questions", "testable", "not_testable", "proxies", "gates", "terms", "count", "horizon", "caveat"];

export const INTENT_SCHEMA = `{"reading":"<one or two sentences: what is actually being asked>",
 "sub_questions":[{"id":"<q1, q2, …>","text":"<a part every answer must address>"}],
 "testable":["<what can be settled here, and by what evidence>"],
 "not_testable":["<what cannot be settled here, and why>"],
 "proxies":["<a measurable stand-in for an untestable part>"],
 "gates":["<a hard condition the asker stated>"],
 "terms":["<term — the reading in use>"],
 "count":<integer, or null>,
 "horizon":"<time frame the asker stated, or null>",
 "caveat":"<one sentence>"}`;

export function intentPrompt(cfg) {
  const system = `${MARK.intent} Several AI analysts are about to answer the same question independently. Before they start, you set the terms: what is being asked, what can and cannot be settled, and what would count as evidence. You are NOT an analyst: do not answer the question, argue a side, or recommend anything. Output ONLY a JSON object.
RULES
- A prediction about the future, a private fact nobody here can see, or a matter of taste is NOT testable. Say so in not_testable and give the closest measurable proxy in proxies.
- testable: what documents, computation, tools or established evidence could settle — concrete, one angle per entry.
- sub_questions: 2 to 6 parts every answer must address, with ids q1, q2, ….
- gates: AT MOST 4 hard conditions every answer must meet — only constraints the asker actually stated (a budget, a platform, a jurisdiction). Never invent requirements; an empty list is normal.
- terms: words that need a definition before they can be argued, each with the reading in use.
- If the asker states a number of items, put it in count (an integer); a stated time frame goes in horizon. Otherwise null.
- caveat: ONE sentence every answer must carry — what it can and cannot promise.
- Be concrete and short. The angle brackets below are TYPE DESCRIPTIONS; a reply that copies them is rejected.
${INTENT_SCHEMA}`;
  const docs = cfg.docs.length ? `\n\nAttached documents every analyst will receive: ${cfg.docs.map((d) => `${d.id} "${d.name}" (${d.words} words)`).join("; ")}.` : "\n\nNo documents are attached.";
  const tools = cfg.tools.length ? `\nTools every analyst may use: ${cfg.tools.map((t) => t.name).join(", ")}.` : "\nNo tools: the analysts answer from the documents and their own knowledge.";
  const lens = cfg.persona ? `\nJudging lens for this run: ${cfg.persona.name} — ${cfg.persona.lens}` : "";
  return { system, user: `The question, verbatim: "${cfg.question}"${docs}${tools}${lens}\n\nRead it. JSON only.` };
}

/** The block every later prompt carries. Empty string when there is no reading. */
export function intentBlock(ask, x) {
  if (!x) return "";
  const li = (a) => (a?.length ? a.map((s) => `  - ${s}`).join("\n") : "  (none)");
  const subs = x.sub_questions?.length ? `\nSub-questions (answer each in "sub_answers", keyed by id):\n${x.sub_questions.map((q) => `  - ${q.id}: ${q.text}`).join("\n")}` : "";
  return `=== THE QUESTION, AS READ — one reading, shared by every analyst; do not re-interpret it ===
Asked: "${ask}"
Read as: ${x.reading}${subs}
Testable here (what evidence or computation can settle):
${li(x.testable)}
NOT testable here (say so in your answer — never pretend a proxy is the thing itself):
${li(x.not_testable)}
Proxies for the untestable parts:
${li(x.proxies)}
Gates every answer must satisfy:
${li(x.gates)}
Terms, and the reading in use:
${li(x.terms)}${x.count ? `\nNumber of items asked for: ${x.count}` : ""}${x.horizon ? `\nTime horizon stated: ${x.horizon}` : ""}${x.caveat ? `\nCarry this caveat into your assumptions, verbatim: "${x.caveat}"` : ""}
Every analyst received this identical reading, so what was meant is settled — argue about the answer.
=== end ===`;
}

// ---------------------------------------------------------------- shared briefing blocks

export function identityLine(cfg, m) {
  const others = cfg.models.filter((x) => x.letter !== m.letter).map((x) => x.letter);
  return `You are Analyst ${m.letter}, one of ${cfg.models.length} analysts (${cfg.models.map((x) => x.letter).join(", ")}). Each analyst is a different AI model answering the same question with exactly the same information; you are being compared, and the comparison is only fair if you use nothing but what this brief gives you. The others are ${others.join(", ") || "none"}.`;
}

export function lensBlock(persona) {
  if (!persona) return `=== STANDARDS ===\nNobody has told you what "good" means for this question. Before anything else, write the standards you are judging by into "assumptions", and say why. Do not silently import a house style.`;
  const li = (a) => (a?.length ? a.map((s) => `  - ${s}`).join("\n") : "");
  return `=== JUDGING LENS — ${persona.name} (identical for every analyst) ===
${persona.lens}${persona.standards?.length ? `\nStandards:\n${li(persona.standards)}` : ""}${persona.emphasize?.length ? `\nEmphasise:\n${li(persona.emphasize)}` : ""}${persona.avoid?.length ? `\nAvoid:\n${li(persona.avoid)}` : ""}
Judge by this lens, not by your own defaults — every analyst was given the same one, so differences between you are differences between models, not between lenses.`;
}

export const SKILLS_CHARS = 14000;
export function skillsBlock(skills) {
  if (!skills?.length) return "";
  let body = skills.map((s) => `--- ${s.name}: ${s.description}\n${s.body}`).join("\n\n");
  if (body.length > SKILLS_CHARS) body = `${body.slice(0, SKILLS_CHARS)}\n[house skills truncated]`;
  return `=== HOUSE SKILLS — procedures for this kind of question (identical for every analyst) ===\nFollow the ones that apply; say when you depart from one and why.\n\n${body}`;
}

export function docsBlock(docs) {
  if (!docs?.length) return "";
  return `=== ATTACHED DOCUMENTS (identical bytes for every analyst; quote them exactly) ===\n${docs.map((d) => `<<<${d.id} "${d.name}" (${d.words} words)\n${d.text}\n${d.id}>>>`).join("\n\n")}`;
}

// ---------------------------------------------------------------- phase 1: the independent answer

export const ARTIFACT_KEYS = ["position", "confidence", "claims", "items", "assumptions", "counter_considerations", "what_would_change_my_mind", "sub_answers"];

export const CLAIM_SCHEMA = `{"id":"<c1, c2, …>","text":"<one checkable statement>","basis":"<one of: quote, arithmetic, tool, reasoning, knowledge>","evidence":"<the exact passage | the expression | the tool result id | empty string>","source":"<document id for a quote, else empty string>","load_bearing":<true or false>}`;

export const ARTIFACT_SCHEMA = `{"position":"<your answer to the question, stated plainly in one paragraph>",
 "confidence":<integer 0-100: how likely you think your position is right>,
 "claims":[${CLAIM_SCHEMA}],
 "items":[{"name":"<the item's name only — its rank is its place in this list>","why":"<why it qualifies>","claims":["<ids of the claims supporting it>"]}],
 "assumptions":["<a standard or premise you rely on, and why>"],
 "counter_considerations":["<the strongest case against your position, argued in its own words>"],
 "what_would_change_my_mind":["<a specific fact or argument>"],
 "sub_answers":{"<sub-question id>":"<your answer to it>"}}`;

export const BASIS_RULES = `HOW YOUR CLAIMS ARE CHECKED — every claim declares its basis, and code checks it:
- "quote": evidence = a passage copied EXACTLY, character for character, from the attached documents; source = its document id (D1, D2, …). Code searches the documents for it. A quote that is not there is reported as FABRICATED under your letter. Use "…" only to join passages you copied exactly.
- "arithmetic": evidence = the expression, e.g. "(1450 - 1200) / 1200"; the claim text states the result. Code recomputes it and checks that the operands appear in the documents, the question or your tool results.
- "tool": evidence = the id of the tool result it comes from (T1, T2, …). Code checks that result exists and contains the claim's numbers.
- "reasoning": your own inference. Labelled as such; not verified.
- "knowledge": your background knowledge. Labelled as such; the memo will never present it as verified.
Use quote, arithmetic or tool whenever the material allows — your grounding rate is reported beside your answer. Never label knowledge as a quote. Mark a claim load_bearing: true when your position falls without it.`;

export function answerPrompt(cfg, m, { intent }) {
  const files = cfg.deliverable === "files";
  const count = intent?.count;
  const tail = files
    ? `${FILES_RULES}\nFirst write ONE short paragraph on the approach you took and the choices you made. Then the files. Do not describe the code afterwards.`
    : `${BASIS_RULES}
${count ? `The question asks for ${count} items: list them in "items" — fewer if fewer genuinely qualify (say why in assumptions); never pad the list with things you would not defend.` : `Leave "items" as [] unless the question asks for a list of things.`}
Be concrete: 3 to 12 claims. Say plainly what you do not know. Consider the best case against yourself before you settle.

YOUR FINAL MESSAGE MUST BE ONE JSON OBJECT and nothing else — not a report, not notes. This pipeline reads the JSON; prose scores as an empty answer however good it is. Think as long as you like; the last thing you write is the object below, starting with "{". The angle brackets are TYPE DESCRIPTIONS, not values — an answer that copies them is rejected:
${ARTIFACT_SCHEMA}`;
  const system = [
    `${MARK.answer} ${identityLine(cfg, m)}`,
    "Work independently: no other answer is visible to you, and yours will be checked by code, not judged by praise.",
    lensBlock(cfg.persona),
    skillsBlock(cfg.skills),
    tail,
  ].filter(Boolean).join("\n\n");
  const user = [
    `QUESTION (verbatim): "${cfg.question}"`,
    intentBlock(cfg.question, intent),
    docsBlock(cfg.docs),
    toolsBlock(cfg.tools, cfg.budget),
    "Begin.",
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

// ---------------------------------------------------------------- what another analyst sees of an answer

/** A compact, prompt-sized view of an artifact, with the code audit attached to each claim. */
export function artifactView(a, { withFiles = false } = {}) {
  if (!a) return null;
  if (withFiles || a.files) {
    return {
      approach: a.position,
      files: (a.files || []).map((f) => ({ name: f.name, bytes: f.bytes, content: clip(f.content, 8000) })),
    };
  }
  return {
    position: a.position,
    confidence: a.confidence,
    claims: (a.claims || []).map((c) => ({ id: c.id, text: c.text, basis: c.basis, evidence: clip(c.evidence, 400), source: c.source || undefined, load_bearing: c.load_bearing, audit: c.audit?.status })),
    items: a.items?.length ? a.items.map((i) => i.name) : undefined,
    assumptions: a.assumptions,
    counter_considerations: a.counter_considerations,
  };
}

// ---------------------------------------------------------------- phase 2: cross-critique

export const CRITIQUE_KEYS = ["agreements", "divergences", "verdicts", "questions"];

export const CRITIQUE_SCHEMA = `{"agreements":["<a point you share, naming the analysts>"],
 "divergences":[{"with":"<analyst letter>","topic":"<what it is about>","mine":"<your view>","theirs":"<their view>","root_cause":"<one of: evidence, interpretation, values>","detail":"<why you differ>"}],
 "verdicts":[{"claim":"<the claim reference only, such as B:c2>","verdict":"<one of: accept, reject, unresolved>","why":"<one sentence>"}],
 "questions":[{"to":"<analyst letter>","question":"<a pointed question>"}]}`;

export function critiquePrompt(cfg, m, { intent, round, mine, theirs, agenda, flags }) {
  const files = cfg.deliverable === "files";
  const agendaText = files ? "" : agenda.length
    ? `\n\nTHE AGENDA — code computed it; every row needs a verdict:\nThese claims were made by others and have no counterpart in your answer. For EACH one give a verdict: accept (you now think it is right), reject (you think it is wrong — say why), or unresolved (neither of you can settle it with what you have). "I did not consider it" is a real answer; say it and then judge the claim.\n${agenda.map((r) => `  - ${r.ref} — "${clip(r.text, 300)}" [basis: ${r.basis}; audit: ${r.audit}]`).join("\n")}`
    : `\n\nTHE AGENDA — code found no claim of theirs without a counterpart in yours. Still give verdicts on any of their claims you dispute.`;
  const flagText = files || !flags.length ? "" : `\n\nCODE AUDIT (computed from the documents and the tool ledgers, not from anyone's prose — treat as fact):\n${flags.map((f) => `  - ${f.ref} ${f.status}${f.detail ? ` — ${f.detail}` : ""}`).join("\n")}\nA fabricated quote, a miscomputed number or a missing tool result is a finding about evidence, not a difference of opinion.`;
  const system = `${MARK.critique} — round ${round}. ${identityLine(cfg, m)}
Below are the other analysts' current answers and your own. Your job is not to be agreeable. For every point where you and another analyst differ, say where and WHY, and classify the root cause as exactly one of:
  "evidence" — you rely on different facts or sources (one has a quote or result the other lacks, or relies on knowledge the other does not accept);
  "interpretation" — the same evidence, a different inference;
  "values" — the same inference, different priorities or criteria.
${files ? "These answers are files. Judge them against the question: requirements met or missed, correctness, robustness, accessibility, design choices." : "Give a verdict on every claim on your agenda (below)."} Ask at most 3 pointed questions, each addressed to one analyst.
Output ONLY JSON. The angle brackets are TYPE DESCRIPTIONS, not values:
${CRITIQUE_SCHEMA}`;
  const user = [
    `QUESTION (verbatim): "${cfg.question}"`,
    intentBlock(cfg.question, intent),
    cfg.persona ? lensBlock(cfg.persona) : "",
    docsBlock(cfg.docs),
    `YOUR ANSWER (you are Analyst ${m.letter}):\n${JSON.stringify(mine)}`,
    ...theirs.map((t) => `ANSWER OF ANALYST ${t.letter}:\n${JSON.stringify(t.view)}`),
  ].filter(Boolean).join("\n\n") + agendaText + flagText;
  return { system, user };
}

// ---------------------------------------------------------------- phase 3: rebuttal

export const REBUTTAL_KEYS = ["answers", "changed_mind", "stand_by", "withdrawn_claims", "new_claims", "final_position", "final_confidence", "final_items"];

export const REBUTTAL_SCHEMA = `{"answers":[{"to":"<analyst letter>","question":"<their question>","answer":"<your answer>"}],
 "changed_mind":[{"topic":"<what>","from":"<your earlier view>","to":"<your view now>","because":"<the argument or evidence that moved you>"}],
 "stand_by":["<a point you keep, and why>"],
 "withdrawn_claims":["<id of one of your own claims you no longer stand by, such as c3>"],
 "new_claims":[${CLAIM_SCHEMA}],
 "final_position":"<your position now, one paragraph>",
 "final_confidence":<integer 0-100>,
 "final_items":["<item name>"]}`;

export function rebuttalPrompt(cfg, m, { intent, round, mine, received, flags, budget }) {
  const files = cfg.deliverable === "files";
  const system = `${MARK.rebuttal} — round ${round}. ${identityLine(cfg, m)}
In the critiques below, "you" means YOU, Analyst ${m.letter}. In a critique row, "mine" is the CRITIC's view and "theirs" is YOURS. Your own current answer is included so that you answer from your own position, not the critic's.
Answer every question put to you. For each challenge either CHANGE YOUR MIND — say from what, to what, and because of what — or STAND BY your view and say why. A changed mind is not a defeat; an unexamined one is. Do not agree just to agree: code measures whether agreement rises while evidence falls, and reports it.
${files ? "If the critiques show your files miss a requirement or are wrong, you may revise them: write the JSON first, then output every revised file IN FULL as a named fence, exactly as in phase 1. Files you do not repeat stay as they were." : `Withdraw claims you no longer stand by, by id. New claims follow the same basis rules and are audited the same way; give them new ids.`}${budget ? `\nIf a factual dispute can be settled with a tool call, settle it: you have ${budget} call${budget === 1 ? "" : "s"}.` : ""}
Output ONLY JSON. The angle brackets are TYPE DESCRIPTIONS, not values:
${REBUTTAL_SCHEMA}`;
  const recv = [];
  if (received.divergences.length) recv.push(`DIVERGENCES RAISED WITH YOU:\n${received.divergences.map((d) => `  - Analyst ${d.from} on "${d.topic}" [${d.root_cause}]: their view (the critic's "mine"): ${d.mine} | your view as they read it: ${d.theirs} | ${d.detail}`).join("\n")}`);
  if (received.verdicts.length) recv.push(`VERDICTS ON YOUR CLAIMS:\n${received.verdicts.map((v) => `  - ${v.claim} — Analyst ${v.from}: ${v.verdict}${v.why ? ` — ${v.why}` : ""}`).join("\n")}`);
  if (received.questions.length) recv.push(`QUESTIONS PUT TO YOU:\n${received.questions.map((q) => `  - from Analyst ${q.from}: ${q.question}`).join("\n")}`);
  if (!recv.length) recv.push("Nobody raised a divergence, a verdict or a question with you this round. Confirm or adjust your answer.");
  const flagText = files || !flags.length ? "" : `\n\nCODE AUDIT OF YOUR CLAIMS (fact, not opinion):\n${flags.map((f) => `  - ${f.ref} ${f.status}${f.detail ? ` — ${f.detail}` : ""}`).join("\n")}`;
  const user = [
    `QUESTION (verbatim): "${cfg.question}"`,
    intentBlock(cfg.question, intent),
    cfg.persona ? lensBlock(cfg.persona) : "",
    docsBlock(cfg.docs),
    `YOUR CURRENT ANSWER (Analyst ${m.letter}):\n${JSON.stringify(mine)}`,
    recv.join("\n\n") + flagText,
    budget ? toolsBlock(cfg.tools, budget) : "",
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

// ---------------------------------------------------------------- phase 4: the memo

export const MEMO_SYSTEM = `${MARK.memo} You are a neutral editor writing the joint memo of a structured debate between AI analysts. Be terse and honest: disagreements that survived are reported as disagreements, never papered over. The CODE-COMPUTED FACTS are ground truth — never restate them differently and never re-score anything. Do not add your own answer to the question, and do not rank the analysts. Output ONLY the memo in markdown, starting at the first heading. Do not think aloud.`;

export const MEMO_RETRY_SYSTEM = `${MARK.memo} You are a neutral editor. Output ONLY the finished memo in markdown. Do NOT think aloud, do not narrate your process, and never write "Let me", "Wait" or "Hmm". Start at the first heading.`;

export function memoPrompt(cfg, { intent, facts, finals, critiques, rebuttals }) {
  const files = cfg.deliverable === "files";
  const structure = files
    ? `## What every attempt shares\n## How they differ (structure, content, design, accessibility, robustness — name the analysts)\n## Requirements some attempts missed\n## What changed during the debate (revisions, and why)\n## Open questions`
    : `## Where they agree (with the strongest shared evidence)\n## Where they still disagree (each side's case, the root-cause class, and what would settle it)\n## What moved during the debate (say plainly whether agreement rose, fell or did not move, and why)\n## Claims to treat with care (every ungrounded load-bearing claim and every fabricated, miscomputed or unsupported claim, by reference)\n## Open questions`;
  const user = [
    `QUESTION (verbatim): "${cfg.question}"`,
    intentBlock(cfg.question, intent),
    cfg.persona ? lensBlock(cfg.persona) : "",
    `CODE-COMPUTED FACTS (ground truth — do not restate them wrongly):\n${facts.map((f) => `- ${f}`).join("\n")}`,
    `FINAL ANSWERS:\n${finals.map((f) => `Analyst ${f.letter}: ${JSON.stringify(f.view)}`).join("\n\n")}`,
    critiques.length ? `CRITIQUES (last round):\n${critiques.map((c) => `Analyst ${c.letter}: ${JSON.stringify(c.critique)}`).join("\n\n")}` : "",
    rebuttals.length ? `REBUTTALS (last round):\n${rebuttals.map((r) => `Analyst ${r.letter}: ${JSON.stringify(r.rebuttal)}`).join("\n\n")}` : "",
    `Write the memo with exactly these sections:\n${structure}`,
  ].filter(Boolean).join("\n\n");
  return { system: MEMO_SYSTEM, user };
}

// ---------------------------------------------------------------- JSON repair

const REPAIR_SHAPES = { intent: INTENT_SCHEMA, answer: ARTIFACT_SCHEMA, critique: CRITIQUE_SCHEMA, rebuttal: REBUTTAL_SCHEMA };

export function repairPrompt(kind, prior, { ledgerText = "" } = {}) {
  return {
    system: `${MARK.repair} You output JSON and nothing else. No prose, no preamble, no code fences, no explanation.`,
    user: `Your previous reply was not the JSON object this pipeline reads, so it is not usable yet. Convert YOUR OWN reply below into the required object. Invent nothing: use only what you already wrote; where you did not decide something, leave that field empty.

Required shape — the angle brackets are TYPE DESCRIPTIONS, not values. Copying them verbatim produces a rejected answer:
${REPAIR_SHAPES[kind] || ARTIFACT_SCHEMA}${ledgerText ? `\n\nTHESE TOOL RESULTS REALLY CAME BACK IN YOUR SESSION (cite them by id):\n${ledgerText.slice(0, 12000)}` : ""}

YOUR REPLY:
${String(prior || "").slice(0, 20000)}`,
  };
}

// ---------------------------------------------------------------- ceilings (PRD §9: a function of the mandate)

export function answerTokens(cfg, intent) {
  if (cfg.deliverable === "files") return 12000;
  const count = Number(intent?.count) || 0;
  const docWords = cfg.docs.reduce((n, d) => n + d.words, 0);
  return Math.min(24000, 4000 + 350 * count + Math.min(3000, Math.round(docWords / 8)) + 300 * cfg.tools.length);
}
export function critiqueTokens(agendaLength, files) { return Math.min(16000, (files ? 3000 : 2000) + 180 * agendaLength); }
export function rebuttalTokens(receivedCount, files) { return files ? 12000 : Math.min(16000, 2500 + 200 * receivedCount); }
export const MEMO_TOKENS = 4000;
export const INTENT_TOKENS = 2500;

export function wordsIn(text) { return wordCount(text); }
