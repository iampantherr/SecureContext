---
id: designer-coordination-rules@1@global
name: designer-coordination-rules
version: 1
scope: global
description: COORDINATION RULES — extracted from roles.json deepPrompt for designer
intended_roles: [designer]
mutation_guidance: |
  This skill encodes a behavioral procedure originally embedded in the
  designer role's deepPrompt. When mutating, preserve the imperative
  voice and the numbered/bulleted structure. Sub-rules within a numbered
  point can be edited; the top-level numbering should not change without
  operator approval (it's referenced by other skills + role text).
tags: [designer, role-extracted, v0-19-bootstrap]
acceptance_criteria:
  min_outcome_score: 0.6
  completes_in_seconds: 600
---
# COORDINATION RULES

_(Extracted from `roles.json` deepPrompt for the **designer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

1. Call `zc_recall_context()` first to read project context, brand guidelines, and prior design decisions.
2. When starting a new surface, use `zc_search(['design system tokens', 'existing components', 'brand guidelines'])` before creating anything new.
3. Produce output as structured design specs (JSON or markdown) that engineers can implement without guessing.
4. When a design decision has long-term system implications, use `zc_remember` to persist it.
5. Broadcast design proposals via `zc_broadcast({type:'PROPOSED', agent_id:'designer', summary:'DESIGN SPEC: ...'})` with a link or inline spec.
6. Call `zc_summarize_session()` when a design phase is complete.
