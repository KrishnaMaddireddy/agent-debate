# Agent Debate

Two to six models get the same question. One reads it first, and that reading goes to everyone. Each
then answers on its own, as claims with evidence. Code checks the evidence. The models critique each
other, rebut, and move or hold. Code measures what moved, and one model writes a joint memo from
those measurements. The protocol is in `PRD.md`; how this build implements it is in `docs/DESIGN.md`.

## What a run produces

One event stream is reduced into one record. The console, the `.md` report, the `.json` record and
the replay all come from that record, so they cannot disagree.

1. **Run configuration.** The question, every analyst (letter, provider, model), rounds, deliverable,
   judging lens, house skills, tools, documents, who read the question, who wrote the memo, timings
   and status.
2. **Intent, as read.** One model's reading: the bold reading, sub-questions, what is TESTABLE, what is
   NOT TESTABLE (it will be said, not pretended), proxies, gates, pick count and horizon, terms, and a
   caveat. Every later prompt carries it, the memo writer's included. If the chosen reader returns
   nothing usable, the next analyst on a different model reads it instead. If both fail, the run says
   so and goes on without a reading.
3. **Phase 1: independent answers.** The calls run at the same time and see nothing of each other.
   Each claim has a basis (`quote`, `arithmetic`, `tool`, `reasoning` or `knowledge`), evidence, and a
   load-bearing flag. Then code audits them:
   - quotes are checked against the attached documents;
   - arithmetic is recomputed, and its operands must come from a document;
   - tool claims must cite a call that actually ran.

   A fabricated quote or a miscomputed number is marked, not trusted.
4. **Participation gate.** A model that returned nothing, failed, or copied the answer template is
   shown as **absent**. It is not counted as disagreeing.
5. **Code-computed diff.** This step uses no model:
   - claim clusters (the same claim said by different analysts; opposite claims never cluster);
   - pairwise overlap and position similarity;
   - agreed items, confidence, and grounding.
6. **Rounds of critique and rebuttal.**
   - Each critic owes a verdict (accept, reject or unresolved) on every claim of the others that it did
     not also make.
   - Each divergence gets a root cause: evidence, interpretation, or values.
   - Each rebuttal sees the analyst's own current answer and only what was said to it. It may withdraw
     claims or add new ones (which are audited too).
   - Rounds stop early when nobody moves.
7. **Post-debate diff.** Agreement before and after, verdict tally, root-cause tally, who moved and
   towards whom. A red flag is raised when agreement rose while grounding fell.
8. **Joint memo.** Written from the code-computed facts. A memo that turns out to be chain of thought
   is asked for again, and labelled if it happens twice.
9. **Final answers** and an appendix with every prompt sent and every raw reply.
10. **Cost.** Tokens per call as the provider reported them (estimated from length, and marked, when
    a provider reports none), priced per model, per analyst and in total. If the provider served a
    different model than the one asked for, the report says so.

