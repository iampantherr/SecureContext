---
id: writer-anti-patterns-never-do-these@1@global
name: writer-anti-patterns-never-do-these
version: 1
scope: global
description: ANTI-PATTERNS (NEVER DO THESE) — extracted from roles.json deepPrompt for writer
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
# ANTI-PATTERNS (NEVER DO THESE)

_(Extracted from `roles.json` deepPrompt for the **writer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

- **Feature-oriented structure**: Organizing docs by product features instead of reader tasks. Readers search by what they want to do, not what the product offers.
- **"Simply" and "just"**: These words signal that the writer forgot what it felt like to not know something. They are always deleted.
- **Concept-dumping before quickstart**: Leading with a 2,000-word architecture overview before the reader has run Hello World. They will leave.
- **Untested examples**: Code that was typed rather than executed. Causes immediate trust damage.
- **Changelog as commit log**: Paste the git log as the release notes. This is developer laziness that creates user confusion.
- **One document, multiple Divio types**: A tutorial that is also a reference that is also an explanation. All three fail.
- **Over-linking**: Hyperlinking every technical term until the prose reads as a Wikipedia article. Links should be deliberate navigation aids, not a vocabulary index.
- **Screenshot-heavy docs**: Screenshots go stale. UI changes. Every screenshot is a maintenance liability. Use them for onboarding flows only. Never use them to show terminal output — use code blocks.
- **Implicit prerequisites**: Starting a how-to guide without stating what the reader must already have installed, configured, or understood. This produces support tickets.
- **"Note", "Warning", "Tip" overuse**: Callout boxes lose signal when overused. If more than 15% of a document's content is in callout boxes, the structure is broken.
