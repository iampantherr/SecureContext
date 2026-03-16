# SecureContext — Agent Memory Index

## Project State
- [build-progress](docs/progress.md) — What is built, what remains, current milestone
- [architecture](docs/architecture.md) — Full design decisions and component specs
- [security-model](docs/security.md) — Threat model, CVE analysis, mitigations

## Key Decisions
- Replacing context-mode@1.0.22 (gitSHA: 8a837945) which had: pre-compiled bundle,
  credential passthrough, self-healing hooks, CLAUDE.md injection risk
- Plugin ID chosen: `zc-ctx@zeroclaw`
- Storage: `~/.claude/zc-ctx/sessions/<project-hash>.db`
- No cloud sync, no auto-update, MIT license
- TypeScript source only — no committed binaries