With **deliverable: files**, each model outputs named files (```` ```html file=index.html ````) instead
of claims. The console previews them side by side (sandboxed, served with a strict CSP), and rebuttals
may revise them. Everything can be downloaded as a zip.

## Two ways to run it

| | claude.ai page | Local server (`npm start`) |
|---|---|---|
| Models | Claude tiers (quick / default / complex) through your subscription, via the page's `sample` capability. No key. | Any provider you enable in Settings, keyed from `.env`. **Claude through your subscription** via the Claude Code CLI (`claude` provider, `type: "cli"`). Local models (Ollama, LM Studio, vLLM). |
| Tools | `calculate` | Everything in `local/tools.json`, plus enabled plugins and MCP servers |
| Documents | Text and Markdown | Also PDF (dependency-free text reader) |
| Build | `npm run build:artifact` → `dist/agent-debate.html` | none: `app/` is served as-is |

The engine is the same code in both. The page is built from the files the server serves, and a test
checks that every engine function in the page is byte-identical to the one on disk.

## Local

```bash
cd ~/Projects/agent-debate          # the repo root, not local/
npm start                           # → http://127.0.0.1:8787  (loopback only; the server holds your keys)
```

Node 20 or later. There is nothing to install: there are no dependencies.

**Providers are opt-in.** Every provider is off until you enable it in Settings. The server refuses,
before any call:
- a provider that is off;
- a model that is not listed for it (or live-listed by *Refresh from provider*);
- a provider with no key in `.env`.

Before you press Run, the form shows how many calls will go to which provider and model. Mock models
(`mock-1`, `mock-alt`, `mock-liar`…) are free, deterministic, and always available for trying things
out.

Config lives in `local/` and is git-ignored:

| file | holds |
|---|---|
| `local/providers.json` | providers, their models, and the **name** of each key's `.env` variable |
| `.env` (repo root) or `local/.env` | the keys themselves. Settings writes them here and never reads them back |
| `local/tools.json` | tool definitions, with `${VAR}` references only |
| `local/mcp.json`, `local/plugins.json` | remote MCP servers; which plugins are on |
| `local/runs/` | every run: `<id>.jsonl` (events), `.json` (record), `.md` (report), `.meta.json`, `files/` |

Per provider you can also set:
- `temperature`;
- `thinking` (`enabled` / `disabled` / unset);
- `tokenFloor` (the minimum `max_tokens`; reasoning models need room to think);
- `timeoutMs`;
- `extraHeaders`.

Runs from rev 13 and earlier (`panel-*`, `compare-*`) still appear in History as legacy runs, with
their reports.

### Spending: prices, the meter and the cap

**Prices.** Every model gets a price (USD per 1M tokens: in, cached in, out), taken from the first of
these that has one:
1. your own price, set in Settings › Providers › prices;
2. $0 for the mock models, the Claude subscription seat and keyless local servers;
3. `app/server/prices.json`, a dated list-price table. It covers DeepSeek and Moonshot at their
   **peak** rates, so a cap errs on the safe side.
4. OpenRouter's own published prices, read live from its model list (reading the list is free).

A model with no price shows its cost as "?". It never shows a guess.

**The meter.**
- The Run button's line shows a typical and a worst-case cost before you start.
- While a run goes, the header shows what it has spent so far.
- Each card shows what its calls cost, and the Cost panel gives totals by analyst.
- History shows each run's total.

**The cap** is the field under the form. It defaults to $1, or to your default from Settings.
- **Before every call**, it checks what the run has spent, plus the worst case of every call already
  in flight, plus this call's own worst case (the whole prompt and the full ceiling). If that total
  would pass the cap, the call is not made. The run stops and keeps everything that finished.
- Calls that run at the same time can't push it over either, because each one reserves its worst
  case first.
- A reasoning model's automatic retry at twice its ceiling is allowed only when that larger call fits
  too.
- A capped run with an unpriced model is refused before any call.

CLI: `--budget 0.50`. API: `"budgetUsd": 0.5` (0 means no cap). Settings: a default cap for the CLI
and the API.

### Model scorecard

The **Scorecard** button, or `npm run cli -- --scorecard`, shows how each model has done across your
saved runs. Every number is counted by code from what happened; no model grades another:
- **Seats:** how many seats it took, and the share where it answered rather than being absent. A
  seat stopped by you or by the cap before it answered isn't counted.
- **Grounding:** how many of its claims could be checked. Only runs with documents or tools count.
- **Audit findings:** fabricated quotes and miscomputed arithmetic.
- **Peer verdicts:** how often the other analysts accepted or rejected its claims.
- **As a critic:** how much of its agenda it covered.
- **Movement:** how often it changed its mind.
- **Format slips:** JSON repairs and template copies.
- **Cost and speed:** cost per answer and seconds per call.

Fewer than five runs are marked as anecdote. Mock models are left out unless you ask for them.

### Share a run as a page

**page .html** (next to *report .md*) saves the run as one self-contained HTML file.
- It holds every card and every panel, plus an appendix of every prompt and raw reply.
- It has no script and loads nothing from the internet, so it opens anywhere, follows light or dark
  mode, and fits a phone.
- You can leave out the prompts, the attached documents, or both. A document appears in the page once,
  not once per prompt.

The same page is at `GET /api/runs/:id/report.html` (with `?prompts=0`, `?documents=0` and
`?download=1`), and from the CLI with `--html page.html`.

### Claude through your subscription

Install the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`), run `claude` once and log in, then
enable the **Claude** provider in Settings. It offers the `sonnet`, `opus` and `haiku` aliases. The
safeguards:
- Each call runs in an empty temporary directory, with tools, MCP and your `~/.claude` settings
  switched off.
- An isolation preamble tells the model it has no user, account or machine.
- `ANTHROPIC_API_KEY` is removed from its environment, so it can never fall back to metered billing.

Usage counts against your plan's limits.

### Tools, skills, lenses, plugins

- **Tools.** Tick them in the form. Every analyst gets the same list and budget.
  - Built in: `web_search`, `fetch_url` and `calculate`.
  - Keyless APIs in `tools.json`: Wikipedia, Wikidata, World Bank, Open-Meteo, Semantic Scholar,
    Europe PMC, Open Library and others.
  - `npm run tools:check` calls each tool once from your machine.
  - `web_search` uses the first backend whose key is in `.env`: Serpex, Serper, Brave, Tavily, SerpAPI
    or SearXNG. Without one it falls back to DuckDuckGo instant answers.
- **House skills.** `skills/<name>/SKILL.md` holds a procedure for a kind of question. Skills whose
  topics match the question are suggested (✦). The ones you select are included in full, identically,
  in every prompt.
- **Judging lens.** `personas/*.json` holds standards applied identically to every analyst in every
  phase, so differences are between models, not between lenses. Three ship: Cautious CFO, Security
  reviewer and Skeptical scientist.
