# TODO — v0.28.1 hook-bypass closure

> **STATUS UPDATE (2026-07-28, v0.50.1):**
> **Bypass 2 (HMAC verify-before-execute) is CLOSED.** The hook now lives in
> the repo (`hooks/skill-script-hmac-verify.mjs`), gates on a shell-tool SET
> (Bash + PowerShell) instead of Bash alone, and `init.mjs` registers it under
> BOTH PreToolUse matchers (with per-(matcher, script) dedup so a second
> matcher registration isn't skipped). Verified: PowerShell invocation of an
> unadmitted skill script → blocked exit 2; Bash regression → blocked exit 2;
> benign PowerShell commands → pass exit 0. The `zc_execute`/`zc_execute_file`
> path noted below remains open (sandboxed, credential-isolated — lower risk).
> **Bypass 1 (PreRead block) remains OPEN** — it is token-discipline, not
> security, and is tracked separately.

Two real bypass paths discovered during v0.28.0 multi-agent E2E. Both
let an agent route around an existing security/discipline hook by
invoking a different tool than the hook intercepts.

Both fixes share one shape: **extend the hooks to scan the command body
of any tool that can spawn a child process — Bash, PowerShell, and any
future shell-equivalent tool — rather than gating on tool name alone.**

## Bypass 1 — PreRead block

**Today:** `~/.claude/hooks/preread-dedup.mjs` intercepts `Read` tool calls.
Files that aren't yet L0/L1-indexed get blocked with a "build the summary
first or pass `force_full_read: true`" message. The intent is to force
the agent into the token-saving notebook discipline.

**Bypass observed:** the agent hit the block, then used `Bash` with
`cat <file>` / `head <file>` / `tail <file>` (or `PowerShell` with
`Get-Content` / `Select-Object`) to read the file content. The hook
never fires because the tool isn't `Read`.

**Fix shape:**

1. Add a new PreToolUse hook (or extend an existing one) that fires on
   `Bash` AND `PowerShell` tool calls.
2. Scan the command body for file-read patterns:
   - Bash:       `cat <path>`, `head <path>`, `tail <path>`, `less <path>`, `more <path>`, `awk … <path>`, `grep … <path>`, `sed … <path>` (last positional arg of any of these)
   - PowerShell: `Get-Content <path>`, `gc <path>` (alias), `Select-Object <path>` (when piped from `Get-Content`), `Type <path>`, `Out-Host < <path>`
3. For each detected file-read, apply the same PreRead policy:
   - File is indexed → redirect (or block + suggest `zc_file_summary` first)
   - File not indexed → block with the same indexing-first instructions
   - `force_full_read`-equivalent escape: add a literal `#sc:raw` comment somewhere in the Bash command to opt out (mirrors the `force_full_read: true` flag)

Edge cases the hook must handle:
- Pipelines: `cat foo.ts | head -50` — only the FIRST `cat <path>` matters
- Wildcards: `cat *.md` — block with a clear message (we can't summarize wildcards)
- Stdin redirection: `command < foo.txt` — count as a read of foo.txt
- Substitution: `echo $(cat foo.json)` — also counts

## Bypass 2 — HMAC verify-before-execute

**Today:** `~/.claude/hooks/skill-script-hmac-verify.mjs` is registered
in `~/.claude/settings.json` under PreToolUse matcher `"Bash"`. When a
Bash command invokes a `<skill>/scripts/<script>.py`, the hook
recomputes the HMAC and blocks if it doesn't match the admission-time
HMAC. Tamper-detection.

**Bypass observed:** the agent used `PowerShell` to invoke
`python <skill>/scripts/<script>.py`. The hook doesn't fire because
its matcher is Bash-only. Tampered scripts would execute.

**Fix shape:**

1. Register the same `skill-script-hmac-verify.mjs` hook under
   PreToolUse matcher `"PowerShell"` (in addition to `"Bash"`).
2. The hook's regex already handles Windows paths
   (`C:\Users\...\.claude\skills\...`). It just needs to be invoked.
3. Add an integration test that confirms a PowerShell invocation of a
   tampered skill script gets blocked.

## Notes on scope

- Both fixes are hook changes, not core code changes. Low risk.
- Both fixes should ship together as v0.28.1 — they're variations of
  the same design gap.
- The PreRead bypass affects the *token-saving discipline*; the
  HMAC-verify bypass affects *security*. The latter is more serious.
- A future shell-equivalent tool (e.g. a `BashSession` or `Run` tool)
  would need the same hook coverage. Worth generalizing the matcher
  list to any process-spawning tool.

## Related — the open MCP-tools angle

The `zc_execute` and `zc_execute_file` MCP tools also spawn subprocesses.
If an agent uses `zc_execute("python", "<malicious code>")`, neither
hook fires. The HMAC-verify hook should probably also intercept these
two MCP calls (when the code body references a skill script path).
Lower priority — these tools are sandboxed and the operator typically
runs them deliberately.

## Acceptance criteria for v0.28.1

- [ ] PreRead-bypass test: agent attempts `Bash cat <indexed-file>` → blocked or redirected
- [ ] PreRead-bypass test: agent attempts `PowerShell Get-Content <indexed-file>` → blocked or redirected
- [ ] HMAC-verify-bypass test: tamper a skill script, attempt invocation via PowerShell → blocked with same error message as Bash
- [ ] Operator escape: `#sc:raw` comment in Bash command bypasses PreRead (parity with `force_full_read`)
- [ ] No regression on existing PreRead + HMAC-verify tests (Bash path still works as v0.26.0+)
- [ ] No regression on existing tool counters (telemetry should not double-count)
