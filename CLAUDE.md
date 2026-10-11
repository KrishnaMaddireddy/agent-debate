# Agent Debate: project instructions for Claude Code

Read `PRD.md` first: it is the product. `docs/DESIGN.md` is how this build implements it. This file
is how we work on it.

## What this is
Two to six models get one question. The build runs it in these steps:
1. One model reads the question, and that reading goes to every later prompt.
2. Each model answers on its own, as claims with evidence.
3. Code audits the evidence.
4. The models critique each other and rebut.
5. Code measures what moved.
6. A memo is written from those measurements.

Generalised from `~/Projects/mcp-model-bridge` (Model Bridge). That repo is the reference for the
provider adapters, the protocol and the console look.

## Layout (rev 14)
- `app/core/`: the engine. It is browser-safe, with no node imports, and runs unchanged in the server,
  the console and the claude.ai page.
- `app/server/`: node:http server, adapters, config, runs.
- `app/ui/`: vanilla ES modules, served as-is.
- `build/artifact.js`: links `app/core` + `app/ui` + `build/host-artifact.js` into one page.
- `legacy/`: the rev ≤13 panel app. Read-only reference; nothing imports it.

## Rules
- **Zero runtime dependencies.** Node ≥ 20, `node:test`. No bundler for the local app.
- **Never ship user config.** That means `local/providers.json`, `local/tools.json`, `.env`,
  `local/seats.json`, `local/mcp.json`, `local/plugins.json` and `local/runs/`. Ship only `*.example`
  and code.
- **Keys live in `.env`.** `providers.json` holds variable names only. Never paste or echo a key.
- **Providers are opt-in.** Never call a provider the user has not enabled, or a model they have not
  listed. Don't spend on metered providers unless the user enabled them for this. Mock models are for
  tests.
- **Symmetry is the product.** Every analyst gets identical inputs, ceilings, timeouts, tools, skills
  and lens, in every phase.
- **Code computes what code can.** That covers overlap, movement, grounding, verdict tallies, root
  causes and participation. Never ask a model what code can compute. Never let a model grade itself.
- **Every ceiling and timeout follows from the mandate**, never from a constant.
- **Phases after phase 1 are fail-soft.** A run with work in hand never dies.
- **Guard every model output.** Typed placeholders only in schemas. Refuse template copies in every
  artifact shape.
- **One event stream.** Everything the UI or the report shows comes from `reduceEvents(events)`. Add an
  event; never add a side channel.
- **Tests.**
  - `npm test` must be green before anything ships.
  - UI changes are checked in a real browser with `npm run test:ui`.
  - `npm run matrix` covers the ten question kinds.
- **Committing.** Commit via the device bridge; never run git from the device VM. The device VM is
  Linux and cannot run the Mac's node_modules, but there are none now.
- **VERSION.txt** carries what changed, test counts and md5s of the shipped files. Record what a live
  run taught in `LESSONS.md`.
