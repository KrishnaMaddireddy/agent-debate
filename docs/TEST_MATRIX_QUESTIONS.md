# Ten-question matrix — mock models

2026-10-11 06:19 UTC · **10 / 10 passed** · `node tests/matrix.mjs`

| # | kind | question | models | result | grounded | headline | guards |
|---|---|---|---|---|---|---|---|
| 1 | decision from a document, with arithmetic | Which 3 cities should we pilot in first? | mock-1, mock-alt | pass | 6/10 | agreement did not move (items agreed by everyone) | — |
| 2 | open question, no documents, three analysts | Is remote work better for junior engineers than office work? | mock-1, mock-alt, mock-3 | pass | 0/6 | agreement ROSE (shared claims +17 pts) | — |
| 3 | policy reading with a lens | Can an employee work from Portugal for 3 weeks without approval? | mock-2, mock-alt | pass | 6/10 | agreement did not move (shared claims) | — |
| 4 | code review | Is this median function correct for arrays of numbers? | mock-1, mock-3 | pass | 6/10 | agreement did not move (shared claims) | — |
| 5 | a fabricating analyst is caught by the audit | How many sign-ups did Austin have? | mock-1, mock-liar | pass | 5/11 | agreement did not move (shared claims) | — |
| 6 | absent analysts are excluded, not counted as disagreement | Should a small team adopt a monorepo? | mock-1, mock-empty, mock-fail, mock-2 | pass | 0/4 | agreement did not move (shared claims) | 2 absent |
| 7 | misbehaving formats: template copy, prose, reasoning channel; the reading falls back | Is a four-day work week good for productivity? | mock-template, mock-prose, mock-reasoning | pass | 0/3 | agreement did not move (shared claims) | 2 JSON repair, 1 template copy, 1 absent |
| 8 | tools: calculator, a greedy caller and a DSML caller | What is 17.5% of 2,340,000 and is it above 400,000? | mock-greedy, mock-dsml | pass | 0/6 | agreement did not move (shared claims) | — |
| 9 | files deliverable | A one-page site announcing the pilot, with a chart | mock-svg, mock-2 | pass | 0/0 | agreement ROSE (position similarity +8 pts) | — |
| 10 | memo writer that leaks its reasoning is retried | Should we raise prices by 10% next quarter? | mock-1, mock-alt | pass | 0/4 | agreement ROSE (shared claims +17 pts) | memo retry, auto-stop after 2 |

## Intent, as read

**1. Which 3 cities should we pilot in first?** — Whether cities pilot first holds up, judged on the evidence available here.

**2. Is remote work better for junior engineers than office work?** — Whether remote work better holds up, judged on the evidence available here.

**3. Can an employee work from Portugal for 3 weeks without approval?** — Whether employee work portugal holds up, judged on the evidence available here.

**4. Is this median function correct for arrays of numbers?** — Whether median function correct holds up, judged on the evidence available here.

**5. How many sign-ups did Austin have?** — Whether many sign-ups austin holds up, judged on the evidence available here.

**6. Should a small team adopt a monorepo?** — Whether small team adopt holds up, judged on the evidence available here.

**7. Is a four-day work week good for productivity?** — Whether four-day work week holds up, judged on the evidence available here.

**8. What is 17.5% of 2,340,000 and is it above 400,000?** — Whether 175% 2,340,000 above holds up, judged on the evidence available here.

**9. A one-page site announcing the pilot, with a chart** — Whether one-page site announcing holds up, judged on the evidence available here.

**10. Should we raise prices by 10% next quarter?** — Whether raise prices next holds up, judged on the evidence available here.

