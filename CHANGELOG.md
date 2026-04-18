# Changelog

All notable changes to SecureContext. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For full release notes including the v0.2.0–v0.8.0 history, see the **[Changelog section in README.md](README.md#changelog)**.

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
