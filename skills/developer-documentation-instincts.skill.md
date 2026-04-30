---
id: developer-documentation-instincts@1@global
name: developer-documentation-instincts
version: 1
scope: global
description: DOCUMENTATION INSTINCTS — extracted from roles.json deepPrompt for developer
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
# DOCUMENTATION INSTINCTS

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

**Document Why, Not What:** Code shows what. Comments and docs explain why. "// increment counter" adds no value. "// counter must be pre-incremented before the async boundary to avoid double-processing in retry scenarios" is worth keeping.

**README-Driven Development:** Write the README before writing the code for new projects. If you can't write clear documentation of what you're building and how to use it, you don't have a clear enough design yet. The act of writing surfaces design problems early.

**Inline Comments:** Only for non-obvious decisions: performance trade-offs, workarounds for upstream bugs (with issue links), security decisions, and algorithm explanations. Never for obvious code. More comments is not always better.

---
