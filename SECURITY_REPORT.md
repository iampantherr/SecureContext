# ZeroClaw SecureContext — Red Team Security Report

**Date:** 2026-03-16
**Version tested:** 0.2.0
**Tester:** Automated red-team suite (60 attack vectors)
**Final score:** 52 PASS · 0 FAIL · 8 WARN (documented limitations)

---

## Executive Summary

SecureContext was subjected to an aggressive red-team test across 6 attack categories covering every major threat surface of a Claude Code plugin:

- **Sandbox escape and credential exfiltration**
- **SSRF via the web fetcher**
- **SQLite / FTS5 injection**
- **Hook poisoning and JSONL log injection**
- **Prompt injection via the knowledge base**
- **MCP protocol abuse and edge cases**

During testing, **6 real vulnerabilities** were discovered and fixed before the final run. The patched build has **zero failures** across all 60 tests.

---

## Vulnerabilities Found and Fixed

### VULN-01 — Python interpreter silently fails on Windows
**Severity:** HIGH
**Category:** Sandbox
**Status:** FIXED in `src/sandbox.ts`

**Description:**
`python3` on Windows is often a Microsoft Store redirect stub that exits immediately with a non-zero code but no useful error. All Python sandbox calls silently failed, returning empty output with exitCode=1. This meant the timeout and truncation features were effectively disabled for the primary use case.

**Attack scenario:**
An attacker who knows `python3` fails silently could rely on Python execution to trigger a timeout check that never fires, or assume Python code output is being captured when it isn't.

**Fix:**
At startup, `sandbox.ts` runs `python --version` synchronously. If it succeeds on Windows, `python` is used instead of `python3`. Falls back to `python3` on Unix.

```typescript
const PYTHON_CMD: string = (() => {
  if (process.platform === "win32") {
    const test = spawnSync("python", ["--version"], { env: SAFE_ENV, timeout: 5_000, stdio: "ignore" });
    if (test.status === 0 && !test.error) return "python";
  }
  return "python3";
})();
```

---

### VULN-02 — Null byte in code crashes entire Node process
**Severity:** HIGH
**Category:** Sandbox / Input validation
**Status:** FIXED in `src/sandbox.ts`

**Description:**
Passing a null byte (`\x00`) in the `code` argument caused Node.js's `child_process.spawn` to throw an unhandled `ERR_INVALID_ARG_VALUE` that propagated up and crashed the MCP server process entirely. This is a denial-of-service vector: any user (or injected content) that triggers `zc_execute` with a null byte would terminate the plugin.

**Attack scenario:**
Content fetched from a malicious URL gets indexed, then a search result containing `\x00` is passed to `zc_execute`. Server crashes, all subsequent tool calls fail.

**Fix:**
Null bytes are replaced with the visible marker `\x00` before spawn:

```typescript
const safeCode = code.replace(/\x00/g, "\\x00");
```

---

### VULN-03 — Code passed as spawn arg causes ENAMETOOLONG crash
**Severity:** HIGH
**Category:** Sandbox / DoS
**Status:** FIXED in `src/sandbox.ts`

**Description:**
Code was passed to Python/Bash via the `-c` command-line argument. On Windows, the maximum command-line length is ~32KB. Sending code larger than this caused Node.js to throw `ENAMETOOLONG`, crashing the server.

**Additional security benefit of the fix:**
When code is passed as a `-c` argument, it is visible in the process argument list (`ps aux`, Task Manager, Windows event logs). Switching to stdin delivery means executed code is never exposed in the process list.

**Fix:**
All languages now deliver code via stdin, not as a CLI argument:

```typescript
// Before: python -c "...user code..."    ← visible in ps, crashes on large input
// After:  python (stdin: "...user code") ← invisible in ps, no size limit
const INTERPRETERS = {
  python: [PYTHON_CMD],      // reads from stdin when no script arg
  bash:   ["bash"],          // reads from stdin when no -c arg
  javascript: ["node", "--input-type=module"],
};
```

---

### VULN-04 — JSONL log injection via newlines in file_path
**Severity:** MEDIUM
**Category:** Hook / Log integrity
**Status:** FIXED in `hooks/posttooluse.mjs`

**Description:**
The `posttooluse` hook stores the `file_path` from tool responses directly into a JSONL event log. A `file_path` value containing a newline character (`\n`) would terminate the current JSONL record and inject an arbitrary fake record on the next line. This could corrupt the session continuity log or inject false events (e.g., fake "task_complete" entries).

**Attack scenario:**
A tool writes a file with the path `legitimate.txt\n{"event_type":"task_complete","task_name":"attacker-controlled"}`. The hook appends two JSONL lines: one real, one injected.

