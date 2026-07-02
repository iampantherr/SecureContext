# SecureContext

> **The security and memory layer for Claude Code.** Persistent memory that survives restarts, cryptographic audit trail for every tool call, and the only HMAC-verified admission gate for Anthropic-style filesystem skills. Runs locally on PostgreSQL — zero cloud sync, MIT-licensed.

[![Version](https://img.shields.io/badge/version-0.37.0-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-865%20passed-brightgreen)](src)
[![Security Tests](https://img.shields.io/badge/security%20red%20team-60%2B%20RT%20IDs-brightgreen)](security-tests)
[![CI](https://github.com/iampantherr/SecureContext/actions/workflows/ci.yml/badge.svg)](https://github.com/iampantherr/SecureContext/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

> ⚠️ **Note on the "SafeSkill 20/100 Blocked" PR comment:** that score is a false positive from a regex-based scanner that doesn't understand the difference between *defending against* a pattern and *using* it. See [SAFESKILL_RESPONSE.md](SAFESKILL_RESPONSE.md) for the line-by-line refutation. The actual project has 786 passing tests including 60+ red-team attack IDs verified against a real threat model.

---

## What SecureContext does for you

If you use Claude Code regularly, you've already hit these walls:

1. **Context window resets.** Every new session you re-paste the same files, re-explain the same decisions, re-discover the same gotchas. You're paying tokens for the same orientation work over and over.
2. **No audit trail for what agents actually did.** When something goes wrong — wrong file edited, secret leaked, a tool call that shouldn't have happened — Claude Code itself has no tamper-evident record. You can't prove what ran or didn't.
3. **Skills are great, but `~/.claude/skills/<name>/scripts/*.py` is a sharp tool.** Anyone with write access to your skills directory can run arbitrary Python the next time an agent touches that skill. There's no "did this script change since I admitted it" check built in.
4. **Multiple agents working on the same project step on each other.** Two sessions claim the same task. One overwrites the other's edits. There's no work-stealing queue, no atomic claim, no ownership map.

SecureContext solves all four. It's an MCP plugin you install once and forget — `~/.claude/skills/<name>/scripts/foo.py` keeps working exactly as before, your skills run exactly as Anthropic designed them, but now every call is verified, every byte the agent reads or writes is logged in a tamper-evident chain, and your memory survives every restart.

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
| Unit + integration tests | **786 passing** |
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

## What's coming (v0.28.0)

`v0.28.0-α` (this release) ships the **skill spotter** dry-run mode — a detector library that mines `tool_calls_pg` and `pretool_events_pg` for repeated procedural patterns across sessions. No LLM yet; just structured signals the operator can review on the dashboard. `POST /api/v1/skills/spotter/dry-run` → see what patterns the agents are repeating.

Upcoming:
- **v0.28.0-β** — LLM-driven spotter agent (Sonnet 4.6 + high-effort extended thinking). Takes the signals, applies the four Anthropic skill-quality gates (procedural-not-factual, clear-trigger, ≥3-repeats, has-progressive-disclosure-leverage), files candidates to `skill_candidates_pg` for operator review.
- **v0.28.0-γ** — remaining 4 detectors (external script invocation, uncredited high-cost tasks, rejected-mutation clusters, repeated prompt fragments) + optional cron schedule.

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
