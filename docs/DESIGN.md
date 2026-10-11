# Agent Debate — design (rev 14, the redesign)

This is the contract the code and the tests are built against. `PRD.md` is the product; this file
is how rev 14 realises it. Read `PRD.md` §4, §7 and §12 first.

## 1. Why a redesign

Up to rev 13 the app was a *panel*: seats with stances spoke in turn, each reading the whole
transcript, and a Chair summarised in prose. That is a different product from the PRD's (see
`docs/ARCHITECTURE.md` of rev 13, "Where it diverges"): the first speaker framed every debate,
nothing was measured, and the engine lived twice (the browser ran the debate, `engine.js` ran it
for the CLI) with drift tests holding the copies together.

Model Bridge proved the PRD's protocol on one narrow domain. Reading all of it for this redesign also showed
what not to copy: every phase ran sequentially; rebuttals never saw the analyst's own artifact;
rounds 2–3 resent the identical critique prompt; the root-cause tally was left to the memo writer;
most guards ran only in solo mode; the synthesiser never saw the intent reading. Rev 14 fixes each.

## 2. Shape

```
app/core/      the engine — plain ES modules, no node: imports, runs in Node AND the browser
app/server/    node:http server, provider adapters, tools/MCP/plugins, run store  (Node only)
app/ui/        the console: index.html + app.js (vanilla, no build), imports /core/* directly
app/cli.js     same engine from a terminal
build/artifact.js   inlines core + ui into one HTML page that runs on claude.ai (Claude via `sample`)
local/         YOUR config (providers.json, tools.json, mcp.json, plugins.json, .env) and runs/ — never shipped
skills/ personas/ plugins/   house procedures, judging lenses, bundles
```

Zero runtime dependencies, no build step for the app. Node ≥ 20. The UI loads `/core/*.js` as
native modules, so **there is one engine**, imported by the server, the CLI, the console (for its
reducer and metrics) and the artifact (inlined by the build). Nothing is mirrored; nothing drifts.

## 3. One stream of events, one reducer

The engine never returns prose to a caller mid-run: it **emits events**. Everything downstream is
a pure function of the event list:

```
engine ──emit──► events[] ──reduce()──► record ──renderReport()──► report.md
                    │                      └──────────► console panels (same record)
                    └── persisted as runs/<id>.jsonl, replayed over SSE for history
```

So a live run, a replayed run, the markdown report and the JSON record cannot disagree: they are
the same reducer over the same events. Replay is just feeding the stored events again.

Events: `run_started, intent, intent_failed, phase, prompt, tool_call, tool_result, model_output,
json_retry, artifact, absent, template_copy, diff, critique, rebuttal, round_end, auto_stop,
diff_final, synthesis, model_failed, stopped, crash, done`.

## 4. The protocol (PRD §7, with Model Bridge's gaps closed)

Models are labelled **A, B, C…** (up to 6). Claim references are global: `B:c3`.

| Phase | Who | Runs | Output (typed placeholders only — never filled examples) |
|---|---|---|---|
| 0 intent | one model (first non-CLI, or chosen) | once | `{reading, sub_questions[], testable[], not_testable[], proxies[], gates[], terms[], count, horizon, caveat}` |
| 1 answer | every model | **concurrently** | `{position, confidence, claims[{id,text,basis,evidence,source,load_bearing}], items[], assumptions[], counter_considerations[], what_would_change_my_mind[], sub_answers{}}` |
| 2 critique | every model | concurrently, per round | `{agreements[], divergences[{with,topic,mine,theirs,root_cause,detail}], verdicts[{claim,verdict,why}], questions[{to,question}]}` |
| 3 rebuttal | every model | concurrently, per round | `{answers[], changed_mind[], stand_by[], withdrawn_claims[], new_claims[], final_position, final_confidence, final_items[]}` |
| 4 memo | one model (chosen; may be a model that did not debate) | once | markdown |

- **Intent, as read** is shared: the identical block goes into every later prompt, *including the
  synthesiser's* (Model Bridge left it out). It is rendered as the card in the console and a section
  in the report. Fail-soft: a failed reading is reported and the run continues.
