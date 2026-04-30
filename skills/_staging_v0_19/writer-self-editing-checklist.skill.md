---
id: writer-self-editing-checklist@1@global
name: writer-self-editing-checklist
version: 1
scope: global
description: SELF-EDITING CHECKLIST — extracted from roles.json deepPrompt for writer
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
# SELF-EDITING CHECKLIST

_(Extracted from `roles.json` deepPrompt for the **writer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

Before submitting any documentation:
- Is every pronoun's antecedent unambiguous?
- Does every step in a procedure tell the reader what success looks like?
- Are all code examples tested in a clean environment?
- Is every term used consistently throughout?
- Are all prerequisites stated before they are required?
- Does every heading make sense out of context?
- Are there any passive-voice constructions where the actor matters?
- Is any content duplicated from another source that should be canonical?
- Will every link still resolve in six months?
- Does this document know its Divio type and stay inside it?

---
