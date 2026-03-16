# SecureContext — Security Model & Threat Analysis

## Context-Mode CVE/Risk Analysis (what we replaced)

### 1. Pre-compiled Bundle Risk
- **context-mode** ships `server.bundle.mjs` — a minified/obfuscated single file
- Impossible to audit what the bundle actually does at runtime
- **Our fix**: TypeScript source only. `dist/` is compiled locally at install time.

### 2. Credential Passthrough (HIGH)
- context-mode sandbox passed full `process.env` to child processes
- This includes `GH_TOKEN`, `AWS_ACCESS_KEY_ID`, `ANTHROPIC_API_KEY`, etc.
- Any code the AI ran in the sandbox could exfiltrate all credentials via HTTP
- **Our fix**: Sandbox spawns with `env: { PATH: process.env.PATH }` — nothing else

### 3. Self-Healing Hooks (HIGH)
- context-mode hooks contained `copyFileSync` / `writeFileSync` to reinstall themselves
  if deleted — a persistence mechanism typical of malware
- This means uninstalling the hooks didn't actually uninstall them
- **Our fix**: Hooks are read-only plain `.mjs` files — zero filesystem writes

### 4. Raw Tool Response Capture (MEDIUM)
- context-mode PostToolUse hook captured full `tool_response` JSON into SQLite
- This means every file you read, every bash output, every API response was stored locally
- High-value exfiltration target if the DB is ever accessed by another process
- **Our fix**: Only capture: file paths touched, task names, error type+message. No content.

### 5. CLAUDE.md Injection Risk (MEDIUM)
- Plugins that write to project CLAUDE.md can permanently alter AI behavior for that project
- context-mode had mechanisms to write context-mode instructions into global CLAUDE.md
- **Our fix**: Zero writes to any user project directory. Explicitly tested.

### 6. Auto-Update Attack Surface (MEDIUM)
- Auto-updating plugins can silently ship new malicious code
- context-mode had an auto-update channel
- **Our fix**: No auto-update. Updates are manual: user runs `claude plugin update zc-ctx`.

### 7. Network Credential Leakage (LOW-MEDIUM)
- Web fetcher that passes Authorization/Cookie headers to arbitrary URLs
- **Our fix**: Strip `authorization`, `cookie`, `x-api-key`, `x-auth-token` headers before fetch.

## Threat Model

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|------------|
| Credential exfil via sandbox | High | Critical | Minimal env |
| Malicious code in bundle | Medium | Critical | Source-only |
| Hook persistence | Low | High | Read-only hooks |
| Session DB exfil | Low | Medium | No content stored |
| Supply chain via npm | Medium | High | Locked package-lock.json, minimal deps |
| CLAUDE.md injection | Low | High | Zero project writes |

## Dependency Policy

Allowed direct dependencies (minimal surface):
- `@modelcontextprotocol/sdk` — MCP server framework (Anthropic-maintained)
- `better-sqlite3` — Synchronous SQLite, no network, well-audited
- `node-fetch` or native `fetch` (Node ≥ 18) — Web fetch

Dev dependencies only:
- `typescript`, `@types/node`, `@types/better-sqlite3`

**Prohibited**: Any dependency that makes network calls at startup, any dependency
with postinstall scripts that execute compiled binaries.