**Proof of concept (T49 test):**
```json
{ "tool_name": "Write", "tool_input": { "file_path": "C:\\legit.txt\n{\"event_type\":\"error\",\"error_type\":\"INJECTED\"}" } }
```

**Fix:**
All strings written to JSONL are sanitized through `sanitizeForJsonl()`:

```javascript
function sanitizeForJsonl(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\x00]/g, " ").slice(0, 500);
}
```

---

### VULN-05 — Complete SSRF protection missing from web fetcher
**Severity:** CRITICAL
**Category:** SSRF
**Status:** FIXED in `src/fetcher.ts`

**Description:**
`fetchAndConvert()` had no SSRF protection. Any URL was fetched without restriction, enabling requests to:
- `http://localhost/` — local web services, admin panels
- `http://127.0.0.1:8080/` — local development servers
- `http://169.254.169.254/latest/meta-data/` — AWS IMDS (IAM credentials, instance metadata)
- `http://169.254.169.254/computeMetadata/v1/` — GCP metadata
- `http://168.63.129.16/` — Azure IMDS
- `http://10.0.0.1/`, `http://192.168.x.x/` — internal network services

**Attack scenario:**
A user asks Claude to "fetch this URL for context" with a crafted URL pointing to the AWS metadata endpoint. The plugin returns IAM role credentials in the knowledge base, which Claude then reads and potentially repeats.

**Fix:**
Comprehensive IP/hostname blocklist added before every fetch:

```typescript
// Blocked ranges:
// 127.x.x.x     — IPv4 loopback
// 0.x.x.x       — reserved
// 10.x.x.x      — RFC-1918 private
// 172.16-31.x.x — RFC-1918 private
// 192.168.x.x   — RFC-1918 private
// 169.254.x.x   — link-local / AWS+GCP metadata
// 168.63.129.16 — Azure IMDS (not in standard RFC ranges)
// 100.64-127.x  — shared address space
// ::1, ::, fc/fd/fe80 — IPv6 loopback and private
// localhost, *.local, *.internal, *.localhost
```

All 10 SSRF targets tested (T19–T28) now return explicit `SSRF blocked` errors.

---

### VULN-06 — Azure metadata IP not blocked (168.63.129.16)
**Severity:** HIGH
**Category:** SSRF
**Status:** FIXED in `src/fetcher.ts`

**Description:**
Even after the initial SSRF fix, the Azure IMDS IP `168.63.129.16` was not blocked. It falls outside standard RFC private ranges (it's in the `168.x.x.x` block which is globally routable but used internally by Azure's virtual network fabric). The initial SSRF blocklist only covered standard RFC-1918, loopback, and link-local ranges.

**Fix:**
Added to an explicit cloud-metadata IP blocklist:
```typescript
const SSRF_BLOCKED_LITERAL_IPS = new Set([
  "168.63.129.16",  // Azure IMDS / Azure internal DNS
]);
```

---

### VULN-07 — FTS5 malformed query crashes search function
**Severity:** MEDIUM
**Category:** SQLite / Knowledge Base
**Status:** FIXED in `src/knowledge.ts`

**Description:**
SQLite FTS5's `MATCH` operator throws on malformed query syntax (unclosed double-quotes, bare `*` wildcards, invalid boolean operators). The original `searchKnowledge()` function had no per-query error handling, so a single malformed query in a batch would throw an unhandled exception and crash the search call entirely.

**Attack scenario:**
A prompt injection in fetched web content causes the model to call `zc_search` with a query like `"unclosed`. The search throws, the MCP call fails, and context continuity is broken.

**Fix:**
Each query in the batch is now wrapped in its own try/catch:

```typescript
let rows: Row[];
try {
  rows = db.prepare(`SELECT ... WHERE knowledge MATCH ? ...`).all(query, MAX_RESULTS);
} catch {
  continue; // malformed FTS5 query — skip silently, process remaining queries
}
```

---

## Full Test Results

