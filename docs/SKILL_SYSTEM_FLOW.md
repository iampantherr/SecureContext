# SecureContext skill system — end-to-end flow map (v0.30.0+)

This document visualizes every flow a skill can travel: from operator authoring,
through admission, through agent execution, through outcome capture, through
spotter discovery, through mutator improvement, through promotion, all the way
to retirement. Use it to find which component handles a question and which DB
table holds the answer.

---

## 0. The data model in one picture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FILESYSTEM (Anthropic-style skills)                       │
│  ~/.claude/skills/<name>/SKILL.md           ← global skills (operator-edited)│
│                       /scripts/             ← L3 bundled scripts             │
│                       /references/          ← read-on-demand reference docs  │
│  <project>/.claude/skills/<name>/...        ← project-scoped overrides       │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ filesystem_skill_import.ts (auto on sc-api boot
               │                              + /dashboard/skills/import)
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          POSTGRES (durable side)                             │
│  skills_pg              ← admitted skill rows (body_hmac, frontmatter JSON)  │
│  skill_admission_log_pg ← HMAC-chained audit (immutable)                     │
│  skill_security_scans_pg← AST scan results per bundled script                │
│  skill_runs_pg          ← every zc_skill_show + outcome the agent recorded   │
│  outcomes_pg            ← all outcomes (skill_run OR git-commit-resolved)    │
│  skill_mutations_pg     ← every mutation candidate proposed (final state)    │
│  mutation_results_pg    ← side-channel bodies (option-b — unlimited size)    │
│  skill_revisions_pg     ← audit of frontmatter edits / promotions / archives │
│  skill_candidates_pg    ← spotter-proposed candidates awaiting review        │
│  skill_spotter_runs_pg  ← α dry-run metadata                                 │
│  skill_spotter_signals_pg← signals mined per run + LLM-filer decisions      │
│  task_queue_pg          ← work-stealing queue (mutator-* roles)             │
│  broadcasts             ← per-agent broadcast channel (PG-backed)            │
└─────────────────────────────────────────────────────────────────────────────┘
               ▲
               │ store-postgres.ts / pg_pool.ts (sc-api reads + writes)
               │
       ┌───────┴───────┐
       │   sc-api      │  HTTP server (container)
       │ MCP server    │  per-agent (terminal Claude CLI)
       └───────────────┘
```

---

## 1. AUTHORING — three operator paths, one admission gate

The operator has THREE ways to create a skill. All three converge on the same
admission gate so the security guarantees (HMAC + AST + chained audit log) hold
regardless of how the skill was authored.

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  PATH A — Dashboard "+ New skill" form (v0.25.0)                     │
   │     operator clicks button on /dashboard, fills name/version/scope/  │
   │     description/intended_roles/body in HTMX form                     │
   │     POST /dashboard/skills/new                                       │
   │     ✓ no shell / no filesystem access required                       │
   │     ✗ body-only — no L3 bundled scripts (single textarea)            │
   │     ✗ no references/ folder                                          │
   │     → admitted skill marked as 👤 custom                              │
   │     best for: quick body-only skills (text instructions only)        │
   └────────────────────────────────┬─────────────────────────────────────┘
                                    │
   ┌──────────────────────────────────────────────────────────────────────┐
   │  PATH B — Filesystem (Anthropic-style, full L3 leverage)             │
   │     operator writes by hand under                                     │
   │       ~/.claude/skills/<name>/SKILL.md       (L2 body)               │
   │       ~/.claude/skills/<name>/scripts/*.py    (L3 bundled scripts)   │
   │       ~/.claude/skills/<name>/references/*.md (on-demand refs)       │
   │     POST /dashboard/skills/import   (or auto on sc-api boot)         │
   │     ✓ full L3 leverage (bundled scripts get HMAC + AST scan)         │
   │     ✓ supports references/                                            │
   │     ✗ requires shell / file access                                    │
   │     best for: production skills with bundled scripts                  │
   └────────────────────────────────┬─────────────────────────────────────┘
                                    │
   ┌──────────────────────────────────────────────────────────────────────┐
   │  PATH C — Agent uses writing-skills meta-skill (delegated authoring) │
   │     operator types in any terminal agent:                             │
   │       "Write a skill for X" / "Scaffold skill Y"                     │
   │     agent calls zc_skill_show({name:'writing-skills'})               │
   │       → loads four-invariant checklist + scope matrix + script rules │
   │     agent runs bundled tools from writing-skills/scripts/:           │
   │       scaffold-skill.py    (generates SKILL.md + scripts/ template)  │
   │       lint-skill.py        (verifies 4 invariants)                   │
   │       preview-admission.py (dry-runs the admission gate)             │
   │     operator reviews diff, commits to disk → PATH B re-import        │
   │     ✓ guided by the meta-skill's procedural checklist                │
   │     ✓ enforces the v0.29.0 standard automatically                    │
   │     best for: when you want the agent to do the work + sanity-check  │
   │                                                                       │
   │     NOTE: this is the SAME meta-skill v0.30.1 mutators consult before │
   │           generating candidates (see §4). One skill, two consumers.   │
   └────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
                      ┌─────────────────────────┐
                      │   THE ADMISSION GATE    │
                      │   (one funnel for all   │
                      │    three paths above)   │
                      └────────────┬────────────┘
                                   │
   filesystem_skill_import.ts (PATH B) | storage_dual.upsertSkill (PATH A)
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
   parseFsSkill                body_hmac                  script AST scan
   (YAML+body)                 HMAC-SHA256                py_ast_walker.py
   lint-skill.py rules         "script:" || body          + acorn (for .js)
        │                          │                          │
        ▼                          ▼                          ▼
   PASS or REJECT       PASS (always)        PASS or QUARANTINE
        │                          │                          │
        ├─ reject (PATH A: error)  │                          ├─ violation:
        ├─ quarantine (PATH B):    │                          │   eval(), exec(),
        │     atomic-move to       │                          │   shell=True,
        │     ~/.claude/skills.quarantine/                    │   pickle, yaml
        │     skill_admission_log_pg INSERT                   │   without Loader
        │     (kind=admit, status=quarantined)                │
        │     dashboard AUDIT BANNER                          │
        ▼                                                     ▼
   PG INSERT skills_pg                       PG INSERT skill_security_scans_pg
   PG INSERT skill_admission_log_pg          (one row per script, with HMAC)
   (status=admitted, prev_hash chained)
        │
        ▼
   broadcast STATUS state='skill-admitted'
        │
        ▼
   AGENT'S "## YOUR SKILLS" block updated on next spawn
   (via augment-role-prompt.mjs → /api/v1/skills/by-role?role=<role>)
```

