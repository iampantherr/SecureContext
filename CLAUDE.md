# SecureContext — Agent Instructions

## What This Project Is

A fully auditable, open-source Claude Code MCP plugin that replaces `context-mode`.
Provides context-window optimization (sandbox execution, FTS5+vector knowledge base,
MemGPT-style persistent memory, session continuity, SSRF-protected web fetch) with
maximum security — no pre-compiled bundles, no credential leakage, no cloud sync.

**Plugin ID:** `zc-ctx@zeroclaw`
**Version:** `0.6.0`
**License:** MIT
**Language:** TypeScript (Node.js ≥ 22)

---

## Directory Layout

```
SecureContext/
├── src/
│   ├── server.ts           MCP server entrypoint — 12 tools
│   ├── config.ts           All constants + env var overrides
│   ├── migrations.ts       Versioned schema migrations (7 migrations)
│   ├── sandbox.ts          Isolated code executor (python/js/bash)
│   ├── knowledge.ts        Hybrid BM25+vector KB + cross-project search
│   ├── embedder.ts         Ollama nomic-embed-text client
│   ├── memory.ts           MemGPT working memory (agent namespacing)
│   ├── fetcher.ts          4-layer SSRF-protected URL fetcher
│   ├── integrity.ts        SHA256 tamper detection
│   ├── session.ts          JSONL event log reader
│   └── *.test.ts           Vitest unit tests (138 tests)
├── hooks/
│   ├── pretooluse.mjs      Blocks risky tool calls
│   ├── posttooluse.mjs     Logs session metadata (read-only)
│   └── stop.mjs            Session boundary marker
├── security-tests/
│   └── run-all.mjs         77 automated attack vectors
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
npm test                         # Vitest unit tests (138 tests)
node security-tests/run-all.mjs  # 77 security attack vectors
node install.mjs                 # Install for Claude Code CLI + Desktop App
node install.mjs --uninstall     # Remove from all configs
```

---

## 12 MCP Tools

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
| `zc_recall_context(agent_id?)` | Restore full context (memory + events + status) |
| `zc_summarize_session(summary)` | Archive session summary (kept 365 days) |
| `zc_status(agent_id?)` | DB health, KB counts, memory fill, fetch budget |

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

## Schema (v0.6.0 — 7 migrations)

| Table | Purpose |
|-------|---------|
| `knowledge` (FTS5) | BM25 full-text search |
| `embeddings` | Ollama vectors with `model_name` + `dimensions` |
| `source_meta` | `source_type` (internal/external) + `retention_tier` |
| `working_memory` | MemGPT facts with `agent_id` namespacing |
| `project_meta` | Human-readable project labels (cross-project search) |
| `db_meta` | Schema version metadata |
| `schema_migrations` | Applied migration tracking |

Retention tiers: `external`=14d · `internal`=30d · `summary`=365d

---

## Agent Continuation Instructions

1. Read `ARCHITECTURE.md` for full component reference
2. Check `git log --oneline` for recent changes
3. Run `npm run build && npm test` after any `.ts` change
4. Run `node security-tests/run-all.mjs` after security-related changes
5. All 138 unit tests + 77 security vectors must pass before pushing
6. Never break the 10 security rules above
7. Commit after every stable milestone with a descriptive message
