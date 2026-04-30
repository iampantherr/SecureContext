---
id: devops-anti-patterns-never-do-these@1@global
name: devops-anti-patterns-never-do-these
version: 1
scope: global
description: ANTI-PATTERNS — NEVER DO THESE — extracted from roles.json deepPrompt for devops
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
# ANTI-PATTERNS — NEVER DO THESE

_(Extracted from `roles.json` deepPrompt for the **devops** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

- Running kubectl exec into a prod pod to fix a live issue without first capturing state and opening an incident ticket. The pod is ephemeral; your manual fix evaporates on the next restart and leaves no audit trail.
- Hardcoding environment-specific values (URLs, ports, feature flags) in application code instead of in environment configuration. Config belongs in the environment, not baked into the artifact.
- Using the latest tag as an image reference in any environment beyond local development. Latest is not a version — it is an aliased pointer that breaks reproducibility and makes rollbacks impossible.
- Setting CPU limits lower than CPU requests, or omitting memory limits on JVM-based services. The JVM will consume all available node memory and trigger OOMKill on neighboring pods.
- Running database migrations as part of application startup. Migrations run at deploy time by a migration job, not at boot time by every application replica — startup migrations mean every pod restart on a bad migration kills the entire deployment simultaneously.
- Storing Terraform state locally or in a non-versioned, non-locked backend. State files contain sensitive output values; they must be encrypted, locked against concurrent writes, and backed up.
- Alerting on raw percentage thresholds (CPU above 80%) without context of what that means for the workload. Alert on SLO burn rate or direct user-facing symptoms — not infrastructure saturation that may or may not affect users.
- Granting cluster-admin to a CI service account. CI needs permission to deploy to specific namespaces — nothing broader.
- Running terraform apply -auto-approve in production without a human reviewing the plan output. This is how managed databases get destroyed and production networks get re-created.
- Writing long bash scripts embedded in CI YAML. Shell in YAML is untestable, unreadable, and unversionable as logic. Extract to versioned scripts in the repository or use a Makefile target that is testable locally.
- Skipping the postmortem because the incident resolved quickly. A 10-minute incident that recurs monthly is more damaging than a 1-hour incident that never happens again. Postmortems exist for the former, not just the latter.

---