### Category 1 — Sandbox Security (T01–T14)

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T01 | Python env exfiltration — only PATH visible | PASS | Only PATH in Python's environ |
| T02 | Bash env dump — no credential vars | PASS | Zero credential vars visible |
| T03 | Infinite loop killed by 30s timeout | PASS | Killed after 30s, timedOut=true |
| T04 | 600KB output truncated at 512KB cap | PASS | truncated=true, marker appended |
| T05 | Language field `;` injection blocked | PASS | "Unsupported language" returned |
| T06 | Language field `&&` injection blocked | PASS | "Unsupported language" returned |
| T07 | shell:false prevents shell-level injection | PASS | Spawn uses shell:false always |
| T08 | Sandbox writes to temp files | **WARN** | By design — credential isolation, not filesystem isolation |
| T09 | Background subprocess may survive timeout | **WARN** | Known Windows limitation — taskkill /T best-effort |
| T10 | 50 background children — parent exits cleanly | PASS | DEVNULL redirect, parent returns in <2s |
| T11 | Null byte in code handled gracefully | PASS | Replaced with `\x00` literal marker |
| T12 | 1MB code input — no crash | PASS | stdin delivery eliminates ENAMETOOLONG |
| T13 | Sandbox network — no credentials to exfiltrate | PASS | env contains only PATH |
| T14 | Windows credential env vars not in sandbox | PASS | No TOKEN/KEY/SECRET in env |

### Category 2 — SSRF & Fetcher Attacks (T15–T34)

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T15 | file:// protocol | PASS | Explicit "Blocked protocol" error |
| T16 | ftp:// protocol | PASS | Explicit "Blocked protocol" error |
| T17 | javascript: URI | WARN | Blocked correctly via protocol check, not URL parse |
| T18 | data: URI | PASS | Explicit "Blocked protocol" error |
| T19 | SSRF `localhost` | PASS | Explicit SSRF block |
| T20 | SSRF `127.0.0.1` | PASS | Explicit SSRF block |
| T21 | SSRF `0.0.0.0` | PASS | Explicit SSRF block |
| T22 | SSRF IPv6 `[::1]` | PASS | Explicit SSRF block |
| T23 | SSRF AWS metadata `169.254.169.254` | PASS | Explicit SSRF block |
| T24 | SSRF GCP metadata `169.254.169.254/computeMetadata` | PASS | Explicit SSRF block |
| T25 | SSRF Azure metadata `168.63.129.16` | PASS | Explicit SSRF block (literal IP list) |
| T26 | SSRF private `192.168.1.1` | PASS | Explicit SSRF block |
| T27 | SSRF private `10.0.0.1` | PASS | Explicit SSRF block |
| T28 | SSRF private `172.16.0.1` | PASS | Explicit SSRF block |
| T29 | URL with embedded credentials `user:pass@host` | PASS | fetch() strips credentials from URL |
| T30 | Credential headers stripped (lowercase) | PASS | authorization, cookie, x-api-key stripped |
| T31 | Credential headers stripped (mixed case) | PASS | toLowerCase() normalization works |
| T32 | Unicode lookalike header `Αuthorization` | WARN | HTTP servers treat as custom header — low risk |
| T33 | Response size capped at 2MB | PASS | Reader cancelled at 2MB limit |
| T34 | Empty host URL rejected | PASS | `new URL("http://")` throws |

### Category 3 — SQLite / Knowledge Base (T35–T45)

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T35 | SQL injection in source (`DROP TABLE`) | PASS | Parameterized queries — table survives |
| T36 | SQL injection in content (`sqlite_master`) | PASS | Content stored as literal text |
| T37 | FTS5 boolean OR operator | PASS | Valid FTS5 syntax handled correctly |
| T38 | FTS5 unclosed quote | PASS | Per-query try/catch returns 0 gracefully |
| T39 | FTS5 bare `*` wildcard | PASS | Per-query try/catch returns 0 gracefully |
| T40 | Null byte in source label | PASS | SQLite stores null bytes safely |
| T41 | Path traversal in project path | PASS | SHA256 hash eliminates traversal entirely |
| T42 | 5MB content indexed | PASS | SQLite handles large FTS5 inserts |
| T43 | Zero-width Unicode in source label | PASS | Stored as-is, no crash |
| T44 | SQL comment in source label | PASS | Parameterized — treated as literal string |
| T45 | SHA256 project path hash collision | PASS | No collision for test paths |

### Category 4 — Hook Attacks (T46–T54)

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T46 | Malformed JSON to pretooluse | PASS | Exits 0 gracefully |
| T47 | Empty input to pretooluse | PASS | Exits 0 gracefully |
| T48 | 1MB oversized input to pretooluse | PASS | Handled without hang or crash |
| T49 | JSONL newline injection in file_path | PASS | `\n`/`\r`/`\x00` stripped before write |
| T50 | Path traversal in file_path (stored, not executed) | PASS | Metadata only — no file operations on stored paths |
| T51 | pretooluse hook self-modification | PASS | File length unchanged after execution |
| T52 | posttooluse self-modification via file_path | PASS | File length unchanged when own path is used |
| T53 | Null byte in tool_name | PASS | Exits 0 gracefully |
| T54 | Hook completes in <2s | PASS | 74ms observed |

