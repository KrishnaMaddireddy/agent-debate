# Agent Debate — Product Requirements Document

**Status:** v1 draft · 2026-09-06 · owner: Krish
**Lineage:** generalises Model Bridge (`~/Projects/mcp-model-bridge`), a multi-model
stock-analyst debate over the PaakData MCP. Everything domain-specific is removed;
every hard-won mechanism is kept. Read §12 before designing anything — each item
there cost a live run to learn.

---

## 1. Problem

Asking one model one question gives you one confident answer and no way to know
how confident you should be. Asking three models the same question gives you
three answers and no way to compare them: different framings, different
assumptions, different levels of grounding, and whoever writes the summary
quietly wins.

What people actually want when they say "have the models discuss it" is:

1. **Independent answers** — each model works alone first, so its position is
   its own and not an echo of whoever spoke first.
2. **A real exchange** — each model reads the others' work, says where and *why*
   it disagrees, answers the others' challenges, and declares a final position.
3. **Measurement in code** — what did they agree on, what stayed contested,
   did anyone change their mind, which disagreements were about facts vs
   assumptions vs values — computed, not narrated.
4. **An honest synthesis** — a memo that reports surviving disagreements as
   disagreements, never papers over them, and is clearly separated from the
   code-computed facts.

Model Bridge proved all four work — for stocks, because every search returns an
exact-filter echo that code can re-verify. This product must work for **any
topic**, where there is no echo. That is the central design problem (§4).

## 2. Goals

- Run N ≥ 2 models (any mix of hosted APIs, a local model, or a CLI-backed
  model) against one plain-English prompt and produce a structured debate
  report with a code-computed diff, in one command or one click.
- Work with **no tools at all** (pure reasoning), with **supplied context**
  (documents, data, URLs the user pastes), or with **pluggable tools** — the
  same protocol regardless.
- Make every objective part of the comparison a function of the artifacts, not
  a model's opinion: overlap, movement, agenda coverage, grounding rate,
  root-cause tally, participation.
- Be honest by construction: a model that produced nothing is *absent*, not
  "disagreeing"; a template copy is *not* a position; a claim no source
  supports is *ungrounded*, and the report says so.
- Cost: a two-model, one-round debate on a normal question under $0.50 and
  under 5 minutes.

## 3. Non-goals (v1)

- Not a chat UI. It is a run-and-report tool with a live console.
- Not a judge/arbiter model that decides who "won". Code measures; the memo
  reports; the human decides.
- Not multi-turn conversation between agents beyond the fixed protocol
  (critique → rebuttal, R rounds). Free-form agent chatter converges on
  flattery; the protocol exists to prevent that.
- No fine-tuning, no RAG infrastructure. Supplied context is passed in the
  prompt, verbatim, to every model identically.

## 4. The verifiability problem — and the answer

In Model Bridge, the *echo line* made disagreement diagnosable: two analysts
who ran different searches were disagreeing about **data**; same rows, different
call was **reading**; same reading, different priorities was **weighting**. A
general question has no echo. Without a substitute, "models discussing" degrades
into eloquent mutual agreement.

The substitute is **claims with declared evidence**, and a code check on the
evidence:

Every position is a list of **claims**. Each claim declares its `basis`:

