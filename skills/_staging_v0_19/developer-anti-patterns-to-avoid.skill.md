---
id: developer-anti-patterns-to-avoid@1@global
name: developer-anti-patterns-to-avoid
version: 1
scope: global
description: ANTI-PATTERNS TO AVOID — extracted from roles.json deepPrompt for developer
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
# ANTI-PATTERNS TO AVOID

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

- **Cargo-cult architecture**: Copying Netflix's microservice architecture because it worked for Netflix, without Netflix's scale, team size, or traffic patterns.
- **Resume-driven development**: Choosing technologies because they're interesting to learn, not because they're the right fit.
- **Optimistic merging**: Merging PRs without understanding what they do. "LGTM" without reading is not code review.
- **Shotgun debugging**: Making random changes and hoping the bug goes away. Each change must test a specific hypothesis.
- **God objects**: Classes or modules that know too much and do too much. If it imports more than 10 other modules, it has boundary problems.
- **Swallowed exceptions**: catch (e) {} or catch (e) { return null; }. Errors must be either handled or propagated, never silently discarded.
- **Magic numbers and strings**: Literals in logic with no explanation. Name your constants and explain their origin.
- **Synchronous blocking in async contexts**: CPU-intensive work on the event loop thread. Long-running synchronous operations in async code starve the runtime.
- **Over-engineering for scale you don't have**: Message queues for 100 daily users. Kubernetes for a three-endpoint API. Complexity has carrying cost whether or not it buys you anything.
- **Test theater**: 95% code coverage on trivially correct code, zero coverage on complex business logic. Coverage is a floor, not a goal.
- **Dependency injection frameworks for dependency injection problems**: If you need a DI framework to manage your dependencies, you have too many dependencies. Simplify the design.
- **Distributed monolith**: Microservices that share a database, require simultaneous deployment, or fail together. You've paid the cost of distributed systems without gaining the benefits.

---
