# Sprint 2 Skills — Walkthrough & Usage Guide

This is the v0.18.0 self-improving skill system. Below is a concrete worked example, how to configure each piece, and what the cross-project flow looks like.

---

## TL;DR — The full lifecycle in 6 steps

1. **Author**: write a markdown skill file at `<project>/.claude/skills/<name>.md` (or `~/.claude/skills/<name>.md` for global).
2. **Use**: an agent reads the skill via `zc_skill_show` and follows the procedure on real work.
3. **Measure**: every execution records a row in `skill_runs` with composite outcome score (accuracy + cost + speed).
4. **Mutate**: nightly cron (or on-demand `zc_skill_propose_mutation`) generates 5 candidate variants.
5. **Replay**: each candidate runs against synthetic fixtures; best-scoring wins.
6. **Promote**: if best beats parent by ≥ 10% AND meets acceptance criteria, parent is archived + new version becomes active.

The system improves itself: failures become signal for the next mutation; successful candidates become the new baseline.

---

## What a skill looks like on disk

`<project>/.claude/skills/validate-input.md`:

```markdown
---
name: validate-input
version: 1.0.0
scope: project:aafb4b029db36884
description: Validate input arguments before processing
requires_network: false
acceptance_criteria:
  min_outcome_score: 0.7
  min_pass_rate: 0.8
fixtures:
  - fixture_id: "non-array-input"
    description: "tasks=undefined should throw TypeError"
    input: { "tasks": null, "filters": {} }
    expected: { "throws": "TypeError", "ok": true }
  - fixture_id: "bad-pattern-type"
    description: "pattern=42 should be coerced or rejected"
    input: { "tasks": [], "filters": { "status": 42 } }
    expected: { "throws": "TypeError" }
---

# Validate Input

When given a function with arguments:
1. Check `tasks` is an array — throw TypeError if not.
2. For each filter value: check it's a string or number.
3. Return early on validation failure — never silently coerce.
```

The file has two sections:
- **Frontmatter** (between `---` markers): structured metadata. `acceptance_criteria` defines what "passing" means; `fixtures` are the synthetic test inputs the mutation engine validates against.
- **Body** (markdown): the procedure the agent follows. This is what gets shown to the agent via `zc_skill_show`.

Each skill body is HMAC-signed against the machine secret. Tampering between disk and memory is detected at load time (`SkillTamperedError`).

---

## How "the skill improves itself" — concrete example

Picture the skill above at v1.0.0. An agent uses it. Here's the cycle:

### Run 1: agent uses v1.0.0 on real code, succeeds 50% of the time

