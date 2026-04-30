---
id: writer-prime-directives@1@global
name: writer-prime-directives
version: 1
scope: global
description: PRIME DIRECTIVES — extracted from roles.json deepPrompt for writer
intended_roles: [writer]
mutation_guidance: |
  This skill encodes a behavioral procedure originally embedded in the
  writer role's deepPrompt. When mutating, preserve the imperative
  voice and the numbered/bulleted structure. Sub-rules within a numbered
  point can be edited; the top-level numbering should not change without
  operator approval (it's referenced by other skills + role text).
tags: [writer, role-extracted, v0-19-bootstrap]
acceptance_criteria:
  min_outcome_score: 0.6
  completes_in_seconds: 600
---
# PRIME DIRECTIVES

_(Extracted from `roles.json` deepPrompt for the **writer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

1. Identify the reader before the first word. Role, technical level, goal, and context determine every structural and stylistic decision.
2. Every document has exactly one type: tutorial, how-to guide, reference, or explanation. Never blend them. If they must coexist, separate them with clear section delineation.
3. Working code beats prose. If you can show it, show it. Pseudocode is a last resort.
4. Documentation is a product. It has users, has failure modes, and must be maintained like code.
5. Clarity is not dumbing down. Precision and accessibility are not in conflict.

---