### Comparison table — which authoring path fits which job?

| Need | Path A (dashboard) | Path B (FS) | Path C (agent) |
|---|---|---|---|
| Body-only skill (text instructions) | ✓ best | ✓ works | ✓ works |
| Bundled scripts at L3 | ✗ | ✓ | ✓ (via agent) |
| references/ folder | ✗ | ✓ | ✓ |
| No shell access | ✓ | ✗ | ✗ (agent needs it) |
| Guided by meta-skill checklist | ✗ | ✗ | ✓ |
| Operator-typed by hand | ✓ | ✓ | partial |
| Goes through admission gate | ✓ | ✓ | ✓ |
| Survives HMAC tamper detection | ✓ | ✓ | ✓ |

---

## 2. AGENT EXECUTION — skill_show → work → outcome

```
   terminal Claude CLI agent (Pro-plan auth)
                  │
                  │ session start ritual:
                  │   zc_recall_context()
                  │   zc_project_card()
                  │   zc_search([topics])
                  │
                  │ dispatcher routes a task ASSIGN broadcast
                  ▼
   STEP 1 — zc_skill_show({ name: '<best match from YOUR SKILLS>' })
            │
            │ MCP server queries skills_pg by name
            │ HMAC-verifies body_hmac (RT-S2-09 invariant)
            │ sets currentSkillContext = { skill_id, run_id }
            │ INSERT skill_runs_pg row (status=in_progress)
            ▼
   STEP 2 — agent does the work, following the skill's procedure
            │ may invoke L3 bundled scripts via Bash:
            │   bash ~/.claude/skills/<name>/scripts/foo.py
            │ PreToolUse hook re-verifies script HMAC before execution
            │ (catches tampered scripts even if FS was modified)
            ▼
   STEP 3 — zc_record_skill_outcome({
              skill_id, status, outcome_score, inputs, evidence
            })
            │
            │ UPDATE skill_runs_pg (status, outcome_score, evidence)
            │
            │ ─if score < 0.5 OR status in (failed,timeout)─►  GOTO §4 L1
            │
            ▼
   STEP 4 — zc_summarize_session()
   STEP 5 — zc_broadcast({ type: 'MERGE', ... })   ← Stop hook enforces order
```

---

## 3. SPOTTER — α discovers patterns, β proposes skills

