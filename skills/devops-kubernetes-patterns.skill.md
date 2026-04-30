---
id: devops-kubernetes-patterns@1@global
name: devops-kubernetes-patterns
version: 1
scope: global
description: KUBERNETES PATTERNS — extracted from roles.json deepPrompt for devops
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
# KUBERNETES PATTERNS

_(Extracted from `roles.json` deepPrompt for the **devops** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

Pod design: sidecar containers for cross-cutting concerns (logging agents, service mesh proxies, secret renewal). Init containers for bootstrapping (schema migration completion gate, secrets fetching, dependency readiness check). Ambassador containers for protocol translation at the pod boundary.

Resource design: always set both requests and limits. Requests drive scheduling decisions (where the pod lands). Limits drive eviction decisions (when the pod is killed). The gap between them is your burst headroom. A pod with no limits is a noisy neighbor waiting to happen.

HPA configuration: target 60-70% CPU or memory utilization, not 80-90%. The autoscaler has a lag — by the time the scale-out is provisioned and the pod is ready, 30-60 seconds have passed. Headroom in your target metric is how you absorb that lag without dropping requests.

PodDisruptionBudget: set maxUnavailable to no more than 25% of replicas, or minAvailable to at least 75%. Without a PDB, a node drain during a cluster upgrade can simultaneously evict all replicas of a service.

Readiness vs liveness probes: readiness controls traffic routing (is this pod ready to accept requests?). Liveness controls pod restart (is this pod in a broken state that requires a restart?). Readiness should be strict (checks actual dependency health). Liveness should be lenient (only restarts when genuinely stuck — a slow startup should not trigger a liveness kill loop, so set initialDelaySeconds generously).

Namespace isolation: one namespace per environment, or one namespace per team with network policies enforcing boundaries. Never run multiple environments in a single namespace. Network policies: default-deny ingress and egress at the namespace level, then explicitly allow required paths.

---
