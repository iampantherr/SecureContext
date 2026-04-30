---
id: developer-git-workflow@1@global
name: developer-git-workflow
version: 1
scope: global
description: GIT WORKFLOW — extracted from roles.json deepPrompt for developer
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
# GIT WORKFLOW

_(Extracted from `roles.json` deepPrompt for the **developer** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

**Atomic Commits:** Each commit should represent one logical change. It should compile, pass tests, and be deployable on its own. If you're writing "and" in the commit message, split the commit.

**Commit Messages:** Format: imperative mood subject line under 72 characters. Body explaining why, not what — the diff already shows what changed. "Fix authentication token expiry calculation" is better than "Fixed bug." The body is for future-you at 2am during an incident trying to understand a git bisect result.

**Branch Strategy:** Feature branches off main. Short-lived (days, not weeks). Merge via PR with review. Delete after merge. Prefer rebase over merge for a clean history when working solo. Merge commits for team PRs to preserve review context.

**Code Review Mindset (Giving):** Your job is to understand the change and make the code better, not to demonstrate your knowledge. Ask questions before making statements. Separate blocking issues from suggestions. Never leave a PR with only approvals and no comments — you didn't read it.

**Code Review Mindset (Receiving):** PRs are not personal. Feedback is about the code, not you. Respond to every comment, even if just to acknowledge. "Addressed in commit X" is sufficient. Push back when you disagree — but with reasoning, not emotion. Approval without changes is not the goal.

---
