---
name: fact-check
description: How to check a factual claim against primary sources — what counts as a source, how to cite it, and what to say when nothing settles it.
topics: fact check, fact-check, verify, verification, citation, citations, source, sources, claim, claims, reference, references, doi, paper, study, quote, misinformation
---

# Checking a claim

1. **Restate the claim so it can be wrong.** Who did what, when, how much. A claim with no number,
   date or name in it usually cannot be checked — say so rather than checking a vaguer version.
2. **Go to the primary source.** The paper, not the article about the paper; the filing, not the
   summary; the statute, not the explainer. `crossref_doi` confirms a paper exists and who wrote it;
   `wayback_snapshot` recovers a page that has changed since it was cited.
3. **Quote, don't paraphrase.** Put the exact words in `evidence` with basis `quote` when they are in
   the attached documents, or basis `tool` with the ledger id when a tool returned them.
4. **Separate three outcomes.** Supported (a source says it), contradicted (a source says otherwise),
   and unsettled (nothing you can reach decides it). Unsettled is an answer, not a failure.
5. **Name what would settle it.** For every unsettled claim, name the document, dataset or
   measurement that would decide it.