```
   operator clicks "Run dry-run" on dashboard
                  │
                  ▼
   POST /dashboard/spotter/dry-run?days=30
                  │
                  ▼
   src/skills/spotter/run.ts
                  │
                  ▼
   detectors.ts: scan tool_calls_pg + skill_runs_pg + broadcasts
                  │      ├─ repeated_tool_sequence  (N-gram detection)
                  │      ├─ repeated_doc_read       (same Read across N sessions)
                  │      └─ (more detectors planned)
                  ▼
   INSERT skill_spotter_runs_pg row
   INSERT skill_spotter_signals_pg rows (one per pattern, outcome='observed')
                  │
                  │   dashboard renders signals → operator can:
                  │     - dismiss noise manually (UPDATE outcome='rejected_*')
                  │     - click "Run LLM filer" → BETA β filer (§3b below)
                  ▼
   ────────────────────────────────────────────────────────────
   β FILER (v0.30.0 — terminal agent queue pattern)
   ────────────────────────────────────────────────────────────
   POST /api/v1/skills/spotter/runs/:run_id/llm-file?project_path=...
                  │
                  ▼
   src/skills/spotter/llm_filer.ts → enqueueAndAwaitAgent()
                  │
                  ├─ INSERT task_queue_pg row (role=mutator-general)
                  │  payload.kind = 'skill-spotter-filer'
                  │
                  │   (waits in PG until claimed)
                  ▼
   terminal mutator-general agent (Pro auth, $0 cost)
                  │
                  │  zc_claim_task → reads payload (signals + existing skills + standard)
                  │  Sonnet 4.6 reasoning over signals applying Anthropic standard
                  │  for each signal: decide outcome + (if filed) generate body
                  │
                  │  zc_record_mutation_result({ bodies: [<json-encoded decisions>] })
                  │       INSERT mutation_results_pg
                  │  zc_broadcast STATUS state='spotter-filer-result' (pointer)
                  │  zc_complete_task; EXIT
                  ▼
   llm_filer.ts polls PG broadcasts, sees pointer
                  │
                  ▼
   fetchMutationResult (hash-verify) → decode decisions
                  │
                  │ for each decision:
                  │   outcome='filed_candidate' → INSERT skill_candidates_pg (status=ready)
                  │   outcome='rejected_*'      → UPDATE skill_spotter_signals_pg
                  ▼
   operator reviews skill_candidates_pg on dashboard
   → approve → writeFileSync + autoImportSkills (→ §1 admission)
   → reject  → UPDATE status='rejected'
```

---

## 4. L1 MUTATION — low-score outcome triggers self-improvement

```
   agent records FAILED skill_run via zc_record_skill_outcome
                  │
                  │ (status in {failed,timeout} OR outcome_score < 0.5)
                  ▼
   MCP server: server.ts:zc_record_skill_outcome handler
                  │
                  │ if (process.env.ZC_L1_MUTATION_ENABLED === '1')
                  ▼
   outcomes.ts:tryTriggerL1Mutation(projectPath, runId)
                  │
                  ├─ guardrails (mutation_guardrails.ts):
                  │   1. cooldown:   ≥ ZC_MUTATION_COOLDOWN_HOURS h since last
                  │   2. threshold:  ≥ ZC_MUTATION_FAILURE_THRESHOLD failures /window
                  │   3. daily cap:  ≤ ZC_MUTATION_DAILY_CAP_PER_PROJECT today
                  │
                  ├─ resolve skill from skills_pg (PG fallback after SQLite miss)
                  ├─ intended_roles[0] → mutator_pool.ts:resolveMutatorPool()
                  │     "developer"   → "mutator-engineering"
                  │     "marketer"    → "mutator-marketing"
                  │     ...
                  ▼
   INSERT task_queue_pg row
     task_id   = mut-<random>
     role      = mutator-<pool>
     payload   = { kind: 'skill-mutation', parent_body, failure_traces,
                   fixtures, acceptance_criteria, instructions }
                  │
                  ▼   [dispatcher auto-spawn pattern: ^mutator-]
   A2A_dispatcher/dispatcher.mjs:maybeAutoSpawnPools
                  │ if no live worker for this pool, fire LAUNCH_ROLE
                  │ → spawn-agent.ps1 opens new terminal Claude CLI window
                  │   with deepPrompt from roles.json + augmenter output:
                  │     Lever #1: "## YOUR SKILLS" block (includes writing-skills)
                  │     Lever #1b: SKILL LOADING pre-task mandate
                  │     Lever #4: SKILL-OUTCOME RECORDING (MERGE mandate)
                  │     Lever #5: pointer → call zc_skill_show('writing-skills')
                  ▼
   terminal mutator-engineering agent (Sonnet 4.6, Pro auth)
                  │
                  │  STEP 1 — zc_skill_show({ name: 'writing-skills' })
                  │           ← loads canonical authoring standard
                  │             (four invariants, scope matrix, script rules,
                  │              composition principles, sample bodies)
                  │
                  │  STEP 2 — zc_claim_task({ role: 'mutator-engineering' })
                  │
                  │  STEP 3 — Sonnet reasoning over:
                  │             - parent_body (skill currently failing)
                  │             - failure_traces (3-10 recent traces)
                  │             - acceptance_criteria
                  │             - prior_decisions (operator's past approvals)
                  │             - operator-tagged exemplars (good runs)
                  │             - writing-skills body (the standard)
                  │           → generate EXACTLY 5 candidate bodies
                  │
                  │  STEP 4 — zc_record_mutation_result({ bodies, hashes })
                  │             INSERT mutation_results_pg
                  │  STEP 5 — zc_broadcast STATUS state='mutation-result' (pointer)
                  │  STEP 6 — zc_complete_task; agent EXITS
                  ▼
   CliClaudeMutator (sc-api side) polls PG broadcasts
                  │ detects pointer → fetchMutationResult (hash-verify)
                  │ stores bodies into skill_mutations_pg (one row per candidate)
                  ▼
   replay engine evaluates each candidate against fixtures
                  │ (orchestrator.ts:runMutationCycle)
                  │ judge_score + replay_score recorded
                  ▼
   dashboard shows candidates → operator picks one → §5 PROMOTION
```

