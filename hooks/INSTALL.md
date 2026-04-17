# SecureContext Harness Hooks — Install

Three optional hooks ship with SC v0.10.0+. They enforce the harness rules described in [`AGENT_HARNESS.md`](../AGENT_HARNESS.md) automatically, so agents don't have to remember the discipline manually.

| Hook | Fires on | Effect |
|---|---|---|
| `preread-dedup.mjs` | `PreToolUse` matcher `Read` | Blocks duplicate Reads of the same file in one session. Redirects the agent to `zc_file_summary`. |
| `postedit-reindex.mjs` | `PostToolUse` matcher `Edit\|Write\|MultiEdit` | After any edit, regenerates the file's L0/L1 semantic summary via the local Ollama model. Clears the Read-dedup entry so the agent can Read the fresh version if needed. |
| `postbash-capture.mjs` | `PostToolUse` matcher `Bash` | Auto-archives bash outputs > 50 lines into the KB. Replaces the raw output in agent context with a compact head+tail summary + searchable source key. |

---

## Install

### 1. Copy the hook scripts

```bash
# PowerShell
Copy-Item -Path "<path-to-SecureContext>\hooks\*.mjs" -Destination "$env:USERPROFILE\.claude\hooks\" -Force

# bash / macOS / Linux
cp <path-to-SecureContext>/hooks/*.mjs ~/.claude/hooks/
```

### 2. Register the hooks in `~/.claude/settings.json`

Add to the top-level `hooks` key (merge with any existing hooks you have):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command",
            "command": "node \"<home>/.claude/hooks/preread-dedup.mjs\"" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command",
            "command": "node \"<home>/.claude/hooks/postedit-reindex.mjs\"" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command",
            "command": "node \"<home>/.claude/hooks/postbash-capture.mjs\"" }
        ]
      }
    ]
  }
}
```

Replace `<home>` with your actual home directory (e.g. `C:/Users/Amit` on Windows, `/Users/you` on macOS).

### 3. (Optional) set `ZC_CTX_DIST` if SC isn't at the default location

The hooks dynamic-import SC's `dist/` directory. By default they look at `~/AI_projects/SecureContext/dist`. If your install is elsewhere, set the env var in your shell profile:

```
# PowerShell profile
$env:ZC_CTX_DIST = "C:\path\to\SecureContext\dist"

# bash
export ZC_CTX_DIST="/path/to/SecureContext/dist"
```

### 4. Opt-outs (per hook)

| Env var | Effect |
|---|---|
| `ZC_READ_DEDUP_ENABLED=0` | Disable PreRead dedup |
| `ZC_BASH_CAPTURE_LINES=99999` | Effectively disable Bash capture (only 100k+ line outputs captured) |
| Remove the hook entry from settings.json | Hard disable |

---

## What to expect when they fire

### `preread-dedup.mjs` blocks a duplicate Read:

```
[zc-ctx harness] Read blocked: 'src/memory.ts' was already Read in this session.

Use one of:
  - zc_file_summary("src/memory.ts")  — L0/L1 summary, no re-Read
  - zc_search(["your question"])       — keyword+semantic search
  - zc_check("your question", path="src/memory.ts") — memory-first answer
```

The agent then picks the alternative and moves on without spending 4k+ tokens re-Reading the file.

### `postedit-reindex.mjs` (silent)

Runs fire-and-forget. No output unless there's a failure (in which case: silent — never breaks the agent).

### `postbash-capture.mjs` replaces a 2000-line test output:

```
[zc-ctx harness] Captured 2134 lines (exit 0, hash a3b7c9d2e1f0).
Full output searchable: zc_search(["npm test"]) or source='tool_output/a3b7c9d2e1f0...'.

## Summary (head + tail)
> zc-ctx@0.10.0 test
> vitest run
...
 Test Files  20 passed (20)
      Tests  449 passed (449)
```

Agent sees 200 tokens instead of 8000; full output is one `zc_search` away if needed.

---

## Uninstall

```bash
# PowerShell
Remove-Item "$env:USERPROFILE\.claude\hooks\preread-dedup.mjs"
Remove-Item "$env:USERPROFILE\.claude\hooks\postedit-reindex.mjs"
Remove-Item "$env:USERPROFILE\.claude\hooks\postbash-capture.mjs"
```

Then remove the `hooks` entries from `~/.claude/settings.json`.
