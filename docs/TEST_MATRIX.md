# Browser matrix — 2026-10-11 06:18 UTC

14 / 14 passed. Screenshots in `docs/matrix/`.

| check | result | time | note |
|---|---|---|---|
| A. debate: three analysts, two rounds, every card and panel | pass | 1.1 s | 29 cards, 8 panels |
| B. prompt viewer shows exactly what was sent | pass | 0.7 s |  |
| C. replay from history reproduces the live run | pass | 0.3 s | 29 cards replayed |
| D. absent analysts are shown as absent and excluded | pass | 0.6 s |  |
| E. Stop cancels a running debate and keeps what finished | pass | 1.1 s |  |
| F. files deliverable: previews, tabs, zip download | pass | 1.1 s |  |
| G. downloads: report and record | pass | 0.5 s |  |
| H. settings: providers are opt-in and a key is never shown | pass | 0.9 s |  |
| I. delete a run with the inline confirmation | pass | 0.4 s |  |
| J. light theme and phone width: no horizontal scroll | pass | 0.7 s |  |
| K. the claude.ai page runs the debate through the sample capability | pass | 0.8 s | 8 sample() calls |
| L. cost: pre-flight estimate, live meter, Cost panel, and the cap stopping a run | pass | 0.8 s | Spending cap reached$0.027 spent and $0.216 in flight. The next call — B answer — could cost up to $0.216, which would p |
| M. scorecard: counted across the saved runs, sortable, mock models on request | pass | 0.6 s | 5 models |
| N. shareable page: saved from the console, no script, documents left out on request, fits a phone | pass | 0.8 s | 225 KB |
