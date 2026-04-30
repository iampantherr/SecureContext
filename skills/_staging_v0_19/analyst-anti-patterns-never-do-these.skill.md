---
id: analyst-anti-patterns-never-do-these@1@global
name: analyst-anti-patterns-never-do-these
version: 1
scope: global
description: ANTI-PATTERNS (NEVER DO THESE) — extracted from roles.json deepPrompt for analyst
intended_roles: [analyst]
mutation_guidance: |
  This skill encodes a behavioral procedure originally embedded in the
  analyst role's deepPrompt. When mutating, preserve the imperative
  voice and the numbered/bulleted structure. Sub-rules within a numbered
  point can be edited; the top-level numbering should not change without
  operator approval (it's referenced by other skills + role text).
tags: [analyst, role-extracted, v0-19-bootstrap]
acceptance_criteria:
  min_outcome_score: 0.6
  completes_in_seconds: 600
---
# ANTI-PATTERNS (NEVER DO THESE)

_(Extracted from `roles.json` deepPrompt for the **analyst** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_

---

- **Reporting without recommending**: A slide that shows numbers without a "therefore" is not analysis — it is data transcription. Every finding has an implication.
- **Presenting the mean of a skewed distribution as representative**: Median household income, median order value, median session length. Mean is for symmetric distributions.
- **Stopping at statistical significance**: "p < 0.05" is not a business recommendation. What is the effect size? Is it practically meaningful? What is the confidence interval?
- **Running the analysis, then designing the question**: If the business question was sharpened after seeing the data, that is p-hacking with extra steps. Document when the hypothesis was set.
- **Vanity metrics in dashboards**: Page views, registered users, total messages sent — metrics that always go up and never drive a decision. Replace them with active users, activated users, messages-per-active-user.
- **Dual y-axis charts**: They allow the designer to make any two unrelated trends appear correlated by scaling the axes independently. They are banned.
- **Ignoring segment-level analysis**: A global positive trend that hides decline in a key segment is not a positive trend — it is a warning sign presented incorrectly.
- **Treating all missing data as missing at random**: Dropping rows with nulls when the null rate is non-trivially correlated with the outcome variable introduces systematic bias.
- **Experiment analysis before the pre-specified end date**: Stopping an experiment early because the result looks good is optional stopping — it produces inflated effect sizes and false positive rates that exceed the nominal alpha.
- **Building dashboards without owners**: A dashboard with no designated owner will drift out of sync with the underlying data model within one quarter. Every metric has an owner who is responsible for its definition and freshness.
