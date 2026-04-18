# Harness Evolution Plan — Sprints 1-4

**Version:** 1.0  
**Created:** 2026-04-18  
**Status:** Approved — implementation in progress  
**Authors:** Amit + Claude (Sonnet 4.6)  
**Canonical reference:** This file. Load it into any Claude session via Read or via `zc_search(["harness evolution plan"])`.

---

## How to use this document

This is the **single source of truth** for everything we're building across SecureContext + A2A_dispatcher to make the harness self-improving. Future Claude sessions should:

1. **Read this file FIRST** when working on any item from the 12-item plan.
2. **Search SC working memory** for `harness_plan_*` facts for the latest deltas.
3. **Update this file** when decisions change (and persist deltas to SC).

Decisions documented here are **locked in** — they were debated, settled, and don't need re-litigation. If a decision needs to change, update the doc + add a "Revision history" entry at the bottom + persist to SC working memory.

---

## Table of contents

1. [Why we're building this](#why)
2. [Current state inventory](#current-state)
3. [Re-ranked priority list (12 items)](#priorities)
4. [Locked-in decisions](#decisions)
5. [Architecture overview](#architecture)
6. [Sprint 1 — Foundation: outcome telemetry + learnings loop](#sprint-1)
7. [Sprint 2 — Skills substrate + autoresearch loop](#sprint-2)
8. [Sprint 3 — Coordination scale-out](#sprint-3)
9. [Sprint 4 — Polish + observability](#sprint-4)
10. [Cross-cutting concerns](#cross-cutting)
11. [Karpathy's autoresearch — exact mapping](#autoresearch)
12. [What gets shipped where (repo map)](#repo-map)
13. [Testing strategy (per sprint, exhaustive)](#testing)
14. [Logging strategy (debugging-first observability)](#logging)
15. [Risks + open questions](#risks)
16. [Glossary](#glossary)
17. [Revision history](#revisions)

---

<a id="why"></a>
## 1. Why we're building this

The model is the brain. The harness is everything around the brain that turns model capability into agentic outcomes. We are explicitly **not** improving the model (that's the job of frontier labs). We are improving the harness.

Four leverage points in any agentic harness:

| Leverage point | Examples | Status as of 2026-04-18 |
|---|---|---|
| **CONTEXT** — what the model sees | Working memory, semantic L0/L1 summaries, retrieval | Heavy investment; second-order improvements remain |
| **CAPABILITY** — what the model can do | MCP tools, sandbox, hooks | Heavy investment; static (no skill composition or self-improvement) |
| **COORDINATION** — how multi-agent work divides + merges | Broadcast types, dispatcher, git worktrees | Solid for 2-3 agents; thin for 5+ |
| **LEARNING** — how the system improves from outcomes | Outcome tagging, skill mutation, A/B testing | **Almost nothing exists** |

The biggest leverage is in LEARNING because *every other improvement we make is unmeasurable until we have outcome data*. Once outcome data flows, every change can be A/B tested and the harness becomes self-improving regardless of model capability.

---

<a id="current-state"></a>
## 2. Current state inventory (2026-04-18)

### What's built and working

**SecureContext v0.10.4:**
- 18+ MCP tools (recall_context, file_summary, project_card, check, search, remember, broadcast, fetch, execute, status, capture_output, issue_token, etc.)
- L0/L1 semantic summaries via local Ollama qwen2.5-coder:14b on RTX 5090
- Hybrid BM25 + nomic-embed-text vector search
- MemGPT-style working memory (100 facts, importance-tiered eviction)
- Per-project orientation cards
- Session summaries (365-day retention)
- Hash-chain integrity on broadcasts (Biba)
- RBAC (HMAC session tokens, role permissions)
- Channel key authentication (scrypt-hardened)
- Prompt-injection scanner in summarizer
- Per-project DB isolation (SQLite SHA256 hash; Postgres for centralized mode)
- 3 PreToolUse/PostToolUse hooks (Read dedup, Edit reindex, Bash capture)
- 2 SessionStart hooks (zc-recall reminder, auto-index)
- Health banner with full/onboarding/degraded modes
- Docker stack: sc-api (3099), sc-postgres (5432, healthy), sc-ollama (11435 with GPU)
- Write-as-you-go indexer (v0.10.4) — crash-safe, real-time KB state

**A2A_dispatcher (commit eac6a4c):**
- 9 broadcast types (ASSIGN/STATUS/PROPOSED/DEPENDENCY/MERGE/REJECT/REVISE/LAUNCH_ROLE/RETIRE_ROLE)
- Per-agent git worktrees (one branch per agent)
- send-to-agent.ps1 SendKeys (clipboard paste + 5-method Enter fallback)
- Idle detection, reminders, escalation
- Agent registry (agents.json)
- Dynamic LAUNCH_ROLE spawning
- Graceful shutdown + zombie cleanup
- SC pre-flight health check
- Model-tier separation (orchestrator=Opus, workers=Sonnet — fixed in eac6a4c)
- Project-level learning collection in `learnings/{metrics,decisions,failures,customer-insights,experiments}.jsonl`

### What's measured to be working but UNDERutilized

- **`learnings/` jsonl files** — collecting good data (rationale, outcomes, root causes, prevention) but no aggregation, no query API, no feedback loop. Two of the five files (experiments, cross-project) are empty because they need automation, not agent discipline.

### What's missing

See [section 3](#priorities) for the full ranked list.

---

<a id="priorities"></a>
## 3. Re-ranked priority list (12 items)

Ranked by `frequency × magnitude × compounding`, ignoring effort. Dashboard moved to last per user decision.

### Tier S — foundational compounders (do first or nothing else compounds)

**1. ⭐⭐⭐⭐⭐ Outcome-tagged memory + learnings loop** *(Sprint 1)*  
Every action gets a deferred outcome tag (shipped/reverted, accepted/rejected, sufficient/insufficient). Background aggregator joins actions ↔ outcomes. Pattern miner runs nightly. Without this, all other improvements are guesses.

**2. ⭐⭐⭐⭐⭐ Skills + continuous self-improvement loop** *(Sprint 2)*  
Skill substrate: `~/.claude/skills/{name}.md` per the autoresearch pattern. Autoresearch loop: replay → measure → mutate → score → keep winners. The single biggest leverage in the system.

### Tier A — behavior changers (each massively shifts agent action selection)

**3. ⭐⭐⭐⭐⭐ Context-budget awareness** *(Sprint 2)*  
Live `tokens_used / 200k` in every tool result. Hard rules: ≥70% requires `zc_file_summary` over `Read`; ≥85% auto-triggers `zc_summarize_session`; ≥95% emergency mode (edits + broadcasts only).

**4. ⭐⭐⭐⭐ Rolling conversation compaction** *(Sprint 2)*  
Background process compacts conversation segments > 30 turns + > 30 min old + stable. Extends effective session length 3-5×.

**5. ⭐⭐⭐⭐⭐ Structured task schema** *(Sprint 3)*  
ASSIGN broadcasts gain required fields: `acceptance_criteria`, `complexity_estimate` (1-5), `file_ownership`, `dependencies`, `required_skills`. Enables: automatic tier routing, dependency graph validation, measurable completion.

**6. ⭐⭐⭐⭐ Tool-cost annotation in descriptions** *(Sprint 1, hot-path)*  
Every tool description gains a cost line + cheaper-alternative hints. Live token cost surfaced in tool results so the agent learns from its own usage in real time.

### Tier B — scale enablers (needed past 3 agents)

**7. ⭐⭐⭐⭐ Work-stealing pool** *(Sprint 3)*  
N workers per role share a Postgres-backed task queue. Workers pull when idle. Eliminates "dev-1 overloaded while dev-2 sits idle."

**8. ⭐⭐⭐ File-ownership enforcement** *(Sprint 3)*  
Dispatcher rejects ASSIGN if `files` overlap an in-flight task. Ends merge-conflict chaos at 5+ agents.

**9. ⭐⭐⭐ Cost attribution** *(Sprint 1, foundational)*  
Per-tool-call telemetry: `(call_id, session_id, agent_id, task_id, tool, input_tok, output_tok, cost_usd, latency_ms, ts)`. Pre-aggregated views for common queries. Powers smart tier-routing decisions.

### Tier C — quality multipliers

**10. ⭐⭐⭐ Retrieval reranker** *(Sprint 4)*  
After BM25+cosine top-20, run bge-reranker-v2-m3 via Ollama to pick best 5. Long-tail retrieval improvement.

**11. ⭐⭐⭐ Multi-hop + HyDE retrieval** *(Sprint 4)*  
HyDE: local LLM generates hypothetical answer → embed → search by it. Multi-hop: follow document references. Big for research-heavy questions.

**12. ⭐⭐⭐ Live dispatch dashboard** *(Sprint 4 — last per user)*  
Web UI / TUI showing live worker state, queue depth, blockers, cost burn. Trivial to build once Sprint 1 (telemetry) + Sprint 3 (structured tasks) exist.

---

<a id="decisions"></a>
## 4. Locked-in decisions

These are settled. Do not re-litigate without updating this section.

### D1. Storage — DUAL backend support (SQLite + Postgres)

**Decision:** Implement **both** SQLite (per-project, default for solo developers) and Postgres (centralized, default for team/Amit's machine).

**Rationale:**
- Solo developers have no operational appetite for Postgres
- Centralized mode is required for cross-project pattern mining (the long-term win)
- Amit personally uses Postgres (Docker container `securecontext-postgres` already running, healthy)
- The existing v0.8 `Store` interface already abstracts both — extend it

**Implementation:** Each new table (outcomes, tool_calls, skills, etc.) gets parallel implementations in `store-sqlite.ts` and `store-postgres.ts` behind a common `Store` interface. The `ZC_STORE` env var controls which is active. `ZC_API_URL` set → Postgres; unset → SQLite.

**Testing requirement:** Every new feature ships with parallel test suites against BOTH backends. CI runs both.

**Performance + scaling note:** Postgres wins for:
- Cross-project queries (federation across N project DBs in SQLite is slow)
- Concurrent writes from multiple agents in the same project (SQLite has WAL but no row-level locking)
- Aggregation queries over large datasets (Postgres has proper query planner)

SQLite wins for:
- Zero-ops setup (just Node + a file)
- Per-machine isolation (no leak risk)
- Crash recovery simplicity

### D2. Skill scope — HIERARCHICAL (per-project + global with cross-project promotion)

**Decision:** Skills exist at **two levels** with explicit promotion path:

- **Per-project:** `<project>/.claude/skills/{name}.md` — locally optimized for this project's quirks
- **Global:** `~/.claude/skills/{name}.md` — works everywhere, the baseline

**Promotion rules:**
1. A new skill starts at the global level (hand-written or seeded)
2. As it runs in a project, the per-project version evolves via the autoresearch loop
3. When a per-project version outperforms the global by ≥X% (TBD threshold) on Y projects, it becomes a candidate for global promotion
4. Global mutation engine considers cross-project candidates when proposing global mutations

**Why this matters (per Amit's example):** A designer skill optimized in an aesthetics-heavy project shouldn't lose those optimizations when used elsewhere. But truly project-specific tweaks (e.g., "this project uses Tailwind v3") should stay local. Hierarchical scope handles both.

**Resolution at skill-load time:** Per-project overrides global. Tools see merged skill (global as base + project overlay).

### D3. Replay benchmark source — SYNTHETIC FIXTURES first, real historical sessions later

**Decision:** Sprint 2 ships with hand-crafted synthetic fixtures only. Real-historical replay is a Sprint 2.5 milestone, gated on the synthetic-fixture loop being stable.

**Rationale:** Real-historical replay costs API tokens. We need the loop debugged first.

**Trigger to switch:** Synthetic-fixture loop has produced ≥3 measurable skill improvements with no false-positive promotions over 1 week.

### D4. Mutation engine — SONNET 4.6 PRIMARY (Opus escalation, pluggable for future local A/B)

**Final decision (revised 2026-04-18):**

```
Tier 1 (95% of mutations): Sonnet 4.6 generates 5 candidates AND picks best
Tier 2 (5% — hard cases):  Opus 4.7 single deep mutation when Tier 1 has failed 3+ times
PLUGGABLE: ZC_MUTATOR_MODEL env var allows swapping in any model
           (e.g. deepseek-r1:32b once we have outcome data to A/B with)
```

**Rationale (why not local):**
- Local 32B models on RTX 5090 (qwen2.5-coder:32b, deepseek-r1:32b) reach ~70-85% of
  Sonnet 4.6 quality on reasoning-heavy tasks like skill mutation. The gap matters most
  for THIS specific task (low volume, infrequent, high reasoning per call).
- Cost is trivially small at our volume (see math below).
- We build the engine with a pluggable model interface so later A/B testing is easy.

**Cost math:**
- Per mutation: ~3k input + ~1k output ≈ $0.024 (Sonnet pricing $3/MTok in + $15/MTok out)
- Nightly: 3 worst skills × 5 candidates × $0.024 = $0.36/night
- Monthly: ~$10.80 + occasional Opus escalation (~$2-5/mo) = **~$13-15/month total**

**Pluggable architecture requirement:**
The mutation engine MUST be implemented behind a `Mutator` interface with an
`MUTATOR_MODEL` factory. Initial impl: `SonnetMutator`. Future impls: `OpusMutator`,
`DeepseekR1LocalMutator`, etc. Switch via `ZC_MUTATOR_MODEL=deepseek-r1:32b` env var
when we want to A/B test local models against Sonnet baseline using outcome data.

**Frequency:**
- Nightly batch: pick the 3 worst-performing skills, run mutation cycle on each
- Per-cycle: 5 Sonnet calls (generate+pick) + 5 fixture replays via cheap local Ollama
- Total nightly: ~$0.36 + occasional Opus escalation = **~$0.50/night worst-case**

### D5. Cost attribution granularity — PER-TOOL-CALL (with pre-aggregated views)

**Decision:** Store the finest grain. Expose roll-ups via SQL views.

**Storage cost:** ~80-150 bytes per tool-call row. ~55MB/year per active project. Negligible.

**Schema:** See Sprint 1 design ([section 6](#sprint-1)).

### D6. Existing learnings/ JSONL files — KEEP + ALSO INDEX

**Decision:** Don't migrate existing `learnings/*.jsonl` files. Keep them for human review (cat-able, grep-able, debuggable). Additionally index every entry into the Postgres `learnings` table on write.

**Rationale:** JSONL is the best format for human-friendly inspection. Postgres is the best format for queries. Both serve different needs — duplicating is fine.

**Implementation:** When agents write to a `learnings/*.jsonl` file (via Edit/Write tool), a PostToolUse hook detects the path pattern and indexes the new lines into Postgres.

---

<a id="architecture"></a>
## 5. Architecture overview

```
                  ┌─────────────────────────────────────────────┐
                  │   The agentic system (Claude/Opus + tools)  │
                  └─────────────┬───────────────────────────────┘
                                │
        ┌───────────────────────┼─────────────────────────┐
        │                       │                         │
        ▼                       ▼                         ▼
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│ CONTEXT      │        │ CAPABILITY   │        │ COORDINATION │
│ (SC: KB,     │        │ (MCP tools,  │        │ (A2A:        │
│  memory,     │        │  hooks,      │        │  broadcasts, │
│  summaries)  │        │  skills)     │        │  dispatcher) │
└──────┬───────┘        └──────┬───────┘        └──────┬───────┘
       │                       │                         │
       │                       │                         │
       └───────────────────────┼─────────────────────────┘
                               ▼
              ┌─────────────────────────────────┐
              │   LEARNING LAYER (Sprint 1+2)   │
              │                                 │
              │  outcomes ────┐                 │
              │               ▼                 │
              │  pattern_miner ──→ skills/      │
              │       │                         │
              │       └──→ tool_descriptions    │
              │       └──→ routing_rules        │
              │       └──→ system_prompts       │
              └─────────────────────────────────┘
```

**The learning layer is the new addition.** It consumes raw events from the three existing layers and emits improvements back into them.

### Data flow

```
Tool call → tool_calls table (Sprint 1)
           ↓
       outcome resolver (commit hook, user signal, follow-up detection)
           ↓
       outcomes table (joined with tool_calls)
           ↓
       pattern_miner (nightly batch)
           ↓
       improvements (skill mutations, tool-desc updates, routing rules)
           ↓
       deployed back into the live harness
```

---

<a id="sprint-1"></a>
## 6. Sprint 1 — Foundation: outcome telemetry + learnings loop

**Goal:** Start collecting per-tool-call telemetry and outcomes. No behavior changes for the agent yet — just data.

**Why first:** Every later sprint queries this data. Without it, learning is impossible.

**Estimated scope:** ~2-3 weeks of focused work.

### Deliverables

#### 6.1 Schema — new tables

Identical schemas in SQLite (`store-sqlite.ts`) and Postgres (`store-postgres.ts`).

```sql
-- Per-tool-call telemetry (the highest-resolution source of truth)
CREATE TABLE tool_calls (
  call_id        TEXT PRIMARY KEY,        -- UUID
  session_id     TEXT NOT NULL,           -- Claude Code session UUID
  agent_id       TEXT NOT NULL,           -- e.g. "Test_Agent_Coordination-developer"
  project_hash   TEXT NOT NULL,           -- SHA256(projectPath)[:16]
  task_id        TEXT,                    -- nullable; from broadcast or skill invocation
  skill_id       TEXT,                    -- nullable; if invoked under a skill
  tool_name      TEXT NOT NULL,           -- e.g. "mcp__zc-ctx__zc_file_summary"
  model          TEXT NOT NULL,           -- e.g. "claude-opus-4-7"
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_usd       REAL NOT NULL,           -- computed from model pricing table
  latency_ms     INTEGER NOT NULL,
  status         TEXT NOT NULL,           -- ok | error | timeout
  error_class    TEXT,                    -- transient | permission | logic | unknown
  ts             TEXT NOT NULL            -- ISO8601
);
CREATE INDEX idx_tc_session ON tool_calls(session_id, ts);
CREATE INDEX idx_tc_task    ON tool_calls(task_id);
CREATE INDEX idx_tc_skill   ON tool_calls(skill_id);
CREATE INDEX idx_tc_role    ON tool_calls(agent_id, model);

-- Outcomes — joined to tool_calls or tasks via ref_id
CREATE TABLE outcomes (
  outcome_id     TEXT PRIMARY KEY,        -- UUID
  ref_type       TEXT NOT NULL,           -- "tool_call" | "task" | "skill_run" | "session"
  ref_id         TEXT NOT NULL,           -- FK into the relevant table
  outcome_kind   TEXT NOT NULL,           -- "shipped" | "reverted" | "accepted" | "rejected"
                                          -- | "sufficient" | "insufficient" | "errored"
  signal_source  TEXT NOT NULL,           -- "git_commit" | "user_prompt" | "follow_up" | "manual"
  score_delta    REAL,                    -- nullable; how this outcome changed the parent score
  evidence       TEXT,                    -- JSON: free-form supporting evidence
  resolved_at    TEXT NOT NULL            -- ISO8601 (when the outcome was determined)
);
CREATE INDEX idx_o_ref ON outcomes(ref_type, ref_id);

-- Mirror of learnings/*.jsonl with structured indexing
CREATE TABLE learnings (
  learning_id    TEXT PRIMARY KEY,
  project_hash   TEXT NOT NULL,
  category       TEXT NOT NULL,           -- "metric" | "decision" | "failure" | "insight" | "experiment"
  payload        TEXT NOT NULL,           -- the JSON line (verbatim from JSONL)
  source_path    TEXT NOT NULL,           -- e.g. "learnings/failures.jsonl"
  source_line    INTEGER,                 -- line number in source file
  ts             TEXT NOT NULL
);
CREATE INDEX idx_l_project_cat ON learnings(project_hash, category, ts);
```

#### 6.2 Tool-call telemetry capture

**Mechanism:** A new wrapper layer in `src/server.ts` that intercepts every MCP tool call, measures its cost + latency + outcome, and writes to `tool_calls`.

**Pricing table:** Hardcoded in `src/pricing.ts` — `{model: {input_per_1k, output_per_1k}}`. Update quarterly.

**Token measurement:** MCP responses include token usage where available; otherwise we use `tiktoken` (or a cheaper counter) to estimate.

#### 6.3 Outcome resolvers

Three signal sources to start:

1. **`git_commit` resolver** — PostToolUse Bash hook detects `git commit`; records the commit hash + files; later checks if the commit was reverted within N days.
2. **`user_prompt` resolver** — Inferred from the next user message. If user says "thanks" / "great" / "perfect" → positive; if "no" / "stop" / "wrong" → negative.
3. **`follow_up` resolver** — Detects `tool_call(zc_file_summary, foo) → tool_call(Read, foo)` patterns within N turns → "summary was insufficient." Same for re-Reads after summarize, re-runs after capture, etc.

#### 6.4 Hook: PostToolUse `learnings_indexer`

When the agent writes to `learnings/*.jsonl` via Edit/Write, this hook parses the new lines and indexes them into the `learnings` table. Idempotent (dedup by learning_id).

#### 6.5 Tool-cost annotation (#6 from priorities)

Every existing MCP tool description gets a cost line:

```
zc_file_summary
  Returns L0 + L1 summary for one file.
  Typical cost: ~400 tokens. Latency: <50ms.
  Cheaper than: Read (~4000 tokens for a 100-line file).
  Equivalent for non-edit questions; not a substitute when you need full file.
```

Plus, every tool **response** gains a header line: `[cost: 423 tok, $0.0013, 47ms]`. Forces the agent to learn cost in the live loop.

### Sprint 1 testing

**SQLite + Postgres parallel test suite.** Each new function in `store-{sqlite,postgres}.ts` ships with:

- Unit tests against both backends (`scripts/test-store-sqlite.mjs`, `scripts/test-store-postgres.mjs`)
- A live integration test (`scripts/test-telemetry-live.mjs`) that:
  1. Spawns a synthetic Claude session calling 20 tools
  2. Verifies all 20 are logged in `tool_calls`
  3. Verifies cost/token math is within ±5%
  4. Verifies outcome resolvers fire correctly
  5. Verifies the JSONL→learnings mirror works

**Performance benchmark:** Insert 10,000 tool_calls + 1,000 outcomes; verify p99 query latency on common views < 100ms.

### Sprint 1 acceptance criteria

- [ ] All 4 new tables created in both backends, migration tested
- [ ] Per-tool-call telemetry capture catches ≥99% of MCP calls (sampled over 100 sessions)
- [ ] Cost-attribution accuracy ±5% vs API billing
- [ ] At least one outcome per session resolved (commit-status or user signal)
- [ ] Tool descriptions show cost line + alternatives (all 18 tools)
- [ ] Tool responses show `[cost: ..., $..., ...ms]` header
- [ ] Existing JSONL learnings indexed into Postgres without breaking the JSONL files
- [ ] Live test: 29/29 unit tests pass; 10/10 integration tests pass on both backends

### Sprint 1 deliverable artifacts

- `src/store.ts` — extend interface with `recordToolCall`, `recordOutcome`, `recordLearning`
- `src/store-sqlite.ts` — implementations
- `src/store-postgres.ts` — implementations
- `src/migrations.ts` — migrations 13-16 (one per table) + Postgres equivalents
- `src/pricing.ts` — model pricing table
- `src/telemetry.ts` — tool-call wrapper logic
- `src/outcomes.ts` — outcome resolver registry + 3 resolvers
- `hooks/learnings-indexer.mjs` — PostToolUse hook
- `scripts/test-store-{sqlite,postgres}.mjs` — unit tests
- `scripts/test-telemetry-live.mjs` — integration test
- Tool description updates in `src/tools.ts` (cost lines + alternatives)
- Tool response augmentation in `src/server.ts` (cost header)
- CHANGELOG entry for v0.11.0

---

<a id="sprint-2"></a>
## 7. Sprint 2 — Skills substrate + autoresearch loop

**Goal:** Skills as first-class artifacts. Autoresearch-style improvement loop running nightly.

**Estimated scope:** ~3-4 weeks.

### Deliverables

#### 7.1 Skill substrate

**Per-project location:** `<project>/.claude/skills/{name}.md`  
**Global location:** `~/.claude/skills/{name}.md`  
**Resolution:** Per-project overrides global. Tools see merged skill.

**Skill schema (markdown frontmatter + body):**

```markdown
---
name: audit_file
version: 0.1.0
description: |
  Read + summarize + scan-for-issues + report on a single source file.
inputs:
  path: { type: string, required: true, description: "File path to audit" }
preconditions:
  - context_budget_remaining_pct: ">= 30"
acceptance_criteria:
  - Returns a structured report with: summary, issues, suggestions
  - Total cost < 2000 tokens
  - Completes in < 30 seconds
metric_weights:
  cost_efficiency: 0.4
  accuracy: 0.4
  speed: 0.2
required_tools:
  - mcp__zc-ctx__zc_file_summary
  - mcp__zc-ctx__zc_search
parent_global_version: 0.1.0   # if this is a per-project override
---

# audit_file

## Steps

1. Call `zc_file_summary({path})` to get L0+L1 (cost ~400 tok)
2. If L0 contains keywords like "TODO", "FIXME", "HACK": call `zc_search([extracted_terms])` to find related context
3. Identify potential issues: complexity, unused imports, missing error handling
4. Return structured report:
   ```yaml
   summary: <from L0>
   issues: [{kind, line?, severity, description}]
   suggestions: [{action, rationale}]
   ```

## Failure modes

- File not indexed yet → fall back to Read with offset/limit
- L0 is truncation (Ollama down) → use Grep to find issue patterns directly

## Cost budget

- Best case: 400 tok (file_summary only, no issues found)
- Typical: 1200 tok
- Worst (acceptable): 2000 tok
```

#### 7.2 New MCP tool: `zc_skill_run(name, args)`

**Behavior:**
1. Resolves skill (per-project + global merge)
2. Validates inputs against schema
3. Checks preconditions
4. Logs invocation to `skill_runs` table (new in Sprint 2)
5. Loads skill body into agent context as a structured plan
6. Returns the plan; agent executes it
7. After agent reports completion, records outcome

#### 7.3 New tables (Sprint 2)

```sql
CREATE TABLE skills (
  skill_id      TEXT PRIMARY KEY,         -- e.g. "audit_file@0.1.0"
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  scope         TEXT NOT NULL,            -- "global" | "project:<hash>"
  body          TEXT NOT NULL,            -- the markdown source
  promoted_from TEXT,                     -- nullable; FK if promoted from project version
  created_at    TEXT NOT NULL,
  archived_at   TEXT,                     -- nullable; soft delete
  archive_reason TEXT
);
CREATE UNIQUE INDEX idx_skills_active ON skills(name, scope) WHERE archived_at IS NULL;

CREATE TABLE skill_runs (
  run_id        TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  task_id       TEXT,
  inputs        TEXT NOT NULL,            -- JSON
  outcome_score REAL,                     -- composite: cost*w + accuracy*w + speed*w
  total_cost    REAL,                     -- summed from tool_calls
  total_tokens  INTEGER,
  duration_ms   INTEGER,
  status        TEXT NOT NULL,            -- "succeeded" | "failed" | "timeout"
  failure_trace TEXT,                     -- nullable; structured failure data for mutation
  ts            TEXT NOT NULL
);
CREATE INDEX idx_sr_skill ON skill_runs(skill_id, ts);

CREATE TABLE skill_mutations (
  mutation_id   TEXT PRIMARY KEY,
  parent_skill_id TEXT NOT NULL,          -- the version being mutated
  candidate_body TEXT NOT NULL,           -- the proposed new markdown
  proposed_by   TEXT NOT NULL,            -- "ollama:qwen2.5-coder:14b" or model name
  judged_by     TEXT,                     -- "sonnet" | "opus" | nullable
  judge_score   REAL,                     -- 0-1
  judge_rationale TEXT,
  replay_score  REAL,                     -- avg outcome_score across replays
  promoted      BOOLEAN DEFAULT FALSE,
  promoted_to_skill_id TEXT,              -- nullable; if promoted, the new skill_id
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);
```

#### 7.4 Replay harness (synthetic fixtures first)

**Synthetic fixture format:** `tests/fixtures/skills/{skill_name}/{fixture_name}/`
```
input.json          - inputs to the skill
expected_outcome.json - expected outcome shape (for scoring)
context.tar.gz      - frozen project state to replay against
```

**Replay process:**
1. Restore frozen project state to a temp dir
2. Spawn an isolated agent (could be local Ollama or cheap Sonnet for replay)
3. Invoke `zc_skill_run(skill_name, fixture_input)`
4. Capture all tool_calls + outcome
5. Compute composite outcome_score
6. Write to `skill_runs` table

**Initial seed fixtures (Sprint 2):** 5 fixtures per skill, hand-crafted, covering happy + edge cases.

#### 7.5 Mutation engine (per D4)

`scripts/mutation-engine.mjs` — runs nightly via cron or scheduled task.

```
For each underperforming skill (bottom 3 by recent avg outcome_score):
  1. Fetch last 20 skill_runs (with failure_traces for failures)
  2. Generate 5 mutation candidates via Ollama qwen2.5-coder:14b
     - Prompt includes: current body, failure traces, common-pattern recommendations
  3. Validate each candidate (parses, schema-valid)
  4. Sonnet 4.6 reads all 5 + picks best (or rejects all → escalate to Opus)
  5. Run replay harness on the picked candidate (5 fixtures)
  6. If avg replay_score > current skill avg by ≥10%: promote
     - Insert new skill row at version v.next
     - Set old row's archived_at + archive_reason
  7. Otherwise: archive the mutation with reason
  8. Log everything to skill_mutations table
```

#### 7.6 Context-budget awareness (#3 from priorities)

**Mechanism:**

1. **Token counter:** Every tool response adds a `_meta.context_used_pct` field
2. **Hook enforcement:** PreToolUse Read hook upgrades to "block + redirect" when context > 70%, suggesting `zc_file_summary` instead
3. **Auto-trigger:** When context > 85%, the next `zc_recall_context` response embeds a directive: "you must call zc_summarize_session before any other tool"
4. **Emergency mode:** > 95%, PreToolUse blocks all tools except `Edit/Write/zc_broadcast/zc_summarize_session`

**Token counting:** Use the conversation history length × tokens-per-char heuristic, then refine with periodic `tiktoken` calibration.

#### 7.7 Rolling conversation compaction (#4 from priorities)

**Mechanism:**
- Background process monitors session conversation history every 5 min
- Identifies stable segments: > 30 turns old, > 30 min since last reference
- Generates a compact summary via local Ollama (qwen2.5-coder:14b)
- Replaces the segment IN PLACE in the session JSONL with a `[COMPACTED]` marker + summary
- Original preserved in `compacted_segments` table for audit

**Risk:** Claude Code's session JSONL is internal. We may need to coordinate with Anthropic on this hook point or implement at the prompt-cache layer instead.

### Sprint 2 acceptance criteria

- [ ] 8 seed skills shipped: `audit_file`, `propose_refactor`, `test_then_commit`, `dependency_trace`, `migrate_pattern`, `extract_then_replace`, `review_pr`, `triage_bug`
- [ ] `zc_skill_run` MCP tool live + tested
- [ ] Synthetic fixture suite: 5 fixtures per skill, all replayable
- [ ] Mutation engine produces measurable improvement on at least 2 of 8 seed skills within 1 week of nightly runs
- [ ] Context-budget awareness reduces re-Read incidents by ≥50% (vs Sprint 1 baseline)
- [ ] Rolling compaction extends median session length by ≥2× without regression on agent decision quality

---

<a id="sprint-3"></a>
## 8. Sprint 3 — Coordination scale-out

**Goal:** Make 5+ agent coordination work reliably.

**Estimated scope:** ~3 weeks.

### Deliverables

#### 8.1 Structured task schema (#5)

Extend `zc_broadcast` ASSIGN type with required fields:

```typescript
{
  type: "ASSIGN",
  agent_id: string,
  task: string,                          // short identifier
  summary: string,                       // free-form description (existing)
  files: string[],                       // existing
  // NEW v0.12 fields:
  acceptance_criteria: string[],         // testable assertions
  complexity_estimate: 1 | 2 | 3 | 4 | 5,
  file_ownership: {                      // explicit ownership assertion
    exclusive: string[],                  // worker has write authority
    read_only: string[]                   // worker may read but not modify
  },
  dependencies: number[],                // broadcast_ids that must MERGE first
  required_skills: string[],             // skill names needed
  estimated_tokens: number,              // optional; for budgeting
  importance: 1-5
}
```

**Migration:** Make new fields nullable for backward compat in v0.12; required in v0.13.

#### 8.2 Work-stealing queue (#7)

**Schema (Postgres only — SQLite doesn't handle concurrent claims well):**

```sql
CREATE TABLE task_queue (
  task_id        TEXT PRIMARY KEY,
  project_hash   TEXT NOT NULL,
  role           TEXT NOT NULL,
  payload        JSONB NOT NULL,         -- the ASSIGN broadcast body
  state          TEXT NOT NULL,          -- "queued" | "claimed" | "done" | "failed"
  claimed_by     TEXT,                   -- agent_id of worker holding the claim
  claimed_at     TIMESTAMPTZ,
  heartbeat_at   TIMESTAMPTZ,
  retries        INTEGER DEFAULT 0,
  ts             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_q_role_state ON task_queue(project_hash, role, state);
```

**Claim logic (Postgres SKIP LOCKED):**

```sql
UPDATE task_queue
SET state='claimed', claimed_by=$1, claimed_at=NOW(), heartbeat_at=NOW()
WHERE task_id = (
  SELECT task_id FROM task_queue
  WHERE project_hash=$2 AND role=$3 AND state='queued'
  ORDER BY ts ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING task_id, payload;
```

**Heartbeat:** Workers POST to `/api/v1/task/heartbeat/{task_id}` every 30s. Tasks with `heartbeat_at` > 5min stale are reclaimed.

#### 8.3 Worker pool spawning

`start-agents.ps1` gains `-WorkerCount` parameter (default 1):

```powershell
.\start-agents.ps1 -Roles developer -WorkerCount 3
# Spawns: developer-1, developer-2, developer-3
# All claim from the same queue
```

#### 8.4 File-ownership enforcement (#8)

Dispatcher receives ASSIGN, checks `file_ownership.exclusive` vs `task_queue` for in-flight claims:

```sql
-- Reject if any file in the new ASSIGN overlaps with an in-flight task's exclusive set
SELECT task_id FROM task_queue
WHERE project_hash = $1
  AND state = 'claimed'
  AND payload->>'file_ownership' @> jsonb_build_object('exclusive', $2);
```

If overlap: dispatcher posts a REJECT broadcast back to orchestrator with reason.

#### 8.5 Complexity-based model tier routing

Orchestrator-side helper (could be a new MCP tool `zc_choose_model(complexity)`):

```
complexity 1 → claude-haiku-4-5
complexity 2 → claude-haiku-4-5
complexity 3 → claude-sonnet-4-6
complexity 4 → claude-sonnet-4-6
complexity 5 → claude-opus-4-7
```

Worker pool config supports per-complexity-tier sub-pools. Routing assigns task to next idle worker in the right tier.

### Sprint 3 acceptance criteria

- [ ] All ASSIGN broadcasts use new schema (backward compat shim for legacy)
- [ ] Worker pool spawning works for 5+ workers per role
- [ ] Work-stealing claims under concurrent load — no double-claim, no missed task
- [ ] File-ownership conflicts rejected with clear error (test: 5 agents, deliberately conflicting ASSIGNs, all but one rejected)
- [ ] Complexity routing measurably reduces average task cost (vs always-Sonnet baseline) by ≥20%

---

<a id="sprint-4"></a>
## 9. Sprint 4 — Polish + observability

**Goal:** Quality multipliers + visibility.

**Estimated scope:** ~2-3 weeks.

### Deliverables

#### 9.1 Retrieval reranker (#10)

**Model:** `bge-reranker-v2-m3` (multilingual, fast cross-encoder, ~600MB).

**Pull:**
```bash
docker exec securecontext-ollama ollama pull bge-reranker-v2-m3
```

**Integration:**
```typescript
// In src/knowledge.ts searchKnowledge:
const candidates = bm25_top_20 + cosine_top_20;
const reranked = await rerank(query, candidates);  // returns top 5
return reranked;
```

**Latency budget:** Reranking 20 candidates < 200ms on RTX 5090.

#### 9.2 HyDE retrieval (#11a)

**New search mode:** `zc_search([query], { mode: "hyde" })`.

**Behavior:**
1. Local Ollama generates a "hypothetical answer" to the query (50-100 tokens, free)
2. Embed the hypothetical answer
3. Search by THAT vector instead of the raw query vector
4. Returns BM25+cosine results as usual

**Empirical gain:** Typically 10-25% better precision@5 on long-tail questions.

#### 9.3 Multi-hop retrieval (#11b)

**New search mode:** `zc_search([query], { mode: "multihop", depth: 2 })`.

**Behavior:**
1. Top-K initial search
2. For each result, extract referenced sources (file paths, URLs, KB IDs in markdown)
3. Search for each reference (depth-1)
4. Optionally repeat (depth-2)
5. Deduplicate, rerank, return top-N

#### 9.4 Live dispatch dashboard (#12)

**Stack:** Lightweight web UI (Next.js or just static HTML+SSE), served from `sc-api`.

**Views:**
- **Overview:** active sessions, agent count by role, queue depth, total cost burn (today/week/month)
- **Per-session:** worker statuses, in-flight tasks, blockers, recent broadcasts
- **Per-task:** state, claimed_by, heartbeat freshness, dependencies, cost-so-far
- **Skill performance:** rankings by avg outcome_score, mutation history
- **Cost attribution:** roll-ups by role / model / project / skill

**Data source:** All from Sprint 1 (tool_calls) + Sprint 3 (task_queue) tables. Dashboard is pure read.

### Sprint 4 acceptance criteria

- [ ] Reranker improves precision@5 on a curated benchmark by ≥15%
- [ ] HyDE mode delivers measurable improvement on at least 30% of long-tail queries
- [ ] Multi-hop mode finds related docs the standard mode misses on ≥20% of test queries
- [ ] Dashboard renders all views; 30-second forensics on stuck session works as advertised

---

<a id="cross-cutting"></a>
## 10. Cross-cutting concerns

### 10.1 Backward compatibility

Every schema change ships with a migration. No data loss. Existing sessions continue to work.

### 10.2 Testing strategy

- **Unit tests** per module against both backends (SQLite + Postgres)
- **Live integration tests** for every MCP tool addition
- **Synthetic fixture suite** for skills (Sprint 2)
- **End-to-end test** monthly: spawn 5-agent session, run benchmark task, verify outcomes
- **Regression test** for Sprint 1 telemetry: every release, replay 10 sessions and verify cost capture is within ±5% of API billing

### 10.3 Documentation discipline

Every sprint produces:
- Updated CHANGELOG entry
- Updated README section
- Updated ARCHITECTURE.md component reference
- Updated AGENT_HARNESS.md (if user-facing behavior changes)
- This file (HARNESS_EVOLUTION_PLAN.md) updated with sprint completion

### 10.4 SecureContext working memory hooks

Each sprint completion → `zc_remember(key="harness_sprint_N_complete", importance=5)` with summary + commit hash. Future sessions can `zc_search(["sprint N"])` to pick up state.

### 10.5 Performance budgets

- Tool-call telemetry overhead: < 10ms per call (measured)
- Outcome resolver overhead: < 100ms per resolve, async
- Mutation engine nightly cost: < $1/night
- Dashboard query p99: < 200ms

### 10.6 Failure modes

Every new component must specify:
- What happens when the Postgres backend is unreachable
- What happens when Ollama is unreachable
- What happens when the reranker is missing
- Whether the agent can continue working in degraded mode

---

<a id="autoresearch"></a>
## 11. Karpathy's autoresearch — exact mapping

`karpathy/autoresearch` (74k stars, March 2026) demonstrates the pattern: agent edits `program.md`, runs `train.py` for fixed time budget, measures `val_bpb`, autonomous overnight loop.

Our equivalent mapping:

| Autoresearch | Our equivalent |
|---|---|
| `program.md` (the skill) | `~/.claude/skills/{skill}.md` (Sprint 2) |
| `train.py` (the workspace) | The user's project files (or sandbox copy in replay) |
| `val_bpb` (the metric) | Composite `outcome_score` (cost + accuracy + speed weighted by skill metric_weights) |
| 5-min budget | Per-skill `acceptance_criteria.completes_in` budget |
| 12 experiments/hour, 100/night | Mutation engine: 3 skills × 5 candidates × 5 fixtures = 75 replays/night |
| Agent edits `train.py` | Mutation engine edits `skills/*.md` |

**Direct applications:**

1. **Skill program-md improvement** — exactly the autoresearch pattern. Sprint 2.
2. **Prompt template optimization** — same loop applied to `roles.json` system prompts. Sprint 2.5 stretch.
3. **Routing-rule discovery** — define routing as code, replay on historical task corpus, mutate, keep winners. Sprint 3 extension.

**NOT applicable:**
- Real-time coordination (deterministic, not learnable search)
- Token budgeting (deterministic rules)
- Reranker training (supervised ML, different pattern)

---

<a id="repo-map"></a>
## 12. What gets shipped where (repo map)

| Component | Repo | Path |
|---|---|---|
| All new MCP tools | `SecureContext` | `src/server.ts` + `src/tools.ts` |
| New tables (SQLite) | `SecureContext` | `src/migrations.ts` (migrations 13-20+) |
| New tables (Postgres) | `SecureContext` | `src/store-postgres.ts` (init.sql) |
| Telemetry capture | `SecureContext` | `src/telemetry.ts` |
| Outcome resolvers | `SecureContext` | `src/outcomes.ts` |
| Skills substrate | `SecureContext` | `src/skills.ts` + `~/.claude/skills/*` |
| Mutation engine | `SecureContext` | `scripts/mutation-engine.mjs` |
| Replay harness | `SecureContext` | `scripts/replay-harness.mjs` |
| Synthetic fixtures | `SecureContext` | `tests/fixtures/skills/` |
| Hooks | `SecureContext` | `hooks/*.{mjs,ps1}` |
| Reranker integration | `SecureContext` | `src/embedder.ts` extension |
| Dashboard | `SecureContext` | `dashboard/` (new dir) |
| Structured task schema | `A2A_dispatcher` + `SecureContext` | both repos (broadcast schema + dispatcher validation) |
| Work-stealing queue | `SecureContext` (storage) + `A2A_dispatcher` (consumers) | both repos |
| Worker pool spawning | `A2A_dispatcher` | `start-agents.ps1` extensions |
| File-ownership enforcement | `A2A_dispatcher` | `dispatcher.mjs` |
| Cost-based model routing | `A2A_dispatcher` | `dispatcher.mjs` (using SC pricing data) |
| This plan | `SecureContext` | `docs/HARNESS_EVOLUTION_PLAN.md` |

---

<a id="testing"></a>
## 13. Testing strategy (per sprint, exhaustive)

Every sprint ships with **8 categories of tests**. No sprint is "done" until all 8 are green.

### Test category matrix

| # | Category | Purpose | Where it lives |
|---|---|---|---|
| 1 | **Unit tests** (per-backend) | Single-function behavior. Run for both SQLite + Postgres. | `src/*.test.ts` (vitest) |
| 2 | **Integration tests** | Cross-component flows. New schema + new API + new hook working together. | `scripts/test-{feature}-live.mjs` |
| 3 | **End-to-end tests** | Realistic user scenarios with synthetic agents. | `scripts/e2e-{sprint}.mjs` |
| 4 | **Performance / load tests** | p99 latency, throughput, memory under stress. | `scripts/perf-{component}.mjs` |
| 5 | **Regression tests** | Replay historical sessions, verify no behavior change. | `scripts/regression-{sprint}.mjs` |
| 6 | **Failure-mode tests** | Postgres down, Ollama down, network dropped, disk full. | `scripts/failmode-{component}.mjs` |
| 7 | **Security / red-team** | Where applicable: prompt injection, RBAC bypass, SSRF. | `security-tests/{feature}.mjs` |
| 8 | **User-scenario tests** | Specific real-world flows from real Amit usage. | `scripts/scenario-{name}.mjs` |

### Sprint 1 — explicit test inventory

**Unit (10+ tests per module, both backends):**
- `recordToolCall()` — happy path, missing fields, large input, concurrent writes
- `recordOutcome()` — link-by-ref-type+ref-id, idempotent on dupe, score_delta math
- `recordLearning()` — JSONL parse, dedup, all 5 categories
- Outcome resolvers — git_commit detection, user_prompt sentiment, follow_up pattern
- Pricing math — every model in pricing table, ±5% accuracy

**Integration:**
- `scripts/test-telemetry-live.mjs`: spawn synthetic agent, call 20 tools, verify all 20 in `tool_calls`, verify cost math, verify outcome resolvers fire
- Hook: write to `learnings/decisions.jsonl` → verify Postgres `learnings` table gets the row

**E2E:**
- `scripts/e2e-sprint1.mjs`: real Claude session (3 turns) on a fixture project. Verify telemetry captured, cost accurate vs API billing within ±5%, at least one outcome resolved.

**Performance:**
- `scripts/perf-tool-calls.mjs`: insert 10,000 tool_calls + 1,000 outcomes; verify p99 query latency on common views < 100ms; insert throughput > 500/sec

**Regression:**
- `scripts/regression-sprint1.mjs`: replay 10 captured historical sessions, verify cost capture matches recorded API billing within ±5%

**Failure-mode:**
- Postgres unreachable during tool call → telemetry buffer + retry, no agent disruption
- Disk full when writing JSONL → graceful warning, no crash
- Out-of-pricing-table model → record at $0 with `unknown_model` flag, log warning

**Security:**
- N/A for Sprint 1 (no new attack surface; existing RBAC covers)

**User scenarios:**
- "Amit runs 1-hour Claude session on RevClear, expects cost report at end" → run, verify report generated, cost within ±5%
- "Amit replays a session to compare alternative tool choices" → replay tool exists, produces measurable diff

### Sprint 2 — explicit test inventory

**Unit:**
- Skill loader — global, per-project, hierarchical merge, malformed frontmatter
- `zc_skill_run` — preconditions check, input validation, output shape, missing skill error
- Mutation engine — Sonnet API mock returning candidates, judge logic, replay scoring
- Replay harness — fixture loading, isolated context, score computation
- Context-budget tracker — token-counting accuracy, hook upgrade rules at 70/85/95%
- Rolling compaction — segment selection, summary quality validation, in-place replace

**Integration:**
- Full mutation cycle: pick skill → generate candidates → judge → replay → promote/archive → verify Postgres state
- Skill invocation: `zc_skill_run("audit_file", {path: "test.ts"})` → tool calls happen as expected → outcome recorded

**E2E:**
- 8 seed skills each tested with ≥5 fixtures
- Nightly mutation engine runs for 7 days on synthetic outcome data → measurable improvement on at least 2 skills
- Context-budget enforcement: synthetic agent at 75% context tries to Read → blocked → uses zc_file_summary instead

**Performance:**
- 1000 skill_runs ingestion < 30 sec
- Mutation engine cycle (5 candidates + 5 replays) < 5 min

**Regression:**
- Existing harness without skills: ensure no behavior regression

**Failure-mode:**
- Sonnet API down during mutation: graceful skip, retry next night
- Replay fixture missing: skip with clear error
- Skill markdown invalid: refuse to load with parser error

**Security:**
- Prompt injection in skill body — must not exfiltrate or escalate (skills are TRUSTED but we still defense-in-depth)
- Mutation cannot edit skill outside `~/.claude/skills/` or `<project>/.claude/skills/` (path validation)

**User scenarios:**
- "Amit invokes audit_file skill on a real source file → gets a structured report"
- "Amit reviews the morning's mutation log, sees what got promoted and why"

### Sprint 3 — explicit test inventory

**Unit:**
- ASSIGN schema validation (all required fields present, types correct, dependencies valid IDs)
- Task queue: claim, heartbeat, reclaim-on-stale, SKIP LOCKED concurrent claims
- File-ownership conflict detection (overlapping exclusive sets, edge cases)
- Complexity → model tier router

**Integration:**
- Worker pool of 5 developers, 50 tasks queued, all 50 claimed and processed
- File-ownership: ASSIGN with overlapping `exclusive` files → REJECT broadcast back to orchestrator

**E2E:**
- 5-agent live session on synthetic 50-task workload: all tasks complete, no double-claim, no merge conflict
- Complexity routing: 100 tasks across complexity 1-5 → measure cost vs always-Sonnet baseline → ≥20% reduction

**Performance:**
- Task queue under concurrent load: 10 workers claiming from 1000-task queue, < 50ms p99 claim latency
- File-ownership check: 100 concurrent ASSIGN validations, < 100ms p99

**Regression:**
- Existing 1-worker-per-role flow: works unchanged when `-WorkerCount` not specified

**Failure-mode:**
- Worker dies mid-task: heartbeat staleness detected within 5 min, task reclaimed by another worker
- Postgres lock contention: SKIP LOCKED prevents deadlock
- Orchestrator posts ASSIGN with malformed schema: rejected with clear error

**Security:**
- File-ownership bypass attempt: agent tries to write to file outside its `exclusive` set → blocked at hook level (extension of preread-dedup pattern)

**User scenarios:**
- "Amit launches a 7-developer pool, 100 tasks, expects all to complete without manual intervention"
- "Amit specifies file_ownership exclusive=[src/auth/*] and another worker tries to ASSIGN same dir → rejected"

### Sprint 4 — explicit test inventory

**Unit:**
- Reranker integration: top-20 → top-5 with measurable score change
- HyDE: hypothetical answer generation + embed + search
- Multi-hop: reference extraction from markdown/code, follow-up search

**Integration:**
- Search with `mode: "rerank"` returns measurably better top-5 vs default
- Search with `mode: "hyde"` finds documents the default mode misses on benchmark

**E2E:**
- Curated benchmark of 50 real questions on 3 indexed projects
- Compare default vs reranker vs HyDE vs multi-hop on precision@5
- Reranker ≥15% precision@5 improvement vs default
- HyDE ≥10% improvement on long-tail (questions with no exact keyword match)

**Performance:**
- Reranker latency: 20 candidates, p99 < 200ms on RTX 5090
- HyDE: hypothetical generation < 1 sec
- Dashboard query: all default views < 200ms p99

**Regression:**
- Default search (no mode flag) unchanged in result ordering and quality

**Failure-mode:**
- Reranker model not pulled: graceful fallback to BM25+cosine ordering
- HyDE: Ollama down → fallback to raw query embedding
- Dashboard: Postgres view missing → 503 with helpful error

**Security:**
- Reranker input must be quoted — must not allow injection via document content into rerank prompt
- Dashboard: read-only; no mutation endpoints; auth required

**User scenarios:**
- "Amit asks a vague question, expects reranker to surface the most relevant 5 of 20 candidates"
- "Amit opens the dashboard, can see live worker state + cost burn in 30 seconds"

### Universal acceptance gates (all sprints)

Before any sprint is marked DONE, all of the following must be true:

- [ ] All 8 categories of tests (where applicable) are green
- [ ] Both SQLite + Postgres backends pass identical test suites
- [ ] Performance budgets met (declared in each sprint section)
- [ ] CHANGELOG entry written
- [ ] AGENT_HARNESS.md / README updated for any user-facing change
- [ ] Logging instrumented (per [section 14](#logging))
- [ ] Critical decision facts persisted to SC working memory
- [ ] This doc's revision history updated

---

<a id="logging"></a>
## 14. Logging strategy (debugging-first observability)

**Principle:** when something goes wrong (and things will), it must take **< 5 minutes** to find the cause from logs alone — not from re-running the agent, not from adding `console.log` after the fact.

### Log categories + levels

| Level | Use for | Volume |
|---|---|---|
| `DEBUG` | Per-operation detail (every state transition, every variable) | High; off by default in prod |
| `INFO` | Important state changes (mutation promoted, queue claimed, session started) | Moderate; on by default |
| `WARN` | Degraded conditions (Ollama unreachable, retry triggered, fallback engaged) | Low; on by default |
| `ERROR` | Failures (Postgres connection lost, schema mismatch, parse error) | Low; on by default + alert |
| `AUDIT` | Security-relevant (token issued, role permission check, file-ownership block) | Low; always on, never compacted |

### Per-component log files

Every major component writes to its own structured-JSON log under `~/.claude/zc-ctx/logs/`:

```
~/.claude/zc-ctx/logs/
├── telemetry.log         (Sprint 1 — every tool call)
├── outcomes.log          (Sprint 1 — every outcome resolution)
├── learnings-mirror.log  (Sprint 1 — every JSONL→Postgres index)
├── skills.log            (Sprint 2 — skill loads, runs, replays)
├── mutations.log         (Sprint 2 — every mutation cycle, full trace)
├── budget.log            (Sprint 2 — context-budget transitions)
├── compaction.log        (Sprint 2 — every rolling-compaction event)
├── tasks.log             (Sprint 3 — queue claims, heartbeats, completions)
├── ownership.log         (Sprint 3 — file-ownership decisions, conflicts)
├── routing.log           (Sprint 3 — complexity → model decisions)
├── retrieval.log         (Sprint 4 — reranker, HyDE, multi-hop debug)
└── audit.log             (cross-component — security-relevant events)
```

### Structured log schema

Every line is JSON:

```json
{
  "ts":        "2026-04-18T20:54:31.182Z",
  "level":     "INFO",
  "component": "mutations",
  "event":     "mutation_promoted",
  "session_id": "abc-123",
  "context": {
    "skill_name":    "audit_file",
    "from_version":  "0.1.0",
    "to_version":    "0.1.1",
    "replay_score_delta": 0.18,
    "judge_rationale": "candidate 3 better separates issues from suggestions"
  },
  "trace_id":  "muta-7f9a"
}
```

### Log rotation + retention

- Rotation: per-day files, max 100MB each (`telemetry.2026-04-18.log`, `telemetry.2026-04-19.log`)
- Retention: 30 days for INFO/WARN/ERROR; 365 days for AUDIT; DEBUG kept 7 days
- Compression: rotated logs gzipped after 24 hours
- Cleanup: nightly cron deletes expired logs

### Cross-log correlation via `trace_id`

Every log entry includes a `trace_id` that propagates through related operations. Example: a mutation cycle generates ONE trace_id (`muta-7f9a`); every log entry from that cycle (Sonnet call, replay, promotion, audit) shares it. Grep by trace_id to reconstruct an entire flow.

### Debug-first MCP tool

A new `zc_logs` tool ships in Sprint 1:

```
zc_logs(component, since, level, trace_id?)
```

Returns recent log entries matching the filter, formatted for agent consumption. The agent can self-debug:

```
Agent: "I keep getting timeouts on the mutation engine. Let me check."
→ zc_logs("mutations", since="1h", level="ERROR")
→ "Found 3 ERRORs: all 'Sonnet API timeout after 30s'. Consider retry with longer timeout."
```

### Console / live-tail mode

Set `ZC_LOG_CONSOLE=1` to also stream INFO+ to stderr. Useful during sprint-specific debugging. Color-coded: cyan=INFO, yellow=WARN, red=ERROR, magenta=AUDIT.

### Log-driven testing

Every test in [section 13](#testing) MUST also assert on log output where appropriate. E.g.:

```js
// Test: Postgres unreachable during tool call
const r = await recordToolCallWithSimulatedPgDown(...);
assert(r.bufferedForRetry, "should buffer when PG down");
assertLogContains("telemetry.log", { level: "WARN", event: "pg_unreachable_buffered" });
```

This catches "silently swallowed errors" — a class of bugs where the code "works" but logs nothing useful when it doesn't.

### Sprint 1 logging deliverables

- `src/logger.ts` — structured JSON logger with levels, rotation, console mode
- `src/log-rotation.ts` — daily rotation + gzip + retention enforcement
- `hooks/log-cleanup.ps1` — nightly cron equivalent
- `zc_logs` MCP tool implementation
- All Sprint 1 components wired through the logger
- README section: "Debugging — where to look first"

---

<a id="risks"></a>
## 15. Risks + open questions

### Known risks

1. **Outcome resolver false positives.** "User said thanks" could be sarcastic. Mitigation: signals are weak labels; pattern miner needs N≥10 samples before promoting a finding.

2. **Mutation drift.** Skills could mutate themselves into local optima that look good on fixtures but fail real-world. Mitigation: parent skill version always preserved; promotion requires improvement on BOTH synthetic AND real-historical fixtures (post Sprint 2.5).

3. **Postgres dependency.** Sprint 3 work-stealing requires Postgres for SKIP LOCKED. SQLite users get a degraded "single worker per role" mode.

4. **Token-counting accuracy.** API doesn't always return token counts; tiktoken estimates can drift ±10%. Mitigation: monthly calibration against API billing.

5. **Conversation compaction risk.** If we get the in-place compaction wrong, the agent loses critical decisions. Mitigation: compacted segments preserved in `compacted_segments` table; agent can request unredaction via `zc_unredact(segment_id)`.

### Open questions (for future decision)

1. **When to flip required vs optional on Sprint 3 schema?** (Currently planned for v0.13 cutover.)
2. **Should the dashboard be served from a separate container or embedded in sc-api?**
3. **Should we publish anonymized pattern data across users (opt-in)?** (Long-term ambition; not Sprint 1-4.)

---

<a id="glossary"></a>
## 16. Glossary

- **Skill** — a markdown program defining a composed agent workflow. Located in `~/.claude/skills/` (global) or `<project>/.claude/skills/` (per-project).
- **Outcome** — a deferred fact about whether an action achieved its goal. Joined to actions via `ref_type, ref_id`.
- **Mutation** — a proposed change to a skill, prompt, or routing rule, generated by the mutation engine.
- **Replay** — running a skill against a fixture or historical session in an isolated environment to measure outcome.
- **Composite outcome score** — weighted combination of cost-efficiency, accuracy, and speed (per skill `metric_weights`).
- **Pattern miner** — nightly batch process that joins outcomes ↔ actions and surfaces ROI patterns.
- **Promotion** — when a per-project skill version outperforms global by ≥X%, it becomes a candidate for global promotion.

---

<a id="revisions"></a>
## 17. Revision history

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-04-18 | v1.0 | Amit + Claude (Sonnet 4.6) | Initial — full plan ratified |
| 2026-04-18 | v1.1 | Amit + Claude (Sonnet 4.6) | D4 mutation engine revised: Sonnet 4.6 PRIMARY (not Ollama hybrid) with pluggable interface for future local A/B. Added §13 Testing strategy (8 categories, per-sprint inventory). Added §14 Logging strategy (debugging-first observability with `zc_logs` tool). |
