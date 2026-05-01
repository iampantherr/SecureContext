# Skill Enforcement Architecture

**Status:** v0.21.0 ships levers #1, #2, and #4 (soft enforcement).
Lever #5 (hard PreTool block) is **designed but unshipped** — see "Deferred" section.

**Created:** 2026-05-01
**Last updated:** 2026-05-01

---

## Why this exists

The self-improvement loop (`HARNESS_EVOLUTION_PLAN.md` Tier S item #2)
relies on agents invoking `zc_record_skill_outcome` so the L1 hook can
fire and the mutator can improve skills based on observed outcomes.

**The gap:** Claude agents are autonomous. Even with `"you MUST"` language
in role prompts, they sometimes pick `Read`/`Edit`/`Bash` directly because
that path is "simpler" for the immediate task. If agents freelance,
`skill_runs_pg` stays empty and the mutator has nothing to improve.

This doc enumerates the five enforcement levers, what's shipped, and
what's deferred — so the design doesn't get lost.

---

## The five levers

### #1 — Inject `## YOUR SKILLS` block at agent spawn ✅ shipped v0.21.0

`start-agents.ps1` calls `generate-role-skill-block.mjs` per agent role,
which queries `skills_pg` for skills with `intended_roles` containing the
role and prepends a markdown block to the deepPrompt. The agent sees the
inventory at every spawn:

```
## YOUR SKILLS — invoke these for measurable outcomes

As a developer, you have the following skills available...

### Skills available to you

- `developer-debugging-methodology@1@global` — Methodology for...
- `developer-prime-directives@1@global` — Five non-negotiable...
- ...
```

**Effort:** ~80 LoC. **Effectiveness:** High — agent now KNOWS what's
available without having to ask. **Risk:** Low — purely additive.

### #2 — Auto-inject applicable skills into `zc_recall_context` ✅ shipped v0.21.0

`/api/v1/recall` accepts a `?role=<role>` parameter and returns skills
matching that role alongside facts. The MCP server's `zc_recall_context`
tool sends the role (from `ZC_AGENT_ROLE` env), the API returns skills,
and the response text includes a `## Skills available for role '<role>'`
section followed by a reminder about `zc_record_skill_outcome`.

This fires automatically on every session start (the SessionStart hook
calls `zc_recall_context` per CLAUDE.md). Reinforces #1 — the agent sees
their skill inventory not just at spawn but every time they recall context.

**Effort:** ~50 LoC (api-server.ts + server.ts). **Effectiveness:**
High — surfaces in the place agents already look. **Risk:** Low.

### #3 — PreTool hook nudge ⏸️ not yet shipped

When the agent tries `Edit`/`Bash`/`Write` on patterns that match a
skill's `intended_roles`, prepend a hint via the PreTool hook:

```
[hint] Skill `developer-debugging-methodology` may apply to this task.
       Invoke via zc_skill_run_replay first to record an outcome, OR
       call zc_record_skill_outcome at MERGE time. Continuing without it.
```

Doesn't block — just nudges. Pattern matching: regex against tool args
(file paths, command keywords) compared to skill `tags` and `description`.

**Effort:** ~150 LoC (new hook in `~/.claude/hooks/`). **Effectiveness:**
Medium — hint fatigue is real. **Risk:** Medium — pattern-match false
positives create noise.

**Decision (2026-05-01):** Defer to v0.22.0+. Ship #1+#2+#4 first, observe
agent behavior for a week, decide if #3 adds value.

### #4 — Mandate via role prompt ✅ shipped v0.21.0

Every role prompt (orchestrator + worker) now ends with a "SKILL-OUTCOME
RECORDING (MANDATORY before MERGE)" section that prescribes the exact
`zc_record_skill_outcome` call shape and explains why it matters. Both
the orchestrator's `$orchSystem` and each worker's `$workerSystem` get
this appended.

**Effort:** ~30 LoC of prompt text. **Effectiveness:** Medium-High —
prompts work most of the time, especially when reinforced by #1 and #2.
**Risk:** Low — pure prompt change.

### #5 — Hard PreTool block ⏸️ designed but DELIBERATELY unshipped

Refuse `Edit`/`Write`/`Bash` until the agent has called either
`zc_skill_run_replay` or `zc_record_skill_outcome` in the current session
for an applicable skill. Implementation sketch:

```typescript
// In a PreToolUse hook, gated by ZC_SKILL_HARD_ENFORCE=1:
const tools_requiring_skill = new Set(["Edit", "Write", "Bash", "MultiEdit"]);
if (tools_requiring_skill.has(toolName)) {
  const sessionSkillRuns = countSkillRunsThisSession(sessionId);
  if (sessionSkillRuns === 0) {
    // Determine if any skill matches the agent's role + this task
    const applicable = await findApplicableSkills(role, taskContext);
    if (applicable.length > 0) {
      return blockToolCall({
        reason: `No skill_run recorded yet. Call zc_skill_show + zc_record_skill_outcome first.`,
        suggested_skills: applicable.slice(0, 3),
      });
    }
    // No skills match → log "no_applicable_skill_for_task" and allow
  }
}
```

**Why deferred:**
1. **Risk of getting agents stuck.** If the pattern-matcher misses the
   applicable skill (false negative), the agent literally cannot proceed.
   This is rage-inducing for the operator and hard to debug remotely.
2. **Risk of cascade failures.** Multi-agent flows where the orchestrator
   needs to run a quick `git status` to plan the next step would also be
   blocked until the orchestrator records a skill outcome — but the
   orchestrator's job isn't really skill-shaped.
3. **#1+#2+#4 are likely sufficient.** If after a week of v0.21.0
   deployment we observe a skill-record rate >70%, the marginal benefit
   of going from 70% to 95% via #5 is probably not worth the rigidity
   cost.
4. **Hard enforcement on Claude is brittle.** Claude can't "go around"
   the block — it just gets stuck and gives up. Soft nudges respect
   agent judgment for the cases the system designer didn't anticipate.

**When to ship:**
- Operator observes <50% skill-record rate after 1 week of v0.21.0
- AND a clear class of "agent is doing the same wrong thing repeatedly"
  failures
- Implementation will be `~250 LoC` in a new
  `~/.claude/hooks/skill-enforce.mjs` PreToolUse hook gated by
  `ZC_SKILL_HARD_ENFORCE=1` so it's opt-in until proven safe

**Implementation notes for future me:**
- The hook runs in node, has access to `~/.claude/zc-ctx/sessions/<hash>.db`
- Query `skill_runs` table for any row in current `session_id`
- If 0, call the API server's `/api/v1/skills/applicable?role=X&task=...`
  endpoint (also unbuilt — needs an LLM call or heuristic)
- Return JSON to the hook stdin with `block: true, reason: "..."` to refuse
  the tool call
- Log every block to `~/.claude/zc-ctx/logs/enforcement.<date>.log` with
  trace_id so operator can audit + tune the heuristic
- Provide an escape hatch: an MCP tool `zc_skill_skip_this_task(reason)`
  that records "no_applicable_skill" with the operator-supplied reason and
  bypasses #5 for the rest of this session

---

## Monitoring (for deciding when/whether to ship #5)

`v0.21.1` should add a "skill usage rate" panel to the dashboard that
shows, per role, the fraction of sessions ending in MERGE that recorded
at least one skill_run. If the rate stays >70% across all roles, #5 is
unnecessary. If the rate drops below 50% for any role, that's a signal
to either (a) improve that role's skills (operator authoring), (b) tighten
the role's prompt, or (c) ship #5 as a last resort.

---

## Related design docs

- `HARNESS_EVOLUTION_PLAN.md` Tier S #2 — "Skills + continuous self-improvement loop"
- `docs/V0_19_E2E_REPORT.md` — discovered the original gap that motivated this work
- `CHANGELOG.md` v0.20.1 — caught the launcher env-propagation bug that exposed the root cause
- `CHANGELOG.md` v0.21.0 — ships levers #1+#2+#4

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-05-01 | Ship #1+#2+#4 as v0.21.0 | Cheap, low-risk, mutually reinforcing. |
| 2026-05-01 | Defer #3 (PreTool nudge) to v0.22+ | Need a week of #1+2+4 data first. |
| 2026-05-01 | DESIGN #5 but DON'T ship | Risk/reward poor until soft levers prove insufficient. Document so the design isn't lost. |
