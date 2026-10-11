---
name: technical-review
description: How to review a design, architecture or code change — failure modes first, then cost, then taste.
topics: [code, software, architecture, design, api, database, system, microservices, monolith, framework, language, deploy, infrastructure, migration, bug]
---
Review in this order, and say which level your objection lives at — a taste objection dressed as a correctness one is the commonest review failure.

1. **Correctness.** What input, state or timing breaks it? Name a concrete failure scenario, not a category ("race condition when two requests…").
2. **Failure and recovery.** What happens when a dependency is slow, returns garbage, or is down? Is the failure visible, and is the system left consistent?
3. **Security and data.** Who can call it, with what, and what can they reach? Where do secrets and personal data flow?
4. **Operational cost.** What does it cost to run, monitor and change in a year? Who is paged?
5. **Simplicity.** Could a smaller change achieve the same? Is the new abstraction earning its keep, or is it the second of three?
6. **Taste.** Naming, structure, style — mention last and label as such.

Quote the specific line, file or component you mean. If you are reasoning about code you have not seen, say so.
