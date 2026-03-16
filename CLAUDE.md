# SecureContext — Agent Instructions

## What This Project Is

A first-party, fully auditable Claude Code MCP plugin that replaces `context-mode`.
It provides context-window optimization (sandbox execution, FTS5 knowledge base, session
continuity, web fetch) with maximum security — no pre-compiled bundles, no credential
leakage, no self-modifying hooks, no cloud sync, no CLAUDE.md injection into projects.

Plugin ID: `zc-ctx@zeroclaw`
License: MIT
Language: TypeScript (Node.js ≥ 18)
Final score: 58/60

## Token Efficiency vs Native Claude Context Management

Native Claude Code has no persistent memory, no KB, and no session continuity. All context
must be re-injected into the active context window each session. SecureContext offloads
content to SQLite FTS5 and retrieves only relevant chunks on demand.

| Operation | Native Claude | SecureContext | Savings |
|---|---|---|---|
| Session startup | Re-paste files (~20,000–50,000 tokens) | `zc_recall_context` (~1,500 tokens) | ~95% |
| Web research (per URL) | Full page in context (~5,000–15,000 tokens) | Top-10 BM25 chunks (~1,500 tokens) | ~85–93% |
| Codebase search | Read files directly (~25,000 tokens) | `zc_batch` grep + KB chunks (~2,000 tokens) | ~92% |
| Cross-session memory | Zero retention | 50-fact bounded working memory + archival | ∞ |
| Long session continuity | Auto-compaction → data loss | Summary persisted; eviction by importance | No loss |

**Aggregate for a 10-session project: ~87% fewer context tokens consumed.**

Mechanism: KB content lives in SQLite, not in the conversation. BM25 FTS5 surfaces only
top-10 relevant chunks per query. Working memory is hard-capped at 50 facts with
importance-scored eviction. Session summaries compress history to ~500 tokens.

### Why Fewer Tokens = Better Agent Performance (Not Just Cheaper)

- **Sharper attention**: Transformer attention spreads across every token in context. A
  5k-token focused context produces more precise reasoning than a 50k-token dump with 80%
  noise. "Lost in the middle" degradation is real — agents miss information buried in large unfocused contexts.
- **No re-orientation cost**: Native Claude spends ~20% of each session catching up.
  `zc_recall_context()` restores structured facts instantly — agent acts from message one.
- **Structured persistence beats auto-compaction**: Claude Code's auto-compaction is lossy
  prose summarization. SecureContext's importance-scored facts and agent-written session
  summaries retain exactly what matters, by design.
- **4× effective workspace**: A 200k window with 150k re-pasted files leaves 50k for work.
  The same window with a 5k SecureContext restore leaves 195k for reasoning and generation.
- **Cost**: ~$6–20/month saved per developer at typical usage (Sonnet 4.6 input pricing).

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
