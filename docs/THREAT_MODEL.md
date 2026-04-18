# SecureContext — Threat Model

**Version:** 1.0
**Last updated:** 2026-04-18 (v0.10.5)
**Status:** active — covers SC v0.6.0 through v0.10.5+ surfaces; will expand for Sprints 1-4 as those ship

This document describes what SecureContext defends against, what's intentionally out of scope, and how the architectural defenses work. Operators reviewing SC for production use should read this alongside `SECURITY_REPORT.md`.

---

## Trust boundaries

```
┌─────────────────────────────────────────────────────────┐
│  TRUSTED ZONE                                           │
│                                                         │
│  ┌────────────┐  stdin/stdout  ┌─────────────────────┐  │
│  │  Claude    │ ◄────────────► │  MCP Server         │  │
│  │  Code/Apps │  (JSON-RPC)    │  (dist/server.js)   │  │
│  └────────────┘                └──────────┬──────────┘  │
│                                            │             │
│                                            │ local       │
│                                            ▼             │
│                              ┌─────────────────────┐    │
│                              │  SQLite (per-proj)  │    │
│                              │  Postgres (opt)     │    │
│                              │  Ollama (local LLM) │    │
│                              │  ~/.claude/zc-ctx/  │    │
│                              └─────────────────────┘    │
└─────────────────────────────────────────────────────────┘
              │
              │ TLS
              ▼
   ┌──────────────────┐
   │ SEMI-TRUSTED     │
   │ Anthropic API    │
   │ (encrypted, but  │
   │  external)       │
   └──────────────────┘
              │
              │ HTTPS+SSRF defense
              ▼
   ┌──────────────────┐
   │ UNTRUSTED        │
   │ External web     │
   │ Source files     │
   │ Skill markdown   │
   │ (any data the    │
   │  agent ingests)  │
   └──────────────────┘
```

### What we trust

- The local OS (filesystem permissions, process isolation, memory safety)
- The Node.js runtime (sandboxed by V8)
- The local Postgres/SQLite installations
- The local Ollama installation
- The user's session (Claude Code or other MCP client)
- TLS to the Anthropic API

### What we do NOT trust

- **Source files indexed for L0/L1 generation** — could contain prompt-injection
- **Web content fetched via `zc_fetch`** — untrusted content with injection-pre-filter
- **Documents fed to reranker / HyDE** (Sprint 4) — untrusted
- **Skill markdown from external sources** (Sprint 2) — treated as code, not configuration
- **Mutation candidates** (Sprint 2) — validated before replay
- **Any tool input** that contains URLs, file paths, or code snippets — sanitized before use

---

## Attacker capabilities (worst-case assumed)

We design defenses assuming an attacker can do at least one of these:

| # | Capability | Mitigation strategy |
|---|---|---|
| 1 | **Local code execution** in a project dir (e.g. malicious source files) | Sandbox isolation; prompt-injection scanner; secret scanner blocks egress |
| 2 | **Network adversary** intercepting Anthropic API calls | TLS; HMAC integrity on all stored tamper-evidence; no secrets in API request bodies |
| 3 | **Compromised npm dependency** | Pinned `package-lock.json`; weekly `npm audit` (Sprint 0+); no auto-update |
| 4 | **Compromised local Ollama** serving manipulated outputs | Response validation; output length caps; no exec from LLM output |
| 5 | **Insider with workstation access** — can read SQLite files, env vars | Hash-chained tamper evidence; audit log catches ANY modification |
| 6 | **Supply-chain attack on skills** (Sprint 2) — malicious skill installed | Skill body scanned at load; HMAC signatures on promotion; operator confirmation for new skills |
| 7 | **Tool input containing prompt injection** | Input scanned + wrapped in `[BEGIN/END]` boundary markers; output length capped |
| 8 | **Adversary with full DB write access** | HMAC-keyed hash chains (v0.10.5+) — attacker can't forge valid hashes without machine secret |

---

## Assets to protect (priority order)

| Rank | Asset | Why it ranks here |
|---|---|---|
| 1 | **Anthropic API credentials** | Drains money + impersonation risk; highest blast radius |
| 2 | **User credentials in environment** (DB passwords, GH_TOKEN, AWS keys, etc.) | Lateral movement; data theft |
| 3 | **Source code IP** | Don't leak project content to unauthorized observers |
| 4 | **Audit log integrity** | Tamper-detection of agent actions; foundation of incident response |
| 5 | **Conversation history** | PII, decisions, IP |
| 6 | **Cost / billing accuracy** | Don't let an attacker manipulate cost reports to hide abuse |

---

## Architectural defenses

### From v0.6.0–v0.9.0

