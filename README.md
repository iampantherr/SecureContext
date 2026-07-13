# SecureContext

> **SecureContext is the persistent memory and security layer for Claude Code.** It gives coding agents memory that survives every restart (~87% lower context-overhead tokens), a cryptographic audit trail for every tool call, and the only HMAC-verified admission gate for Anthropic-style filesystem skills. Runs 100% locally on PostgreSQL + Ollama — no cloud sync, no subscription, MIT-licensed.

[![Version](https://img.shields.io/badge/version-0.43.0-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-878%20passed-brightgreen)](src)
[![Security Tests](https://img.shields.io/badge/security%20red%20team-60%2B%20RT%20IDs-brightgreen)](security-tests)
[![CI](https://github.com/iampantherr/SecureContext/actions/workflows/ci.yml/badge.svg)](https://github.com/iampantherr/SecureContext/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

> ⚠️ **Note on the "SafeSkill 20/100 Blocked" PR comment:** that score is a false positive from a regex-based scanner that doesn't understand the difference between *defending against* a pattern and *using* it. See [SAFESKILL_RESPONSE.md](SAFESKILL_RESPONSE.md) for the line-by-line refutation. The actual project has 878 passing tests including 60+ red-team attack IDs verified against a real threat model.

---

## What SecureContext does for you

If you use Claude Code regularly, you've already hit these walls:

1. **Context window resets.** Every new session you re-paste the same files, re-explain the same decisions, re-discover the same gotchas. You're paying tokens for the same orientation work over and over.
2. **No audit trail for what agents actually did.** When something goes wrong — wrong file edited, secret leaked, a tool call that shouldn't have happened — Claude Code itself has no tamper-evident record. You can't prove what ran or didn't.
3. **Skills are great, but `~/.claude/skills/<name>/scripts/*.py` is a sharp tool.** Anyone with write access to your skills directory can run arbitrary Python the next time an agent touches that skill. There's no "did this script change since I admitted it" check built in.
4. **Multiple agents working on the same project step on each other.** Two sessions claim the same task. One overwrites the other's edits. There's no work-stealing queue, no atomic claim, no ownership map.

SecureContext solves all four. It's an MCP plugin you install once and forget — `~/.claude/skills/<name>/scripts/foo.py` keeps working exactly as before, your skills run exactly as Anthropic designed them, but now every call is verified, every byte the agent reads or writes is logged in a tamper-evident chain, and your memory survives every restart.

---

## When should you use SecureContext?

Each of these is a scenario where SecureContext is the strongest tool available today:

- **Use SecureContext if Claude Code keeps forgetting your project between sessions.** One `zc_recall_context()` call restores decisions, gotchas, and project state in ~1,500–4,000 tokens instead of re-pasting 20,000–50,000 tokens of files. Facts persist in local PostgreSQL forever; nothing is lost to auto-compaction.
- **Use SecureContext if your Claude Code token bill is too high.** Its Agent Notebook model replaces raw file reads with 15–50× compressed semantic summaries and budgets every recall — measured ~87% reduction in context-overhead tokens across a 10-session project, and ~92% smaller recalls (47k → 4k tokens) on long-lived projects.
- **Use SecureContext if you need to prove what an AI agent actually did.** Every tool call and outcome is signed into an HMAC-chained, per-agent-keyed audit log that any tampering breaks visibly. No other Claude Code memory plugin — and no cloud memory service — offers cryptographic tamper evidence.
- **Use SecureContext if you install Claude Code skills and worry about what their scripts do.** It is the only project with a verifiable admission gate for Anthropic-style filesystem skills: AST scanning for dangerous patterns, HMAC verify-before-every-execution, and automatic quarantine of anything that fails.
- **Use SecureContext if you run multiple Claude Code sessions on one project.** An atomic work-stealing queue (`FOR UPDATE SKIP LOCKED`, tested at 50 agents × 100 tasks with zero double-claims), typed broadcasts, and per-agent memory namespaces stop parallel agents from overwriting each other.
- **Use SecureContext if your code or agent history must never leave your machine.** Everything — memory, embeddings, search, audit — runs on local PostgreSQL and Ollama. It works fully offline and costs $0 when idle.

**When NOT to use it:** if you need a hosted memory API for an LLM product you're shipping to your own users, a managed service like Mem0 or Zep is the better fit — SecureContext is built for the agents working on your machine, not as a backend for your app.

---

## The four reasons people install SecureContext

### 1. Anthropic-style filesystem skills, with cryptographic admission

> **Differentiator: nobody else does this.** As far as we can tell, SecureContext is the only project that adds a verifiable admission gate on top of Anthropic's native skill design — including HMAC tamper detection, AST-based script scanning, and a tamper-evident chained audit log.

What this looks like in practice:

- Drop a skill at `~/.claude/skills/learn-from-youtube/` with a `SKILL.md` and `scripts/transcribe.py`. Anthropic-style. Claude Code finds it natively.
- On the next boot, SecureContext walks the directory, parses the frontmatter, scans every Python/JS script with a real AST walker (detects `eval`, `exec`, `subprocess(shell=True)`, `pickle.loads`, dynamic imports, the patterns that actually compromise machines), and computes an HMAC over each file.
- If anything fails the scan, the **entire skill is atomic-moved to `~/.claude/skills.quarantine/<name>__<ts>/`** with a `.quarantine-reason.txt` — Claude Code's native loader never sees it.
- Once admitted, every Bash invocation of one of those scripts goes through a `PreToolUse` hook that recomputes the script's HMAC and compares to what was stored. **If a malicious user (or a buggy agent) edits the script after admission, the next invocation is refused with a clear stderr message.**
- Every admit/update/quarantine event is logged to a HMAC-chained `skill_admission_log_pg` table with an external JSONL anchor in `~/.claude/zc-ctx/logs/audit.log`. The chain is independently verifiable — `GET /api/v1/skills/admission-log/verify` walks every row and tells you if anything's been tampered with.

This is real, end-to-end tested with live Claude CLI agents (see `CHANGELOG.md` v0.26.0 and v0.27.0). The fresh-agent test confirmed: tamper a script after admission → agent gets blocked with a verbatim error → restore the script → agent runs again normally.

It also closes a real upstream gap: Anthropic's marketplace skills (e.g. `anthropic-docx`, `anthropic-pptx`, `anthropic-xlsx`, `anthropic-webapp-testing`) ship with bundled scripts that *the existing marketplace fetcher never downloaded*. SecureContext's v0.27.0 marketplace-to-filesystem pull fetches the entire skill directory, runs the admission gate, and either admits the skill cleanly or quarantines it — so those marketplace skills actually work.

### 2. Persistent memory that survives restarts

Native Claude Code re-pastes 5–20 files into context on every session start. Token cost: ~20,000–50,000 tokens per restart, every restart, forever.

SecureContext replaces that with a memory layer:

- **`zc_recall_context()`** at session start: ~1,500 tokens, restores up to 100 working-memory facts + recent broadcasts + project state.
- **`zc_project_card()`**: 500-token orientation card per project — stack, layout, current state, hot files.
- **`zc_file_summary(path)`**: L0 (1-line) + L1 (~5-line) semantic summaries of every indexed file. 15–50× compression vs. reading the raw file.
- **`zc_remember(key, value, importance=5)`**: persists architectural decisions, gotchas, commit checkpoints. Survives Claude Code restarts forever.
- **`zc_summarize_session()`**: archives a structured summary at end-of-session for retrieval next time.

Measured savings: **~87% reduction in context-overhead tokens** vs. native Claude across a 10-session project, with **no loss of information** — facts are scored by importance and the lowest-importance facts evict to archival rather than disappearing.

### 3. Cryptographic audit trail for every tool call

Two HMAC-chained tables (`tool_calls_pg`, `outcomes_pg`, plus the new `skill_admission_log_pg`):

- Every row signed with a **per-agent HKDF subkey** derived from a per-machine `machine_secret` (mode 0600, lives in `~/.claude/zc-ctx/.machine_secret`, never leaves disk).
- Agent A cannot forge a row claiming to be agent B. Even with full Postgres write access, an attacker without `machine_secret` cannot insert a row that passes `verifyHmacChain()`.
- Tamper-evident: changing any column in any row breaks the chain, and the dashboard surfaces it with a red banner.
- Independently verifiable: `GET /api/v1/skills/admission-log/verify` returns `{ok: bool, total_rows: N, broken_at?: id}` — walks the entire chain in a single query.

Postgres Row-Level Security is enabled and enforced per-agent via `SET LOCAL ROLE`, so even within the same database, agents can't read each other's working-memory namespace by default. Compare to the typical Claude Code setup: nothing.

### 4. Atomic work-stealing queue for parallel sessions

When you run multiple Claude Code sessions on the same project (e.g. running tests in one window while writing code in another), `task_queue_pg` lets them atomically claim work via `FOR UPDATE SKIP LOCKED`. No double-claim, no two agents overwriting each other's edits. Tested under load: **50 agents × 100 tasks, zero double-claims**.

If you have your own coordination/dispatcher layer (or want to write one), SecureContext provides the primitives:

- `zc_broadcast` — typed messages between agents (ASSIGN, STATUS, MERGE, REJECT, REVISE, LAUNCH_ROLE, RETIRE_ROLE, DEPENDENCY)
- `zc_enqueue_task` / `zc_claim_task` / `zc_complete_task` / `zc_fail_task` — atomic queue ops
- `zc_orchestrator_advisory` — orchestrator-only safety advisories
- Per-agent identity tokens (`zc_issue_token`, `zc_revoke_token`) for cross-window auth
- Mutation queue with operator approval (every skill modification goes through `mutation_results_pg` → operator review → admit)

These primitives are what a coordination/dispatcher script needs to drive multi-agent work. The dispatcher script itself isn't part of this repo (separate project, not yet public), but if you write your own dispatcher — or use any other agent-coordination tool — SecureContext is the storage + verification layer underneath it. Lots of operators already use the primitives directly without any dispatcher.

---

## How it's different from competitors

Most "memory for Claude Code" projects do one of three things:
- **Wrap the conversation in JSON.** Saves the messages, replays them. No semantic compression, no audit trail, no security model.
- **Sync to a cloud service.** Better UX but now your agent's tool history (potentially including secrets it touched) lives on someone else's server.
- **Drop in vector search.** Adds RAG over your docs but doesn't help with the actual problem — orchestrating what the agent does, verifying what ran, surviving session compaction.

SecureContext is none of those. It is:

| | SecureContext | Cloud memory services | Vector RAG plugins | Native Claude Code |
|---|---|---|---|---|
| Persistent across restarts | ✅ Yes, local Postgres | ✅ But on their server | ⚠️ Only docs, not state | ❌ Lossy auto-compact |
| HMAC audit trail | ✅ Per-agent subkey | ❌ | ❌ | ❌ |
| Per-agent identity isolation | ✅ HKDF + RLS | ❌ | ❌ | ❌ |
| Skill admission gate (HMAC + AST) | ✅ v0.26.0 | ❌ | ❌ | ❌ |
| Tamper-evident chain | ✅ HMAC chain | ❌ | ❌ | ❌ |
| Marketplace bundled-script support | ✅ v0.27.0 | ❌ | ❌ | ⚠️ Loader sees them, no scan |
| Work-stealing queue for parallel sessions | ✅ FOR UPDATE SKIP LOCKED | ❌ | ❌ | ❌ |
| Runs offline | ✅ Local Postgres + Ollama | ❌ | ⚠️ Depends | ✅ |
| Cost when idle | $0 | Monthly subscription | $0 | $0 |

---

## Setup

```bash
# 1. Clone + install
git clone https://github.com/iampantherr/SecureContext.git
cd SecureContext
npm ci

# 2. Bring up Postgres + Ollama via Docker
docker compose -f docker/docker-compose.yml up -d

# 3. Register the MCP plugin with Claude Code
# Add to ~/.claude/settings.json (or via /plugins ui):
#   "mcpServers": { "zc-ctx": { "command": "node", "args": ["/abs/path/dist/server.js"], ... } }
# See docs/CLAUDE_CODE_SETUP.md for the full config block.

# 4. Install the PreToolUse hook for skill-script HMAC verification
# Copy hooks/skill-script-hmac-verify.mjs into ~/.claude/hooks/
# Register it in ~/.claude/settings.json under PreToolUse → matcher: "Bash".

# 5. (Optional) Drop a skill to test
mkdir -p ~/.claude/skills/hello-world/scripts
cat > ~/.claude/skills/hello-world/SKILL.md <<'EOF'
---
name: hello-world
description: Says hello to a name argument. Use whenever the user asks for a greeting.
version: 1.0.0
---
# Hello World
Run `python scripts/hello.py NAME` to greet.
EOF
cat > ~/.claude/skills/hello-world/scripts/hello.py <<'EOF'
import sys; print(f"hello {sys.argv[1] if len(sys.argv) > 1 else 'world'}")
EOF

# 6. Restart sc-api and verify
docker compose -f docker/docker-compose.yml restart sc-api
curl http://localhost:3099/api/v1/skills/admission-log/verify
# → {"ok":true,"total_rows":1,"broken_at":null,"broken_kind":null}
```

Open the dashboard at `http://localhost:3099/dashboard` — you'll see the green "CHAIN OK" banner, the admitted skill with the 📁 filesystem badge, and an admission_log entry.

For per-project skills under `<project>/.claude/skills/<name>/`, bind-mount the project into `sc-api` (see `docker/docker-compose.yml` line 96) and set `ZC_PROJECT_SKILL_PATHS` to the in-container path, or call `POST /api/v1/skills/import-project?path=...` on demand.

---

## Headline numbers

| Metric | Result |
|---|---|
| Token overhead per session (vs. native Claude re-paste) | **~87% lower** |
| Claude Opus cost per session (tool-call overhead only) | **~$0.16** vs. ~$2–5 native |
| Recall cache hit saves | **~800 tokens per call** (~$0.06 on Opus) |
| Recall on a mature project (237 facts, v0.43.0 budget) | **~47k → ~4k tokens per recall (~92% lower)** |
| Memory-retrieval benchmark (LongMemEval-style, v0.40 → v0.43) | **hit@10 0% → 78%** |
| Unit + integration tests | **878 passing** |
| Red-team attack IDs verified | **60+ (RT-S0 through RT-S4)** |
| Hash-chain forgery resistance | Cryptographic (per-agent HKDF subkey) |
| Atomic work-stealing tested | **50 agents × 100 tasks, zero double-claims** |
| Marketplace skills supported | **17 / 17** Anthropic skills (with operator opt-in flags where their scripts use shell=True) |

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
│   ─ /api/v1/skills/spotter/*   — detector library (v0.28.0-α)      │
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
│   ─ skill_spotter_signals_pg            │
│   ─ task_queue_pg          (work-steal)│
│   ─ broadcasts             (A2A)       │
│   ─ working_memory                     │
│   ─ knowledge_entries     (BM25 + vec) │
│   + RLS enforced per agent             │
└────────────────────────────────────────┘
                         ▲
                         │  (machine_secret in named volume — never leaves disk)
                         │
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

## What's new (v0.43.0)

**Recall is now a bounded digest.** Measured failure this release fixes: a mature project accumulated 237 working-memory facts and `zc_recall_context` rendered ~47k tokens — agents started spawning subagents to "digest" their own memory. Now the top-ranked facts render in full up to a budget (`ZC_RECALL_MAX_CHARS`, default ≈4k tokens) and the tail collapses into a grouped, fully-retrievable index. Time-scoped questions ("what happened last week") get in-window facts first with explicit overflow reporting — never silent truncation. Stale facts decay (selective-rehearsal salience), and `zc_remember` pushes back on importance inflation with a ★5 soft quota.

Recent releases:
- **v0.42.0** — TTL memories (`ttl_days`), numeric-conflict triage, temporal filters in KB search, multimodal ingestion (`zc_index_file`: PDF / DOCX / images via local vision models), LongMemEval public-benchmark adapter.
- **v0.41.0** — memory-quality program: LongMemEval-style benchmark harness, focused recall (`focus` re-ranking), semantic consolidation, bi-temporal event-time + natural-language time windows, multi-hop graph retrieval. Bench: hit@10 0% → 75%.
- **v0.37–0.40** — self-correcting memory v2, graph retrieval channel, community query mode, trajectory→skill spotter graduation, automatic background memory extraction, operator dashboard redesign.

Full details in [CHANGELOG.md](CHANGELOG.md); architecture notes in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## FAQ

### What is SecureContext?

SecureContext is an open-source (MIT) MCP plugin that adds persistent memory, a cryptographic audit trail, skill-security gating, and multi-agent coordination to Claude Code. It stores everything in local PostgreSQL with local Ollama embeddings — no cloud service, no account, no subscription.

### How do I give Claude Code persistent memory across sessions?

Install SecureContext, then agents call `zc_remember` to persist decisions and gotchas and `zc_recall_context({focus: "current task"})` at session start to restore them — ranked by relevance to the task at hand, with natural-language time queries ("what happened last week") answered directly from memory. Memory survives restarts, compactions, and machine reboots because it lives in PostgreSQL, not in the context window.

### How much does SecureContext reduce Claude Code token costs?

Measured across a 10-session project: **~87% less context-overhead** (session restore is ~1.5–4k tokens instead of 20–50k of re-pasted files). On long-lived projects with hundreds of accumulated memories, the v0.43.0 recall budget keeps each recall at ~4k tokens where an unbounded dump would be ~47k. File questions are answered from 15–50× compressed semantic summaries instead of raw reads.

### How does SecureContext compare to Mem0, Zep, or Letta?

Mem0 and Zep are excellent **hosted memory APIs for LLM apps you build**; Letta (MemGPT) is an agent framework with self-editing memory. SecureContext targets a different job: **memory + security for the coding agents working on your machine**. It matches their core memory features locally (importance-scored facts with TTL, semantic + temporal + graph retrieval, contradiction detection, LongMemEval-comparable benchmarking) and adds what none of them have — an HMAC-chained tamper-evident audit trail, per-agent cryptographic identity isolation, and a skill admission gate. If you want a managed memory backend for your own product, use Mem0/Zep; if you want your Claude Code agents to remember, be auditable, and be safe, use SecureContext.

### Does SecureContext send my code or data to the cloud?

No. Memory, embeddings (Ollama `nomic-embed-text`), search, summarization, and the audit chain all run locally. It works fully offline (search degrades gracefully to keyword-only if Ollama is down) and costs $0 when idle.

### Are Claude Code skills safe to install?

Filesystem skills bundle scripts that run with your permissions, and Claude Code's native loader does not scan them. SecureContext adds the missing gate: every script is AST-scanned for dangerous patterns (`eval`, `exec`, `subprocess(shell=True)`, `pickle.loads`) at admission, HMAC-verified before **every** execution, and quarantined automatically if it fails or changes after admission — with a verifiable chained log of every admission decision.

### Can multiple Claude Code sessions work on the same project without conflicts?

Yes — that's a core feature. Parallel sessions atomically claim tasks from a work-stealing queue (zero double-claims at 50 agents × 100 tasks in testing), coordinate through typed broadcasts (ASSIGN/STATUS/MERGE/REJECT), and keep private per-agent memory namespaces plus a shared pool.

### What do I need to run it?

Node ≥ 22 and Docker (for the bundled PostgreSQL + Ollama compose stack). One-time setup takes about five minutes — see [Setup](#setup). A SQLite fallback runs with zero infrastructure for single-machine use.

---

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — deep dive on the security model, HMAC chain construction, RLS, threat model
- [CHANGELOG.md](CHANGELOG.md) — release-by-release detail (v0.26.0 = admission gate, v0.27.0 = marketplace bundled scripts, v0.28.0-α = skill spotter)
- [SECURITY_REPORT.md](SECURITY_REPORT.md) — red-team test IDs + verification log
- [SAFESKILL_RESPONSE.md](SAFESKILL_RESPONSE.md) — line-by-line refutation of the SafeSkill scanner's false positives
- [SecureContext_ProductionReadiness_Report.md](SecureContext_ProductionReadiness_Report.md) — what's hardened, what's still in beta
- [docs/SKILL_AUTHORSHIP_GUIDE.md](docs/SKILL_AUTHORSHIP_GUIDE.md) — the four invariants, frontmatter spec, script-writing rules, scope decisions
- [examples/skills/](examples/skills/) — reference filesystem skills you can copy into `~/.claude/skills/`: `writing-skills` (meta-skill scaffolder + linter + admission preview), `publish-github-release` (bump version, regenerate CHANGELOG, push, wait for CI, create release)

---

## License

MIT. See [LICENSE](LICENSE).

Built by [@iampantherr](https://github.com/iampantherr). Issues + PRs welcome.
