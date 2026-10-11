# Lessons — one entry per live run that taught something

(PRD §12 carries the twelve inherited from Model Bridge. Add to this file, not
to your memory.)

## rev 14 — what building the PRD engine taught (mock and browser runs, 2026-09-30)

- **Opposite claims look alike to word overlap.** "X outweighs the costs" and "X does not outweigh the
  costs" share almost every content word. Clustering must be polarity-aware (negation parity plus
  antonyms), checked at the cluster level, or disagreement is reported as consensus.
- **Numbers decide sameness.** Two claims that share a year but differ on the amount are different
  claims. The smaller number set must be contained in the larger.
- **Events must be snapshots.** An event that held a live reference let a later rebuttal rewrite the
  phase-1 record. emit() deep-clones.
- **A lens given once is a lens forgotten.** The persona reached phase 1 only; critique, rebuttal and
  memo judged by the models' own defaults. Every phase now carries it.
- **One bad reader should not cost the whole run its reading.** A template-copying reader left every
  analyst without a shared question. One fallback to the next analyst on a different model is cheap
  and recorded.
- **Recovered answers must say where they came from.** An answer parsed out of the reasoning channel is
  now noted on the answer, not silently treated as ordinary content.

## rev 14 — first live run (DeepSeek ×2, 2026-09-30)

- **Models copy the format they are shown, not the format they are told.** The agenda listed rows as
  `B:c4 — "text"`, and the critic's verdict references came back in exactly that shape. Parse what the
  prompt displays, or display only what should come back.
- **Evidence strings are written for people.** "1200 - 800; 1200 - 300" and "…covers exactly three
  cities" are how an analyst writes arithmetic. An audit that wants one expression and a digit calls
  good work unparseable or miscomputed.
- **Names carry commentary.** "Austin — first" is a rank, not a different city. Any key that compares
  model output across models must strip the annotation first.
- **A same-model debate still disagrees.** Two deepseek-chat analysts reached the same three cities
  under different rules and confidences; the root causes came out as interpretation and values, with
  none from evidence. It works as a cheap smoke test, but it is not a substitute for mixing models.

## rev 15: live runs with the meter on (DeepSeek, 2026-10-11)

- **The model you ask for is not always the model that answers.** `deepseek-chat` is served by
  `deepseek-flash`. The response's `model` field says so, and the report now records it. A price
  table keyed on the requested id must follow the alias.
- **The same model under two names behaves differently.** `deepseek-flash` asked directly wrote
  13k output tokens for one answer; `deepseek-chat` (served by it) wrote 2.7k. Price per answer, not
  per token, is the number to compare. The scorecard shows it.
- **One wrong quote character can move every brace after it.** `"…last year.',` left the outer object
  unparseable, and the next-best candidate was an item fragment carrying `"claims": ["c3","c6"]`. It
  was accepted as the answer. An answer must state a position; anything less goes to repair.
- **A cap checked after the call is a report, not a cap.** Checking each call's worst case before it
  starts, and reserving it while it runs, is what lets "$0.01" mean $0.01 when calls run in parallel.
