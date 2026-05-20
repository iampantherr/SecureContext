# Bundled-script rules

These are the patterns the SecureContext admission gate's AST scanner blocks.

## Python

Bundled `scripts/*.py` MUST NOT contain:

| Pattern | Why blocked | Use instead |
|---|---|---|
| `eval(...)` | Arbitrary code execution | Use a proper parser |
| `exec(...)` | Arbitrary code execution | Refactor; never legitimate in a skill |
| `compile(...)` | Compile-then-eval is identical risk | Refactor |
| `__import__(some_var)` | Dynamic import = arbitrary code | Hardcode the import statement |
| `subprocess.run(..., shell=True)` | Shell injection | `shell=False` with argument list; OR declare `shell_exec_ok: true` |
| `subprocess.Popen(..., shell=True)` | Same | Same |
| `subprocess.call(..., shell=True)` | Same | Same |
| `os.system(...)` | Equivalent to `shell=True` | Same |
| `os.popen(...)` | Same | Same |
| `pickle.loads(...)`, `pickle.load(...)` | Arbitrary object construction | `json.loads`, `msgpack` |
| `dill.loads`, `marshal.loads` | Same | Same |
| `yaml.load(...)` (no Loader=) | PyYAML's default loader = arbitrary objects | `yaml.safe_load(...)` |

## JavaScript / Node

Bundled `scripts/*.{js,mjs,cjs}` MUST NOT contain:

| Pattern | Why blocked | Use instead |
|---|---|---|
| `eval(...)` | Arbitrary code execution | Refactor |
| `new Function(...)` | Eval-equivalent | Refactor |
| `child_process.exec(...)` | Shell injection | `child_process.spawn` with argv array |
| `child_process.execSync(...)` | Same | Same |
| `vm.runInNewContext(...)` | Arbitrary code execution | Refactor |
| `vm.runInThisContext(...)` | Same | Same |

`child_process.spawn` / `spawnSync` produce **warn** findings rather than
**block** — operator must audit those uses but they don't automatically
quarantine.

## Shell (.sh)

The AST scanner does not parse shell. By default, any bundled `.sh` is
treated as `unsupported_language` and the skill is quarantined.

To admit a skill that legitimately ships shell scripts:

```yaml
unsupported_scripts_ok: true
```

Operator must manually review the shell scripts. Common legitimate uses:

- `bash scripts/create-release.sh` — wrapping `gh release create` (typically safe)
- `bash scripts/init-repo.sh` — git init + first commit boilerplate
- `bash scripts/wait-for-ci.sh` — `gh run watch` polling

If the shell script is non-trivial, prefer rewriting in Python.

## Required style for all bundled scripts

1. **Args via `argparse` (Python) or `process.argv` / commander (Node).** Document them.
2. **stdout = the answer.** The agent reads stdout to decide what to do next.
3. **stderr = diagnostics.** Errors, progress, warnings.
4. **Exit code 0 = success.** Non-zero = failure with a stderr message explaining what.
5. **Idempotent where possible.** Re-running with same inputs produces same outputs (so operator can re-run after a failure).
6. **No `input()`, no TTY reads.** Scripts get all data from args or stdin.
7. **No long-running daemons.** Skills are step-by-step; long-running processes go in `~/.claude/agents/` instead.
8. **Read project config from `<project>/.<name>-config.json`** if you need project-specific values. Never hardcode.

## Data files under `scripts/`

The admission gate whitelists common data-file extensions (`.xml`, `.xsd`,
`.json`, `.yaml`, `.html`, `.css`, `.ttf`, `.png`, etc.) — these get
HMAC-stamped but not AST-scanned. This is so skills like `anthropic-docx`
can ship OOXML schemas under `scripts/office/` without false-positive
quarantines.

The complete whitelist is in `src/skills/script_scanner.ts:DATA_FILE_EXTENSIONS`.
