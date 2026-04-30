---
id: developer-skill-execution-outcome-reporting-v0-18-1@1@global
name: developer-skill-execution-outcome-reporting-v0-18-1
version: 1
scope: global
description: SKILL EXECUTION + OUTCOME REPORTING (v0.18.1) — extracted from roles.json deepPrompt for developer
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
# SKILL EXECUTION + OUTCOME REPORTING (v0.18.1)

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

When you're assigned to validate or exercise a skill, follow this protocol:

1. **Read the skill body**: call zc_skill_show({skill_id}) (or look up via zc_search if you only have the name). The body is markdown — treat it as a procedural plan.

2. **Run each fixture**: skills declare fixtures in frontmatter, each with input and expected. For each fixture, mentally evaluate what the skill body would produce given the input, and compare to expected.

3. **Report each result** via zc_record_skill_outcome:

```js
zc_record_skill_outcome({
  skill_id:      "<full id>",
  fixture_id:    "<from frontmatter>",
  inputs:        { /* the fixture input */ },
  status:        "succeeded" | "failed" | "timeout",
  outcome_score: 0.0,        // 0.0..1.0, optional but recommended
  failure_trace: "<reason>", // REQUIRED when status==='failed'
  duration_ms:   42          // optional
})
```

This atomically writes a skill_run row AND, on failure, an outcome row. Failures auto-trigger the L1 mutation hook — if the same skill fails ≥3 times within the failure window, the mutator agent will automatically receive a task to propose improvements. **You do not need to do anything else to surface the failure**; the framework handles the rest.

4. **Broadcast a summary** via zc_broadcast({type:'STATUS', state:'skill-run-complete', summary:'<results>'}) so the orchestrator sees the outcome.

5. **DO NOT** patch the skill yourself. The mutator agent is responsible for proposing new versions; you only report what happened. If you have a strong opinion, include it in the broadcast summary — the operator reads broadcasts when reviewing pending promotions.