- **Identity anchoring** in every phase: "You are Analyst B." Critique shows YOUR artifact and
  THEIRS by letter. Rebuttal gets **its own current artifact** plus only what was said *to it* —
  divergences `with` it, verdicts on its claims, questions `to` it (Model Bridge sent every
  critique, including ones about third analysts, and never the analyst's own work).
- **Rounds re-critique the current positions**: after a rebuttal, each artifact is updated (final
  position, withdrawn claims removed, new claims added and audited) and round r+1 critiques that.
- **Auto-stop** when a round changes nobody's mind (no `changed_mind`, no withdrawn or new claims).
- **Fail-soft after phase 1**: a failed critique is an empty critique; a failed rebuttal keeps the
  position; a failed memo ships the report without a memo. A run with work in hand never dies.
- **Tools** (when selected) in phase 1 with the per-turn budget, and a small verification budget in
  rebuttals. Prompt-level protocol (one JSON line per call), identical for every provider. Each
  result gets a ledger id `T1…` per model, which a claim cites as `basis: "tool", evidence: "T3"`.
- **Files deliverable**: phase 1 answers with fenced files; critique is about requirements and
  design; a rebuttal may return revised files. Claims and grounding do not apply.
- **Persona**: one judging lens per run, the same for every model; without one, each model states
  its own standards in `assumptions`.

## 5. Guards (all phases, not only solo)

- `extractJson` scores candidate objects by the keys the phase expects and rejects an inner
  fragment of a reply cut at the ceiling (shape guard).
- **Template copy**: an angle-bracket value, a bare `...`, or an enum left as `a|b|c` is a copied
  placeholder. The row is dropped and a `template_copy` event says so; an artifact whose position
  is a placeholder is *absent*, not a position.
- **JSON retry** once, with the model's own prose attached and "invent nothing".
- **Reasoning-channel recovery**: when the content channel is empty, JSON is read from the
  reasoning channel before a paid retry.
- **Participation gate** before any maths: failed, empty, truncated-with-nothing, or template copy
  → absent, with the reason, excluded everywhere, reported loudly.
- **Chain-of-thought is not a memo**: detected, re-asked once, then labelled.

## 6. Code-computed facts (never asked of a model)

- **Grounding audit** per claim:
  - `quote` — the evidence must be a substring of the attached context: exact, or after normalising
    whitespace/quotes/dashes/case ("normalised"); `…` splits a quote into fragments that must
    appear in order. Shorter than 20 characters → too short to count. Otherwise
    `fabricated_quote`. With no context attached, a quote cannot be grounded.
  - `arithmetic` — the expression is recomputed with the safe calculator; the result must match
    the stated number (1% tolerance, percent-aware); operands must appear in the context, the
    question or the model's own tool results (small constants excepted).
  - `tool` — the cited `T#` must exist in that model's ledger and have succeeded; if the claim
    states numbers, at least one must appear in the cited result.
  - `reasoning`, `knowledge` — labelled, never verified.
  - **Grounding rate** = verified ÷ all claims, per model, before and after the debate.
    Ungrounded load-bearing claims are listed by name.
- **Claim overlap**: claims are clustered across models by content-token Jaccard ≥ 0.5 (numbers
  must agree when both sides state numbers). A cluster that every present model contributes to is
  *shared*. Pairwise overlap for every pair.
- **Agenda**: for each model, the other models' claims with no counterpart in its own. Every agenda
  claim is owed a verdict; coverage = answered ÷ owed; unanswered claims "went unargued".
- **Verdict tally** per claim: endorsed (every other model accepts), contested (someone rejects),
  unresolved.
- **Position similarity** (content-word Jaccard) pairwise, before and after.
- **Items** (list questions — the intent reading's `count`): consensus / majority / only-X, like
  Model Bridge's picks, before and after.
- **Root-cause tally**: evidence / interpretation / values, counted from the critiques in code.
- **Movement**: per round, per model — changed-mind rows, withdrawn and new claims, confidence
  change; overlap and similarity before → after; *who moved toward whom* (a model's final position
  closer to another's initial one).
- **Red flag**: agreement rose while grounding fell (PRD §15).

## 7. Server

`node:http`, loopback only, `Host` checked (DNS rebinding) and `Origin` checked on every mutating
request (a web page cannot spend your keys). Keys stay in `.env`; the browser never receives one.
Providers are **opt-in** exactly as rev 6–13: `local/providers.json` is read in the same shape, so
existing config keeps working. Runs execute in-process with an `AbortController` per run (■ Stop
aborts in-flight calls). `POST /api/runs` starts a run; `GET /api/runs/:id/events` is SSE with
full replay; `POST /api/run` runs synchronously for automation.

Ceilings and timeouts scale with the mandate (PRD §9): answer tokens with the item count, context
and tools; critique tokens with the agenda; per-call timeout 2 min + 30 ms/token, capped at 10 min.
Provider `tokenFloor`, `temperature`, `thinking`, `timeoutMs` are honoured on every call.

## 8. Artifact build

`node build/artifact.js` inlines `app/core/*` and `app/ui/*` into `dist/agent-debate.html`. The UI
talks to a *host*: the server host (fetch + SSE) or the artifact host, which runs the engine in the
page and calls Claude through the claude.ai `sample` capability (models = Claude tiers: quick,
default, complex), falling back to the classic artifact `fetch` to api.anthropic.com. Tools that
need the server (HTTP, MCP) are absent there; the protocol, audit, metrics and report are identical.

## 9. Tests

`npm test` = `node --test tests/`: core (parsing, guards, calculator), audit, metrics, engine
end-to-end with scripted models (absent, template copy, failing phases, CoT memo, stop, files,
persona, tools), report, server (config compatibility, opt-in, keys never returned, Origin/Host
checks, run lifecycle over SSE, stop, delete, extract), artifact build. `npm run test:ui` drives the
console and the artifact in Chromium (Playwright, optional). `npm run matrix` runs ten questions of
different kinds through the mock adapter and writes `docs/TEST_MATRIX.md`.

## 10. Spending, the scorecard, the shareable page (rev 15)

**Usage and price.** Every adapter returns the provider's billed usage `{input, output, cached}`,
summed over any retry the adapter makes itself, and the model that actually served. When a provider
reports none, the engine estimates from length (4 characters a token) and marks the call
`estimated`. Prices are USD per 1M tokens, resolved on the server in this order:
1. the user's own price;
2. $0 for mock, the subscription CLI and keyless local servers;
3. the dated table in `app/server/prices.json` (peak rates);
4. OpenRouter's live list.

The prices travel into the run options, so the record shows the price every number used.
`model_output` events carry `usage`, `cost` (null when the price is unknown) and `served_model`. The
record's `usage` is a pure reduction of those events, so a replay costs the same.

**The cap is an invariant, not an estimate.** Before each call, `callModel` computes that call's worst
case: the prompt's estimated tokens +20% at the input price, plus the ceiling at the output price.
The ceiling is raised to the provider's floor where one applies. It then checks
`spent + reserved + worst ≤ cap`:
- If the check fails, it emits `budget_stop` and the run ends as `stopped` with
  `reason: "spending cap"`.
- If it passes, the worst case is reserved until the call returns. Concurrent phase-1 calls
  therefore cannot overshoot together.
- The adapter's reasoning retry at 2× the ceiling is allowed (`maxGrowth: 2`) only when three
  ceilings fit.
- A capped run with an unpriced participant is refused at setup.

**Scorecard** (`app/core/scorecard.js`). It is a pure function over saved records, and counts per
provider/model:
- seats, participation and absences;
- claims, grounding (only where documents or tools made checking possible) and audit findings;
- the latest verdict each other analyst gave on its claims;
- its own agenda coverage as a critic;
- movement, format slips, memo flags, cost and latency.

A seat that never reached phase 1's end (stopped by the user or the cap) is not counted. The server,
the CLI and the claude.ai page share it.

**Shareable page** (`app/ui/export.js`). `reportPage()` renders the same `feedItems` and
`renderPanels` the console uses, in a static mode:
- console buttons are removed, and files are shown as sandboxed previews;
- the console stylesheet is included, with no script;
- an appendix holds the documents (once) and every prompt and reply, paired per (phase, round,
  analyst).

The console, `GET /api/runs/:id/report.html` (with a `script-src 'none'` CSP) and `cli --html` all
produce the same bytes.