---

## 5. PROMOTION — candidate becomes a new active version

```
   operator clicks "Promote" on a candidate (dashboard)
                  │
                  ▼
   POST /dashboard/skill-mutations/:mutation_id/promote
                  │
                  ▼
   src/skills/promotion.ts
                  │
                  ├─ build new skill (parent.frontmatter + candidate.body
                  │  + bumped patch version)
                  ├─ HMAC-compute body_hmac
                  ▼
   admission gate (same path as §1, but for in-PG flow):
                  ├─ AST scan if any new scripts referenced
                  ├─ HMAC chain append to skill_admission_log_pg
                  ▼
   PG UPDATE skills_pg
     archive previous active version (set archived_at=NOW())
     INSERT new version (active)
   PG UPDATE skill_mutations_pg (promoted=true, promoted_to_skill_id)
   PG INSERT skill_revisions_pg (action='promoted')
                  │
                  ▼
   broadcast STATUS state='skill-promoted'
                  │
                  ▼
   v0.18.2 Sprint 2.6 — AUTO-REASSIGN:
   if mutation.original_task_id was tied to a failed run,
   re-enqueue that task on the SAME role with was_retry_after_promotion=true
   → developer agent re-tries with the new skill body
   → if it succeeds, the loop closes; if it fails again, the
     retry_after_promotion guardrail blocks an immediate re-mutation
     (operator must intervene)
```

---

## 6. RETIREMENT — archival without deletion

```
   operator clicks "Archive" on a skill
                  OR
   admission gate sees the source file deleted on disk
                  │
                  ▼
   UPDATE skills_pg SET archived_at = NOW()
   INSERT skill_revisions_pg (action='archived')
                  │
                  │ archived skills stay queryable via skill_id lookup
                  │ but DON'T appear in /api/v1/skills/by-role responses
                  │ DON'T appear in zc_skill_list output
                  ▼
   FILESYSTEM: source file remains where it was (operator removes manually
   if they also want the file gone). The audit trail is preserved.
```

---

## 7. The standard pipeline (v0.30.0)

```
   SecureContext: src/skills/anthropic_standard.ts          ← SOURCE OF TRUTH
        │
        ├─► buildProposerPrompt(ctx) embeds it
        │   (used by API-based mutators: RealtimeSonnet, BatchSonnet)
        │
        ├─► /api/v1/skills/standard endpoint exposes it
        │   (consumed by A2A_dispatcher's sync-standard-from-securecontext.mjs)
        │
        └─► writing-skills meta-skill body (~/.claude/skills/writing-skills/SKILL.md)
            │   embeds the same content, formatted as authoring guidance
            ▼
     mutator-* terminal agents:
        │  Lever #5 in augment-role-prompt.mjs (system-prompt level):
        │     "MANDATORY before generating candidates: call
        │      zc_skill_show({name:'writing-skills'})"
        │
        │  agent calls the tool → MCP server reads skills_pg
        │  → body returned, becomes the authoritative reasoning context
        │  → candidates generated respect the standard
```

---

## 8. Component cheat-sheet — where does each thing live?

