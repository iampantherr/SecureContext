# Changelog

All notable changes to SecureContext. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For full release notes including the v0.2.0–v0.8.0 history, see the **[Changelog section in README.md](README.md#changelog)**.

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
