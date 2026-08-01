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

## Edit mode — for multi-iteration edit sessions (v0.55.3)

The summary redirect saves tokens on *orientation* reads, but an agent editing a
file needs the literal bytes (`Edit` matches on `old_string`), and an
edit→test→fix loop would otherwise pay a summary round-trip on every iteration.

**Instruct your agents** (in your CLAUDE.md / system prompt) to engage edit mode
*before* starting any multi-edit work, scoped to the files in their plan:

```bash
node ~/.claude/hooks/zc-edit-mode.mjs on 30 src/foo.ts src/bar.ts   # scoped (preferred)
node ~/.claude/hooks/zc-edit-mode.mjs on 30                          # whole project
node ~/.claude/hooks/zc-edit-mode.mjs off                            # when done
node ~/.claude/hooks/zc-edit-mode.mjs status
```

While active, Reads of the scoped files return full bytes with no summary
detour. Three properties keep it safe:

- **Auto-expiry** (default 30 min): a forgotten mode cannot disable the redirect
  forever — blocks return by themselves, against summaries that
  `postedit-reindex` has already refreshed from the edited files.
- **Blast radius is never suspended**: the `prewrite-impact` hook still fires on
  the first Edit/Write of each file, so the agent sees the cross-file callers of
  the function it is changing even with summaries off.
- **Scoped beats global**: files outside the named set still get summaries.

Suggested agent rule: *one-off edit → `zc_file_summary` then a ranged Read;
two or more expected iterations on the same file(s) → edit mode first, before
the first read.* Agents that skip the rule learn the command from the redirect's
own block message — the cost of non-compliance is exactly one turn, once; the
adaptive bypass ledger (per file+mtime) then suppresses further blocks for that
file version anyway.

Measured effect of the adaptive stack (real headless-agent A/B, comprehension
task over 67k-token files): the old deny-always redirect cost **+61.9%** billed
tokens versus no redirect; with the ledger warm the same task ran at **−0.9%** —
the penalty is fully eliminated while the ~98% per-read saving on orientation
reads is retained. See `docs/TOKEN_SAVINGS_MEASUREMENT.md`.