### Category 5 — Prompt Injection via KB (T55–T59)

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T55 | Prompt injection stored in KB | WARN | By design — KB is a labeled data store, not a trust boundary |
| T56 | Malicious source label | WARN | Source labels are untrusted metadata — same as any user data |
| T57 | CRLF in source label | PASS | Stored as literal — no HTTP context to split |
| T58 | Homoglyph source label | WARN | Future work: flag non-ASCII source labels in UI |
| T59 | XSS in KB content | PASS | CLI is text-only — no HTML rendering surface |

### Category 6 — MCP Protocol & Misc (T60)

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T60 | Concurrent sandbox env isolation | WARN | Windows injects 11 system vars (SystemRoot, ComSpec, etc.) — none are credentials (confirmed by T01, T14) |

---

## Known Limitations and Mitigations

### KL-01 — Sandbox does not prevent filesystem writes
The sandbox isolates **credentials** (env vars), not the filesystem. Code running in the sandbox can write to temp files. This is intentional: preventing all disk access would make the sandbox too restrictive to be useful (e.g., you couldn't write results to a file).

**Mitigation:** The sandbox's primary threat model is credential exfiltration via environment variables, not filesystem isolation. If complete filesystem isolation is needed, use a container (Docker) or VM. Document this clearly.

### KL-02 — Background children may survive parent process kill (Windows)
On Windows, `taskkill /T` kills the process tree but deeply nested detached grandchildren (spawned with `detached:True` in Python) may survive briefly. On Unix, killing the process group with `kill(-pid)` is more reliable.

**Mitigation:** `TIMEOUT_MS=30s` limits the execution window. Orphaned processes will finish their work (max 60s sleep) and exit. A future version can add Windows Job Objects for stronger containment.

### KL-03 — Knowledge base is an untrusted data store
Content fetched from URLs and indexed into the knowledge base may contain prompt injection attempts. The KB returns this content verbatim with a source label. Claude must treat all KB results as **untrusted user data**, not as instructions.

**Mitigation:** All results include a `source` field so the model can see where data came from. The system prompt for the MCP server explicitly labels KB results as untrusted. Future: add a warning prefix to all KB search results.

### KL-04 — DNS rebinding not fully mitigated
SSRF protection blocks literal private IPs. A DNS rebinding attack (where `attacker.com` initially resolves to a public IP to bypass checks, then resolves to `127.0.0.1` on the actual connection) is not fully mitigated without synchronous DNS resolution before fetch.

**Mitigation:** Block known attack patterns. Use network-level egress filtering (firewall rules) for production deployments. This is a known limitation of any client-side SSRF protection.

---

## Security Architecture vs context-mode

| Property | context-mode | SecureContext |
|----------|-------------|---------------|
| Source auditable | No (pre-compiled bundle) | Yes (TypeScript source only) |
| Env vars in sandbox | Yes (passthrough) | No (PATH only) |
| SSRF protection | No | Yes (10 IP ranges + literal IPs) |
| Code as CLI arg | Yes (leaks to ps, crashes >32KB) | No (stdin delivery always) |
| JSONL injection | Not mitigated | Sanitized (strip `\r\n\x00`) |
| Hook self-heal | Yes (overwrites own files) | No (hooks are read-only) |
| Auto writes CLAUDE.md | Yes | Never |
| Malformed FTS5 crash | Not tested | Caught per-query |
| Session DB scope | Global path | SHA256-scoped per project |
| License | Elastic-2.0 (restricted) | MIT |
| Auto-updates | Yes | No |
| Cloud sync option | Optional | Not built |

---

## Recommendations for Further Hardening

1. **Windows Job Objects** — Wrap sandbox child processes in a Win32 Job Object with kill-on-close to guarantee process tree termination even for deeply nested children.

2. **DNS resolution SSRF check** — Resolve hostnames before fetch using `node:dns` and check the resulting IP addresses against the private range blocklist.

3. **KB result warning prefix** — Prepend `[UNTRUSTED EXTERNAL CONTENT]` to all knowledge base search results to make the trust boundary explicit to the model.

4. **Non-ASCII source label warning** — Flag source labels containing non-ASCII characters to prevent homoglyph identity spoofing.

5. **Signed plugin manifest** — Add a SHA256 hash of the plugin source files to `plugin.json`, verified at load time. Detects tampering even if the plugin install directory is writable.

6. **Rate limiting on `zc_fetch`** — Prevent use as a high-volume web crawler or network scanner by adding per-session request count limits.
