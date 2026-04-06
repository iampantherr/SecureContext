# SecureContext — Agent Instructions

## What This Project Is

A fully auditable, open-source Claude Code MCP plugin that replaces `context-mode`.
Provides context-window optimization (sandbox execution, FTS5+vector knowledge base,
MemGPT-style persistent memory, session continuity, SSRF-protected web fetch) with
maximum security — no pre-compiled bundles, no credential leakage, no cloud sync.

**Plugin ID:** `zc-ctx`
**Version:** `0.8.0`
**License:** MIT
**Language:** TypeScript (Node.js ≥ 22)

---

## Directory Layout

```
SecureContext/
├── src/
│   ├── server.ts           MCP server entrypoint — 13 tools
│   ├── config.ts           All constants + env var overrides
│   ├── migrations.ts       Versioned schema migrations (9 migrations)
│   ├── sandbox.ts          Isolated code executor (python/js/bash)
│   ├── knowledge.ts        Hybrid BM25+vector KB + cross-project search
│   ├── embedder.ts         Ollama nomic-embed-text client
│   ├── memory.ts           MemGPT working memory (agent namespacing)
│   ├── fetcher.ts          4-layer SSRF-protected URL fetcher
│   ├── integrity.ts        SHA256 tamper detection
│   ├── session.ts          JSONL event log reader
│   └── *.test.ts           Vitest unit tests (248 tests)
├── hooks/
│   ├── pretooluse.mjs      Blocks risky tool calls
│   ├── posttooluse.mjs     Logs session metadata (read-only)
│   └── stop.mjs            Session boundary marker
├── security-tests/
│   └── run-all.mjs         84 automated attack vectors
├── .github/workflows/ci.yml  Build + unit tests + security tests on every push
├── .claude-plugin/
│   └── plugin.json         Claude plugin manifest
├── install.mjs             One-command installer (CLI + Desktop App)
├── ARCHITECTURE.md         Full architecture reference
├── SECURITY_REPORT.md      Threat model + security audit
├── CLAUDE.md               THIS FILE
├── package.json
├── package-lock.json       Always committed — locked deps
└── tsconfig.json
```

---

## Build Commands

```bash
npm ci                           # Install deps from lockfile
npm run build                    # tsc compile → dist/
npm test                         # Vitest unit tests (248 tests)
node security-tests/run-all.mjs  # 84 security attack vectors
node install.mjs                 # Install for Claude Code CLI + Desktop App
node install.mjs --uninstall     # Remove from all configs
```

---

## 13 MCP Tools

| Tool | Description |
|------|-------------|
| `zc_execute(language, code)` | Run code in credential-isolated sandbox |
| `zc_execute_file(path, language, code)` | File analysis in sandbox (TARGET_FILE via stdin) |
| `zc_fetch(url, source?)` | SSRF-protected URL fetch → index into KB |
| `zc_index(content, source)` | Manually index text into session KB |
| `zc_search(queries[])` | Hybrid BM25+vector search on current project KB |
| `zc_search_global(queries[], max_projects?)` | Cross-project federated search |
| `zc_batch(commands[], queries[])` | Parallel: shell commands + KB search |
| `zc_remember(key, value, importance?, agent_id?)` | Store fact in working memory |
| `zc_forget(key, agent_id?)` | Delete fact from working memory |
| `zc_recall_context(agent_id?)` | Restore full context (memory + shared channel + events + status) |
| `zc_summarize_session(summary)` | Archive session summary (kept 365 days) |
| `zc_status(agent_id?)` | DB health, KB counts, memory fill, fetch budget |
| `zc_broadcast(type, agent_id, ...)` | [v0.7.1] Post to shared A2A channel (ASSIGN/STATUS/PROPOSED/DEPENDENCY/MERGE/REJECT/REVISE/set_key) |

---

## Security Rules — NEVER Violate

1. Sandbox MUST spawn with `env: { PATH: process.env.PATH }` only — zero credential vars
2. Sandbox MUST enforce: 30s timeout, 512KB stdout cap, 64KB stderr cap
3. Hooks MUST be read-only — no `writeFileSync`, `copyFileSync`, `mkdirSync`
4. NEVER write to any user project directory (no CLAUDE.md injection)
5. NEVER do runtime `npm install` — all deps must be in `package-lock.json`
6. NEVER store raw tool responses — only: file paths, task names, error messages
7. Network fetch: strip `Authorization`, `Cookie`, `X-Api-Key` headers before sending
8. All SQLite DBs live in `~/.claude/zc-ctx/sessions/` — scoped by SHA256 project hash
9. No auto-update mechanism — plugin updates are manual only
10. `ZC_STRICT_INTEGRITY=1` → server exits on tamper, not just warns

---

## Schema (v0.8.0 — 9 migrations)

| Table | Purpose |
|-------|---------|
| `knowledge` (FTS5) | BM25 full-text search |
| `embeddings` | Ollama vectors with `model_name` + `dimensions` |
| `source_meta` | `source_type` (internal/external) + `retention_tier` |
| `working_memory` | MemGPT facts with `agent_id` namespacing |
| `broadcasts` | A2A shared coordination channel (append-only, key-authenticated) |
| `project_meta` | Human-readable project labels + channel key hash |
| `db_meta` | Schema version metadata |
| `schema_migrations` | Applied migration tracking |

Retention tiers: `external`=14d · `internal`=30d · `summary`=365d

---

## Agent Continuation Instructions

1. Read `ARCHITECTURE.md` for full component reference
2. Check `git log --oneline` for recent changes
3. Run `npm run build && npm test` after any `.ts` change
4. Run `node security-tests/run-all.mjs` after security-related changes
5. All 248 unit tests + 84 security vectors must pass before pushing
6. Never break the 10 security rules above
7. Commit after every stable milestone with a descriptive message

---

## Broadcast Channel — Known Design Limitations (Gap 4)

The `agent_id` parameter in `zc_broadcast` is **unauthenticated in open mode** (no `set_key`).
Any agent can post with any `agent_id` string — there is no cryptographic binding between
the parameter value and the actual calling agent. This is an accepted architectural trade-off:

- **In key-protected mode**: `agent_id` on gated types (ASSIGN/MERGE/REJECT/REVISE) is
  protected indirectly — only the key-holder can write those types, so the agent_id on
  those messages is trustworthy as long as the key is kept secret.
- **In open mode**: `agent_id` is a human-readable label only. Treat it as a self-declared
  identifier, not a verified identity. Malicious workers could spoof another agent's ID.
- **Practical implication**: In automated, fully-trusted pipelines (all agents are your code),
  open mode is fine. For untrusted code pipelines, always use key-protected mode.
- **Not planned for fix**: Full agent identity binding would require PKI (per-agent keypairs),
  which is out of scope for a local coordination tool. Document the limitation; use key mode.
