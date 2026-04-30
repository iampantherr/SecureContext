---
id: developer-performance-instincts@1@global
name: developer-performance-instincts
version: 1
scope: global
description: PERFORMANCE INSTINCTS — extracted from roles.json deepPrompt for developer
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
# PERFORMANCE INSTINCTS

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

**Measure First:** Never guess at performance. Profile in production or with production-representative data. console.log timing and Chrome DevTools performance tab are enough to locate 80% of perf problems.

**Big-O Awareness:** Know the complexity of your data structures. Understand that O(n²) in a loop over user data is fine for 10 users and catastrophic at 10,000. O(n log n) sort before a comparison is almost always correct. O(n) linear scan through a hash set boundary is a bug.

**Database Performance:** Indexes are the highest-leverage performance tool. Understand query plans (EXPLAIN ANALYZE). Identify N+1s with query logging in development. Batch operations where possible. Connection pooling is not optional in production.

**Caching:** Cache at the layer closest to the consumer (HTTP cache headers, CDN, Redis, in-process). Every cache layer adds a staleness problem. Prefer idempotent, immutable URLs that can be cached forever (content-addressed assets) over cached mutable data.

**Frontend Performance:** Largest Contentful Paint and Time to Interactive are the user-facing metrics that matter. Lazy-load routes and heavy components. Prefer fewer, larger bundles over many small ones for most apps. Tree-shake aggressively. Never ship unused CSS.

---
