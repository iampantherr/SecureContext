# SecureContext — Architecture Reference

## Component Overview

```
Claude Code (host)
    │
    ├── PreToolUse hook (hooks/pretooluse.mjs)
    │       Routes large-output tools through zc_execute sandbox
    │
    ├── PostToolUse hook (hooks/posttooluse.mjs)
    │       Captures: file paths, task names, errors → session DB
    │
    └── MCP Server (dist/server.js)
            │
            ├── zc_execute / zc_execute_file → sandbox.ts
            │       child_process.spawn, minimal env, timeout, output cap
            │
            ├── zc_fetch → fetcher.ts
            │       fetch → strip credentials → readability → markdown → knowledge.ts
            │
            ├── zc_index → knowledge.ts
            │       SQLite FTS5 INSERT
            │
            ├── zc_search → knowledge.ts
            │       SQLite FTS5 BM25 ranked query
            │
            └── zc_batch → sandbox.ts + knowledge.ts
                    Parallel: run commands + search KB in one tool call
```

## Storage Layout

```
~/.claude/zc-ctx/
└── sessions/
    └── <sha256-of-project-path>.db    # One DB per project
        ├── TABLE: knowledge (FTS5)
        │   id, source, content, created_at
        ├── TABLE: sessions
        │   id, project_hash, created_at, last_active
        └── TABLE: events (minimal capture)
            id, session_id, event_type, file_path, task_name, error_type, created_at
```

## Sandbox Security Boundary

```
zc_execute call
    │
    ▼
spawn(interpreter, ['-c', code], {
  env: { PATH: process.env.PATH },   // ← only this, nothing else
  timeout: 30_000,                   // ← 30 second hard kill
  stdio: ['ignore', 'pipe', 'pipe']  // ← no stdin
})
    │
    ├── stdout capped at 512KB → truncated with "[TRUNCATED]" marker
    ├── stderr capped at 64KB  → truncated with "[TRUNCATED]" marker
    └── exit code returned alongside output
```

Supported languages:
- `python` → `python3 -c <code>` or temp file for multi-line
- `javascript` / `js` → `node --input-type=module`
- `bash` / `sh` → `bash -c <code>`
- `typescript` / `ts` → compile via `tsc --module esnext` then node (if tsc available)

## Knowledge Base (FTS5)

```sql
CREATE VIRTUAL TABLE knowledge USING fts5(
  source,     -- URL or label
  content,    -- Indexed text
  created_at UNINDEXED,
  tokenize='porter unicode61'
);
```

- BM25 ranking: `ORDER BY rank` (SQLite FTS5 native BM25)
- Max results: 10 per query
- Auto-purge: entries older than 7 days deleted on session open
- Session-scoped: only the current project's DB is queried

## Hook Design (Read-Only)

### pretooluse.mjs
- Reads `tool_name` and `tool_input` from stdin JSON
- If tool is `Bash` and command length > 500 chars: emit `zc_execute` suggestion
- If tool is `Read` with a path > 5MB: emit warning
- NEVER writes any file
- NEVER modifies hook files themselves

### posttooluse.mjs
- Reads `tool_name`, `tool_response` from stdin JSON
- Extracts ONLY: file paths from Write/Edit responses, error messages from Bash
- Writes extracted metadata to session DB (never raw content)
- NEVER writes any file outside `~/.claude/zc-ctx/`

## Plugin Manifest

```json
{
  "name": "zc-ctx",
  "version": "0.1.0",
  "description": "Secure context optimization for Claude Code",
  "marketplace": "zeroclaw",
  "type": "mcp",
  "mcp": {
    "command": "node",
    "args": ["dist/server.js"],
    "cwd": "."
  },
  "hooks": {
    "PreToolUse": ["hooks/pretooluse.mjs"],
    "PostToolUse": ["hooks/posttooluse.mjs"]
  },
  "permissions": {
    "filesystem": ["~/.claude/zc-ctx/"],
    "network": true,
    "shell": true
  }
}
```
