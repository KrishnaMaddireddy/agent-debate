# Agent Debate — project instructions for Claude Code

Read `PRD.md` first. It is the product; this file is how we work on it.

## What this is
N models answer one prompt independently, then critique each other, rebut,
declare final positions, and code measures what moved. Generalised from
`~/Projects/mcp-model-bridge` (Model Bridge) — that repo is the reference
implementation for the provider adapters, the debate protocol, the event
stream, the web console and the test discipline. Port, don't reinvent; when in
doubt open `../mcp-model-bridge/model_bridge.js` and read the comment above the
block you are about to write — every one names the live failure it fixes.

## Rules
- Zero runtime dependencies (node's own http/fs). No build step.
- Keys live in `.env` / the shell. `providers.json` holds env VARIABLE NAMES.
  Never paste a key into chat, a doc, or a fixture.
- Symmetry is the product: every model gets identical inputs, ceilings,
  timeouts and tools. Anything one provider can see that another cannot makes
  the run measure the harness. Deliver everything through the prompt.
- Code computes the objective parts (overlap, movement, grounding, agenda
  coverage, participation). Never ask a model what code can compute; never let
  a model grade itself.
- Every ceiling and timeout is a function of the mandate, never a constant.
- Phases after the first are fail-soft. A run with work in hand never dies.
- Typed placeholders only in prompts; refuse template copies in every artifact
  shape (artifact, critique, rebuttal).
- Tests extract the REAL source block out of the engine, never a copy. All
  suites green before anything ships. UI changes are loaded in a real browser
  (Playwright) before they ship.
- Rev numbering starts at 1. `VERSION.txt` carries what changed, test counts,
  and md5s of every shipped file.

## Build order
PRD §14: M1 (CLI, two models, claims, gate, guard, diff, report) → M2
(grounding + N-way + concurrency + scaling) → M3 (console) → M4 (skills,
personas, expansion) → M5 (tools). Ship each milestone behind its tests.

## First task
Build M1. Start by writing `debate.js` with: `.env` autoload, args, the
provider adapters ported from Model Bridge (`callOpenAIStyle`, `callAnthropic`,
`_thinkMode`/`_thinkBody`/`_reasoningApi`, the temperature retry, the
reasoning-channel recovery), the artifact schema from PRD §6, phases 1–4 from
PRD §7, `extractJson` + the artifact-shape guard + the template-copy guard,
the participation gate, overlap/movement, and the markdown report. Then
`debate_nway_test.js` extracting the diff block. Prove it on five questions of
different kinds (PRD §5) and record what each run taught in `LESSONS.md`.