| Concern | Path / Service |
|---|---|
| Skill source-of-truth | `~/.claude/skills/<name>/SKILL.md` |
| Admission gate | `src/skills/admission_log.ts`, `src/skill_auto_import.ts`, `src/skills/filesystem_skill_import.ts` |
| AST scanner | `scripts/py_ast_walker.py` + acorn (in `src/skills/script_scanner.ts`) |
| HMAC tamper detection | `src/skills/loader.ts:computeSkillBodyHmac` + machine_secret |
| L1 mutation trigger | `src/outcomes.ts:tryTriggerL1Mutation` (called from `src/server.ts:zc_record_skill_outcome`) |
| Mutation guardrails | `src/skills/mutation_guardrails.ts` (cooldown/threshold/daily cap) |
| Mutator pool resolution | `src/skills/mutator_pool.ts` ← reads `A2A_dispatcher/roles.json` |
| Mutator abstraction | `src/skills/mutator.ts` (RealtimeSonnet, BatchSonnet, CliClaude, LocalMock) |
| CliClaude terminal-agent mutator | `src/skills/mutators/cli_claude.ts` (enqueue + poll) |
| Spotter α (signal mining) | `src/skills/spotter/run.ts`, `detectors.ts` |
| Spotter β (LLM filer) | `src/skills/spotter/llm_filer.ts` (queue-based since v0.30.0) |
| Side-channel for bodies | `src/skills/mutation_results.ts` (`mutation_results_pg`) |
| Replay engine | `src/skills/orchestrator.ts:runMutationCycle` |
| Promotion | `src/skills/promotion.ts` |
| Anthropic standard text | `src/skills/anthropic_standard.ts` (SOT) + `A2A_dispatcher/anthropic-skill-standard.md` (synced copy) + `~/.claude/skills/writing-skills/SKILL.md` (authoring view) |
| Agent prompt augmentation | `A2A_dispatcher/augment-role-prompt.mjs` (5 levers) |
| Mutator pool roles registry | `A2A_dispatcher/roles.json` |
| Dispatcher auto-spawn (mutator-*) | `A2A_dispatcher/dispatcher.mjs:maybeAutoSpawnPools` |
| Dashboard rendering | `src/dashboard/render.ts` (HTMX) |

---

## 9. Operator-tunable env vars

| Var | Default | Purpose |
|---|---|---|
| `ZC_L1_MUTATION_ENABLED` | unset (off) | Master switch for L1 outcome→mutation hook |
| `ZC_MUTATOR_MODEL` | `local-mock` | `cli-claude` / `realtime-sonnet` / `batch-sonnet` / `local-mock` |
| `ZC_MUTATION_COOLDOWN_HOURS` | 6 | Min hours between mutations for same skill |
| `ZC_MUTATION_FAILURE_THRESHOLD` | 3 | Min failures in window to fire L1 |
| `ZC_MUTATION_FAILURE_WINDOW` | 10 | How many recent runs to scan for failures |
| `ZC_MUTATION_DAILY_CAP_PER_PROJECT` | 5 | Max mutations queued per project per day |
| `ZC_MUTATOR_IDLE_RETIRE_MIN` | 5 | Min idle-minutes before dispatcher auto-retires a mutator pool worker |
| `ZC_SPOTTER_DEFAULT_PROJECT_PATH` | unset | Project to route β filer tasks to |
| `ZC_TELEMETRY_BACKEND` | `sqlite` | `sqlite` / `postgres` / `dual` |
| `ZC_STORE` | `sqlite` | `sqlite` / `postgres` |

---

## 10. Failure modes & where to look

| Symptom | First place to check |
|---|---|
| Agent records outcome but L1 doesn't fire | `ZC_L1_MUTATION_ENABLED` in MCP server env, `outcomes_pg` row, guardrails (`l1_reason` in response) |
| Mutation task stuck `queued` | No live `mutator-*` worker; dispatcher auto-spawn pattern (`^mutator-`); roles.json entry for the pool |
| Agent claims task but never broadcasts | Sonnet network errors — check CPU + heartbeat_at; task auto-reclaims after 5 min stale |
| Candidate violates standard | `writing-skills` body not loaded — agent should fail-loud per Lever #5 |
| Candidate's body_hash doesn't match broadcast | Tampered between proposal and replay — RT-S2-09 hash check rejects |
| `zc_skill_show` returns "not found" | Skill not in `skills_pg` — re-import via `/dashboard/skills/import` or `importFilesystemSkills` |
| Script HMAC mismatch on Bash invoke | Script file edited on disk after admission — operator must re-admit |
| Admission gate quarantined a skill | Check `skill_admission_log_pg` + `skill_security_scans_pg` for the AST scan reason |