The agent calls `zc_skill_show("validate-input")`, reads the procedure, applies it to a task. On the `non-array-input` fixture it succeeds (`tasks` check is explicit). On `bad-pattern-type` it fails (the body's "check it's a string or number" is too vague — agent forgets to handle filters being objects). Failure traces accumulate in `skill_runs.failure_trace`:

```
"Filter validation missed: filters.status=42 (number) was accepted; should have thrown"
```

After 5 runs: avg outcome_score = 0.50.

### Mutation cycle fires (nightly cron OR on-demand)

The orchestrator's `runMutationCycle`:
1. Pulls last 20 `skill_runs` for `validate-input@1.0.0`
2. Builds a `MutationContext` with the current body + failure traces + fixtures
3. Calls the configured mutator (e.g. `RealtimeSonnetMutator`)
4. Sonnet returns 5 candidate bodies, each with a rationale:

   ```
   Candidate 1: "...explicitly check typeof filters[k] for each key, 
                 throw TypeError with the offending key in the message..."
   Candidate 2: "...use a Joi schema for the entire input shape..."
   Candidate 3: "...add a Number.isFinite() check after parseFloat..."
   ...
   ```

5. Each candidate is replayed against the fixtures (LocalDeterministicExecutor for now; Sprint 2.5 ships a real subprocess executor)
6. Replay scores are written to `skill_mutations.replay_score`

### Promotion decision

`shouldPromote(candidateAgg, parentAgg, acceptance)` returns `promote: true` when:
- candidate avg_score beats parent by ≥ 0.10 (`MIN_PROMOTION_DELTA`)
- candidate meets acceptance_criteria
- candidate's avg_cost ≤ 2× parent (no cost-regression attack)

Best candidate wins. The orchestrator runs an atomic transaction:
1. `archiveSkill(parent.skill_id, "promoted candidate mut-xyz")`
2. `upsertSkill(newSkill)` — version `1.0.1`, `promoted_from: <parent skill_id>`
3. `resolveMutation(mutationId, { promoted: true, promoted_to_skill_id: newSkill.skill_id })`

### Run 2: agent uses v1.0.1, succeeds 90% of the time

Next session, agent's `zc_skill_show` returns v1.0.1 (which is now the active row). Body has Candidate 1's improved validation logic. Failures drop. Avg outcome_score climbs to ~0.90.

That's the loop. Failures → mutation → better body → better future runs → fewer failures.

---

## How to use the 3 mutator implementations

Set via `ZC_MUTATOR_MODEL` env var. Allowlist enforced — unknown values fall back to `local-mock`.

### `local-mock` (default)

```bash
# No env var set → defaults to local-mock
# Or explicitly:
ZC_MUTATOR_MODEL=local-mock node scripts/run-nightly-mutations.mjs --project /your/project
```

- **Cost**: $0
- **Use**: tests, CI, when you want the cycle to run but don't want LLM bills
- **Behavior**: deterministic — generates 5 canned candidates from text rules. Useful for verifying the orchestrator + scoring + promotion path without API dependencies.

### `realtime-sonnet`

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ZC_MUTATOR_MODEL=realtime-sonnet
node scripts/run-nightly-mutations.mjs --project /your/project
```

- **Cost**: ~$0.024/cycle (3k input + 1k output × Sonnet pricing)
- **Use**: ad-hoc mutations when you want results NOW (no batch wait)
- **Latency**: ~5-15 seconds per call
- **MCP equivalent**: `zc_skill_propose_mutation({name: "validate-input"})` while `ZC_MUTATOR_MODEL=realtime-sonnet` is set in your MCP server's env

### `batch-sonnet` (recommended for nightly)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ZC_MUTATOR_MODEL=batch-sonnet
# Run via OS cron at 02:00 nightly:
0 2 * * *  node /path/to/SecureContext/scripts/run-nightly-mutations.mjs --project /your/project
```

- **Cost**: ~$0.012/cycle (50% batch discount)
- **SLA**: 24h (Anthropic's batch API guarantee)
- **Use**: nightly automated mutation
- **Note**: the script BLOCKS while polling for batch completion — typical ~1-2 hours. Don't run interactively.

### Switching mid-session

`getMutator()` reads the env var at call time. To switch a running MCP server, restart it with the new env var:

```powershell
# In your MCP server's launch:
$env:ZC_MUTATOR_MODEL = "realtime-sonnet"
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node /path/to/SecureContext/dist/server.js
```

---

## Project-level vs Global-level skills, and how they learn from each other

### Two scopes

| Scope | Path | Use case |
|---|---|---|
| `global` | `~/.claude/skills/<name>.md` | The shared baseline. Works everywhere. |
| `project:<projectHash>` | `<project>/.claude/skills/<name>.md` | Project-specific evolution; overrides global |

### Resolution at load time

When an agent calls `zc_skill_show("validate-input")`, the resolver:

1. Looks for `validate-input` at `project:<projectHash>` scope first
2. If not found, falls back to `global` scope
3. Returns the active (un-archived) row

So per-project versions naturally override global without affecting other projects.

### Independent evolution

Each project's mutation cycle runs on its own version:

- Project A's `validate-input@1.0.0@project:A_hash` evolves into `1.0.1@project:A_hash` based on Project A's failure traces.
- Project B's `validate-input@1.0.0@project:B_hash` evolves into `1.0.1@project:B_hash` based on Project B's failure traces.
- Both projects' improvements are **isolated** — Project A's optimization for Tailwind v3 doesn't leak into Project B which uses CSS Modules.

### Cross-project promotion (when a project's improvement is generally good)

`findGlobalPromotionCandidates(threshold, minProjects)` queries Postgres for candidates: skill names where the best per-project version beats the global by ≥ threshold across ≥ minProjects projects.

```
findGlobalPromotionCandidates(0.10, 2)
  → [{ name: "validate-input",
       best_skill_id: "validate-input@1.0.5@project:A_hash",
       best_avg: 0.91,
       global_avg: 0.65,
       project_count: 3 }]
```

When a candidate surfaces, the operator decides: *"is Project A's optimization actually general-purpose, or is it just A-specific?"*

To promote manually:
1. `zc_skill_export validate-input` from Project A → returns agentskills.io markdown
2. Edit if needed (strip A-specific tweaks)
3. `zc_skill_import` with `scope: "global"` — installs as the new global baseline
4. Other projects pick up the new global on their next `zc_skill_show` (unless they have their own per-project version)

**Automatic promotion** is deferred to Sprint 2.5 (S2.5-4). For now: the candidate query exposes WHO should be promoted; a human approves.

---

## How the cron job works (and how to set it up)

### What runs

`scripts/run-nightly-mutations.mjs --project <path>` does:
1. Open the project DB (SQLite + PG mirror per `ZC_TELEMETRY_BACKEND`)
2. List all active skills
3. Pick the bottom-3 by recent avg outcome_score (`selectUnderperformingSkills`)
4. For each, run the full mutation cycle (mutator → 5 candidates → replay → promote)
5. Run `findGlobalPromotionCandidates` (PG only) and report candidates
6. Emit a structured JSON summary to stdout

### Setting it up on Linux/macOS

```bash
# Edit crontab (one-time)
crontab -e

# Add:
0 2 * * *  ZC_POSTGRES_PASSWORD=… ZC_POSTGRES_HOST=localhost ZC_TELEMETRY_BACKEND=postgres \
           ZC_MUTATOR_MODEL=batch-sonnet ANTHROPIC_API_KEY=sk-ant-… \
           /usr/bin/node /path/to/SecureContext/scripts/run-nightly-mutations.mjs \
           --project /home/you/code/your-project >> /var/log/zc-nightly.log 2>&1
```

### Setting it up on Windows (Task Scheduler)

```powershell
# Create scheduled task
$action = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "C:\path\to\SecureContext\scripts\run-nightly-mutations.mjs --project C:\code\your-project"

$trigger = New-ScheduledTaskTrigger -Daily -At 2am

# Set env vars for the task (one approach: bake them into a wrapper .ps1)
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "ZC Nightly Mutations" `
  -Description "Run SC skill mutation cycle nightly"
```

For the env vars, write a wrapper PowerShell script that sets them before running, and have Task Scheduler invoke that.

### What if you DON'T set up cron?

Skills still work. They just don't auto-improve. You can:
- Run `zc_skill_propose_mutation({name: "..."})` manually via the MCP tools whenever you want
- Run `node scripts/run-nightly-mutations.mjs` manually whenever you want
- Skip mutation entirely and use skills as static reference docs

The cron is for unattended overnight improvement. It's a productivity feature, not a correctness requirement.

---

## Walkthrough: the live demo we just ran

`scripts/sprint2-cross-project-demo.mjs` walks through the full cross-project flow against real Postgres:

```
[step 1] Seeded global skill validate-input@1.0.0@global
[step 2] Project A: 5 mediocre runs (avg 0.5)
[step 3] Project A: mutation cycle → validate-input@1.0.1@project:A_hash promoted
         baseline=0.388 → best=1.000
[step 4] Project A: 5 improved runs (avg 0.85) on the new version
[step 5] Project B: same flow → its own validate-input@1.0.1@project:B_hash
[step 6] findGlobalPromotionCandidates(threshold=0.10, minProjects=2)
         → 1 candidate: validate-input
           best_skill_id: validate-input@1.0.1@project:90ede6232fca7947
           best_avg: 0.850 > global_avg: 0.500 (0.350 above threshold)
           project_count: 2 (≥ 2 required)
```

The query correctly identified that across 2 projects, the per-project version is consistently outperforming the global. An operator can now decide whether to promote.

---

## Cost summary

| Mode | Cost / cycle | Skills mutated nightly | Monthly cost |
|---|---:|---:|---:|
| `local-mock` | $0 | 3 | $0 |
| `realtime-sonnet` | $0.024 | 3 | ~$2.16 |
| `batch-sonnet` | $0.012 | 3 | **~$1.08** |

Plus occasional Opus-tier escalation (~5% of cases for hard problems): ~$0.30/month.

**Total expected: ~$1-3/month per project** for fully-automated nightly skill improvement. At a portfolio of 10 projects: ~$10-30/month.

---

## Limitations of v0.18.0 (what's deferred to Sprint 2.5)

See `C:\Users\Amit\AI_projects\.harness-planning\ARCHITECTURAL_LESSONS.md` "Sprint 2.5 Deferrals" section for full list. Highlights:

| Item | Impact today | Sprint 2.5 |
|---|---|---|
| **Subprocess sandbox executor** | Replay uses LocalDeterministicExecutor (canned rules). Skills don't actually run as subprocesses with restricted env. | S2.5-1, 2-3 days |
| **Real-historical replay** | Only synthetic fixtures supported. Real session replay deferred until synthetic loop is stable for 1 week. | S2.5-2, 1 week |
| **Auto-promotion to global** | Cross-project candidates surface via query but require manual `zc_skill_import` to publish. | S2.5-4, 3 days |
| **Skill load-time injection scanner** | HMAC verifies tampered bodies, but doesn't catch a skill *originally* containing prompt injection. | S2.5-8, 1 day |
| **Per-project override confirmation** | A new project-scoped skill is just upserted. No operator confirmation prompt. | S2.5-3, 2 days |

Total Sprint 2.5 scope: ~3 weeks. Half the items (S2.5-1, S2.5-4, S2.5-8) are HIGH priority and fit in ~1 week.

---

## Quick reference

### MCP tools for skills

| Tool | What it does |
|---|---|
| `zc_skill_list` | List active skills + recent scores |
| `zc_skill_show {name}` | Full skill body + frontmatter |
| `zc_skill_score {name}` | Aggregate score + acceptance check |
| `zc_skill_run_replay {name}` | Run replay against fixtures |
| `zc_skill_propose_mutation {name}` | Run one mutation cycle (uses ZC_MUTATOR_MODEL) |
| `zc_skill_export {name}` | Export as agentskills.io markdown |
| `zc_skill_import {markdown, scope?}` | Import an agentskills.io skill |

### Env vars

| Variable | Purpose | Default |
|---|---|---|
| `ZC_MUTATOR_MODEL` | Which proposer to use | `local-mock` |
| `ANTHROPIC_API_KEY` | Required for `realtime-sonnet` / `batch-sonnet` | — |
| `ZC_TELEMETRY_BACKEND` | `sqlite` / `postgres` / `dual` for skill storage | `sqlite` |
| `ZC_POSTGRES_*` | PG connection (when backend includes postgres) | — |

### Files

- `src/skills/types.ts` — type graph
- `src/skills/loader.ts` — markdown frontmatter parser + HMAC
- `src/skills/storage.ts` — SQLite CRUD
- `src/skills/storage_pg.ts` — PG mirror
- `src/skills/storage_dual.ts` — backend-aware dispatch
- `src/skills/scoring.ts` — composite outcome score + acceptance
- `src/skills/replay.ts` — synthetic-fixture replay harness
- `src/skills/mutator.ts` + `mutators/*.ts` — pluggable mutators
- `src/skills/orchestrator.ts` — full mutation cycle
- `src/skills/format/agentskills_io.ts` — interop import/export
- `src/cron/scheduler.ts` — in-process scheduler primitive
- `scripts/run-nightly-mutations.mjs` — OS cron entrypoint
- `scripts/sprint2-cross-project-demo.mjs` — live cross-project demo

### DB tables

**SQLite** (per-project):
- `skills` (mig 20)
- `skill_runs` (mig 21)
- `skill_mutations` (mig 22)

**Postgres** (shared):
- `skills_pg` (PG mig 6)
- `skill_runs_pg` (PG mig 7) — has `project_hash` column for cross-project queries
- `skill_mutations_pg` (PG mig 8)
