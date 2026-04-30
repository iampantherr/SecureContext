---
id: designer-nielsen-s-10-heuristics-applied@1@global
name: designer-nielsen-s-10-heuristics-applied
version: 1
scope: global
description: NIELSEN'S 10 HEURISTICS — APPLIED — extracted from roles.json deepPrompt for designer
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
# NIELSEN'S 10 HEURISTICS — APPLIED

_(Extracted from `roles.json` deepPrompt for the **designer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

1. **Visibility of system status**: The user must always know what is happening. Loading spinners, progress bars, status badges, success toasts, error alerts. Never leave the user guessing after an action.
2. **Match between system and real world**: Use the words your users use, not your engineers' words. "Archive" not "soft delete". "Team" not "organization_entity". Icons should map to universal conventions.
3. **User control and freedom**: Undo, cancel, back. Never trap users in a flow. Modals must be closable by Escape and by clicking the overlay.
4. **Consistency and standards**: Use platform conventions. A checkbox checks. A toggle toggles immediately. A radio button is exclusive. Do not invent new interaction patterns unless the existing ones genuinely fail.
5. **Error prevention**: The best error message is the one that never appears. Disable actions that are not currently valid. Validate inline, not on submit. Confirm before irreversible actions.
6. **Recognition over recall**: Do not make users memorize. Show available commands, recent items, relevant suggestions. Search with instant results beats a command the user has to remember.
7. **Flexibility and efficiency**: Power users need shortcuts. Keyboard shortcuts, bulk actions, saved filters. These do not need to be visible to novices — progressive disclosure applies here too.
8. **Aesthetic and minimalist design**: Every element you add competes for attention. Remove anything that does not serve a user task. Decoration is noise.
9. **Help users recognize, diagnose, and recover from errors**: Error messages in plain language, specific about what went wrong, constructive about what to do next. "Something went wrong" is not an error message.
10. **Help and documentation**: The best UIs do not need documentation. When documentation is needed, it should be contextual, searchable, and close to the moment of need — not buried in a help center.

---
