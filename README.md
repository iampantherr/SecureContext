# SecureContext — Secure Multi-Agent Harness for Claude Code

> **Persistent memory, verifiable telemetry, and work-stealing coordination for multi-agent Claude Code sessions.**
> Built on the principle: *cybersecurity into the architecture, not bolted on.* HMAC-chained audit trail, per-agent cryptographic identity, Postgres Row-Level Security, atomic work distribution, closed learning loop. Zero cloud sync. MIT license.

[![Version](https://img.shields.io/badge/version-0.18.0-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-786%20passed-brightgreen)](src)
[![Security Tests](https://img.shields.io/badge/security%20red%20team-60%2B%20RT%20IDs-brightgreen)](security-tests)
[![CI](https://github.com/iampantherr/SecureContext/actions/workflows/ci.yml/badge.svg)](https://github.com/iampantherr/SecureContext/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)
[![SafeSkill 20/100](https://img.shields.io/badge/SafeSkill-20%2F100_Blocked-red)](https://safeskill.dev/scan/iampantherr-securecontext)

---

## What SecureContext Is Today

SecureContext started as a token-optimization memory plugin. Through 17 sprints of design + red-team verification it evolved into something larger:

**A hardened harness for running multi-agent Claude Code sessions** where multiple agents (Opus orchestrator + Sonnet worker pool) coordinate through a verifiable audit trail, share memory across sessions, distribute work atomically through a Postgres queue, and feed failures back into a learning corpus — all while staying within the Claude Code TUI (so Claude Pro auth keeps working — no API-key upgrade required).

Four pillars:

| Pillar | What it means |
|---|---|
| **Persistent memory** | Working memory facts, session summaries, KB search — survives Claude Code restarts. MemGPT-style importance scoring; hybrid BM25 + vector retrieval. |
| **Verifiable security** | HMAC hash chain over every tool call + outcome. Per-agent HKDF subkeys — agent A cryptographically cannot forge a row claiming to be agent B. Postgres RLS with per-query `SET LOCAL ROLE`. Credential-isolated sandbox for `zc_execute`. |
| **Multi-agent coordination** | Broadcast channel for ASSIGN / STATUS / MERGE. Postgres work-stealing queue (`FOR UPDATE SKIP LOCKED`) for atomic task distribution across worker pools. Dynamic role spawn via LAUNCH_ROLE. Dispatcher nudge + Stop-hook enforcement to prevent worker drift. |
| **Closed learning loop** | Per-tool-call telemetry with real cost accounting. Three outcome resolvers (git_commit, user_prompt sentiment, follow-up pattern). Outcomes auto-feed `learnings/failures.jsonl` + `learnings/experiments.jsonl` — no agent discipline required. |

---

## Headline Numbers

| Metric | Result |
|---|---|
| Token overhead per session (vs. native Claude re-paste) | **~87% lower** |
| Claude Opus cost per session (tool-call overhead only) | **~$0.16** vs. ~$2–5 native |
| Recall cache hit saves | **~800 tokens per call** (~$0.06 on Opus) |
| Unit + integration tests | **786 passing** |
| Red-team attack IDs verified | **60+ (RT-S0 through RT-S4)** |
| Hash-chain forgery resistance | Cryptographic (per-agent HKDF subkey) |
| Agents per role (work-stealing pool) | **1 to 20** (tested 50 × 100 no double-claim) |

---

## Key Capabilities

### 1. Persistent Memory That Survives Restarts

Claude's context window is lossy. When it compacts, architecture decisions, file locations, and task state vanish. SecureContext persists them.

- **Working memory**: `zc_remember("api_key_rotation_decided", "use KMS", importance=5)`. Bounded to 100–250 facts (auto-scales with project complexity). Lowest-importance facts evict to archival KB rather than disappearing.
- **Session summaries**: `zc_summarize_session()` archives a structured summary for 365 days. Retrievable via `zc_search(["prior session"])`.
- **Shared broadcast channel**: multi-agent A2A coordination (ASSIGN, STATUS, MERGE, DEPENDENCY, PROPOSED, REJECT, REVISE, LAUNCH_ROLE, RETIRE_ROLE).
- **Hybrid KB search**: FTS5 BM25 + Ollama vector reranking. Falls back cleanly to BM25-only if Ollama is unavailable.
- **Cross-project search**: `zc_search_global` federates across all local project KBs.

### 2. Security That Auditors Can Verify

- **HMAC-chained rows** on `tool_calls_pg` + `outcomes_pg`. Tampering with any row breaks the chain; `verifyChain()` detects it deterministically.
- **Per-agent HKDF subkeys**: each agent signs its rows with a key derived from the shared machine secret + agent_id. No other agent can produce a valid signature. **RT-S2-01 proves it with a live forgery attempt.**
- **Postgres RLS (T3.2)**: 4 policies on `outcomes_pg` for the classification tiers public/internal/confidential/restricted. `restricted` rows visible only to the writing agent via `current_setting('zc.current_agent', true)`.
- **Per-query `SET LOCAL ROLE` (T3.1)**: every write transaction switches to a per-agent Postgres role so a compromised agent can't escalate its database identity.
- **Credential-isolated sandbox** for `zc_execute`: PATH-only environment, 30s timeout, 512 KB output cap, no ANTHROPIC_API_KEY / AWS / GitHub tokens leak through.
- **Secret scanner** on 11 patterns + high-entropy detection, runs before any external send.
- **Audit log** — append-only HMAC-chained — survives even catastrophic context compaction.

### 3. Multi-Agent Coordination (Production-Grade)

Via the companion [A2A_dispatcher](https://github.com/iampantherr/A2A_dispatcher):

- **Worker pools with -WorkerCount N**: `start-agents.ps1 -Roles developer -WorkerCount 3` spawns `developer-1/2/3`, all sharing `role="developer"` and one work-stealing queue.
- **Atomic work distribution**: Postgres `FOR UPDATE SKIP LOCKED` guarantees each queued task is claimed exactly once. Unit-verified with 50 concurrent workers racing for 100 tasks (RT-S4-01 — zero double-claims).
- **File-ownership overlap guard**: `/api/v1/broadcast` rejects ASSIGN with HTTP 409 Conflict if `file_ownership_exclusive` overlaps an in-flight task's set. Two workers can never be given the same file.
- **Dynamic role spawn**: orchestrator broadcasts `LAUNCH_ROLE state=qa` → dispatcher spawns a QA agent mid-session. Matching `RETIRE_ROLE` cleans it up.
- **Dispatcher wake-nudge**: polls the queue every 15s; if a role has queued tasks and alive workers aren't claiming, sends them a direct "call zc_claim_task now" message.
- **Stop-hook enforcement**: blocks a worker from ending its session if the queue still has claimable tasks for its role (forces drain-before-summarize).
- **Role-tagged registration**: `agents.json._agent_roles` sidecar maps agent_id → role so the dispatcher can route by pool.

### 4. Honest Cost Accounting

Every MCP tool call produces a row with input_tokens, output_tokens, model, latency, status, and cost_usd. v0.17.2 corrections:

- **Tier 1** — `computeToolCallCost` prices from the LLM's perspective: tool call args at output rate (LLM generated), tool response at input rate (LLM ingests next turn). Naive accounting over-reported Opus recall cost by 5×.
- **Tier 2** — DB-assembly tools (`zc_recall_context`, `zc_file_summary`, `zc_project_card`, `zc_status`) show $0 cost so the orchestrator's delegate-vs-DIY decision isn't polluted by infra noise.
- **Opus orchestrator makes real cost trade-offs**: "should I read this file myself (Opus input rate) or delegate to a developer (Sonnet) via ASSIGN broadcast overhead?" With honest numbers, the trade is decidable.

### 5. Closed Learning Loop (v0.17.2 L4)

When `recordOutcome({outcomeKind: "rejected" | "failed" | "insufficient" | "errored" | "reverted"})` lands, it also atomically appends a structured JSON line to `<project>/learnings/failures.jsonl`. High-confidence `shipped` / `accepted` outcomes append to `experiments.jsonl`. No agent discipline required.

Future sessions surface those learnings via `zc_search(["past failures for X"])` — the loop is now structural, not behavioral.

### 6. Self-Improving Skills (v0.18.0 Sprint 2)

Skills are versioned, hash-protected markdown procedures that agents discover at session start and follow when doing work. They improve themselves over time:

- **Two-scope hierarchy**: per-project skills override global. Per-project optimizations don't pollute other projects.
- **Composite outcome scoring**: every skill execution records `accuracy + cost + speed` into `skill_runs`. Failure traces feed the mutator.
- **Pluggable mutators**: `local-mock` (free, deterministic), `realtime-sonnet` (Anthropic API direct), `batch-sonnet` (50% discount via Batch API). Allowlist-enforced via `ZC_MUTATOR_MODEL` env var (RT-S2-05).
- **Synthetic-fixture replay**: candidates are validated against hand-crafted fixtures before promotion. Pass/fail + accuracy gate prevents regressions.
- **Atomic promotion**: when a candidate beats parent by ≥10% AND meets acceptance criteria, parent is archived and new version is inserted in one transaction.
- **Cross-project promotion**: `findGlobalPromotionCandidates` walks `skill_runs_pg` to surface per-project versions consistently outperforming global. Operator approves before global publishes.
- **Audit trail**: every candidate (promoted or not) lands in `skill_mutations`. `body_hmac` verified at every load (RT-S2-08); `candidate_hmac` verified at every replay (RT-S2-09).
- **agentskills.io interop**: lossless export/import via the open standard.

7 new MCP tools: `zc_skill_list`, `zc_skill_show`, `zc_skill_score`, `zc_skill_run_replay`, `zc_skill_propose_mutation`, `zc_skill_export`, `zc_skill_import`. See [docs/SKILLS_WALKTHROUGH.md](docs/SKILLS_WALKTHROUGH.md) for the full lifecycle + cron setup + mutator selection.

### 7. Architectural Quality Gates

Three automated checks prevent whole classes of regression:

- **L1 — env-pinning linter** (`npm run check:env`): scans `src/` for `process.env.ZC_*` refs, asserts every CRITICAL var (like `ZC_AGENT_ID`) is explicitly pinned in the dispatcher's launcher templates. Would have caught the pre-v0.17.0 bug where every agent's MCP server inherited the last-written agent_id (breaking per-agent HKDF isolation). 14-case self-test.
- **L3 — no-floating-promises ESLint** (`npm run lint`): `@typescript-eslint/no-floating-promises` caught 3 real violations on install. Equivalent bug silently dropped 9 months of outcome writes when `outcomes.ts` became async in v0.12.0. 5-case regression self-test.
- **L4 — outcome auto-feedback** (see above): the learning loop itself is enforced in code, not by convention.

---

## Architecture at a Glance

```
                     ┌──────────────────┐
                     │ Claude Code TUI  │
                     │ (Opus + Sonnet)  │
                     └────────┬─────────┘
                              │ MCP (stdio)
               ┌──────────────┴──────────────┐
               │    SecureContext server     │
               │    (src/server.ts)          │
               └──┬──┬──┬──┬──────────────┬──┘
                  │  │  │  │              │
                  │  │  │  │              ▼
                  │  │  │  │       zc_execute (sandbox)
                  │  │  │  │       zc_fetch   (SSRF-guarded)
                  │  │  │  ▼
                  │  │  │  zc_enqueue_task / zc_claim_task (SKIP LOCKED)
                  │  │  ▼
                  │  │  zc_broadcast (HMAC-chained, ownership-guarded)
                  │  ▼
                  │  zc_recall_context (60s TTL cache; per-agent scoped)
                  ▼
                  zc_remember / zc_search (working memory + KB)

         All persisted to one of:
         • ~/.claude/zc-ctx/sessions/{projectHash}.db  (SQLite, local)
         • sc-postgres                                 (Docker, PG + pgvector)
```

Complete architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Harness usage rules: [AGENT_HARNESS.md](AGENT_HARNESS.md).

---

## MCP Tools (25)

### Memory + Retrieval (7)
| Tool | What it does |
|---|---|
| `zc_remember` | Store a fact with importance score (1–5) and optional agent namespace |
| `zc_forget` | Remove a fact |
| `zc_recall_context` | Restore working memory + broadcasts + session events (60s cache with change-detection) |
| `zc_summarize_session` | Archive session summary to 365-day KB |
| `zc_search` | Hybrid BM25 + vector search in current project |
| `zc_search_global` | Federated search across all local project KBs |
| `zc_status` | DB health + KB counts + working-memory fill + fetch budget |

### Indexing + Knowledge (5)
| Tool | What it does |
|---|---|
| `zc_index` | Manually index text into the KB |
| `zc_fetch` | Fetch a URL (SSRF-checked) → Markdown → indexed as `[EXTERNAL]` |
| `zc_index_project` | Bulk-index project tree with semantic L0/L1 via local Ollama |
| `zc_file_summary` | L0/L1 summary accessor (replaces Read for check/review questions) |
| `zc_project_card` | Per-project orientation card (stack, state, gotchas) — read or update |

### Execution + Analysis (5)
| Tool | What it does |
|---|---|
| `zc_execute` | Run Python/JS/Bash in credential-isolated sandbox |
| `zc_execute_file` | Analyse a specific file in sandbox (stdin-passed TARGET_FILE) |
| `zc_batch` | Run shell commands AND search KB in one parallel call |
| `zc_check` | Memory-first answer with confidence scoring (high/medium/low/none) |
| `zc_capture_output` | Archive long bash output to KB (auto-called by PostBash hook) |

### Multi-Agent Coordination (2)
| Tool | What it does |
|---|---|
| `zc_broadcast` | Post to A2A shared channel: ASSIGN/STATUS/MERGE/PROPOSED/DEPENDENCY/REJECT/REVISE/LAUNCH_ROLE/RETIRE_ROLE. File-ownership overlap guard at API layer. |
| `zc_explain` | Trace how a specific broadcast was routed / acknowledged |

### Work-Stealing Queue (6) — v0.17.0
| Tool | What it does |
|---|---|
| `zc_enqueue_task` | Orchestrator enqueues into `task_queue_pg` keyed by (project, role) |
| `zc_claim_task` | Worker atomically claims oldest queued task (FOR UPDATE SKIP LOCKED) |
| `zc_heartbeat_task` | Refresh claim (workers must call every 30s) |
| `zc_complete_task` | Mark claimed task done |
| `zc_fail_task` | Mark failed + bump retries counter |
| `zc_queue_stats` | Count by state {queued, claimed, done, failed} |

### Graph Analysis (3) — v0.13.0
| Tool | What it does |
|---|---|
| `zc_graph_query` / `zc_graph_path` / `zc_graph_neighbors` | Proxy to [graphify](https://github.com/safishamsi/graphify) subprocess |
| `zc_kb_cluster` | Louvain community detection over KB graph |
| `zc_kb_community_for` | Look up community of a specific KB source + community-mates |

### Cost Routing + Replay (2)
| Tool | What it does |
|---|---|
| `zc_choose_model` | Returns Haiku/Sonnet/Opus recommendation for a complexity (informational — orchestrator decides) |
| `zc_replay` / `zc_ack` | Replay un-acknowledged broadcasts / mark one as seen |

### RBAC (2)
| Tool | What it does |
|---|---|
| `zc_issue_token` | Short-lived HMAC-signed session token bound to (agent_id, role) |
| `zc_revoke_token` | Revoke all tokens for an agent |

### Observability (1)
| Tool | What it does |
|---|---|
| `zc_logs` | Query structured logs (per-component, agent-scoped, trace_id correlation) |

---

## Installation

### Docker Stack (recommended)

**Prerequisites**: Docker Desktop 4.x+, Node.js 22+.

```bash
git clone https://github.com/iampantherr/SecureContext
cd SecureContext
cp docker/.env.example docker/.env
# Edit docker/.env: set POSTGRES_PASSWORD + ZC_API_KEY (generate via crypto.randomBytes)
```

Start the stack:
```powershell
# Windows — auto-detects NVIDIA / AMD / CPU
.\docker\start.ps1
```
```bash
# Linux / macOS
./docker/start.sh
```

Three containers come up: `securecontext-postgres` (PG + pgvector), `securecontext-api` (HTTP API), `securecontext-ollama` (embeddings). All set to `restart: unless-stopped` — they come back on every boot.

Verify:
```bash
curl http://localhost:3099/health
# {"status":"ok","version":"0.18.0","store":"postgres","ollamaAvailable":true,"searchMode":"hybrid (BM25 + vector)"}
```

Register with Claude:
```bash
node install.mjs --remote http://localhost:3099 <your-ZC_API_KEY>
```
Restart Claude Code after running.

### Local SQLite (single-developer, no Docker)

**Prerequisites**: Node.js 22+ only. Clone repo, `npm install`, `npm run build`, then:

```bash
node install.mjs --local
```

Writes `~/.claude/settings.json`'s MCP `zc-ctx` entry pointing at `dist/server.js`. Data lives in `~/.claude/zc-ctx/sessions/{projectHash}.db`. No vector search (falls back to BM25) unless Ollama is installed locally at `http://127.0.0.1:11434`.

### Multi-Agent Harness

To run multi-agent sessions, also clone the companion dispatcher:
```bash
git clone https://github.com/iampantherr/A2A_dispatcher
cd A2A_dispatcher
# Launch 1 orchestrator (Opus) + 3 developers (Sonnet) sharing one queue:
powershell -File start-agents.ps1 -Project C:\path\to\your\project -Roles developer -WorkerCount 3
```

See A2A_dispatcher's README for LAUNCH_ROLE / RETIRE_ROLE / file ownership details.

---

## Quick Start

In a new Claude Code session on your project:

```
You: please restore context and tell me what we were working on

Claude:  (calls zc_recall_context)
         [restores ~50 working memory facts, recent session events, shared
          broadcast channel, and health banner — all in ~1500 tokens]
         
         Last session we were refactoring auth: decided to use HMAC signing
         via KDF-derived per-agent subkeys. The prototype is in src/security/
         hmac_chain.ts and 28/28 unit tests pass. Next step was wiring the
         per-query SET LOCAL ROLE for RLS...
```

Tell Claude to remember things as they happen:
```
You: we settled on using pgvector over pinecone because we need local-first

Claude: (calls zc_remember with importance=5)
```

End the session:
```
You: wrap up please

Claude: (calls zc_summarize_session)  
        [persists structured summary; next session's zc_recall_context will surface it]
```

---

## How It Compares

### vs. `claude-mem` (21k+ stars)

| Feature | claude-mem | SecureContext |
|---|---|---|
| Memory | AI-compressed summaries (lossy) | MemGPT importance-scored facts (structured, bounded) |
| Security | None documented | HMAC chain + per-agent HKDF + RLS + sandbox |
| Multi-agent | None | Work-stealing queue + dispatcher + broadcast channel |
| Telemetry | None | Per-call cost/latency/token rows |
| Learning loop | None | Outcome → failures.jsonl auto-feedback |
| Audit trail | None | HMAC-chained, tamper-detectable |

### vs. `context-mode` (the one SecureContext originally replaced)

| Concern | context-mode | SecureContext |
|---|---|---|
| Env leaks to sandbox | ❌ Full env inherited | ✅ PATH-only env |
| SSRF protection | ❌ | ✅ Multi-layer (protocol/DNS/redirect) |
| Prompt injection via KB | ❌ | ✅ Pre-filter + trust labels on external content |
| Self-modifiable hooks | ❌ | ✅ Hook paths + manifests verified |
| Multi-agent | ❌ | ✅ Full harness |

### vs. Claude's Native Context Management

| Concern | Native | SecureContext |
|---|---|---|
| Survives session restart | ❌ starts fresh | ✅ `zc_recall_context` restores |
| Handles 150k+ token context | Auto-compacts (lossy) | Bounded working memory + archival KB |
| Cost per session (overhead) | ~$2–5 | ~$0.16 (with recall cache) |
| Cross-session continuity | ❌ | ✅ summaries + facts persist |
| Pool parallelism | ❌ single-session | ✅ N workers via `-WorkerCount` |

---

## Cost Model

**Claude Sonnet 4.6 pricing**: $3/Mtok input, $15/Mtok output.  
**Claude Opus 4.7 pricing**: $15/Mtok input, $75/Mtok output.

Typical SecureContext-harness session with Opus orchestrator + Sonnet developers:

| Operation | Count | Cost |
|---|---:|---:|
| `zc_recall_context` on Opus (first call) | 1 | ~$0.012 |
| `zc_recall_context` on Opus (cache hit, 2nd+) | 2 | $0.00 |
| `zc_choose_model` on Opus | 1 | $0.004 |
| `zc_enqueue_task` × 4 on Opus | 4 | $0.024 |
| `zc_broadcast` ASSIGN × 4 on Opus | 4 | $0.016 |
| Developer work (Sonnet) | 6 | $0.014 |
| `zc_summarize_session` on Opus | 1 | $0.003 |
| **Total per user-task-cycle** | | **~$0.16** |

Same flow without the harness (native re-paste + cold retries): **$2–5 per cycle**. That's where the 87% token-savings claim comes from.

---

## Testing & Verification

```bash
npm test              # 645 unit + integration tests
npm run lint          # ESLint @typescript-eslint/no-floating-promises
npm run check:env     # L1 env-pinning linter — catches un-pinned critical vars
npm run check:env:test  # self-test of the env linter (14 cases)
npm run lint:test     # self-test of the floating-promises rule (5 cases)

node security-tests/run-all.mjs  # 60+ red-team attack IDs (RT-S0-* through RT-S4-*)
```

Red-team categories:
- Sandbox escape + credential isolation (RT-S0-*)
- SSRF + fetcher (RT-S1-*)
- SQLite / KB injection (RT-S1-12 symlink escape)
- Hook + prompt-injection-via-KB
- Chain tamper-detection (RT-S1-15/16)
- Per-agent HKDF forgery (RT-S2-01)
- Reference Monitor + token binding (RT-S2-02/03/04/05/06)
- Cross-agent RLS (RT-S3-05)
- Work-stealing queue correctness (RT-S4-01 — 50 workers × 100 tasks no double-claim)
- File-ownership overlap guard (RT-S4-05/06/07)

---

## Recent Changes

See [CHANGELOG.md](CHANGELOG.md) for the full history. Highlights from the last quarter:

- **[v0.18.0](CHANGELOG.md#0180)** (2026-04-29) — **Sprint 2 baseline**: skill mutation engine. Versioned hash-protected skills, synthetic-fixture replay harness, pluggable mutators (`local-mock`, `realtime-sonnet`, `batch-sonnet`), composite outcome scoring, atomic promotion, cross-project promotion candidates. 7 new MCP tools, 132 new tests, 786/786 passing. Postgres mirror for multi-machine consistency. agentskills.io interop.
- **[v0.17.2](CHANGELOG.md#0172)** (2026-04-20) — L1 env-pinning linter + L3 no-floating-promises ESLint + L4 outcome → failures.jsonl auto-feedback. Closes 3 architectural-bug classes pre-Sprint-2.
- **[v0.17.1](CHANGELOG.md#0171)** — Agent-idle fixes (claim-drain, Stop-hook queue-drain, dispatcher wake-nudge) + 60s recall cache + Tier 1+2 pricing correctness.
- **[v0.17.0](CHANGELOG.md#0170)** — Postgres work-stealing queue (`FOR UPDATE SKIP LOCKED`) + complexity-based model router + file-ownership overlap guard + `-WorkerCount N` multi-worker pools.
- **[v0.16.0](CHANGELOG.md#0160)** — Postgres backend for telemetry + outcomes + learnings; Tier 3 security (per-query `SET LOCAL ROLE` + Row-Level Security).
- **[v0.15.0](CHANGELOG.md#0150)** — Structured ASSIGN schema (`file_ownership_exclusive`, `complexity_estimate`, `acceptance_criteria`, etc.) + MAC classification on outcomes.
- **[v0.14.0](CHANGELOG.md#0140)** — Provenance tagging (EXTRACTED / INFERRED / AMBIGUOUS / UNKNOWN) + AST code extractor + Louvain community detection.
- **[v0.13.0](CHANGELOG.md#0130)** — graphify integration (zc_graph_query / path / neighbors) + auto-indexed graph reports.
- **[v0.12.0](CHANGELOG.md#0120)** — ChainedTable abstraction + per-agent HKDF subkey (Tier 1 security fix).
- **[v0.11.0](CHANGELOG.md#0110)** — Telemetry foundation (tool_calls hash chain + outcomes pipeline + learnings mirror).

For v0.6–v0.10 history see [CHANGELOG.md](CHANGELOG.md).

---

## Contributing

Issues and PRs welcome. Before opening a PR:

```bash
npm run build
npm test                  # must be 786/786 (or updated)
npm run lint              # 0 errors
npm run check:env         # 0 unclassified
node security-tests/run-all.mjs  # all red-team IDs pass
```

Architectural decisions are recorded in `C:\Users\Amit\AI_projects\.harness-planning\ARCHITECTURAL_LESSONS.md` (local-only — not in the repo to keep internal strategy out of public history). Consult before proposing changes that touch the security foundation, telemetry pipeline, or work-stealing queue.

---

## License

MIT — see [LICENSE](LICENSE). Built for self-hostable, auditable agent infrastructure. No telemetry-back-to-vendor. No cloud dependencies beyond what you configure yourself.

---

**Companion project**: [A2A_dispatcher](https://github.com/iampantherr/A2A_dispatcher) — multi-agent orchestration layer that spawns / routes / retires worker pools against this harness.
