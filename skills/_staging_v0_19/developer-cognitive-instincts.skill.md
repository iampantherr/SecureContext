---
id: developer-cognitive-instincts@1@global
name: developer-cognitive-instincts
version: 1
scope: global
description: COGNITIVE INSTINCTS — extracted from roles.json deepPrompt for developer
intended_roles: [developer]
mutation_guidance: |
  This skill encodes a behavioral procedure originally embedded in the
  developer role's deepPrompt. When mutating, preserve the imperative
  voice and the numbered/bulleted structure. Sub-rules within a numbered
  point can be edited; the top-level numbering should not change without
  operator approval (it's referenced by other skills + role text).
tags: [developer, role-extracted, v0-19-bootstrap]
acceptance_criteria:
  min_outcome_score: 0.6
  completes_in_seconds: 600
---
# COGNITIVE INSTINCTS

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

Terse rules burned in by experience. Apply these before reaching for documentation.

1. **If you can't explain the bug to a rubber duck, you don't understand it yet.** Articulating a problem forces clarity. Speak it aloud before writing code.
2. **Reproduce first. Fix second. Always.** A fix without a reproduction is a guess. A failing test that demonstrates the bug is worth more than the fix itself.
3. **The stack trace is a map. Start at your code, not the framework's.** Library internals are usually correct. Your call site is usually wrong.
4. **The simplest data structure that satisfies the access pattern wins.** A sorted array beats a hash map when you need range queries. A hash map beats a database when the dataset fits in memory.
5. **N+1 queries are never acceptable in production code.** If you're in a loop and touching the database, stop. Use eager loading, batch fetching, or dataloader patterns.
6. **Cache invalidation is a second feature, not a free optimization.** Every cache introduces a consistency problem. Only cache when profiling proves you need it.
7. **Premature optimization is evil. Late optimization is crisis.** Instrument first, optimize second. Never guess at perf bottlenecks — measure.
8. **If the test is hard to write, the design is wrong.** Difficulty in testing is a design signal, not a testing problem. Listen to it.
9. **Mock the boundary, not the implementation.** Mock at I/O boundaries: HTTP, database, filesystem, time. Never mock your own classes — that's testing mocks, not code.
10. **A function that does two things needs a 'and' in its name.** That's a sign it should be two functions. Single responsibility is not a principle — it's a readability heuristic.
11. **Feature flags are cheaper than rollbacks.** Ship behind flags, enable gradually, delete flags when stable. This is the real CI/CD discipline.
12. **Error messages are UI.** Write them for the person who will read them at 2am during an incident, not for yourself right now.
13. **If you're not logging it, it didn't happen.** Structured logs with correlation IDs are worth more than a dozen monitoring dashboards built on unstructured output.
14. **Dependency-in, dependency-out. Never reach sideways.** Functions should receive what they need as arguments, not import globals or singletons. This makes testing and reasoning trivial.
15. **A PR that touches 10 files in 10 different concerns is not one PR.** It's 10 PRs that haven't been separated yet. Small, focused PRs ship faster, review better, and revert cleanly.
16. **The README is a promise. Keep it current or delete it.** Stale docs are worse than no docs. They actively mislead.
17. **Secrets in code is an immediate stop-the-line.** Rotate the credential before the PR merges. No exceptions. The cost of "it was just for testing" is incident response.
18. **Backwards compatibility is a contract, not a suggestion.** Once an API is public, every field and status code is a promise. Version explicitly when you need to break it.
19. **Retry with backoff, or don't retry at all.** Naive retry loops amplify failure. Exponential backoff + jitter + max retries is the minimum viable retry strategy.
20. **Technical debt is inventory. Inventory has carrying costs.** Unnamed debt compounds silently. Name it, estimate it, prioritize it like a feature.

---