- **Credential-isolated sandbox** (`src/sandbox.ts`) — code execution gets `PATH`-only env vars, no secrets leak in
- **SSRF protection** (`src/fetcher.ts`) — multi-layer URL validation before any network call
- **Prompt-injection pre-filter** — scan + redact known patterns from fetched web content
- **Per-project DB isolation** — SHA256-hashed database paths; no cross-project leakage
- **Hash chain integrity** (`src/chain.ts`) — broadcasts table tamper-detected via SHA256 chain (Biba integrity model, Ch. 13 of Chin & Older 2011)
- **RBAC** (`src/access-control.ts`) — HMAC-signed session tokens bound to `agent_id` + `role`
- **Capability confinement** (Ch. 11) — `agent_id` validated against token's bound `aid` claim at the reference monitor
- **Channel key authentication** — scrypt-hardened (OWASP Interactive Login params)
- **Non-transitive delegation** (Ch. 7) — tokens scoped to issuing project only

### Added in v0.10.5 (Sprint 0)

- **Machine secret** (`src/security/machine_secret.ts`) — single per-machine 64-byte CSPRNG secret stored at `~/.claude/zc-ctx/.machine_secret` with file mode 0600. Used as HMAC key for new tamper-evidence chains.
- **Generic HMAC chain** (`src/security/hmac_chain.ts`) — reusable primitive for any new tamper-evident table. **Stronger than v0.9.0 SHA256 chains:** an attacker with full DB access cannot forge valid `row_hash` without the machine secret.
- **Audit log** (`src/security/audit_log.ts`) — append-only, HMAC-chained log of every privileged operation (`token_issued`, `secret_scanner_match`, `skill_promoted`, etc.). Stored at `~/.claude/zc-ctx/logs/audit.log`. Verifiable via `verifyAuditChain()`.
- **Secret scanner** (`src/security/secret_scanner.ts`) — detects API keys (Anthropic, OpenAI, AWS, GitHub, Google, Slack, Stripe), JWTs, SSH private keys, Bearer tokens, and high-entropy strings. Used at every external egress boundary.

### Architectural principles applied throughout

1. **Defense in depth** — every component has at least 3 layers (input validation, authorization, audit logging).
2. **Least privilege** — every component runs with minimum permissions (e.g. telemetry can only INSERT, not UPDATE/DELETE).
3. **Secure-by-default** — every config defaults to the most secure option; opt-out is explicit.
4. **Cryptographic integrity** — hash chains everywhere tamper-detection matters.
5. **Secrets management** — secrets never appear in logs (even DEBUG); never in tool inputs sent to LLM; never in API request bodies.
6. **Adversarial input handling** — all untrusted content scanned + wrapped in boundary markers; never executed.
7. **Audit + forensics** — every privileged operation logged to immutable audit chain.
8. **Supply chain security** — pinned deps; weekly `npm audit`; explicit model allowlists; manual review for skill installations.

---

## Out of scope (intentionally)

These are NOT defended against — assumed beyond our control or accepted risk:

- **Persistent root-level malware on the operator's machine.** We trust the OS up to a point. If the attacker is root, they can read the machine secret regardless of file permissions.
- **Side-channel attacks on the GPU** (Ollama-related). Ollama's local inference is treated as a trusted service; GPU side-channels would compromise any local model.
- **Quantum break of TLS / SHA256 / HMAC-SHA256.** Standard crypto assumptions.
- **User explicitly opting out of safety controls** (e.g. setting `ZC_RBAC_ENFORCE=0`). Documented; operator's choice.
- **Misuse by authorized agents.** RBAC restricts what agents can do; it does not prevent an agent with valid permissions from doing something the operator later regrets. Audit log captures the trail.

---

## Compliance + privacy

- **All telemetry stays LOCAL** by default (SQLite per-project). Centralized Postgres is opt-in.
- **No telemetry leaves the machine** without explicit operator action (`ZC_API_URL` set, batch API submissions).
- **Anthropic API submissions** follow Anthropic's privacy policy; data isolated per organization.
- **Conversation history retention** — 30 days for INFO logs; 365 for AUDIT; configurable.
- **Right to deletion** — `zc_purge_session(session_id)` removes all data referencing that session (chain remains; row contents replaced with `[REDACTED]` markers).

---

## Incident response (per `HARNESS_EVOLUTION_PLAN.md` §15.8 internal reference)

If a security incident is suspected:

1. **Preserve evidence:** AUDIT log is immutable + chain-protected. Snapshot DB.
2. **Quarantine:** revoke all session tokens; require re-issuance.
3. **Diagnose:** `verifyAuditChain()` + `verifyChain()` (broadcasts) + `secret_scanner` review of recent inputs.
4. **Contain:** disable mutation engine if mutation-related; disable skill loading if skill-related.
5. **Recover:** restore from snapshot if integrity broken; archive corrupted data for forensics.
6. **Report:** generate incident report from AUDIT log + chain verification + relevant tool_calls.

---

## Reporting security issues

If you discover a security issue in SecureContext, please report it via GitHub Issues with the `security` label, OR contact the maintainer directly via the email in the repository profile. We aim to acknowledge within 48 hours and fix critical issues within 7 days.

DO NOT post details of unpatched vulnerabilities publicly until coordinated disclosure is complete.

---

## Revision history

| Date | Version | Change |
|---|---|---|
| 2026-04-18 | 1.0 | Initial. Covers v0.6.0–v0.10.5 surfaces. Sprint 0 modules added (machine_secret, hmac_chain, audit_log, secret_scanner). |
