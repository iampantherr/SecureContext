# Changelog

All notable changes to SecureContext. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For full release notes including the v0.2.0–v0.8.0 history, see the **[Changelog section in README.md](README.md#changelog)**.

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
