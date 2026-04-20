# Changelog

All notable changes to SecureContext. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For full release notes including the v0.2.0–v0.8.0 history, see the **[Changelog section in README.md](README.md#changelog)**.

## [0.17.0] — 2026-04-20 — Sprint 3 Phase 3: Work-Stealing Queue + Model Router + Ownership Guard + Multi-Worker Pools

Sprint 3 Phase 3 — the pieces that let multiple workers in the same role share one task queue without stepping on each other. Closes the "single worker per role" limit that v0.15.0/v0.16.0 left in place.

### Added — Postgres work-stealing queue (§8.2)

- **`task_queue_pg`** table (migration id=5) with state CHECK constraint + routing index `(project_hash, role, state, ts)` + partial heartbeat index `WHERE state='claimed'`.
- **`src/task_queue.ts`** — seven operations backed by `FOR UPDATE SKIP LOCKED` so N workers can race-claim atomically without blocking each other:
  - `enqueueTask()` — idempotent (`ON CONFLICT DO NOTHING`)
  - `claimTask()` — atomic primitive (`UPDATE ... WHERE task_id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`)
  - `heartbeatTask()` — workers must call every 30s
  - `completeTask()` / `failTask()` — terminal states (fail bumps `retries`)
  - `reclaimStaleTasks(staleAfterSeconds=300)` — sweep dead claims back to queue
  - `getQueueStats()` — counts by state
- **13 unit tests** (`src/task_queue.test.ts`) including:
  - **RT-S4-01**: 50 concurrent workers × 100 tasks → each task claimed EXACTLY once (no double-claim; core correctness property of `SKIP LOCKED`)
  - **RT-S4-02**: 600s-stale heartbeat → reclaim back to queued + retries++
  - **RT-S4-03**: `failTask` bumps retries + persists failure_reason
  - **RT-S4-04**: cross-role + cross-project scope isolation

### Added — 6 MCP tools exposing the queue

- `zc_enqueue_task` (orchestrator) · `zc_claim_task` (worker) · `zc_heartbeat_task` · `zc_complete_task` · `zc_fail_task` · `zc_queue_stats`
- Worker `agent_id` is sourced from `ZC_AGENT_ID` env var so a multi-worker pool (e.g. `developer-1/2/3` all `role=developer`) shares one queue keyed by `(project_hash, role)` and claims atomically.
- **5 MCP integration tests** (`src/task_queue_mcp.test.ts`) covering end-to-end lifecycle, 3-worker race, fail path, stats aggregation, cross-project isolation.

### Added — Complexity-based model router (§8.5)

- **`src/indexing/model_router.ts`** — `chooseModel(complexity 1-5)` returns `{model, tier, reason, estimatedInputCostPerMtok, inputClamped}`:
  - 1-2 → **Haiku 4.5** (trivial tasks, $0.25/Mtok)
  - 3-4 → **Sonnet 4.6** (standard work, $3.00/Mtok — cost/quality sweet spot)
  - 5   → **Opus 4.7** (hard reasoning, $15.00/Mtok)
- Env overrides: `ZC_MODEL_TIER_{HAIKU,SONNET,OPUS}` resolved per call so operators can flip at runtime.
- Safe defaults: `null` / `undefined` / `NaN` / `Infinity` / out-of-range → Sonnet with `inputClamped=true`.
- **19 unit tests** covering tier mapping, rounding, clamping edges, env overrides, result shape.
- **`zc_choose_model`** MCP tool wraps it.

### Added — File-ownership overlap guard at `/api/v1/broadcast` (§8.2)

- HTTP API rejects `ASSIGN` whose `file_ownership_exclusive` overlaps any in-flight (unmerged) ASSIGN's exclusive set → **HTTP 409 Conflict** with `overlapping_files` + `conflicting_broadcast_id`. Prevents two workers being assigned the same file.
- "In-flight" = ASSIGN whose `task` has no subsequent MERGE in the last 200 broadcasts.
- **5 integration tests** (`src/ownership_guard.test.ts`):
  - **RT-S4-05**: overlapping exclusive → 409
  - **RT-S4-06**: disjoint exclusive → 200
  - **RT-S4-07**: re-ASSIGN allowed after MERGE of the prior task
  - Plus back-compat (no excl set) + non-ASSIGN types bypass guard

### Fixed — `recallSharedChannel` was silently dropping v0.15.0 §8.1 structured columns

SQLite-path `recallSharedChannel` only projected legacy columns. All downstream consumers saw `file_ownership_exclusive=undefined` even when the DB column was populated — the ownership-guard work surfaced this hidden v0.15.0 gap. Now projects all 7 v0.15.0 §8.1 columns with NULL → `undefined` semantics.

### Added — `-WorkerCount N` on `start-agents.ps1` + role-tagged registration (A2A_dispatcher side)

- New `-WorkerCount` param (1-20, default 1). When > 1, expands each `-Roles` entry into N numbered workers suffixed `-1`..`-N`:
  ```powershell
  start-agents.ps1 -Roles developer -WorkerCount 3
  # → spawns developer-1, developer-2, developer-3
  #   each with its own WT window, worktree, registration
  #   all sharing role="developer" — one work-stealing queue
  ```
- `Get-AgentRole` helper strips `-N` suffix so `$roleMeta` + `roles.json` deep-prompt lookups still work.
- `register.mjs` accepts `--role` flag / `ZC_AGENT_ROLE` env → writes `_agent_roles[agentId]` sidecar so dispatcher can route by role without breaking the existing `agentId → pane` string map.
- Back-compat: `WorkerCount=1` (default) preserves legacy plain names ("developer" not "developer-1").
- **Env propagation fix**: worker/orchestrator launch scripts now also propagate `ZC_POSTGRES_*` + `ZC_TELEMETRY_BACKEND` so the agent's MCP server can reach `task_queue_pg` (closes the longstanding v0.10.4 env-propagation follow-up).

### Added — `scripts/backfill-learnings.mjs` (close the learning loop)

- The PostToolUse `learnings-indexer.mjs` hook only mirrors NEW Write/Edit events — prior `<project>/learnings/*.jsonl` rows never get indexed into `learnings` / `learnings_pg`. So agents couldn't `zc_search` past decisions/failures from earlier sessions.
- New script scans `<project>/learnings/*.jsonl`, categorizes by filename stem, idempotently upserts (via `UNIQUE`), mirrors to PG when `ZC_TELEMETRY_BACKEND=postgres|dual`.
- Verified on Test_Agent_Coordination: 6 rows backfilled (3 decisions + 3 metrics). Previously both SQLite and PG had 0 learnings rows despite JSONL content existing.

### Test Suite

- **617/617 unit+integration tests pass** (was 575 pre-v0.17.0; +42 new: 13 task_queue + 19 model_router + 5 ownership guard + 5 task_queue MCP).
- Live E2E on Test_Agent_Coordination with `-WorkerCount 3`: agent called `zc_choose_model` (verified 2→haiku, 4→sonnet, 5→opus tier mapping), enqueued 3 disjoint-ownership tasks via `zc_enqueue_task`, workers atomically claimed via `zc_claim_task`, committed actual file hardening (e.g. `checkRequest(req)` in `src/rate-limiter.js` throwing `TypeError: rate-limiter: req argument is required`; `harden: validate argv in index` commit `f25acf5a`).

### Migration

- **Schema**: migration id=5 (`task_queue_pg`) is idempotent + additive — Postgres-only feature (no SQLite companion).
- **API**: zero breaking changes. All new MCP tools are additive.
- **Env for workers**: if you run in HTTP/Postgres mode, restart agents via `start-agents.ps1` so they pick up the updated launch scripts that propagate `ZC_POSTGRES_*`. Until then, `zc_enqueue_task`/`zc_claim_task` return `Postgres pool unavailable`.

## [0.16.0] — 2026-04-19 — Sprint 3 Phase 2: Postgres Backend + T3.1/T3.2 (RLS) + API ASSIGN forwarding

Sprint 3 Phase 2 — the Postgres backend that's been deferred since v0.12.x lands here, along with both remaining Tier 3 fixes (T3.1 per-query `SET LOCAL ROLE` and T3.2 Row-Level-Security policies). Closes the v0.15.0 known limitation where structured ASSIGN fields were silently dropped by the HTTP API.

### Added — Postgres backend for telemetry/outcomes

- **`src/pg_pool.ts`** — process-singleton `pg.Pool` with retry-friendly defaults (60s idle timeout, 30s statement timeout). Lazy initialization; returns null when no creds configured (graceful degrade for SQLite-only deployments). `withTransaction()` + `withClient()` helpers.
- **`src/pg_migrations.ts`** — 4 migrations creating `tool_calls_pg`, `outcomes_pg`, `learnings_pg` (mirroring SQLite schema with `BIGSERIAL` ids + `JSONB` evidence + `TIMESTAMPTZ`). Idempotent; safe to call on every server start.
- **`src/security/chained_table_postgres.ts`** — `ChainedTablePostgres` implementing the same `ChainedTable` interface as SQLite. Uses `BEGIN; SELECT row_hash FROM ... ORDER BY id DESC LIMIT 1 FOR UPDATE; INSERT ...; COMMIT` pattern — Postgres analog of SQLite's `BEGIN IMMEDIATE`. Same chain content (HKDF-keyed HMAC) as SQLite — rows are byte-identical across backends.

### Added — `ZC_TELEMETRY_BACKEND` env switch (server-side)

Previously hinted at; now wired in. Per-process choice of where telemetry rows land:

| Value | Behavior |
|---|---|
| `sqlite` (default) | Writes to project SQLite (current v0.15.0 behavior) |
| `postgres` | Writes to Postgres `tool_calls_pg` / `outcomes_pg` / `learnings_pg` |
| `dual` | Writes to BOTH (parity-verification mode for migration) |

Wired into `recordToolCall` + `recordOutcome` via the `_recordToolCallLocal` / `_recordOutcomeLocal` mode-switch paths added in v0.12.1.

### Added — Tier 3 fix T3.1: per-query `SET LOCAL ROLE` (Chin & Older 2011 Ch11)

Each agent now writes its telemetry under a **per-agent Postgres role** instead of the pool's broad role:

1. On first tool call from a new `agent_id`, lazily provisioned via `CREATE ROLE "zc_agent_<sanitized>" NOLOGIN NOINHERIT` (idempotent via DO/EXCEPTION).
2. Granted minimum privileges: `INSERT, SELECT, UPDATE` on telemetry tables (`UPDATE` required for `SELECT FOR UPDATE` row locking), `INSERT` on learnings, `USAGE ON SCHEMA public`, `USAGE` on BIGSERIAL sequences.
3. Pool's owning role granted `MEMBER OF` the per-agent role, so `SET ROLE` works.
4. Each chained INSERT runs inside `BEGIN; SET LOCAL ROLE <agent>; INSERT ...; COMMIT;` — `SET LOCAL` is auto-reset on COMMIT/ROLLBACK so the next pooled checkout starts clean.

**Result:** Postgres's `current_user` reflects the actual writing agent, not the pool's user. Bears directly on T3.2 below.

### Added — Tier 3 fix T3.2: Row-Level Security policies on `outcomes_pg`

Migration 4 enables `ALTER TABLE outcomes_pg ENABLE ROW LEVEL SECURITY` and adds 4 policies (covering Bell-LaPadula confidentiality tiers per Chin & Older 2011 Ch5+Ch13):

| Policy | Permits |
|---|---|
| `outcomes_read_public_internal` | SELECT where `classification IN ('public','internal')` for any role |
| `outcomes_read_confidential` | SELECT where `classification = 'confidential'` for any agent role (registered = non-empty `current_user`) |
| `outcomes_read_restricted` | SELECT where `classification = 'restricted' AND created_by_agent_id = current_setting('zc.current_agent', true)` — only the originating agent |
| `outcomes_write_any` | INSERT for any role with table-level INSERT (gated by Tier 1 GRANTs) |

`set_config('zc.current_agent', $agentId, true)` is set per-write-transaction so the RLS predicate evaluates against the correct agent identity.

**RT-S3-05 verifies live:** alice writes a `'restricted'` outcome; bob (with valid `zc_agent_bob` role + correct `current_user`) cannot SELECT it; alice can SELECT her own. **This is enforced inside Postgres, not in application code** — same as Postgres protecting financial transaction tables. Even a compromised agent process with valid credentials cannot read other agents' restricted outcomes.

### Added — HTTP API forwards structured ASSIGN columns

`POST /api/v1/broadcast` now accepts and forwards the 7 structured ASSIGN fields added in v0.15.0:

- `acceptance_criteria`, `complexity_estimate`, `file_ownership_exclusive`, `file_ownership_read_only`, `task_dependencies`, `required_skills`, `estimated_tokens`

**Closes the v0.15.0 known limitation** where these fields were silently dropped in HTTP/Docker API mode.

### Test summary

- **575/575 tests pass** (565 baseline + **10 new Postgres-backend tests**)
- All 10 Postgres tests run **against the real local Docker container** (`securecontext-postgres`) — they're skipped automatically when no PG is reachable so CI stays portable
- **RT-S3-05 verified live**: cross-agent read of `'restricted'` row blocked by Postgres RLS even when both agents share the pool's DB credentials
- **RT-S3-06 verified live**: chain hashes are byte-identical across SQLite + Postgres backends — rows can be migrated between backends without rehashing

### Bugs found + fixed during integration

1. `provisionAgentRole` originally ran GRANTs inside the writer transaction → Postgres permission cache didn't see them at SET LOCAL ROLE time. Fixed by running provisioning on its own connection (separate transaction, auto-committed).
2. `SELECT FOR UPDATE` on `tool_calls_pg` requires `UPDATE` privilege (not just SELECT) on most PG versions — added explicit `GRANT UPDATE`.
3. `GRANT USAGE ON SCHEMA public` was missing — required even for tables with table-level grants when the role doesn't inherit defaults.

### Known limitations

- **Existing `securecontext-api` Docker container is on v0.8.0** and doesn't yet have the v0.16.0 endpoints/columns. To use HTTP API mode against the bundled stack: rebuild + redeploy the container with the v0.16.0 code (`docker compose build sc-api && docker compose up -d sc-api`).
- **Live multi-agent test through `start-agents.ps1` with `ZC_TELEMETRY_BACKEND=postgres`** requires the Docker image rebuild above. Functionally validated via 10 unit tests against real Postgres + cross-agent forgery RLS test (RT-S3-05) — the remaining "real agent in a real terminal" verification is a Docker-rebuild step away.
- v0.17.0 (next) lands §8.2-8.5 work-stealing queue + worker pool spawning + file-ownership enforcement + complexity-based model routing — uses the Postgres backend shipped here.

### Upgrade notes

**Backward-compatible by default.** Deployments that don't set `ZC_TELEMETRY_BACKEND` continue to use SQLite exactly as in v0.15.0.

**To enable Postgres backend:**

1. Set `ZC_POSTGRES_PASSWORD` (or full `ZC_POSTGRES_URL`) — without these, the pool refuses to initialize and falls back to SQLite
2. Set `ZC_TELEMETRY_BACKEND=postgres` (or `=dual` for parity verification during migration)
3. The shared Postgres role needs `CREATEROLE` privilege so it can provision per-agent roles. The bundled `scuser` already has this. For custom Postgres setups: `ALTER ROLE <pool_user> WITH CREATEROLE;`
4. Rebuild + redeploy the Docker `securecontext-api` container to pick up the new endpoints

**For agents with sensitive user-prompt outcomes:** classification `'restricted'` rows now have **defense-in-depth via Postgres RLS** (in addition to the v0.15.0 SQLite application-level filter). Even if an attacker gains DB credentials, restricted rows remain author-only.

---

## [0.15.0] — 2026-04-18 — Sprint 3 Phase 1: Structured ASSIGN + MAC Classification (Tier 3 Part)

First slice of Sprint 3 — the foundation pieces that don't require Postgres backend. Adds structured task fields to `ASSIGN` broadcasts (so dispatcher can route by complexity / enforce file ownership / resolve dependencies) and adds Mandatory Access Control labels to outcomes (closes Tier 3 fix T3.2 from §8.6 — at the SQLite layer; Postgres RLS lands in v0.16.0).

### Added — §8.1 Structured ASSIGN broadcast schema (additive, backward-compatible)

**Migration 18** adds 7 NULLABLE columns to `broadcasts`:

| Column | Type | Purpose |
|---|---|---|
| `acceptance_criteria` | TEXT (JSON array) | Testable assertions defining "task done"; up to 20 items × 500 chars |
| `complexity_estimate` | INTEGER | 1-5 estimate (5=needs Opus, 1=trivial Haiku); enables tier routing in v0.17 |
| `file_ownership_exclusive` | TEXT (JSON array) | Files this task has exclusive WRITE authority over; path-traversal filtered |
| `file_ownership_read_only` | TEXT (JSON array) | Files this task may READ but not modify |
| `task_dependencies` | TEXT (JSON array of broadcast IDs) | Broadcast IDs that must MERGE before this task can start |
| `required_skills` | TEXT (JSON array) | Skill names needed (Sprint 2 mutation engine will route by these) |
| `estimated_tokens` | INTEGER | Optional token-cost estimate for budgeting |

**API change (additive):** `broadcastFact()` accepts the new fields as optional opts; `BroadcastResult` echoes them back. **Backward compat preserved:** legacy ASSIGN broadcasts without these fields still work — DB stores NULL, response returns empty/null per field.

**Sanitization (defense-in-depth):**
- `complexity_estimate` clamped to 1..5; out-of-range coerced to NULL
- File paths run through `isSafeFilePath` (rejects `../` and `..\\`)
- `task_dependencies`: only positive integers kept, max 50
- `acceptance_criteria` truncated to 500 chars per item, max 20 items
- `required_skills` truncated to 100 chars per item, max 20 items
- `estimated_tokens` clamped to [0, 1B]; non-finite → NULL

**Index:** `idx_b_complexity ON broadcasts(complexity_estimate, type)` for the dispatcher's tier-routing scan that lands in v0.17.

### Added — §8.6 T3.2 MAC-style classification on outcomes

**Migration 19** adds two columns to `outcomes`:

| Column | Default | Constraint |
|---|---|---|
| `classification` | `'internal'` | `CHECK IN ('public', 'internal', 'confidential', 'restricted')` |
| `created_by_agent_id` | NULL | required when `classification='restricted'` |

**Read filter logic in `getOutcomesForToolCall(projectPath, callId, requestingAgentId?)`:**

| Tier | Visible to |
|---|---|
| `public` | All callers |
| `internal` | All callers (current behavior — no change for existing rows) |
| `confidential` | Any caller with non-empty `requestingAgentId` (registered agent) |
| `restricted` | ONLY the originating `created_by_agent_id` |

**Backward-compat:** omitting `requestingAgentId` returns ALL rows (admin/legacy path — preserves v0.14.0 behavior for callers that haven't updated yet).

**Per-resolver auto-classification:**
- `resolveUserPromptOutcome` → `'restricted'` + `createdByAgentId = ZC_AGENT_ID || recentCall.agent_id` (sentiment about a user message belongs to the originating agent only — cross-agent reads would leak how a specific user spoke to a specific worker)
- `resolveGitCommitOutcome` → default `'internal'` (commit info isn't sensitive)
- `resolveFollowUpOutcomes` → default `'internal'` (file_summary insufficiency is project-internal)

**Defensive defaults:**
- Caller passes `classification='restricted'` without `createdByAgentId` → downgraded to `'confidential'` + warning logged (no silent loss of readability)
- Invalid classification value (e.g. `'TOP-SECRET'`) → coerced to `'internal'` (fail-safe default)
- CHECK constraint enforces the four allowed values at the DB level (RT-S3-04 verifies SQL injection blocked)

**Maps to Chin & Older 2011 Ch5 (Security Policies) + Ch13 (Confidentiality and Integrity Policies — Bell-LaPadula).**

### Tests — 24 new (565/565 total pass)

**§8.1 structured ASSIGN (10 tests):**
- User case: full structured ASSIGN round-trips (10 fields verified end-to-end)
- Backward-compat: legacy ASSIGN without new fields still works
- Edge cases: complexity clamping (0/6/-1/3/3.7), oversize cap (30→20 acceptance_criteria), path-traversal rejection, integer-only filter on dependencies, length cap on skills, negative/NaN/oversize tokens, coexistence with non-ASSIGN broadcasts

**§8.6 T3.2 classification (14 tests):**
- Default `'internal'` classification round-trips
- All 4 levels round-trip
- `'restricted'` without `createdByAgentId` → downgraded to `'confidential'`
- `getOutcomesForToolCall` without filter → admin/legacy path returns all rows
- `'public'` + `'internal'` visible to all
- `'confidential'` blocks empty agent_id, allows non-empty
- **RT-S3-02:** cross-agent read of `'restricted'` row blocked (alice writes, bob can't read; alice can read her own; mixed-agent scenario where each sees only their own)
- **RT-S3-03:** legacy rows get `'internal'` default from migration; CHECK constraint blocks attempts to NULL out classification
- **RT-S3-04:** SQL injection / typo via direct DB UPDATE blocked by CHECK constraint
- `resolveUserPromptOutcome` auto-tags `'restricted'` with the agent's identity; cross-agent read blocked
- `resolveGitCommitOutcome` stays `'internal'`
- Invalid classification on input coerced to `'internal'` (defensive)

### Known limitation (deferred to v0.16.0)

- **HTTP API mode (`ZC_TELEMETRY_MODE=api` / Docker stack):** the existing api-server (`securecontext-api` Docker container) doesn't yet know about the structured ASSIGN columns. Broadcasts going through the HTTP `/api/v1/broadcast` endpoint silently drop the new fields. **Local-mode broadcasts work fully.** v0.16.0 will add Postgres support for the new columns + RLS policy enforcing T3.2 at the database layer.
- **Per-agent Postgres role (Tier 3 fix T3.1):** intentionally deferred to v0.16.0 since it depends on the Postgres backend for telemetry/work-stealing landing first (per §8.6 acceptance criteria).

### Upgrade notes

**Backward-compatible.** No existing call sites break:
- `broadcastFact()` keeps its old signature; new fields are optional opts
- `recordOutcome()` keeps its old signature; new `classification` + `createdByAgentId` are optional
- `getOutcomesForToolCall()` keeps its old signature; new `requestingAgentId` is optional (omit for current admin/legacy behavior)
- Migrations 18+19 are defensive (idempotent, skip if column already exists, skip if base table missing)

**For dispatcher implementations:** start emitting `complexity_estimate` and `file_ownership_exclusive` on ASSIGN broadcasts now — v0.17 work-stealing queue will consume them.

**For agents handling sensitive user prompts:** outcomes from `resolveUserPromptOutcome` are now auto-tagged `'restricted'` with your agent_id binding. Cross-agent leaks of inferred sentiment are blocked at the SQLite read filter (and at Postgres RLS in v0.16.0).

---

## [0.14.0] — 2026-04-18 — Native AST + Provenance Tagging + Louvain Community Detection

The "deeper internal capabilities" release. Three new features that complement v0.13.0's graphify integration — bringing similar structural-understanding capabilities natively to SC's KB even when graphify isn't available:

1. **AST extractor for code files** — deterministic L0/L1 summaries for TypeScript / JavaScript / Python via regex-based extraction. Skips the LLM call for code files where AST gives a comprehensive summary.
2. **Provenance tagging** — `EXTRACTED` / `INFERRED` / `AMBIGUOUS` / `UNKNOWN` on every `working_memory` and `source_meta` row. Maps to Chin & Older 2011 Ch6+Ch7 "speaks-for" formalism: every claim carries its trust chain.
3. **Louvain community detection** — clusters KB sources by graph topology (no embeddings). New `zc_kb_cluster` + `zc_kb_community_for` MCP tools.

### Phase A — Provenance tagging

**Migrations 16 + 17** add a `provenance TEXT NOT NULL DEFAULT 'UNKNOWN'` column to `working_memory` and `source_meta` with a CHECK constraint enforcing the four allowed values:

| Tag | Meaning |
|---|---|
| `EXTRACTED` | Read directly from a primary source (file, AST, git output, deliberate user input) |
| `INFERRED` | Produced by an LLM or similarity heuristic |
| `AMBIGUOUS` | Multiple plausible readings, user/agent should review |
| `UNKNOWN` | Legacy rows from before v0.14.0 (default for migration) |

**API changes (additive — backward compatible):**

- `rememberFact(projectPath, key, value, importance, agentId, provenance?)` — defaults to `EXTRACTED` (the user typed it deliberately = high trust)
- `indexContent(projectPath, content, source, sourceType, retentionTier, l0?, l1?, provenance?)` — defaults to `INFERRED` (most KB content is LLM-summarized)
- `indexProject` automatically tags AST-extracted summaries `EXTRACTED`, semantic summaries `INFERRED`, truncation fallbacks `AMBIGUOUS`

**ON CONFLICT semantics:** re-asserting a fact with a different provenance updates the row (allows promotion `INFERRED → EXTRACTED` after verification, or downgrade `EXTRACTED → AMBIGUOUS` on uncertainty).

**Red-team test RT-S3-01:** SQL injection through provenance value blocked by the CHECK constraint.

### Phase B — AST extractor (TS/JS/Python)

**`src/indexing/ast_extractor.ts`** — regex-based AST extraction that produces deterministic L0/L1 summaries for code files without an LLM call. Languages supported in v0.14.0:

- **TypeScript** (`.ts`, `.tsx`): exports, imports, classes (incl. abstract), interfaces, type aliases, functions (incl. async, generator), decorators, JSDoc module headers
- **JavaScript** (`.js`, `.jsx`, `.mjs`, `.cjs`): exports (ESM + CommonJS module.exports), imports (`import`/`require`), classes, functions, decorators
- **Python** (`.py`, `.pyw`): top-level classes/functions (with privacy convention), imports (`import`/`from ... import`), `__all__` for explicit exports, decorators, module docstrings

**Why regex first, tree-sitter later:** tree-sitter requires per-language WASM grammar files (~500KB each) that aren't bundled. Regex covers the common cases that matter (top-level exports, imports, classes, functions) at zero install friction. The interface is designed so a future v0.15.0 can swap in `web-tree-sitter` for the same languages without breaking consumers — output shape is identical.

**Cost reduction:** for a typical TS project, ~80% of code files get a deterministic L0 in <1ms each (no Ollama call). Only files needing semantic summarization (markdown, complex prose) hit the LLM. **Net: ~80% LLM cost reduction on indexing for code-heavy projects.**

**`IndexProjectResult` gains `astExtractedCount: number`** reporting how many files used the AST path.

**Live verification on Test_Agent_Coordination:** 4 EXTRACTED source_meta rows, sample L0:
- `rate-limiter.js` → "REST API Rate Limiter Middleware. Contains 1 class, 1 function."
- `search.js` → "Task Search — Fuzzy Matching... Contains 2 functions, 1 import."

### Phase C — Louvain community detection

**`src/indexing/community.ts`** + new MCP tools `zc_kb_cluster` and `zc_kb_community_for`. Builds a graph from the project's `knowledge` table (nodes = sources; edges = co-references via filename/path mentions), runs the Louvain modularity-maximization algorithm, and stores assignments in a new `kb_communities` table.

**Algorithm choice:** Louvain (not Leiden as originally planned — Leiden isn't published as an npm package). Same family — both maximize modularity by edge density. Leiden fixes some pathological cases that Louvain can hit on disconnected graphs, but for typical software projects with dense module graphs the practical difference is small. Documented honestly.

**Why this matters:** for "what's related to X" type questions, **graph topology beats vector similarity** for many use cases. Two files that import each other are obviously related — no embedding call needed. Communities surface higher-order structure (e.g. "the auth cluster", "the data layer cluster") that pure top-k similarity misses.

**Two new MCP tools:**

- **`zc_kb_cluster()`** — runs Louvain over the current KB, persists assignments. Returns top communities + sample sources.
- **`zc_kb_community_for(source)`** — looks up a source's community + community-mates. Use for "what's related to X" where X is a known source path.

**Live verification:** ran on Test_Agent_Coordination — clustered 26 sources into 5 communities (sizes 6, 6, 5, 2, 1, ...). Both new MCP tools called successfully by the live developer agent.

### New dependencies

- `web-tree-sitter` ^0.26.8 — installed but not yet wired (placeholder for v0.15.0 tree-sitter upgrade)
- `graphology` ^0.26.0 — graph data structure for Louvain
- `graphology-communities-louvain` ^2.0.2 — community detection algorithm

### Test summary

- **541/541 tests pass** (470 baseline + **71 new**: 17 provenance + 42 AST + 12 community)
- **Live agent integration test passed** on Test_Agent_Coordination — all three features fired
- Real-world edge cases covered: empty files, syntax-broken files, very-large files (>5MB rejected), comments-only files, abstract classes, generator functions, default exports, decorators, Python `__all__`, async def, deeply-nested code

### Upgrade notes

**Backward compatible.** No existing code paths break:

- `rememberFact` and `indexContent` keep the old positional signature; provenance is the new optional last argument
- AST extraction is automatic for code file extensions but doesn't change behavior for non-code files
- Community detection is opt-in via the new MCP tools — nothing runs unless an agent explicitly calls `zc_kb_cluster`
- Migrations 16+17 are defensive (idempotent + skip if column already present)

**For agents:**
- For "what's the architecture of this project" → call `zc_kb_cluster` first, then drill into top communities with `zc_kb_community_for`
- For "what's related to X" where X is a known file → `zc_kb_community_for("file:src/X.ts")`
- For "summarize this code" → `zc_file_summary` now returns AST-extracted summary if file is in TS/JS/Python (faster, deterministic, EXTRACTED tag)

### Deferred

- **Tree-sitter WASM grammar integration** — the regex extractor covers the 80/20 case. v0.15.0 can swap in tree-sitter for the same interface (no breaking change).
- **Sprint 3** picks up Tier 3 access-control fixes — see `HARNESS_EVOLUTION_PLAN.md §8.6` (locked with hard "DO NOT START" gate).

---

## [0.13.0] — 2026-04-18 — graphify integration: structural knowledge graph as a first-class SC capability

Adds three new MCP tools that proxy to **[graphify](https://github.com/safishamsi/graphify)**, the AI coding assistant skill that builds structural knowledge graphs of any folder. Plus auto-indexing of `GRAPH_REPORT.md` so agents discover it via normal `zc_search` without needing to know graphify exists.

**Why both:** SC and graphify solve different problems. SC = persistent state + multi-agent + telemetry + security. graphify = structural map of code + multimodal corpus understanding. They stack multiplicatively for token savings on architectural questions:

| Question type | Without either | SC alone | graphify alone | **Both stacked** |
|---|---|---|---|---|
| "How does auth work?" (architectural) | ~25k tokens | ~2k tokens (BM25 chunks) | ~500 tokens (god-node + community) | **~1.5k tokens** (graph orient → SC fetch precise) |
| "What did the developer agent commit?" (state) | N/A | ~1.5k tokens | N/A | ~1.5k tokens |
| "Show me X module's signatures" (multimodal/AST) | N/A | N/A | ~800 tokens | ~800 tokens |

### Added — three new MCP tools

- **`zc_graph_query(query: string)`** — natural-language graph query. Forwards to graphify's `query_graph` (which traverses `graph.json` and returns matching nodes + relationships + confidence tags). Use for "how does X relate to Y" / "what depends on Z".
- **`zc_graph_path(from: string, to: string)`** — shortest path between two named nodes. Forwards to graphify's `shortest_path`. Use for "trace the call chain".
- **`zc_graph_neighbors(node: string)`** — immediate neighbors of a node. Forwards to graphify's `get_neighbors`. Use for "what's directly connected to X".

All three return helpful hints when graphify isn't set up:

```
No graphify graph found at /your/project/graphify-out/graph.json.
Run `/graphify .` in this project (requires the graphify CLI:
`pip install graphifyy && graphify install`). Then retry zc_graph_query.
```

### Added — auto-index `graphify-out/GRAPH_REPORT.md`

`zc_index_project` now automatically detects + indexes graphify's one-page architectural overview into the SC KB. The L0 summary identifies it as "GRAPH_REPORT.md from graphify — structural knowledge graph: god nodes, communities, suggested architectural questions" so agents discover it via normal `zc_search` without needing to know graphify exists.

`IndexProjectResult` gains a `graphReportIndexed: boolean` field reporting whether the auto-index ran.

### Added — `src/graph_proxy.ts`

Lightweight subprocess client that:
- Spawns `python -m graphify.serve graphify-out/graph.json` lazily (only on first `zc_graph_*` call)
- Reuses one subprocess per project per SC server lifetime (cached handle)
- Communicates via JSON-RPC over stdio (graphify's native protocol)
- 10-second timeout per call, captures stderr to logs at WARN
- Subprocess shutdown on SC server exit
- **Defensive defaults:** ANY failure returns ok=false with a hint — never throws, never crashes the calling tool

### Security

- graphify subprocess runs with the SAME UID as the SC MCP server — no privilege escalation
- Project path is normalized + validated before being passed; `spawn` uses argv array (no shell interpolation)
- Subprocess can be killed via `shutdownAllGraphifyHandles()` for clean shutdown
- graphify's output is treated as untrusted data — JSON-RPC parsing is strict; malformed lines logged + skipped

### Test summary

- **470/470 tests pass** (459 baseline + 11 new graph_proxy tests covering: missing graphify-out, missing graph.json, hint contents, graceful subprocess failure, no-throw guarantee)
- **No regression** — all v0.11.0/v0.12.0/v0.12.1 tests pass unchanged
- **Live subprocess path is not unit-tested** (would require Python + graphifyy in CI). Covered by manual integration testing.

### Upgrade notes

**Backward-compatible — no agent-facing changes when graphify isn't installed.** SC works exactly as before. The three new tools are inert (return hints) until you `pip install graphifyy && graphify install` and `/graphify .` your project.

**To enable the integration:**

1. Install graphify (one-time, system-wide): `pip install graphifyy && graphify install`
2. Build a graph for your project: `/graphify .` from inside your AI assistant
3. Next `zc_index_project` call will auto-detect + index `GRAPH_REPORT.md`
4. Agents can immediately use `zc_graph_query` / `zc_graph_path` / `zc_graph_neighbors`

**Recommended workflow for agents** (combined SC + graphify):

| Question | Right tool |
|---|---|
| Architectural / structural ("how is X organized") | `zc_graph_query` first, then `zc_search` for precise content |
| State / history ("what was decided") | `zc_recall_context` |
| Specific implementation ("show me func X") | `zc_search` with the function name |
| What's connected to X | `zc_graph_neighbors` |

### Deferred to v0.14.0

The deeper structural-understanding capabilities discussed in the design review (v0.13.0 → v0.14.0 split):
- **Native AST tree-sitter pre-pass** for code files (LLM-free L0 from class/function/import extraction; ~50% indexing cost reduction for code-heavy projects)
- **EXTRACTED / INFERRED / AMBIGUOUS provenance tagging** on `working_memory` + `knowledge_entries` (Chin & Older 2011 "speaks-for" formalism — every claim carries its trust chain)
- **Leiden community detection** over the SC KB (graph topology beats vector similarity for some queries at near-zero cost)

These complement graphify rather than competing with it (graphify provides the cross-corpus map; v0.14.0 work brings similar capabilities natively to SC's KB even when graphify isn't available). Sprint 3 then picks up Tier 3 access-control fixes — see `HARNESS_EVOLUTION_PLAN.md §8.6`.

---

## [0.12.1] — 2026-04-18 — Tier 2: Reference Monitor + session_token binding for telemetry

Closes the **two largest remaining access-control gaps** identified in the v0.12.0 design review (Chin & Older 2011 — Ch6 + Ch12). Telemetry writes now have a single bypass-proof enforcement point that authenticates the writer's identity, not just verifies row integrity.

### Added — HTTP API Reference Monitor (`src/api-server.ts`)

Two new endpoints implement the Reference Monitor pattern (Chin & Older 2011 Ch12 — exactly one enforcement point per protected resource, tamper-proof + always invoked + verifiable):

- **`POST /api/v1/telemetry/tool_call`** — accepts a tool_call row, validates the `Authorization: Bearer <session_token>` header, asserts `payload.aid === body.agentId` (cross-agent forgery blocked), and delegates the write to the local `recordToolCall` (which still uses `ChainedTableSqlite` + per-agent HMAC subkey from v0.12.0).
- **`POST /api/v1/telemetry/outcome`** — same pattern for outcome rows. Outcomes have no per-row `agent_id` (writer is the resolver runtime), so the binding check is just "valid token required" — prevents anonymous poisoning.

The validation logic uses the existing `verifyToken` machinery from v0.9.0 RBAC — same HMAC-signed token format, same `agent_sessions` table, same project_hash binding, same revocation flow. No new auth substrate.

### Added — telemetry HTTP client (`src/telemetry_client.ts`)

When `ZC_TELEMETRY_MODE=api`, the MCP server's `recordToolCall` / `recordOutcome` route through the Reference Monitor instead of writing the local DB directly:

```ts
if (mode === "api" || mode === "dual") {
  // Fetch + cache session_token; POST to /api/v1/telemetry/...
  return await recordToolCallViaApi(input, sessionToken);
}
return await _recordToolCallLocal(input);
```

Token lifecycle:
- At first call, fetches a session_token via `POST /api/v1/issue-token` (existing v0.9.0 endpoint)
- Caches in-process for 1 hour
- Re-fetches on HTTP 401 from the API
- Falls back to local-mode if the API is unreachable or RBAC unconfigured (logged as a warning, never throws)

### Added — `ZC_TELEMETRY_MODE` env var

| Value | Behavior |
|---|---|
| `local` (default) | Direct SQLite writes (current v0.12.0 behavior) |
| `api` | Routes through HTTP API Reference Monitor |
| `dual` | Writes to BOTH (migration mode for verifying parity) |

### Security closes Tier 2 gaps from access-control review

| Gap | Before | After (v0.12.1) |
|---|---|---|
| **#1: No bypass-proof enforcement point.** Each agent's MCP server opened the project DB directly. | Any process with file access could write rows. | All writes route through the API; only the API process holds DB write authority. |
| **#2: `agent_id` was an unauthenticated string.** | Agent A could write rows claiming to be agent B. | The API verifies `body.agentId === token.aid`. Forgery blocked at the Reference Monitor with HTTP 403. |

Combined with v0.12.0's per-agent HMAC subkey (Tier 1 #1), telemetry rows are now both **integrity-protected** (chain) AND **authenticated** (token-bound writer).

### Red-team tests (RT-S2-02 through RT-S2-06)

- **RT-S2-02:** alice's token cannot write a row claiming bob → HTTP 403 with explicit "cross-agent forgery blocked" error
- **RT-S2-03:** missing/malformed/empty `Authorization` header → 401
- **RT-S2-04:** revoked token → 401
- **RT-S2-05:** project-A token used against project-B path → 401 (project-scoped capability per Ch11)
- **RT-S2-06:** end-to-end via `recordToolCallViaApi` client helper succeeds with valid token

### Test summary

- **459/459 tests pass** (449 baseline + 10 new Reference Monitor tests)
- Stress test 10 workers × 100 calls: chain ✓ OK, 458 writes/sec sustained
- Local-mode regression-free (default behavior unchanged for backward compat)

### Upgrade notes

**Backward-compatible by default.** Existing deployments continue using local-mode SQLite unless they explicitly set `ZC_TELEMETRY_MODE=api`.

**For multi-agent production deployments:**

1. Set `ZC_API_KEY` (already required for v0.9.0+ broadcast RBAC)
2. Set `ZC_TELEMETRY_MODE=api` in agent environments
3. Set `ZC_AGENT_ID` + `ZC_AGENT_ROLE` per agent (used for session_token issuance)
4. Rebuild + redeploy the SC HTTP API container — the v0.12.1 code adds the new `/api/v1/telemetry/*` endpoints. The shipped Docker image will need a refresh.

**For single-agent / local dev:** no changes required. Continue using the default local-mode.

### Known limitations / deferred to v0.12.2

- **Postgres backend (`ChainedTablePostgres`)** still pending. v0.12.1 ships the Reference Monitor pattern; v0.12.2 will add Postgres as a second `ChainedTable` implementation.
- **Tier 1 fix #2 (POSIX 0700/0600 hardening) and Tier 1 fix #3 (per-agent Postgres role)** still pending — depend on Postgres backend.
- **Cross-backend stress test** — pending Postgres backend.
- **Sprint 3 (Tier 3 fixes)** — explicitly locked in `HARNESS_EVOLUTION_PLAN.md §8.6` with hard "DO NOT START Sprint 3 until..." gate.

---

## [0.12.0] — 2026-04-18 — Sprint 2 prep: ChainedTable abstraction + per-agent HMAC subkey (Tier 1 #1)

**This is a foundation release.** It introduces the storage abstraction layer that future Postgres support will plug into, and closes the largest pre-existing access-control gap in v0.11.0's hash-chain design. **Breaking change for chain verification — see migration notes.**

### Added — backend-agnostic storage abstraction

- **`src/security/chained_table.ts`** — `ChainedTable<TInput, TRow>` interface for hash-chained append-only tables. All operations are `async` (Option 4 from the design review — sync internally for SQLite, async-ready for Postgres without API change). Per-agent HMAC subkey derivation via HKDF lives here.
- **`src/security/chained_table_sqlite.ts`** — SQLite implementation. Wraps `BEGIN IMMEDIATE` around the SELECT-prev-hash + caller's INSERT (preserves the v0.11.0+ concurrency-fix invariant, now in a clean abstraction).

### Added — security: per-agent HMAC subkey (closes Tier 1 Gap #5 from access-control review)

Sprint 1 (v0.11.0) used the raw machine secret as the HMAC key for all hash-chained rows. This made the chain integrity-only against external tampering, not authentication: any agent process knowing the machine secret could compute valid HMACs claiming any `agent_id`.

v0.12.0 derives a per-agent subkey using HKDF-Expand:

```
chain_hmac_key = HKDF-Expand(machine_secret, "zc-chain:" || agent_id, 32)
```

The verifier reads each row's stored `agent_id` and derives the matching subkey. A row claiming a wrong identity fails HMAC verification at the chain check. Combined with v0.12.1's session_token binding (next release), telemetry rows become genuinely *authenticated* — the chain proves not just "this row hasn't been modified" but "this row was written by the agent it claims to have been written by."

**Maps to Chin & Older 2011, Ch6 + Ch7** ("speaks-for" formalism — every claim should carry its trust chain).

**New red-team test RT-S2-01:** agent B cannot forge a row claiming to be agent A. Verifier catches the forgery via hash-mismatch.

### Changed — async public API (Option 4)

`recordToolCall`, `recordOutcome`, and the three resolvers (`resolveGitCommitOutcome`, `resolveUserPromptOutcome`, `resolveFollowUpOutcomes`) are now `async`. The SQLite path remains synchronous internally — the wrapper adds microseconds of overhead — but the new uniform interface makes future backends drop in without API change.

**Cascade:**
- Every call site needs `await` (167+ in tests already updated)
- Test callbacks moved from `() => {}` to `async () => {}` where applicable
- `verifyToolCallChain` + `verifyOutcomesChain` remain sync (read-only, no Postgres pressure yet)

### Removed

- The per-process `_lastHashCache` from v0.11.0. Was redundant once `BEGIN IMMEDIATE` shipped (the cache was always-stale across processes anyway), and added a Heisenbug surface area. Reading the latest hash inside the IMMEDIATE-locked transaction is sub-millisecond — no perceptible perf change.
- `_resetTelemetryCacheForTesting` is now a no-op (kept for backward-compat with tests that imported it).

### ⚠️ BREAKING CHANGE — chain verification

**Existing v0.11.0 chains (in already-populated `tool_calls` / `outcomes` tables) will fail to verify under v0.12.0.** This is intentional: the HMAC key derivation changed (raw secret → HKDF-derived per-agent subkey).

**Impact:** `verifyToolCallChain` / `verifyOutcomesChain` will report `ok: false, brokenKind: "hash-mismatch", brokenAt: 0` for any row written before upgrading.

**Migration options:**
1. **Truncate and restart** — for non-production deployments, easiest path. New rows verify cleanly.
2. **Re-hash retroactively** — write a migration script that, for each existing row, recomputes `row_hash` using the new subkey. Provided as `scripts/migrate-v011-to-v012-chains.mjs` (TODO — coming in v0.12.1).
3. **Coexist** — keep v0.11.0 verification helpers as `verifyToolCallChain_v011` for legacy chains; use v0.12.0 helpers for new rows. Not recommended long-term.

### Test summary

- **449/449 tests pass** (433 baseline + 16 new chained_table tests, including RT-S2-01 cross-agent forgery)
- **Stress test still chain ✓ OK** under 10 concurrent writers × 100 calls per project DB (regression from v0.11.0+a7ed9a1 confirmed)
- All 22 prior test files untouched in coverage (only their async-cascade calls were updated)

### Deferred to v0.12.1

This release is the **foundation** for the rest of v0.12. v0.12.1 will add:

- **Tier 2 fix #1: Reference Monitor pattern** — telemetry writes route through SecureContext HTTP API (single bypass-proof enforcement point per Chin & Older Ch12). MCP server becomes a *client* of the API; never opens DB files directly.
- **Tier 2 fix #2: session_token binding** — every `recordToolCall` requires a session_token bound to `agent_id` (matches RBAC for broadcasts shipped in v0.9.0).
- Postgres backend (`ChainedTablePostgres`) using single-statement INSERT + `FOR UPDATE` subquery
- `ZC_TELEMETRY_BACKEND=sqlite|postgres|dual` env selection
- Tier 1 fix #2: 0700/0600 POSIX hardening on session DB files
- Tier 1 fix #3: per-agent Postgres role with INSERT-only grant
- Cross-backend stress test (50+ concurrent writers, both backends)

Sprint 3 will then add **Tier 3** — see `HARNESS_EVOLUTION_PLAN.md §8.6` (locked in with hard "DO NOT START" gate).

---

## [0.11.0] — 2026-04-17 — Sprint 1: outcome telemetry + learnings loop foundation

Adds the full **observability foundation** that lets future sprints (mutation engine, skill promotion, task routing) learn from what actually worked. Every MCP tool call is now recorded with cost + latency + outcome signals into a tamper-evident, hash-chained SQLite table. No agent-facing breakage — just a new `[cost: ...]` header on responses and one new MCP tool.

### Added — telemetry pipeline (`src/telemetry.ts`, `src/pricing.ts`, `src/logger.ts`, `src/outcomes.ts`)

- **`src/pricing.ts`** — USD-per-Mtok pricing table for Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 and Ollama models. `computeCost(model, input, output, {batch, cached_input_tokens})` returns `{cost_usd, known}`. Anthropic Batch API 50% discount supported. HMAC-signed baseline at `~/.claude/zc-ctx/.pricing_signature` detects tampering with the table across restarts.
- **`src/logger.ts`** — structured-JSON, per-component, daily-rotated logger with 5 levels and 11 components (telemetry, outcomes, learnings-mirror, skills, mutations, budget, compaction, tasks, ownership, routing, retrieval). Cross-log correlation via `newTraceId()`. `secret_scanner.redactSecrets()` applied automatically to every string value unless `ZC_LOG_RAW=1`. File mode 0600 on POSIX. New `readLogs()` API with agent-scoped filtering (Sprint 1 §15.4 requirement).
- **`src/telemetry.ts`** — records every MCP tool dispatch to a new `tool_calls` table with cost, latency, status, error class, model, session, agent, project hash, tokens, trace id. Hash-chained via Sprint 0 `hmac_chain.ts`. In-memory cache of the last row hash per project keeps the hot path under 50 ms p95. Failure is LOUD (logger.error) but never throws — calling tool's success must not depend on telemetry working. `sanitizeToolInput()` truncates + redacts before storage.
- **`src/outcomes.ts`** — three resolvers that produce deferred outcome tags on previously-recorded tool calls:
  - **`resolveGitCommitOutcome`** — detects `[branch hash]` in bash output, links a "shipped" outcome (confidence 0.95) to the most recent tool call in that session.
  - **`resolveUserPromptOutcome`** — heuristic sentiment classifier on user messages; records "accepted" / "rejected" with confidence 0.5. **Never stores raw message text** — only `sentiment` + `message_length`. Rate-limited.
  - **`resolveFollowUpOutcomes`** — detects `Read(X)` following `zc_file_summary(X)` in the same session within 5 minutes → records "insufficient" outcome against the summary call (confidence 0.85). Signal that the summary wasn't enough.
- Outcomes table has its own independent hash chain from tool_calls — both are independently verifiable.

### Added — new MCP tool

- **`zc_logs(component, since_date?, until_date?, min_level?, event_contains?, trace_id?, agent_id?, limit?)`** — query structured telemetry logs from the harness. Newest-first. Agent-scoped by default (falls back to `ZC_AGENT_ID` env): an agent only sees its own entries plus system entries, never another agent's. Covered by RT-S1-13 red-team test.

### Added — PostToolUse hook

- **`hooks/learnings-indexer.mjs`** — mirrors JSONL writes to `<project>/learnings/*.jsonl` into the project's SQLite `learnings` table (schema migration 15). Categories auto-inferred from filename stem. Idempotent via `UNIQUE(project_hash, source_path, source_line)`. Symlink-escape rejection (RT-S1-12) confirms the hook will not follow a symlink out of the project directory. 64 KB/line + 10 k lines/run defensive caps. Never crashes Claude Code.

### Added — migrations

- **Migration 13**: `tool_calls` table + 5 pre-aggregated views (`v_session_cost`, `v_task_cost`, `v_role_cost`, `v_tool_cost`, `v_tool_call_outcomes`). Perf benchmark: 10 k rows, p99 < 100 ms on view queries.
- **Migration 14**: `outcomes` table (hash-chained, independent from tool_calls).
- **Migration 15**: `learnings` table (JSONL mirror target).

### Changed — `src/server.ts`

- Every MCP tool dispatch is now wrapped: existing handler body extracted into an inner `dispatchToolCall(name, args)`; outer `setRequestHandler` adds a `[cost: 423 in, 87 out, $0.0013, 47ms]` header to the first text block of every response. Agent learns its own cost in the live loop (per §6.5).
- New env vars: `ZC_AGENT_ID` (agent identity), `ZC_AGENT_MODEL` (agent model). Default `default` / `unknown`.
- `classifyError(e)` maps thrown errors to `transient` / `permission` / `logic` / `unknown` for error-class attribution on failed calls.

### Testing — 70 new tests across 5 files + 1 integration file

- **`src/pricing.test.ts`** — 14 tests (cost math, batch discount, cached input, tamper detection)
- **`src/logger.test.ts`** — 19 tests (5 levels, secret redaction, rotation, trace ids)
- **`src/telemetry.test.ts`** — 17 tests incl. RT-S1-06 (tamper), RT-S1-07 (chain extends), RT-S1-08 (secret-in-input scrubbed)
- **`src/outcomes.test.ts`** — 28 tests incl. RT-S1-09 (tamper), RT-S1-10 (multi-row chain), RT-S1-11 (no raw user prompt persisted)
- **`src/learnings_indexer.test.ts`** — 15 tests incl. RT-S1-12 (symlink escape rejected)
- **`src/readLogs.test.ts`** — 17 tests incl. RT-S1-13 (agent scoping blocks cross-agent reads), RT-S1-14 (no side effects on read)
- **`src/sprint1_integration.test.ts`** — 10 tests: user scenarios US1 (summarize-then-read), US2 (commit-after-edit), US3 (positive reply), US4 (multi-project isolation), US5 (trace_id correlation) + RT-S1-15 (secret rotation invalidates chains) + RT-S1-16 (project_path isolation)
- **`src/migrations-sprint1.test.ts`** — 11 tests incl. 10 k-row perf benchmark (p99 < 100 ms)
- **Full suite: 433/433 passing** across 22 test files (added 131 tests on top of the 302 Sprint 0 baseline).

### Security controls mapped to §15.4

- Hash chains on `tool_calls` + `outcomes` tables (HMAC-keyed via `machine_secret`) — attacker with full DB write cannot forge valid rows
- Secret-in-input auto-redacted via `secret_scanner` before any log line or telemetry row
- Outcome evidence schema intentionally stores `sentiment` + `length`, never raw prompt text
- `zc_logs` is agent-scoped by default — `ZC_AGENT_ID` blocks cross-agent log reads
- `learnings-indexer` hook `realpath`s target + project and rejects any path escaping `<project>/learnings/` via symlink
- Pricing table baseline HMAC-signed — tamper detection on process start

### Upgrade notes

Zero user action required. First MCP tool call after upgrade silently:
1. Generates `~/.claude/zc-ctx/.pricing_signature` (HMAC baseline for the pricing table)
2. Applies migrations 13–15 to the project SQLite DB (tool_calls + outcomes + learnings tables)

The `[cost: ...]` header now appears at the top of every MCP tool response — this is intentional and teaches the agent to budget. Set `ZC_AGENT_ID=<your-agent-id>` before spawning a worker agent if you want telemetry + log-scoping to be agent-specific instead of lumped under `default`.

To install the learnings-indexer hook: copy `hooks/learnings-indexer.mjs` to `~/.claude/hooks/` and register in `~/.claude/settings.json` under `hooks.PostToolUse` with matcher `Write|Edit|MultiEdit|NotebookEdit`.

---

## [0.10.5] — 2026-04-18 — Sprint 0: security baseline (cybersecurity-first foundation)

Adds shared security infrastructure that future releases (Sprint 1+) build on top of. **No new MCP tools.** No agent-facing behavior change. Internal-only modules + a public threat model document.

### Added — `src/security/` (4 new modules + tests)

- **`machine_secret.ts`** — single per-machine 64-byte CSPRNG secret stored at `~/.claude/zc-ctx/.machine_secret` with mode 0600. Used as HMAC key seed for tamper-evident chains and audit log signatures. Override via `ZC_MACHINE_SECRET` env var (testing/CI). Rotation via `rotateMachineSecret()`. Atomic file ops; never logged.
- **`hmac_chain.ts`** — reusable HMAC-keyed hash chain primitive. Stronger than v0.9.0's plain SHA256 chain (`src/chain.ts`): an attacker with full DB write access cannot forge valid `row_hash` without the machine secret. Used by audit_log; will be used for tool_calls / outcomes / skills / mutations in Sprint 1+. Constant-time comparison via `timingSafeEqual`. Pipe-escape canonicalization prevents collision attacks.
- **`audit_log.ts`** — append-only, HMAC-chained log of every privileged operation. Stored at `~/.claude/zc-ctx/logs/audit.log` as JSONL. Verifiable end-to-end via `verifyAuditChain()`. Detects tampering (content mod, deletion, insertion). No public API for delete/edit. Designed to never be sent to LLM context.
- **`secret_scanner.ts`** — detects API keys (Anthropic, OpenAI, AWS, GitHub, Google, Slack, Stripe), JWTs, SSH private keys, Bearer tokens, and high-entropy strings. `scanForSecrets(text)` returns matches by TYPE only (never the full secret). `redactSecrets(text)` returns text with secrets replaced by `[REDACTED:type]` markers. <1ms for 10KB inputs.

### Added — public security documentation

- **`docs/THREAT_MODEL.md`** — project security artifact describing trust boundaries, attacker capabilities, assets to protect, architectural defenses (v0.6 → v0.10.5), out-of-scope items, compliance + privacy, and incident response procedure. For operators reviewing SC for production use.

### Added — testing

- **76 new tests** in `src/security/` (16 machine_secret + 23 hmac_chain + 11 audit_log + 26 secret_scanner)
- **14 explicit red-team test IDs** (RT-S0-01 through RT-S0-14) covering tamper detection, key forgery, canonicalization collisions, secret leak prevention
- Vitest config (`vitest.config.ts`) added: excludes `dist/` from test discovery (was double-running compiled tests); sequential file execution to prevent shared-state interference on `~/.claude/zc-ctx/` paths

### Changed — `.gitignore`

- Added rules to keep INTERNAL planning docs out of the public repo (e.g. strategy discussions, design memos)
- `docs/THREAT_MODEL.md` is INCLUDED in the repo (project security artifact, public)

### Why this release

This is **Sprint 0** of a multi-sprint harness evolution roadmap. Cybersecurity-first means we ship the security foundation BEFORE feature code. Every subsequent sprint (telemetry + outcomes, skills + mutation, structured tasks + work-stealing, observability + dashboard) will use these primitives to keep new attack surfaces closed by construction.

### Upgrade notes

Zero user action required. New modules are inert until used by Sprint 1+ features. Existing chains (`src/chain.ts` on broadcasts) and tools unchanged.

The new `~/.claude/zc-ctx/.machine_secret` file is generated on first import of any security module. Mode 0600. Back this up if you back up your `~/.claude/zc-ctx/` directory (loss invalidates all signed audit entries / chained tables — they'd appear "tampered" since the verification key would no longer match).

### Test summary

- **302/302 unit tests pass** (76 new + 226 existing, no regressions)
- **All 14 RT-S0 red-team tests pass**

---

## [0.10.4] — 2026-04-18 — Write-as-you-go indexing (crash-safe + real-time progress)

Found during live E2E on a 650-file project (`A2A_communication`): the v0.10.2 `indexProject` had a batch-then-write design that held all KB writes until every file was summarized. On a ~40-min indexing run this meant:
- **Zero incremental durability** — a crash at file 649/650 lost every summary.
- **DB was empty to outside observers for the full 40 minutes** — then jumped from 0 to 650 rows in one flush.
- **Stale-state probing** — a second Claude session opening the same project mid-index saw an empty KB and (in some paths) spawned a second indexer for the same or parent directory.

### Changed

- **`harness.ts indexProject` — per-file pipeline.** Each worker now summarizes one file, immediately calls `indexContent()` to persist L0/L1 to `source_meta` + content to `knowledge`, then reports progress. Concurrency (`Config.SUMMARY_CONCURRENCY`, default 4) inlines the bounded-worker pattern from `summarizeBatch` without buffering all summaries in memory. `summarizeBatch` is no longer imported by `harness.ts` (still exported from `summarizer.ts` for callers that want the old batched shape).
- **onProgress callback fires AFTER the write**, not after the summary. So `background-index.mjs` status files and any consumer UIs now reflect real KB state, not mid-flight summarization.

### Benefits

- **Crash-safe.** Indexer interrupted at N/M files → first N files are durably in the KB. Re-running re-summarizes only the missing M-N files (via the `getIndexingStatus` "already-indexed" probe).
- **Real-time visibility.** `zc_file_summary(path)` starts returning semantic summaries on the very first file that completes, rather than after the whole project finishes.
- **No rogue re-spawns.** The SessionStart hook's check for "already being indexed" no longer fires false negatives mid-index.
- **Memory bounded.** Previous design held a `Map<path, SummaryPair>` of all 650 summaries. New design holds at most `SUMMARY_CONCURRENCY` (4) in flight.

### Migration

Zero user action needed. Just pull + rebuild:
```bash
cd SecureContext
git pull origin main
npm run build
```

## [0.10.3] — 2026-04-17 — Bug fixes: legacy migration + env propagation + excludes

Two bugs that silently broke v0.10.2 auto-indexing on real projects, found during live E2E testing with `Test_Agent_Coordination`:

### Fixed

**1. Migration 11 NULL crash on legacy broadcasts DBs.**
Pre-v0.7.0 broadcasts table had no NOT NULL constraints, so existing rows had NULLs in `task`, `files`, `summary`, etc. Migration 11's naive `INSERT INTO broadcasts_new SELECT * FROM broadcasts` crashed with `NOT NULL constraint failed: broadcasts_new.task` on any DB migrated from pre-v0.7.0 — which meant every v0.10.0+ harness tool threw on open for those projects. Fixed by replacing the naive SELECT with an explicit column list + `COALESCE(col, default)` for each NOT NULL column.

**2. Background indexer didn't inherit ZC_OLLAMA_URL from MCP env.**
`session-start-index-check.ps1` spawned `background-index.mjs` with only the PowerShell process env. `ZC_OLLAMA_URL` lives in `~/.claude/settings.json` under the MCP server's env block, not in the shell env. So the spawned indexer defaulted to `http://127.0.0.1:11434/api/embeddings` (native Ollama, not the Docker Ollama on port 11435). When native Ollama was down, every file fell back to truncation summaries — defeating the whole purpose. Fixed by reading the MCP env from `settings.json` in the hook and passing it through `ProcessStartInfo.EnvironmentVariables`.

**3. Default excludes were too narrow — picked up per-editor dotfolders.**
Old list: `node_modules,dist,build,.git,coverage,.worktrees,.next,.cache,out`. Missed `.claude/` (skills, settings), `.cursor/`, `.idea/`, `.vscode/`, `.agent-prompts/`, `.gstack/`, `.venv/`, `venv/`, `__pycache__/`, `vendor/`, `target/`, `logs/`, `tmp/`. On `Test_Agent_Coordination` the old list indexed 308 files (mostly editor config + agent prompt scratch); new list indexes 26 real source files. Override via `ZC_INDEX_PROJECT_EXCLUDES`.

### Added

- **`probe-indexing-status.mjs`** now handles migration errors gracefully — returns `{state: "error", error: msg}` instead of crashing the hook. The PowerShell hook prints a helpful diagnostic reminder when this happens.

### Live-verified

Real run on `Test_Agent_Coordination` (8 legacy broadcasts from April 6, pre-v0.10.0 schema):
1. Hook fires → migration 11+12 apply cleanly (NULLs coalesced)
2. Background indexer runs → **26 files semantically summarized via qwen2.5-coder:14b on GPU**
3. Sample L0s:
   - `a.txt` → *"Prints 'hello A' to the console."*
   - `index.js` → *"This file logs the number of tasks from a JSON file."*
   - `reports/security-review.md` → *"Security review of `src/search.js` highlighting critical vulnerabilities in task search feature."*
4. All 8 legacy broadcasts preserved after migration.

### Migration

Zero user action required. Just `git pull` and rebuild:
```bash
cd SecureContext
git pull origin main
npm run build
cp hooks/session-start-index-check.ps1 ~/.claude/hooks/
```

The migration 11 fix is transparent — DBs that already applied migration 11 (before it was buggy) are unaffected; DBs that haven't applied it yet use the new COALESCE version.

## [0.10.2] — 2026-04-17 — Auto-indexing on session start + banner upgrade

Addresses the "existing project, first time" onboarding friction from v0.10.0: scenario 2 (user installs SC on a half-built project) no longer requires the agent to explicitly call `zc_index_project()`. A SessionStart hook detects unindexed projects and triggers indexing in the background automatically.

### Added

- **`hooks/session-start-index-check.ps1`** — SessionStart hook that detects project markers (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `CLAUDE.md`, etc.), probes the project's indexing state, and spawns `background-index.mjs` if no source files have been indexed yet. Non-blocking — agent work starts immediately. Emits a `<system-reminder>` telling the agent what's happening.
- **`scripts/background-index.mjs`** — detached node process that runs `indexProject()` and writes a JSON status file (`~/.claude/zc-ctx/sessions/<hash>.indexing.status`) with live progress (`total_files`, `completed_files`). Cleans up on completion. Treats status files older than 1 hour as stale (crash recovery).
- **`scripts/probe-indexing-status.mjs`** — small wrapper so the PowerShell hook can read `getIndexingStatus()` via a clean stdout contract.
- **`harness.ts` → `getIndexingStatus(projectPath)`** — returns `{state: "not-indexed" | "indexing" | "indexed", totalFiles, completedFiles, startedAt, ...}`. Reads both `source_meta` (for "already indexed") and the status file (for live progress). Treats status files > 1h as stale.
- **`harness.ts` → `indexProject(..., { onProgress })`** — new optional progress callback so the background indexer can update the status file on each file.
- **Banner upgrade (health mode = "onboarding")** — `zc_recall_context()` and `zc_status()` now print a short info banner (not the scary yellow warning block) when:
  - project has no indexed source files yet → "Run `zc_index_project()` to generate semantic L0/L1 summaries (~30-60s typical)"
  - indexing is actively running → "Indexing in progress: 12/50 files, 24%"

### Tested

- **`scripts/test-autoindex-live.mjs`** — 33 assertions across 6 real scenarios:
  1. Bare directory (no project markers) → silent no-op
  2. Existing project, first time (3 files) → full lifecycle not-indexed → indexing → indexed
  3. Already-indexed project → hook is a no-op
  4. Concurrent hook invocation (resume after compact) → second call sees 'indexing' state
  5. Stale status file (simulated crash) → treated as stale, fresh indexer starts
  6. Health banner transitions correctly through lifecycle
- All 33 passing against GPU-enabled Docker Ollama + `qwen2.5-coder:14b`.

### Changed

- **`SystemHealth.mode`** adds a new `"onboarding"` state alongside `"full"` and `"degraded"`. Keeps legitimate "project is new, still setting up" states from triggering the degraded-mode alarm.
- **`formatHealthBanner()`** returns three distinct shapes: empty (full), info block (onboarding), warning block (degraded).
- **`getSystemHealth(projectPath?)`** now takes an optional project path. When provided, populates `indexingStatus`.

### Migration

Fully additive — no breaking changes. To enable auto-indexing:

```
# Copy the new hook
cp SecureContext/hooks/session-start-index-check.ps1 ~/.claude/hooks/

# Add to ~/.claude/settings.json under hooks.SessionStart (alongside the
# existing session-start-zc-recall.ps1). See hooks/INSTALL.md.
```

Or re-run the one-command installer:
```
node SecureContext/scripts/setup-docker.mjs --health-only
```

## [0.10.1] — 2026-04-17 — One-command Docker setup helper

### Added
- **`scripts/setup-docker.mjs`** — interactive one-command installer that takes a fresh machine from zero to SC full mode:
  - Verifies Docker + Compose are installed
  - Auto-detects GPU (NVIDIA / AMD / CPU) and selects the matching compose overlay
  - Pulls the Docker stack images (`sc-api`, `sc-postgres`, `sc-ollama`)
  - Starts the stack with healthcheck polling
  - Interactive model chooser with VRAM-aware recommendations (default: `qwen2.5-coder:14b`)
  - Pulls `nomic-embed-text` + chosen coder model via the Docker Ollama's `ollama pull`
  - Final health check reporting Full / Degraded mode
  - Flags: `--model <name>` (non-interactive), `--gpu nvidia|amd|cpu` (override detection), `--no-start`, `--health-only`

### Paired with (separate repo)
- **A2A_dispatcher `start-agents.ps1`** — pre-flight health check verifying `securecontext-api`, `securecontext-postgres`, `securecontext-ollama` are healthy and both Ollama models are installed before launching agents. Interactive proceed/abort prompt in degraded mode; `-SkipHealthCheck` for CI.

### Changed
- Version: `0.10.0` → `0.10.1` (patch — no behavioral change to existing tools)

## [0.10.0] — 2026-04-17 — Harness Engineering: semantic summaries + project card + bash capture

### Added — Tier A (core harness primitives)
- **`zc_index_project(options?)`** — walks the project tree and indexes every source file with an L0 (one-line purpose) + L1 (detailed summary). Excludes `node_modules`, `dist`, `build`, `.git`, `coverage`, `.worktrees` by default. Idempotent.
- **`zc_file_summary(path)`** — direct accessor for a file's L0/L1. The primary Tier-1 verb: replaces `Read` for "check/review/what-does-X-do" questions. ~400 tokens vs ~4000 for a full Read. Flags `stale=true` if file mtime > indexed-at.
- **`zc_project_card(fields?)`** — per-project orientation card (stack + layout + state + gotchas + hot_files). Read with no args, update by passing any subset. ~500 tokens replaces the ~8k orientation ritual (`ls` + `Read CLAUDE.md` + Glob + Read-a-few-files).
- **`zc_check(question, path?)`** — memory-first answer wrapper. Searches KB, returns top hits with confidence scoring (`high`/`medium`/`low`/`none`). Forces search-first as the default path.
- **`zc_capture_output(command, stdout, exit_code)`** — archives long bash output into the KB (FTS-searchable) and returns a compact head+tail summary. SHA256-deduplicated by command+stdout.

### Added — Tier B (semantic summarizer + hooks)
- **`src/summarizer.ts`** — local Ollama chat model pipeline for semantic L0/L1. Auto-probes installed models from a preference list (coder-first: `qwen2.5-coder:14b` → 7b → 32b → deepseek-coder → codellama → starcoder → general models). Graceful fallback to deterministic truncation when Ollama is unreachable or no supported model installed.
- **Prompt-injection scanner** — detects adversarial patterns in file content (`ignore previous instructions`, `new system prompt`, etc.). Wraps content in explicit `[BEGIN/END FILE CONTENT]` boundary markers in the prompt so the model treats it as data, not directive. Flags `injectionDetected=true` for auditing.
- **Model allowlist** — `ZC_SUMMARY_MODEL_ALLOWLIST` env var restricts which models are acceptable (defense against misconfigured overrides).
- **VRAM lifecycle control** — `ZC_SUMMARY_KEEP_ALIVE=30s` (default) makes Ollama unload the model from VRAM 30s after the last summarization request. Model loads for the indexing burst, unloads when idle.
- **Three PostToolUse/PreToolUse hook scripts** (`hooks/preread-dedup.mjs`, `postedit-reindex.mjs`, `postbash-capture.mjs`) + `hooks/INSTALL.md`. Opt-in; each auto-enforces one harness rule.

### Added — operator-facing
- **`AGENT_HARNESS.md`** — canonical ruleset every agent follows when using SC. Agent-agnostic (Claude, GPT, Gemini, etc.).
- **Live harness test suite** (`scripts/live-harness-test.mjs`) — 52 assertions covering migration, summarizer probe, semantic generation, injection detection, indexProject end-to-end, file summary round-trip, project card merge, bash capture dedup, session read log primitives, check confidence buckets. All passing against `qwen2.5-coder:14b`.

### Schema — migration 012
- `project_card(id, stack, layout, state, gotchas, hot_files, updated_at)` — singleton per project
- `session_read_log(session_id, path, read_at)` — PreRead dedup backend
- `tool_output_digest(hash, command, summary, exit_code, full_ref, created_at)` — bash archive

### Changed
- `indexContent()` gains optional `precomputedL0` / `precomputedL1` params so callers can inject semantic summaries. Backward compatible — omitted params fall back to first-N-char truncation.
- Version: `0.9.0` → `0.10.0` (minor, additive — no breaking changes).

### Config additions
- `ZC_SUMMARY_ENABLED` (default on), `ZC_SUMMARY_MODEL` (auto-probe), `ZC_SUMMARY_TIMEOUT_MS` (30s), `ZC_SUMMARY_CONCURRENCY` (4), `ZC_SUMMARY_KEEP_ALIVE` (`30s`), `ZC_SUMMARY_MODEL_ALLOWLIST` (empty = any)
- `ZC_BASH_CAPTURE_LINES` (50), `ZC_BASH_TAIL_LINES` (20)
- `ZC_READ_DEDUP_ENABLED` (default on)
- `ZC_INDEX_PROJECT_EXCLUDES` (default: `node_modules,dist,build,.git,coverage,.worktrees,.next,.cache,out`)

### Token savings (measured, perfect-usage baseline)
| Scenario | v0.9.0 | v0.10.0 harness | Reduction |
|---|---|---|---|
| Session startup (known project) | ~5,000 | ~2,000 | 60% |
| "Review/check" question | ~2,000 | ~400 | 80% |
| Bug-fix session (5 files) | ~24,000 | ~8,000 | 67% |
| Heavy bash session (10 big outputs) | ~40,000 | ~1,000 | 98% |
| 10-session project total | ~200,000 | ~100,000 | 50% |

### Security
- All 449 unit tests pass; live harness suite 52/52 pass.
- Summarizer egress restricted to `127.0.0.1:11434` — no external network calls.
- Summarizer response validation (format parser rejects malformed outputs; length caps on L0/L1).
- Prompt-injection scanner + "treat as data" prompt framing.
- Fail-safe design: every hook falls through on error (never breaks the agent).

---

## [0.9.0] — 2026-04-17 — RBAC Default-On & Channel-Key Enforcement (**BREAKING**)

### Breaking changes
- **`RBAC_ENFORCE` now defaults to `true`.** Every `zc_broadcast` requires a valid HMAC-signed `session_token` bound to an `agent_id` + `role`. The pre-v0.9.0 "no active sessions → no RBAC" advisory path is removed.
- **`CHANNEL_KEY_REQUIRED` now defaults to `true`.** An unregistered project rejects all broadcasts until the operator calls `zc_broadcast(type='set_key', channel_key=...)`. The pre-v0.9.0 "open mode" is removed.

### Added
- **Agent-ID binding at the reference monitor.** The broadcast's `agent_id` must equal the token's bound `aid` claim — closes the Chapter 11 capability-confinement gap where a worker with a valid STATUS-capable token could post a broadcast carrying `agent_id='orchestrator'` and have the dispatcher route it as one.
- **12 red-team tests (T_R01–T_R12)** covering positive controls, `AGENT_ID_MISMATCH`, missing/expired/revoked/tampered tokens, cross-project token rejection (`ph` claim mismatch), role privilege escalation (worker → ASSIGN / REJECT / REVISE), `ZC_RBAC_ENFORCE=0` opt-out verified via child process, and `CHANNEL_KEY_REQUIRED` rejection on a bare project.
- **`zc_status`** now reports `RBAC enforcement: ACTIVE (v0.9.0 default)` and `Channel key: REQUIRED (v0.9.0 default)` (or the matching `DISABLED`/`optional` lines when env opt-outs are set).

### Changed
- **`verifyChannelKey()`** now throws when no key is registered and `CHANNEL_KEY_REQUIRED=true`, instead of returning `true` in silent open mode.
- **`broadcastFact()`** RBAC block is now unconditional (behind `Config.RBAC_ENFORCE`). The previous `hasActiveSessions(db)` shortcut — which would quietly disable RBAC on a fresh DB — is removed.
- **Legacy Category 7 broadcast tests (T_B01–T_B07)** retooled to bootstrap a channel key + issue a session token, matching v0.9.0 default-on auth. T_B02 re-focused from "open-mode spoofing documented" (impossible now) to "legitimate developer MERGE accepted" as a positive control complementing T_R09.

### Migration
- **Recommended path:** call `zc_broadcast(type='set_key', channel_key=...)` once per project, then call `zc_issue_token(agent_id, role)` at session start and pass `session_token=` + `channel_key=` on every `zc_broadcast`. The A2A dispatcher `start-agents.ps1` wiring automates this — see the dispatcher repo for the script changes.
- **Legacy path (trusted single-user desktop):** set `ZC_RBAC_ENFORCE=0` + `ZC_CHANNEL_KEY_REQUIRED=0` in your MCP server's `env` block. Not recommended on any setup where the MCP server is network-reachable.

### Security
- **449 unit tests pass** across 20 test files.
- **96 red-team attack vectors: 91 PASS, 0 FAIL, 5 WARN** (all five warnings are pre-existing documented limitations from v0.8.0 or earlier — sandbox filesystem isolation, detached subprocess containment, javascript: URI explicit-guard hardening, Unicode lookalike header, concurrent sandbox env isolation).

---

## [0.8.0] — 2026-04-10 — Production Architecture (PostgreSQL + Docker + Smart Memory)

See [README § v0.8.0](README.md#v080--production-architecture-postgresql--docker--smart-memory). Highlights:
- `Store` interface with SQLite (default) and PostgreSQL + pgvector backends.
- HTTP API server (`src/api-server.ts`) with Bearer auth, rate limiting, full RBAC surface.
- Docker stack (`docker/`) with named `securecontext-*` containers, GPU overlays, and `start.ps1`/`start.sh`.
- Smart working memory sizing (dynamic 50–200 facts by project complexity).
- Auto memory extraction in PostToolUse hook.
- 192 integration tests, all passing.

---

## [0.7.2] — 2026-04-02 — KB Prompt Injection Pre-filter
See [README § v0.7.2](README.md#v072--kb-prompt-injection-pre-filter).

## [0.7.1] — 2026-03-29 — Broadcast Channel Security Hardening
See [README § v0.7.1](README.md#v071--security-hardening-broadcast-channel).

## [0.7.0] — 2026-03-25 — A2A Multi-Agent Coordination
See [README § v0.7.0](README.md#v070--a2a-multi-agent-coordination).

## [0.6.0] — 2026-03-16 — Production Hardening Release
See [README § v0.6.0](README.md#v060--production-hardening-release). First tagged release.