| basis | what it means | what code can check |
|---|---|---|
| `quote` | supported by a verbatim passage from the supplied context | the passage is an **exact substring** of the supplied context — the echo analog. A "quote" that is not in the context is flagged `fabricated_quote`. |
| `arithmetic` | computed from numbers in the context | the operands appear in the context; the result is recomputed. |
| `tool` | returned by a tool call (when tools are enabled) | the tool ledger contains it (Model Bridge's provenance audit, ported). |
| `reasoning` | the model's own inference | nothing — but it is *labelled* as such, and the grounding rate excludes it. |
| `knowledge` | the model's background knowledge | nothing — labelled; the memo must not present it as verified. |

Disagreements are classified by the critic into the general analogues of
data/reading/weighting:

- **evidence** — they are using different facts or sources (one has a quote the
  other lacks; one relies on `knowledge` the other doesn't accept);
- **interpretation** — same evidence, different inference;
- **values** — same interpretation, different priorities or criteria.

The **grounding rate** (claims with `quote`/`arithmetic`/`tool` basis that
verified ÷ all claims) is a first-class metric per model, reported beside
overlap and movement. It is the honest replacement for "how much should I
trust this answer".

## 5. Users and core use cases

- **A decision with a document trail** — "Should we adopt X? Here are the two
  proposals and last quarter's numbers." Grounding matters; quotes are checkable.
- **Code or design review** — "Here is the diff / the ADR. What's wrong with
  it?" Claims are about specific lines; a `quote` is a line reference.
- **Research question, no context** — "Is intermittent fasting effective for
  weight loss?" Pure `knowledge`/`reasoning` claims; the value is in the
  classified disagreement and the agenda coverage, and the report must say the
  grounding rate is 0 by construction.
- **Essay / argument stress test** — the user supplies their own writing;
  models attack it independently, then argue about which attacks hold.
- **Model comparison** — the user wants to know how GPT, Claude, DeepSeek,
  Kimi differ on *this kind* of question. Same inputs to all is the whole
  point (§9).

## 6. Artifact schema

Every model must output this JSON and nothing else. Placeholders are typed,
never filled examples (a filled example gets copied — §12.1).

```json
{
  "position": "<one paragraph: the answer, stated plainly>",
  "confidence": "<0-100>",
  "claims": [
    {"id": "c1", "text": "<one checkable statement>",
     "basis": "quote|arithmetic|tool|reasoning|knowledge",
     "evidence": "<the verbatim passage / the arithmetic / the tool result id / null>",
     "load_bearing": "<true if the position falls without it>"}
  ],
  "assumptions": ["<what is being taken as given, and why>"],
  "counter_considerations": ["<the best case against this position, in its own words>"],
  "what_would_change_my_mind": ["<a specific fact or argument>"],
  "sub_answers": {"<sub-question id from phase 0>": "<answer>"}
}
```

Critique object (per critic, one call covering all others):

```json
{"agreements": ["..."],
 "divergences": [{"with": "<model label>", "claim_or_topic": "...", "mine": "...", "theirs": "...",
                  "root_cause": "evidence|interpretation|values", "detail": "..."}],
 "their_claims_verdict": [{"model": "...", "claim_id": "...", "verdict": "accept|reject|unresolved", "why": "..."}],
 "questions": ["<at most 3, pointed>"]}
```

Rebuttal object:

```json
{"answers": ["..."], "changed_mind": [{"topic": "...", "from": "...", "to": "...", "because": "..."}],
 "stand_by": ["..."], "final_position": "...", "final_confidence": "<0-100>",
 "final_claims": ["<claim ids kept>"]}
```

## 7. The protocol

**Phase 0 — question expansion (optional, default on).** One model (the fastest
non-CLI model, or `--expander`) restates the question, splits it into 2–6
sub-questions, states what would count as evidence, and flags what is
*unanswerable* (predictions, private facts, matters of taste). The identical
expansion goes to every model. This settles "what is being asked" before anyone
answers, so the debate is about the answer. Shown to the user; fail-soft.

**Phase 1 — independent work.** Every model gets the identical brief: the
question, the expansion, the supplied context (verbatim, same order), the
house skills index (§10), the artifact schema, and — if tools are enabled — the
same tools with the same budget. Models run **concurrently** (Model Bridge ran
them in sequence and spent half its wall-clock waiting). Output: one artifact
each.

**Code, between phases.** Participation gate (an empty or template artifact is
*absent*, excluded from all maths, reported loudly). Grounding audit (§4).
Overlap of positions and of claims (by normalised text; claims that match
across models are "shared"). Per-model agenda: the claims the others made that
this model did not — every one must get a verdict in critique.

**Phase 2 — cross-critique.** Each model, in one call, reads every other
artifact **plus its own** (identity anchoring — §12.3), classifies each
divergence, and gives a verdict on every claim on its agenda. Code checks agenda
coverage; unanswered claims are reported as "went unargued". A critique that
copies the template is treated as no critique.

**Phase 3 — rebuttal.** Each model gets the critiques *of its work*, **its own
artifact again**, and an explicit identity line ("you are X; 'mine' in these
critiques means their position"). It answers, states what it changed and what
it stands by, and declares a final position and final claims. `changed_mind`
rows and `final_claims` are placeholder-filtered. A failed rebuttal keeps the
phase-1 position.

**Rounds.** R rounds of phases 2–3 (default 1, max 3). **Auto-stop** when a
round changes nobody's mind — repetition drifts models toward false consensus.

**Code, post-debate.** Final overlap recomputed from declared final positions;
**movement** = final agreement − initial agreement; root-cause tally; grounding
rate per model, before and after (claims dropped under critique count as
grounding *improvements*, not losses).

**Phase 4 — synthesis.** One model writes the memo from the code-computed facts
(handed to it as ground truth), the artifacts, critiques and rebuttals. The memo
must: lead with what all agreed, report each contested point with each side's
case and its root-cause class, say plainly whether agreement rose or fell and
why, list the ungrounded load-bearing claims by name, and end with open
questions. A memo that is chain-of-thought is re-asked once, then labelled as
not a memo. A failed synthesis ships the report without a memo — the
code-computed sections are the product; the memo is prose on top.

## 8. Inputs

CLI: `node debate.js --question "..." [--context file.md ...] [--models a,b,c]
[--rounds 1-3] [--persona <file>] [--skills <dir>] [--tools <config>]
[--expander <key>] [--no-expand] [--no-auto-stop] [--out report.md]`.

Web console: the same, as a form; live feed of every phase, prompt, claim,
critique and rebuttal; right-hand panels computed in the browser from the event
stream (overlap, movement, grounding, root-cause tally, absences).

Context: files are read whole and passed verbatim to every model in the same
order, with a size warning above ~60k chars and a hard cap the user raises
knowingly. Same bytes to everyone or the comparison is void.

## 9. Providers and fairness

Port Model Bridge's adapter layer as-is: OpenAI-chat-shape and Anthropic-shape
adapters; `providers.json` with `{key, label, env, base, path, model,
temperature?, thinking?, token_floor?, timeout_ms?}`; `env` names a variable,
never a key; thinking as a *mode*, dialect inferred from the base URL; the
temperature-400 retry; the reasoning-channel recovery; the CLI-backed provider
(Claude Code) with ambient-context isolation.

**Symmetry is the product.** Same question, same expansion, same context, same
skills, same tools, same budgets, same ceilings, same timeouts — for every
model. Anything one provider can see that another structurally cannot (a CLI's
local files, a bigger window) makes the run measure the harness. Deliver
everything through the prompt.

**Every ceiling is a function of the mandate.** Final-answer tokens scale with
the expected artifact size; critique tokens scale with the agenda length;
per-call timeout scales with max tokens (2 min + 30 ms/token, cap 10 min).
Nothing is a constant tuned for the small case.

**Phases 2–4 are fail-soft.** One slow or failed model files an empty critique /
keeps its phase-1 position / ships the report without a memo. A run that has
work in hand never dies because of a later phase.

## 10. Skills and personas

- **Skills** (`skills/<name>/SKILL.md`, frontmatter name + description) are
  house procedures for a *kind* of question — "how to critique a proposal",
  "how to evaluate a study", "how to review a diff". Index in every brief;
  bodies via a free `read_skill` tool (inlined for the CLI provider). Identical
  for all models.
- **Personas** are judging lenses — the standard by which "good" is judged
  (cautious CFO, security reviewer, skeptical scientist). One persona per run,
  applied to every model; the point is that differences are then differences
  between *models*, not between lenses. `--persona` optional; without one, each
  model is told to state its own standards in `assumptions`.

## 11. Outputs and metrics

**Report (markdown):** header (question, expansion, context summary, models,
settings); code-computed diff (shared position? shared claims; per-model
exclusives; pairwise overlap for N > 2; agenda coverage; **grounding rate per
model**; absences); post-debate diff (final overlap, movement, rounds, per-round
changes); the memo; appendix with every artifact, critique, rebuttal and the
grounding audit.

**Event stream (jsonl, fd 3):** `started, phase, prompt, expanded, artifact,
absent, grounding, diff, critique, agenda_gap, rebuttal, template_copy,
round_end, auto_stop, diff_final, synthesis, model_failed, crash, done`.

**Metrics the product is judged by:** initial and final overlap; movement;
agenda coverage; grounding rate; root-cause tally; participation; wall-clock;
cost.

## 12. Lessons imported from Model Bridge (each cost a live run)

1. **Filled examples get copied.** Typed placeholders only; refuse artifacts,
   critiques and rebuttals that echo the template (`"..."`, `SYM`, enum strings
   as values).
2. **A model that produced nothing did not disagree — it was absent.** Gate
   participation before any maths; never let an empty list zero a consensus.
3. **Rebuttals need identity anchoring.** A model given only critiques *of* its
   work, without its own artifact, answered in the critic's voice. Include the
   model's own artifact and say who "mine" and "theirs" are.
4. **Every ceiling and timeout must scale with the mandate.** A 20-item answer
   into a window sized for 5 gets cut; the parser then accepts an inner
   fragment as the whole; the retry stands down. Guard the shape, scale the
   window, scale the timeout, size the retry like the answer.
5. **Later phases must be fail-soft.** The most expensive failure is the one
   after every model has already done its work.
6. **Show the prompts.** The biggest lever on a model is what it was told;
   emit every prompt as sent, appended material included.
7. **Chain-of-thought is not a memo.** Detect it, re-ask once, label it.
8. **Stale flags ban corrected claims.** Re-audit final positions after
   rebuttal; a claim fixed under critique is a fixed claim.
9. **One reading of the question, shared.** Expand once; hand everyone the
   same expansion; show it.
10. **Compose angles, don't chain.** A mega-prompt that yields nothing tells you
    nothing about which constraint did it. (Tools-mode lesson; also true of
    over-specified questions.)
11. **Stream progress from opaque providers,** filtered to the calls that are
    the work, not the plumbing.
12. **Test by extracting the real source block**, never a copy. Six suites, all
    green, before anything ships.

## 13. Architecture

Zero runtime dependencies. `debate.js` (engine: CLI, providers, protocol,
audits, report), `debate_server.js` (local web server, fd-3 events → SSE),
`debate_ui.html` (three-column console), `skills/`, `personas/`,
`providers.json.example`, tests that extract real blocks from the engine.
Node ≥ 20. The Model Bridge files are the reference implementation for every
one of these; port, don't reinvent.

## 14. Milestones

- **M1 — CLI, two models, no tools, no context.** Phases 1–4, claims schema,
  participation gate, template guard, overlap/movement, report. Prove it on
  five questions of different kinds.
- **M2 — Grounding.** `--context`, the quote verifier (exact substring),
  arithmetic re-check, grounding rate, agenda coverage, N-way with pairwise
  matrix, concurrent phase 1, scaled ceilings/timeouts, fail-soft phases.
- **M3 — Console.** Server + UI ported from Model Bridge: live feed, prompt
  display, computed panels, history, resizable layout.
- **M4 — Skills, personas, question expansion.** `--skills`, `--persona`,
  phase 0 with the expansion card.
- **M5 — Tools (optional).** A generic tool config (HTTP/MCP) with the
  provenance ledger ported from Model Bridge; grounding basis `tool`.

## 15. Risks

- **Sycophancy / convergence** — models agree because agreeing is easy. The
  protocol counters it (independent first, mandatory agenda, auto-stop) and
  the metrics expose it (movement toward the first speaker, grounding rate
  falling as agreement rises is a red flag — report it).
- **Identity confusion** in multi-agent prompts (§12.3).
- **Cost and wall-clock** grow with N² critiques and long context; concurrency
  and scaled timeouts are mandatory, not optional.
- **Ungrounded topics** produce grounding rate 0 by construction; the report
  must say so up front so nobody reads "3 models agree" as verified.

## 16. Open questions

- Should the grounding verifier accept near-verbatim quotes (whitespace,
  punctuation) or only exact substrings? Start exact; loosen with evidence.
- Claim matching across models: normalised text overlap vs. a model-judged
  "same claim" pass? Start with code (Jaccard on normalised tokens ≥ 0.8);
  never let a model grade its own overlap.
- Should the synthesiser be a model that did not debate? Cheaper to reuse
  the first; fairer to use a fourth. Make it a flag.
