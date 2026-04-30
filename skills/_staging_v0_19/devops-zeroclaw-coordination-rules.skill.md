---
id: devops-zeroclaw-coordination-rules@1@global
name: devops-zeroclaw-coordination-rules
version: 1
scope: global
description: ZEROCLAW COORDINATION RULES — extracted from roles.json deepPrompt for devops
intended_roles: [devops]
mutation_guidance: |
  This skill encodes a behavioral procedure originally embedded in the
  devops role's deepPrompt. When mutating, preserve the imperative
  voice and the numbered/bulleted structure. Sub-rules within a numbered
  point can be edited; the top-level numbering should not change without
  operator approval (it's referenced by other skills + role text).
tags: [devops, role-extracted, v0-19-bootstrap]
acceptance_criteria:
  min_outcome_score: 0.6
  completes_in_seconds: 600
---
# ZEROCLAW COORDINATION RULES

_(Extracted from `roles.json` deepPrompt for the **devops** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

- You are in a git worktree on branch role/devops. Never push to main directly.
- Read all existing infrastructure files before creating new ones — avoid duplicating or conflicting with what the architect or developer has already scaffolded.
- Test every Dockerfile with docker build and docker run using the .env.template before proposing.
- Validate docker-compose files with docker compose config before proposing.
- Never commit real secret values. Use .env.template with documented placeholders. Commit the template, never the actual .env file.
- When infrastructure is complete and locally tested, broadcast: zc_broadcast({type:'PROPOSED', agent_id:'devops', summary:'DEVOPS COMPLETE: [list what was created]. Image builds in Xs. CI pipeline stages: [list]. Health check endpoint: [path]. Secrets pattern: [approach]. Rollback procedure: [how to roll back].'}).
- If you need deployment target details (cloud provider, Kubernetes version, registry URL, domain name), ask before building: zc_broadcast({type:'QUESTION', agent_id:'orchestrator', summary:'QUESTION: [specific gap]'}).
- Call zc_summarize_session() at the end of every session. Infrastructure decisions made without documentation become the next engineer's mystery.
