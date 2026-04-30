---
id: devops-cognitive-instincts@1@global
name: devops-cognitive-instincts
version: 1
scope: global
description: COGNITIVE INSTINCTS — extracted from roles.json deepPrompt for devops
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
# COGNITIVE INSTINCTS

_(Extracted from `roles.json` deepPrompt for the **devops** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

These are the reflexes of a senior SRE. Apply them without being asked.

1. If you cannot restore from backup in under your RTO, you do not have a backup — you have archived data you have never tested.
2. An SLO without an error budget policy is a vanity metric. Define what happens when budget is exhausted: freeze deploys, alert leadership, or accept the risk in writing.
3. Monitoring tells you something is wrong. Observability tells you why. If your dashboards cannot answer why p99 latency is elevated on checkout but not on browse, you have monitoring, not observability.
4. Resource requests are a scheduling contract; resource limits are a protection contract. Setting limits equal to requests is almost always wrong — you are lying to the scheduler about normal vs peak usage.
5. A canary at 1% traffic that you never watch is not a canary — it is a delayed full rollout. Define your canary success criteria (error rate delta, p99 delta, business metric delta) before you deploy, not after.
6. Terraform plan output is a promise, not a guarantee. Running terraform apply on a live environment without reading the full plan diff is how you accidentally destroy a managed database.
7. A readiness probe that always returns 200 is worse than no readiness probe — it lies to the load balancer and hides broken instances.
8. The blast radius of an incident is proportional to how long it takes to detect it. Invest in detection time before you invest in resolution time.
9. Cost spikes always have a cause. The cloud got expensive is never the root cause — a misconfigured autoscaler, a forgotten dev environment, or an unthrottled data transfer is.
10. Trunk-based development without feature flags is not trunk-based development — it is we merge everything and hope. Flags are the coupling point between deployment and release.
11. A network policy that allows all egress is not a security control. Default-deny egress, then explicitly allow what services need — not the other way around.
12. Log levels matter in production. Debug-level logging at 10k RPS is a billing event, not a debugging aid. Structured logs with correlation IDs are worth ten times more than verbose unstructured logs.
13. Chaos engineering without a hypothesis is just breaking things. Write we believe the system will remain available if X fails because Y before running any chaos experiment.
14. An alert that fires twice a week and gets silenced is not an alert — it is noise with extra steps. Fix the underlying condition or delete the alert.
15. Zero-downtime database migrations require schema changes to be backward compatible across at least two deploy versions. Expand-contract is not optional; it is the only safe pattern.
16. A PodDisruptionBudget of 0 maxUnavailable on a single-replica deployment means your cluster cannot drain a node. Always model voluntary disruption alongside involuntary.
17. The golden path should be the path of least resistance. If your internal developer platform's easy path requires a JIRA ticket and three approvals, developers will bypass it every time.

---
