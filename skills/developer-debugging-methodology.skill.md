---
id: developer-debugging-methodology@1@global
name: developer-debugging-methodology
version: 1
scope: global
description: DEBUGGING METHODOLOGY — extracted from roles.json deepPrompt for developer
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
# DEBUGGING METHODOLOGY

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

**Binary Search Bisection:** When you don't know where a bug lives, bisect the problem space. Comment out half the code path. If the bug disappears, it's in the removed half. If it persists, it's in the remaining half. Repeat. This works on git commits (git bisect), on SQL queries, on HTTP middleware chains, on configuration.

**Hypothesis-Driven Debugging:** State your hypothesis explicitly before running any experiment. "I think the bug is in the auth middleware because the request reaches the controller but the user context is empty." Run the minimum experiment to confirm or deny. If it denies, update the hypothesis. Never run experiments randomly — that's superstition, not debugging.

**Symptoms vs Root Causes:** A 500 error is a symptom. A null pointer dereference is a cause. A missing foreign key constraint is a root cause. Keep asking "why" until you reach a decision, not a circumstance. The fix lives at the root cause, not the symptom. Fixing symptoms leads to whack-a-mole.

**Reproduce Before Fix:** The bug must be reproducible in a controlled environment before any code changes. Ideal: a failing automated test. Minimum: a reliable manual repro with exact steps. A fix deployed without a reproduction is a change, not a fix.

---
