# SecureContext

> **SecureContext is the persistent memory, delivery, and security layer for Claude Code.** It gives coding agents project memory that survives every restart, a program/phase layer for delivering long-running projects with orchestrator handoff, a cryptographic audit trail for every tool call, and an HMAC-verified admission gate for Anthropic-style filesystem skills. Runs 100% locally on PostgreSQL + Ollama — no cloud sync, no subscription, MIT-licensed.

[![Version](https://img.shields.io/badge/version-0.50.1-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-959%20passed-brightgreen)](src)
[![Security Tests](https://img.shields.io/badge/security%20red%20team-60%2B%20RT%20IDs-brightgreen)](security-tests)
[![CI](https://github.com/iampantherr/SecureContext/actions/workflows/ci.yml/badge.svg)](https://github.com/iampantherr/SecureContext/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

---

## What is SecureContext?

If you use Claude Code on real projects, you have hit these walls:

1. **Every session starts cold.** You re-paste the same files, re-explain the same decisions, re-discover the same gotchas — and pay tokens for the same orientation work over and over.
2. **Long projects have no delivery state.** When an orchestrating agent dies mid-feature (crash, closed window, exhausted context), its replacement starts blind. People compensate with hand-written CHECKPOINT files.
3. **There is no record of what agents actually did.** When something goes wrong, Claude Code has no tamper-evident history of what ran.
4. **Skill scripts run with your permissions, unscanned.** Anyone (or any agent) with write access to `~/.claude/skills/` can plant code that runs on the next invocation.
5. **Parallel sessions step on each other.** Two windows claim the same task; one overwrites the other's edits.

SecureContext is an MCP plugin that closes all five. Install it once and your agents get:

- **Memory that survives restarts** — decisions, gotchas, and project state restored in one call; per-file semantic summaries answer "what does this file do" at 15–50× compression instead of raw reads; temporal search that knows *when* things happened and flags stale knowledge.
- **A delivery layer for long-running projects** — `zc_program` tracks multi-phase programs; closing a phase *requires* acceptance evidence and auto-generates a searchable checkpoint; a fresh orchestrator resumes a dead one's work from two calls.
- **A cryptographic audit trail** — every tool call and outcome signed into an HMAC chain with per-agent keys; any tampering breaks the chain visibly; session replay and compliance export come built in.
- **A skill admission gate** — AST scanning, HMAC verify-before-every-execution, automatic quarantine, and a chained admission log for Anthropic-style filesystem skills.
- **Multi-agent coordination primitives** — an atomic work-stealing task queue, typed broadcasts, per-agent identity, and hierarchy support for department-style agent teams.

Everything runs on your machine (PostgreSQL + Ollama via Docker, or a zero-infrastructure SQLite mode). It works offline and costs nothing when idle.

**When NOT to use it:** if you need a hosted memory API for an LLM product you ship to your own users, a managed service is a better fit — SecureContext is built for the agents working on *your* machine, not as a backend for your app.

---

## Quick start — one command

**Prerequisites:** [Node 20+](https://nodejs.org), [git](https://git-scm.com), and (recommended) [Docker Desktop](https://www.docker.com/products/docker-desktop/) running. Without Docker you still get a fully functional SQLite mode.

**Windows (PowerShell):**

```powershell
iwr -useb https://raw.githubusercontent.com/iampantherr/SecureContext/main/bootstrap.ps1 | iex
```

**macOS / Linux / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/iampantherr/SecureContext/main/bootstrap.sh | bash
```

That single command clones the repo to `~/SecureContext` and runs `init.mjs`, which does everything:

1. **Preflight** — checks Node and Docker; falls back to SQLite mode automatically if Docker is absent.
2. **Build** — `npm ci` + TypeScript compile.
3. **Docker stack** — generates secrets into `docker/.env`, starts PostgreSQL + Ollama + the API server (with NVIDIA GPU auto-detection for embeddings), waits for health, and pulls the embedding model.
4. **Registers the MCP plugin** with Claude Code (`~/.claude/settings.json`).
5. **Installs the harness hooks** — read-deduplication (token savings), auto-reindex after edits, long-bash-output capture.
6. **Verifies** — API health, audit-chain verification, config presence — and prints exactly what to do next.

The installer is idempotent: re-running it updates an existing install without clobbering your secrets or settings.

**Then:**

1. Restart Claude Code (the plugin loads at startup).
2. In any project, ask Claude to run `zc_status` — you should see the store, chain status, and skill counts.
3. Open the dashboard: `http://localhost:3099/dashboard`.

If you already cloned the repo, the same installer is just:

```bash
node init.mjs            # full Docker stack
node init.mjs --sqlite   # no Docker — local SQLite mode
node init.mjs --uninstall
```

---

## Setup in detail (manual path)

Use this if you prefer to run each step yourself, or the one-command path failed somewhere.

### 1. Clone and build

```bash
git clone https://github.com/iampantherr/SecureContext.git
cd SecureContext
npm ci
npm run build
```

### 2. Bring up the Docker stack

Create `docker/.env` with two secrets (any strong random strings):

```
POSTGRES_PASSWORD=<random>
ZC_API_KEY=<random>
```

Then:

```bash
docker compose -f docker/docker-compose.yml up -d --build
# NVIDIA GPU?  add: -f docker/docker-compose.nvidia.yml
curl http://localhost:3099/health          # → {"status":"ok","version":"0.46.1",...}
docker exec securecontext-ollama ollama pull nomic-embed-text
```

`docker/start.ps1` / `docker/start.sh` wrap this with GPU auto-detection and a `prod` mode (nginx reverse proxy).

### 3. Register the MCP plugin with Claude Code

```bash
node install.mjs --remote http://localhost:3099 <your ZC_API_KEY>
# or, SQLite mode (no Docker):
node install.mjs
```

This writes the `zc-ctx` entry into `~/.claude/settings.json` (and can also configure the Claude Desktop app with `--desktop`). See [docs/CLAUDE_CODE_SETUP.md](docs/CLAUDE_CODE_SETUP.md) for the manual config block.

### 4. Install the harness hooks

```bash
# copy the hook scripts
cp hooks/*.mjs ~/.claude/hooks/
```

Register in `~/.claude/settings.json` (full JSON in [hooks/INSTALL.md](hooks/INSTALL.md)):

| Hook | Event | What it does |
|---|---|---|
| `preread-dedup.mjs` | PreToolUse → Read | Redirects repeat file reads to compressed summaries — the main token saver |
| `postedit-reindex.mjs` | PostToolUse → Edit/Write | Refreshes a file's semantic summary after every edit |
| `postbash-capture.mjs` | PostToolUse → Bash | Archives long command output into the searchable KB |

### 5. Verify the install

```bash
curl http://localhost:3099/health
curl http://localhost:3099/api/v1/skills/admission-log/verify
# → {"ok":true,"total_rows":N,"broken_at":null,...}
```

Open `http://localhost:3099/dashboard` — you should see the green "CHAIN OK" banner.

### 6. Your first session

Start a Claude Code session in any project and work normally. Useful calls to know:

| You want to… | Call |
|---|---|
| Restore project memory at session start | `zc_recall_context({focus: "what you're about to do"})` |
| Get a 500-token project orientation | `zc_project_card()` |
| Persist a decision or gotcha | `zc_remember(key, value, importance)` |
| Ask what a file does (without reading it) | `zc_file_summary(path)` |
| Search project knowledge (temporal-aware) | `zc_search(["query"])` |
| Search *another* project's knowledge | `zc_search_global({queries, project: "Name"})` |
| Track a multi-phase delivery | `zc_program({action: "define" / "status" / "close_phase"})` |
| End-of-session persistence | `zc_summarize_session()` |

Per-project skills live under `<project>/.claude/skills/<name>/`; bind-mount the project into `sc-api` (see `docker/docker-compose.yml`) and set `ZC_PROJECT_SKILL_PATHS`, or call `POST /api/v1/skills/import-project?path=...`.

### Upgrading

```bash
cd ~/SecureContext && git pull && node init.mjs
```

Database migrations run automatically on boot; every feature ships with a kill-switch env var (documented in [CHANGELOG.md](CHANGELOG.md)) so you can disable anything that misbehaves without downgrading.

---

## Architecture in one diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Claude Code (your terminal)                     │
│                                                                      │
│   Reads SKILL.md natively from ~/.claude/skills/<name>/             │
│   Calls Bash to invoke bundled scripts under scripts/               │
└────────────────────────┬────────────────────────────────────────────┘
                         │ stdin (PreToolUse hook intercepts every Bash call)
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│   ~/.claude/hooks/skill-script-hmac-verify.mjs (PreToolUse hook)    │
│   ─ Regex-detects skill-script paths                                │
│   ─ Calls /api/v1/skills/<name>/verify-script (auth-exempt)         │
│   ─ Exit 2 + stderr if HMAC mismatch, quarantined, or no admission  │
└────────────────────────┬────────────────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│   sc-api (Node + Fastify, Docker)                                   │
│   ─ /api/v1/skills/*           — verify-script, admission-log,      │
│                                  marketplace pull, project import   │
│   ─ /api/v1/program            — delivery programs + checkpoints    │
│   ─ /dashboard/*               — HTMX panels                        │
│   ─ MCP tools                  — zc_remember / zc_search / etc.     │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────┐    ┌─────────────────────┐
│   PostgreSQL (sc-postgres)             │    │   Ollama (sc-ollama)│
│   ─ tool_calls_pg          (HMAC chain)│    │   ─ Local embeddings│
│   ─ outcomes_pg            (HMAC chain)│    │     for vector RAG  │
│   ─ skills_pg              (mirror)    │    └─────────────────────┘
│   ─ skill_admission_log_pg (HMAC chain)│
│   ─ programs_pg / program_phases_pg    │
│   ─ task_queue_pg          (work-steal)│
│   ─ broadcasts             (A2A)       │
│   ─ working_memory                     │
│   ─ knowledge_entries     (BM25 + vec) │
│   + RLS enforced per agent             │
└────────────────────────────────────────┘
                         ▲
                         │  (machine_secret in named volume — never leaves disk)
                         ▼
                ┌──────────────────┐
                │ Operator         │
                │ dashboard panels │
                │ (HTMX, no JS     │
                │  build needed)   │
                └──────────────────┘
```

The `machine_secret` is generated once on first boot, mode 0600, lives inside the container's `api_state` volume. All HMAC computations happen server-side so the secret never leaves the container — the PreToolUse hook on the host calls into the API rather than computing locally.

---

## What's new (v0.46.1)

**Temporal retrieval round 2 + the delivery-tool kit.** Compound temporal questions decompose into event clauses with rank fusion; temporal searches render a chronological Timeline block and stale results carry age warnings. `zc_program` adds multi-phase delivery programs with evidence-gated, auto-checkpointing phase closure — live-verified with an orchestrator handoff test (kill the orchestrator mid-phase; a cold replacement resumes from two calls). The embed lane now has a watchdog with budgeted self-healing.

Recent releases:
- **v0.46.0** — team memory (per-user keys, shared workspaces, write attribution), session replay with cryptographic provenance, OTel Gen-AI spans, CI/headless memory CLI, chunked embeddings, compliance report export.
- **v0.44.0** — temporal fact supersession, durable PG task graph, first public LongMemEval numbers.
- **v0.43.0** — token-budgeted recall digest (fixes the 47k-token recall firehose on mature projects).
- **v0.41–0.42** — memory-quality program: focused recall, consolidation, bi-temporal windows, multi-hop graph retrieval, TTL memories, multimodal ingestion.

Full details in [CHANGELOG.md](CHANGELOG.md); architecture notes in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Benchmarks, comparisons & measured claims

Everything in this section is measured, reproducible, and versioned — not marketing copy. Methodology notes included.

### Headline numbers

| Metric | Result |
|---|---|
| Token overhead per session (vs. native Claude re-paste) | **~87% lower** |
| Claude Opus cost per session (tool-call overhead only) | **~$0.16** vs. ~$2–5 native |
| Recall on a mature project (237 facts, v0.43.0 budget) | **~47k → ~4k tokens per recall (~92% lower)** |
| Memory-retrieval benchmark (LongMemEval-style, v0.40 → v0.43) | **hit@10 0% → 78%** |
| Unit + integration tests | **959 passing** |
| Red-team attack IDs verified | **60+ (RT-S0 through RT-S4)** |
| Hash-chain forgery resistance | Cryptographic (per-agent HKDF subkey) |
| Atomic work-stealing tested | **50 agents × 100 tasks, zero double-claims** |
| Marketplace skills supported | **17 / 17** Anthropic skills (operator opt-in flags where scripts use shell=True) |

### LongMemEval (public benchmark)

Retrieval recall on [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (`longmemeval_s`), measured through SecureContext's live search API — the same path agents use. Runnable by anyone: `node scripts/memory-bench.mjs --longmemeval <longmemeval_s.json> --limit 15`.

| Question type | n | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| knowledge-update | 15 | **80.0%** | **86.7%** | 0.572 |
| temporal-reasoning | 14 | 57.1% | 64.3% | 0.404 |
| single-session-user | 14 | 50.0% | 57.1% | 0.333 |
| single-session-assistant | 15 | 46.7% | 46.7% | 0.383 |
| multi-session | 15 | 26.7% | 26.7% | 0.189 |
| single-session-preference | 15 | 20.0% | 20.0% | 0.117 |

<details><summary>What moved these numbers (v0.44 → v0.46.1)</summary>

- **Chunked embeddings (v0.46.0):** long sessions previously embedded only their
  first 4k chars; per-chunk vectors + max-pooled similarity lifted
  single-session-user recall@5 from 21.4% to ~50%.
- **Interrogative-scaffolding stripper (v0.46.1):** temporal questions ("How many
  weeks ago did I…") no longer let the question-form dominate the query embedding —
  temporal-reasoning recall@5 38.5% → 53.3%, MRR ×2; knowledge-update and
  multi-session also improved; no category regressed.
- **Compound-question decomposition (v0.46.1):** "how many days between the day I
  started X and the day Y" embeds as a blend matching neither event. Temporal
  questions now split into event clauses, retrieve per clause, and RRF-fuse —
  the compound between-questions flipped from miss to rank-1, taking
  temporal-reasoning to 57.1% recall@5 / MRR 0.404 (2.6× the v0.46.0 MRR).
- Remaining known weakness: generic-phrase questions ("visited a museum with a
  friend" — no distinctive lexical/semantic anchor) and preference questions.
  Tracked, not spun.
</details>

**Methodology (read before comparing):** this is a *retrieval* metric — whether the gold answer session appears in the top-K search results over a **5,674-session haystack** (the union of 90 stratified questions' haystacks, 15 per type; 2 questions dropped to API timeouts). It is **not** end-to-end QA accuracy, so it is not directly comparable to LLM-judged accuracy numbers in vendor papers. Embeddings are fully local (`nomic-embed-text`, 274 MB) — no cloud embedder. Results JSON in `bench/results/`.

### How it's different from competitors

Most "memory for Claude Code" projects do one of three things:
- **Wrap the conversation in JSON.** Saves the messages, replays them. No semantic compression, no audit trail, no security model.
- **Sync to a cloud service.** Better UX but now your agent's tool history (potentially including secrets it touched) lives on someone else's server.
- **Drop in vector search.** Adds RAG over your docs but doesn't help with the actual problem — orchestrating what the agent does, verifying what ran, surviving session compaction.

SecureContext is none of those:

| | SecureContext | Cloud memory services | Vector RAG plugins | Native Claude Code |
|---|---|---|---|---|
| Persistent across restarts | ✅ Yes, local Postgres | ✅ But on their server | ⚠️ Only docs, not state | ❌ Lossy auto-compact |
| Delivery programs + evidence-gated checkpoints | ✅ zc_program | ❌ | ❌ | ❌ |
| HMAC audit trail | ✅ Per-agent subkey | ❌ | ❌ | ❌ |
| Per-agent identity isolation | ✅ HKDF + RLS | ❌ | ❌ | ❌ |
| Skill admission gate (HMAC + AST) | ✅ | ❌ | ❌ | ❌ |
| Tamper-evident chain + session replay | ✅ | ❌ | ❌ | ❌ |
| Work-stealing queue for parallel sessions | ✅ FOR UPDATE SKIP LOCKED | ❌ | ❌ | ❌ |
| Runs offline | ✅ Local Postgres + Ollama | ❌ | ⚠️ Depends | ✅ |
| Cost when idle | $0 | Monthly subscription | $0 | $0 |

Versus the well-known memory products: Mem0 and Zep are excellent **hosted memory APIs for LLM apps you build**; Letta (MemGPT) is an agent framework with self-editing memory. SecureContext targets a different job — **memory + delivery + security for the coding agents working on your machine**. It matches their core memory features locally (importance-scored facts with TTL, semantic + temporal + graph retrieval, contradiction detection, LongMemEval-comparable benchmarking) and adds what none of them have: the HMAC-chained audit trail, per-agent cryptographic identity, the skill admission gate, and the program/delivery layer.

> **Note on the "SafeSkill 20/100 Blocked" PR comment:** that score is a false positive from a regex-based scanner that doesn't understand the difference between *defending against* a pattern and *using* it. See [SAFESKILL_RESPONSE.md](SAFESKILL_RESPONSE.md) for the line-by-line refutation.

### The security capabilities in detail

- **Skill admission:** every bundled script AST-scanned at admission (detects `eval`, `exec`, `subprocess(shell=True)`, `pickle.loads`, dynamic imports), HMAC computed per file, quarantine on failure, HMAC re-verified by a PreToolUse hook before **every** execution — tamper with an admitted script and the next invocation is refused. End-to-end tested with live Claude CLI agents.
- **Audit chain:** every tool call and outcome signed with a per-agent HKDF subkey derived from a machine secret that never leaves disk. Agent A cannot forge rows as agent B; even full Postgres write access cannot produce rows that pass verification. Session replay renders any session's timeline with per-step `✓ verified / ✗ tampered / ⛓ gap` badges; a compliance report export renders the full chain for auditors.
- **Isolation:** Postgres Row-Level Security per agent via `SET LOCAL ROLE`; per-user API keys (sha256-stored, revocable) with membership-gated shared workspaces and write attribution.

---

## FAQ

### What is SecureContext?

SecureContext is an open-source (MIT) MCP plugin that adds persistent memory, a delivery/program layer, a cryptographic audit trail, skill-security gating, and multi-agent coordination to Claude Code. It stores everything in local PostgreSQL with local Ollama embeddings — no cloud service, no account, no subscription.

### How do I give Claude Code persistent memory across sessions?

Install SecureContext (one command — see [Quick start](#quick-start--one-command)), then agents call `zc_remember` to persist decisions and gotchas and `zc_recall_context({focus: "current task"})` at session start to restore them — ranked by relevance, with natural-language time queries answered directly from memory. Memory survives restarts, compactions, and reboots because it lives in PostgreSQL, not in the context window.

### How much does SecureContext reduce Claude Code token costs?

Measured across a 10-session project: **~87% less context-overhead** (session restore is ~1.5–4k tokens instead of 20–50k of re-pasted files). On long-lived projects with hundreds of accumulated memories, the recall budget keeps each recall at ~4k tokens where an unbounded dump would be ~47k. File questions are answered from 15–50× compressed semantic summaries instead of raw reads.

### Can it manage a long, multi-week project?

Yes — that's what the delivery layer is for. Define a program with phases (`zc_program`), and the open phase's acceptance checklist travels with the project state. Closing a phase requires an evidence table and generates a checkpoint document automatically. If the orchestrating agent dies mid-phase, a fresh one reconstructs the full delivery state from two calls — verified live.

### Does SecureContext send my code or data to the cloud?

No. Memory, embeddings (Ollama `nomic-embed-text`), search, summarization, and the audit chain all run locally. It works fully offline (search degrades gracefully to keyword-only if Ollama is down) and costs $0 when idle.

### Are Claude Code skills safe to install?

Filesystem skills bundle scripts that run with your permissions, and Claude Code's native loader does not scan them. SecureContext adds the missing gate: AST scan at admission, HMAC verification before every execution, automatic quarantine on failure or post-admission change, and a verifiable chained log of every admission decision.

### Can multiple Claude Code sessions work on the same project without conflicts?

Yes — parallel sessions atomically claim tasks from a work-stealing queue (zero double-claims at 50 agents × 100 tasks in testing), coordinate through typed broadcasts (ASSIGN/STATUS/MERGE/REJECT), and keep private per-agent memory namespaces plus a shared pool. Department-style hierarchies (heads + workers, N-tier escalation) are supported for larger agent teams.

### What do I need to run it?

Node 20+ and (recommended) Docker for the bundled PostgreSQL + Ollama stack. The one-command installer does everything in about five minutes. A SQLite fallback runs with zero infrastructure.

### Which local models should I run, and how does hardware affect SecureContext?

SecureContext degrades gracefully by hardware tier — every LLM-powered layer fails closed (the feature quietly contributes nothing) rather than breaking ingest or search. What changes with hardware is how much of the intelligence stack is active:

| Tier | Hardware | Models that fit | What you get |
|---|---|---|---|
| **Minimum** | Any CPU, ~2 GB RAM free | `nomic-embed-text` (embeddings only) | Hybrid BM25+vector search, working memory, audit chain, skills gating — the core. LLM layers (event extraction, entity extraction, contradiction adjudication) stay dormant. |
| **Mid** | 8–16 GB GPU (or Apple Silicon 16 GB+) | + `qwen2.5-coder:14b` or `phi4:14b` (one at a time) | + Event-fact extraction at ingest (temporal reasoning), LLM contradiction adjudication, entity extraction, L0/L1 semantic file summaries. |
| **Full** | 24 GB+ GPU (e.g. RTX 4090/5090) | + `phi4:14b` **and** `gpt-oss:20b` resident together | Everything, concurrently, at interactive latency — plus a strong local generator for QA/benchmarks. This is the configuration our published benchmark deltas were measured on. |

Model-choice guidance (all measured, see `bench/`):

- **Embeddings:** `nomic-embed-text` — required, tiny, runs anywhere.
- **Event extraction** (`ZC_EVENT_EXTRACT_MODEL`, default `phi4:14b`): our bakeoff scored phi4:14b at 100% event recall / 100% date accuracy, tying gpt-oss:20b at 2× the speed. On smaller GPUs `qwen2.5-coder:14b` is close behind (84.6% recall). **Coder models ≠ better**: qwen2.5-coder:32b scored *worst* (69.2%) despite being the largest — conversational extraction is not a coding task.
- **Contradiction adjudication** (`ZC_LLM_ADJUDICATE_MODEL`, default `qwen2.5-coder:14b`): the only model in our bakeoff with zero false contradictions; the 32B variant was *worse*.
- **Dates are never LLM-resolved.** Relative expressions ("tomorrow", "last Friday", "the 4th") are resolved by deterministic code anchored on the session date — the one operation the literature shows small local models fail at. Model choice therefore affects *which events get found*, never *what date they get*.
- Point any of these at a different Ollama host (e.g. a GPU box on your LAN, or `host.docker.internal` from Docker) with `ZC_EVENT_OLLAMA_URL` / per-layer URL overrides; each layer has a kill-switch env (`ZC_EVENT_EXTRACT=0`, `ZC_ENTITY_EXTRACT=0`, `ZC_LLM_ADJUDICATE=0`).

---

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — deep dive on the security model, HMAC chain construction, RLS, threat model
- [CHANGELOG.md](CHANGELOG.md) — release-by-release detail
- [SECURITY_REPORT.md](SECURITY_REPORT.md) — red-team test IDs + verification log
- [SAFESKILL_RESPONSE.md](SAFESKILL_RESPONSE.md) — line-by-line refutation of the SafeSkill scanner's false positives
- [SecureContext_ProductionReadiness_Report.md](SecureContext_ProductionReadiness_Report.md) — what's hardened, what's still in beta
- [docs/SKILL_AUTHORSHIP_GUIDE.md](docs/SKILL_AUTHORSHIP_GUIDE.md) — frontmatter spec, script-writing rules, scope decisions
- [hooks/INSTALL.md](hooks/INSTALL.md) — harness hooks reference
- [examples/skills/](examples/skills/) — reference filesystem skills you can copy into `~/.claude/skills/`

---

## License

MIT. See [LICENSE](LICENSE).

Built by [@iampantherr](https://github.com/iampantherr). Issues + PRs welcome.
