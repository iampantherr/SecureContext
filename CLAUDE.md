# SecureContext — Agent Instructions

## What This Project Is

A first-party, fully auditable Claude Code MCP plugin that replaces `context-mode`.
It provides context-window optimization (sandbox execution, FTS5 knowledge base, session
continuity, web fetch) with maximum security — no pre-compiled bundles, no credential
leakage, no self-modifying hooks, no cloud sync, no CLAUDE.md injection into projects.

Plugin ID: `zc-ctx@zeroclaw`
License: MIT
Language: TypeScript (Node.js ≥ 18)

## Directory Layout

```
SecureContext/
├── .claude/                  # Project-local agent memory and docs
│   ├── MEMORY.md             # Agent memory index (this project)
│   ├── docs/
│   │   ├── architecture.md   # Full architecture reference
│   │   ├── security.md       # Security model and threat analysis
│   │   └── progress.md       # Build progress log
├── .claude-plugin/
│   └── plugin.json           # Claude plugin manifest
├── src/
│   ├── server.ts             # MCP server entrypoint — 6 tools
│   ├── sandbox.ts            # Isolated code executor
│   ├── knowledge.ts          # SQLite FTS5 knowledge base
│   ├── session.ts            # Minimal session tracker
│   └── fetcher.ts            # Web fetch + markdown converter
├── hooks/
│   ├── pretooluse.mjs        # Read-only routing hook
│   └── posttooluse.mjs       # Read-only session capture hook
├── dist/                     # Compiled JS (never committed)
├── CLAUDE.md                 # THIS FILE — agent instructions
├── package.json
├── package-lock.json         # ALWAYS committed — locked deps
└── tsconfig.json
```

## Build Commands

```bash
npm install          # Install deps from lockfile only
npm run build        # tsc compile → dist/
npm run dev          # Watch mode compile
npm run lint         # ESLint check
npm test             # Vitest test suite
```

## Security Rules (NEVER violate these)

1. Sandbox MUST spawn with `env: { PATH: process.env.PATH }` only — zero credential vars
2. Sandbox MUST enforce: 30s timeout, 512KB stdout cap, 64KB stderr cap
3. Hooks MUST be read-only — no `writeFileSync`, `copyFileSync`, `mkdirSync` inside hooks
4. NEVER write to any user project directory (no CLAUDE.md injection)
5. NEVER do runtime `npm install` — all deps must be in package-lock.json
6. NEVER store raw tool responses in session — only: file paths, task names, error messages
7. Network fetch: strip `Authorization`, `Cookie`, `X-Api-Key` headers before sending
8. All SQLite DBs live in `~/.claude/zc-ctx/sessions/` — scoped per project hash
9. Session DB auto-wiped after 7 days of inactivity
10. No auto-update mechanism — plugin updates are manual only

## MCP Tools Exposed

| Tool | Description |
|---|---|
| `zc_execute(language, code)` | Run code in isolated sandbox |
| `zc_execute_file(path, language, code)` | File-based sandbox analysis |
| `zc_fetch(url, source?)` | Fetch URL → markdown → index into KB |
| `zc_index(content, source)` | Manually index text into session KB |
| `zc_search(queries[])` | BM25 FTS5 search across KB |
| `zc_batch(commands[], queries[])` | Commands + search in one call |

## Continuation Instructions for Future Agents

1. Read `.claude/MEMORY.md` first — it tracks build state and decisions
2. Read `.claude/docs/progress.md` — it logs what is done and what remains
3. Check `git log --oneline` — stable versions are tagged `v0.x.0`
4. Never break the 10 security rules above
5. Run `npm run build` after any `.ts` change and verify it compiles
6. Commit after every stable milestone with a descriptive message
7. Tag release commits: `git tag v0.x.0`
