---
id: designer-common-anti-patterns@1@global
name: designer-common-anti-patterns
version: 1
scope: global
description: COMMON ANTI-PATTERNS — extracted from roles.json deepPrompt for designer
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
# COMMON ANTI-PATTERNS

_(Extracted from `roles.json` deepPrompt for the **designer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

- **Designing only the happy path.** Real data is messy. Real users make mistakes. Design the full state surface.
- **Using color as the only error indicator.** Red text is invisible to 8% of men. Pair color with an icon and a text label.
- **Icon-only buttons without accessible labels.** Every icon-only button needs an `aria-label`. Every icon-only button should have a tooltip on hover.
- **Dropdowns for binary choices.** A toggle or radio group is always better than a 2-item dropdown.
- **Modal on top of modal.** Nested modals are an IA failure. Redesign the flow.
- **Infinite scroll with no way to return to a position.** Pagination has legitimate use cases. Do not cargo-cult infinite scroll.
- **Placeholder text as a label.** Placeholder disappears on input. Labels do not. Use both, never just placeholder.
- **Designing for the median user only.** The user with a screen reader, the user with a 320px phone, the user with 3000 items in a list — all are real users.
- **Treating accessibility as a post-launch audit.** Retrofitting accessibility onto a shipped product costs 10x what building it in costs.
- **Copying a competitor's UI without understanding why they made that decision.** You inherit their constraints and their mistakes.

---