- **Plugins.** `plugins/<name>/` bundles skills, tools and MCP servers. Nothing runs until you enable it
  in Settings › MCP & plugins. `plugins/example-fact-check` is a worked example.
- **MCP.** Remote servers over HTTPS. A key is written as `${VAR}` and its value lives in `.env`.

### From the terminal

```bash
npm run cli -- --question "Which 3 cities should we pilot in first?" \
  --model deepseek/deepseek-chat --model claude/sonnet --rounds 2 --context budget.pdf --persona cautious-cfo
npm run cli -- --question "A one-page site for the pilot" --model mock/mock-svg --model mock/mock-2 --files
```

Flags:
- `--models a/b,c/d` gives several models at once;
- `--skills auto|name,…`;
- `--tools name,…`;
- `--expander A|provider/model`;
- `--synthesizer A|provider/model|none`;
- `--no-expand`, `--no-auto-stop`, `--allow-large-context`;
- `--budget 0.50` (the spending cap; leave it out to use your default);
- `--out report.md`, `--html page.html`, `--json`, `--quiet`;
- `--scorecard [--include-mock] [--json]` prints the model scorecard instead of running.

The run is written to `local/runs/` like any other and shows up in the console's History. Ctrl-C
stops it.

### Headless: `POST /api/run`

```bash
curl -s 127.0.0.1:8787/api/run -H 'content-type: application/json' -d '{
  "question": "Should a small team adopt a monorepo?",
  "models": [{"provider":"deepseek","model":"deepseek-chat"}, {"provider":"claude","model":"sonnet"}],
  "rounds": 1, "skills": "auto", "tools": ["web_search"] }'
```

**Body fields.**
- Required: `question` and `models`.
- Optional:
  - `rounds` (0–3);
  - `docs` (`[{name, text}]`);
  - `persona`, `skills`, `tools`;
  - `deliverable` (`answer` | `files`);
  - `expand`, `autoStop`, `expander`, `synthesizer`;
  - `budgetUsd` (the spending cap; 0 for none; absent uses your default);
  - `full` (include prompts and raw outputs).

**Other endpoints.**
- `POST /api/runs` starts a run and returns its id at once.
- `GET /api/runs/:id/events` streams the run as server-sent events, and replays a finished run.
- `POST /api/runs/:id/stop` stops it.
- `GET /api/runs/:id/report.md` returns the report, and `report.html` the shareable page.
- `GET /api/scorecard` (`?mock=1` to include mock models) returns the scorecard.

The server answers only on loopback, checks the Host header (against DNS rebinding), and refuses
cross-origin writes.

## claude.ai page

`npm run build:artifact` writes `dist/agent-debate.html`: one self-contained page, about 310 KB. It
is published as an artifact with two capabilities:
- `sample`: Claude, billed to your plan. claude.ai asks for permission once.
- `downloads`: saving reports and pages.

Runs are kept in memory and in the page's local storage (the last six). The page has the scorecard
and the shareable page too. It has no spending cap, because nothing there is billed per token.

## Tests

```bash
npm test          # 107 unit, engine, server, adapter, feature and page tests — mock models, fake providers, no network
npm run matrix    # ten questions of different kinds through the whole pipeline → docs/TEST_MATRIX_QUESTIONS.md
npm run matrix -- --live deepseek/deepseek-chat,claude/sonnet   # the same ten on models YOU enabled (billed)
npm run test:ui   # browser matrix, 14 checks (needs Playwright: PLAYWRIGHT_MODULE, CHROMIUM_PATH) → docs/TEST_MATRIX.md
```

## Publishing

`.env`, `local/providers.json`, `local/tools.json`, `local/mcp.json`, `local/plugins.json`,
`local/seats.json`, `local/runs/` and `dist/` are git-ignored. Only the `*.example` files ship. Before
a push, `git status` must show none of them.

## Layout

```
app/
  core/        browser-safe engine — runs unchanged in the server, the console and the claude.ai page
    engine.js    phases, events, guards          prompts.js   every prompt and schema
    audit.js     quote / arithmetic / tool audit metrics.js   clusters, overlap, verdicts, movement
    record.js    events → record → report        json.js      JSON extraction and template guards
    cost.js      tokens, prices, the estimate    scorecard.js the model scorecard
    text.js calc.js files.js tools-protocol.js mock-models.js
  server/      node:http server, adapters, config, runs, tools, MCP, plugins, PDF text
  ui/          the console (vanilla ES modules, served as-is); export.js renders the shareable page
  cli.js
build/         artifact linker + claude.ai host
personas/ skills/ plugins/   lenses, house skills, plugin bundles
local/         your config (git-ignored) + *.example
tests/         node:test suites, the ten-question matrix, the browser matrix
docs/          DESIGN.md, test reports, screenshots
legacy/        the rev ≤13 panel app, kept for reference; not used
```
