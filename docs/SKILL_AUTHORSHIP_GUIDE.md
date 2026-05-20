# Skill Authorship Guide

> How to write Anthropic-style filesystem skills that pass SecureContext's admission gate and actually get used by agents.

This document is the canonical reference for writing skills. Every skill in `examples/skills/` follows these rules, and the `writing-skills` meta-skill enforces them via its bundled linter.

## What a skill is (and isn't)

A **skill** is a directory at `~/.claude/skills/<name>/` (global) or `<project>/.claude/skills/<name>/` (project-scoped) containing:

1. A `SKILL.md` file with YAML frontmatter and a procedural body
2. Optionally, bundled scripts under `scripts/` that the agent invokes via Bash
3. Optionally, reference docs under `references/` that the agent reads on demand

The skill loads in three layers (Anthropic's "progressive disclosure"):

- **L1** — the `description` field in the frontmatter (~100 tokens). Always in the agent's context.
- **L2** — the SKILL.md body (≤5,000 tokens). Loaded when the description matches the user's request.
- **L3** — the bundled `scripts/` and `references/`. Loaded on demand when the body says to read or run them.

A skill is **not**:

- A copy of a prompt. If you'd write it once, it's a prompt, not a skill.
- A factual document. Facts go in `references/` or in `zc_remember`. Skills are *procedures*.
- A one-off task. If a procedure isn't worth running ≥3 times, it doesn't need to be a skill.

## The four invariants every skill must satisfy

The `writing-skills` meta-skill's `scripts/lint-skill.py` checks these. If any fail, the admission gate will reject your skill.

### 1. Trigger is a one-sentence "use this whenever X" rule

Wrong:

```yaml
description: A utility for working with YouTube videos.
```

Right:

```yaml
description: |
  Use this whenever the user pastes a YouTube URL (youtube.com or youtu.be) or
  asks to learn from / summarize / extract content from a YouTube video. The
  skill fetches the transcript and returns it for the agent to reason over.
```

The trigger is what the agent matches against to decide whether to load L2. Vague triggers = the skill never fires; specific triggers = the skill fires reliably on the right requests.

### 2. Body is procedural

Numbered steps. Not narrative. Not "here's some context, you figure it out."

Wrong:

```markdown
This skill helps with publishing releases. Releases involve several things
including versioning, changelogs, and tags. Make sure to handle all of them.
```

Right:

```markdown
## Procedure

1. Run `scripts/preflight.py` — exits non-zero if working tree dirty or CI red.
2. Run `python scripts/bump-version.py {major|minor|patch}` — updates all version
   references atomically.
3. Run `python scripts/regenerate-changelog.py` — generates the new CHANGELOG
   section from `git log`. Operator reviews before commit.
4. `git commit -m "vX.Y.Z — <title>" && git push origin main`
5. Run `bash scripts/wait-for-ci.sh` — polls `gh run watch`, exits non-zero if red.
6. Run `bash scripts/create-release.sh vX.Y.Z`.
```

### 3. Bundled scripts are single-responsibility

One script, one job. If a script does three things, split it into three scripts. This:

- Makes the AST scanner happy (smaller scripts = fewer false positives)
- Makes the skill's procedure readable (each step maps to one script)
- Lets the agent reuse individual scripts in unrelated workflows

Wrong: `scripts/release.py` that bumps version, regenerates changelog, commits, pushes, tags, and creates release.

Right: `scripts/bump-version.py`, `scripts/regenerate-changelog.py`, `scripts/create-release.sh` — one each.

### 4. Scripts read project-specific config from a known location, never hardcode it

A global skill that touches a project-specific value (commit message template, custom CHANGELOG markers, deploy hooks) must read it from `<project>/.<skill-name>-config.json` OR `zc_remember(key='<skill-name>_config')`. Defaults must be sensible.

Wrong (hardcoded in script):

```python
COMMIT_PREFIX = "RevClear:"
```

Right (reads project config, falls back to default):

```python
def load_config(project_root: Path) -> dict:
    cfg_path = project_root / ".publish-config.json"
    if cfg_path.exists():
        return json.loads(cfg_path.read_text())
    return {"commit_prefix": ""}  # default

COMMIT_PREFIX = load_config(project_root).get("commit_prefix", "")
```

This is what makes a skill **truly global**. One skill, N project configs.

## Frontmatter schema (per Anthropic spec + SecureContext extensions)

```yaml
---
# === Required (Anthropic spec) ===
name: kebab-case-name              # ≤64 chars, lowercase, alphanumeric + - _
description: |                     # ≤1024 chars, MUST contain a clear trigger
  Use this whenever <X>. The skill <does Y>.

# === Optional (Anthropic spec) ===
allowed_tools: [Bash, Read, Edit]  # restricts which tools the skill may use
user_invocable: true               # default true
disable_model_invocation: false    # default false; true = skill only fires on explicit user request

# === SecureContext extensions ===
version: 1.0.0                     # semver
scope: global                      # global | project | quarantine
intended_roles: [developer]        # which roles benefit; used for role-prompt injection
tags: [release, git, github]

# === Admission-gate opt-ins (only set after manual review) ===
shell_exec_ok: false               # true → admit scripts that use subprocess(shell=True)
unsupported_scripts_ok: false      # true → admit .sh / .rb / etc. scripts the AST scanner can't parse
---
```

## Script-writing rules (admission gate enforces these)

These are the patterns the AST scanner blocks at admission. Avoid them, or your skill gets quarantined:

| Pattern | Why blocked | Alternative |
|---|---|---|
| `eval(...)`, `exec(...)`, `compile(...)` | Arbitrary code execution | Refactor; use a proper parser |
| `subprocess.Popen(..., shell=True)` | Shell injection vector | Use `shell=False` with argument list; or declare `shell_exec_ok: true` after review |
| `os.system(...)`, `os.popen(...)` | Same | Same as above |
| `pickle.loads(...)`, `pickle.load(...)` | Arbitrary object construction | Use JSON or msgpack |
| `__import__(user_input)` | Dynamic import = arbitrary code | Hardcode imports at top of file |
| `yaml.load(...)` (PyYAML, no `Loader=`) | Arbitrary Python object construction | Use `yaml.safe_load(...)` |
| `eval`, `new Function(...)` in JS | Same as Python `eval` | Refactor |
| `child_process.exec(...)` in JS | Shell injection | Use `spawn` with argument array |

The complete list lives in `scripts/py_ast_walker.py` and `src/skills/script_scanner.ts`.

### Required style for bundled scripts

- **Args via `argparse`** (Python) or `process.argv` (Node). Document them.
- **stdout = the answer.** Whatever the agent should read.
- **stderr = diagnostics.** Errors, progress, warnings.
- **Exit code 0 = success.** Non-zero = failure with a stderr message explaining what.
- **Idempotent where possible.** Re-running with same inputs produces same outputs.
- **No prompts for input.** Scripts never call `input()` or read TTY — they get all data from args or stdin.

## Composition: skills calling skills

Skills can invoke other skills via Bash. This is how you compose without duplicating:

```markdown
## Procedure

1. Generate the release notes: `python scripts/regenerate-changelog.py`
2. Ensure the README is current: invoke the `readme-author` skill —
   `python ~/.claude/skills/readme-author/scripts/regenerate.py`
3. Tag and push: `bash scripts/create-release.sh vX.Y.Z`
```

The admission gate doesn't care that one skill invokes another. Each script is HMAC-verified individually on every Bash call.

## When to make a skill **global** vs **project-local**

| Signal | Make it global | Make it project-local |
|---|---|---|
| Procedure works on standard files (package.json, CHANGELOG.md, README.md) | ✅ | |
| Procedure has zero hardcoded paths / project names / config values | ✅ | |
| Pattern has appeared in ≥2 different projects | ✅ | |
| Pattern references project-specific files (HANDOFF.md, CleanCheck-specific docs) | | ✅ |
| Pattern hardcodes project-specific URLs / DB IDs / ports | | ✅ |
| Pattern has only appeared in one project | | ✅ |

When in doubt: **start project-local, promote to global** once you see the pattern repeat in another project. The skill-spotter agent (v0.28.0-β) will surface promotion candidates automatically based on cross-project occurrence counts + a semantic project-binding check.

## How the admission gate actually evaluates your skill

When you drop a skill at `~/.claude/skills/foo/` and `sc-api` boots (or you call `POST /api/v1/skills/import-project`):

1. **`filesystem_skill_import.ts`** walks the directory.
2. **Frontmatter parse + validation** (`validateAnthropicFrontmatter`). Bad frontmatter → atomic-move to `~/.claude/skills.quarantine/<name>__<ts>/` with `.quarantine-reason.txt`.
3. **Per-script AST scan** (`script_scanner.ts` for JS, `py_ast_walker.py` for Python). Any block-severity finding without an explicit opt-in → quarantine.
4. **HMAC computation** — every file gets `HMAC-SHA256("script:" || content, machine_secret)`. Stored in `skill_hmacs` JSONB on `skills_pg`.
5. **Admission log entry** — HMAC-chained row in `skill_admission_log_pg` + JSONL anchor in `~/.claude/zc-ctx/logs/audit.log`.
6. **Skill is live.** Claude Code's native loader discovers it next session.

At runtime, every Bash invocation of `~/.claude/skills/<name>/scripts/*` goes through the `PreToolUse` hook that recomputes the HMAC and compares to the stored value. **Tamper a script after admission → next agent invocation gets blocked with a verbatim error message.**

## Testing your skill locally

The `writing-skills` meta-skill bundles two helpers:

```bash
# Lint a skill against the four invariants + Anthropic spec
python ~/.claude/skills/writing-skills/scripts/lint-skill.py ~/.claude/skills/my-new-skill/

# Preview what admission would do (without writing to PG)
python ~/.claude/skills/writing-skills/scripts/preview-admission.py ~/.claude/skills/my-new-skill/
```

Run both before you commit any new skill. If the linter passes, the admission gate will admit.

## The "where to start" question

If you're writing your first skill, start with one of:

1. **Something you do ≥3× a week that has clear steps.** Releasing a version, deploying to staging, updating a README, generating a status report.
2. **Something with a bundled script you already have.** If you have `scripts/foo.py` sitting around, wrap it in a SKILL.md. The procedural framing forces you to write down when to use it, which becomes the L1 trigger.
3. **A pattern you noticed yourself repeating across multiple Claude Code sessions.** That's the signal the skill-spotter would flag. Encode it.

Don't start with:

- A skill that needs to wrap an entire 12-step procedure. Break it into 2–4 smaller skills that compose.
- A skill whose trigger is vague ("for general project work"). The agent won't load it.
- A skill that just contains documentation. Documentation goes in `references/`, not in a procedural skill.

## Reference: end-to-end example skills

In this repo at `examples/skills/`:

- `writing-skills/` — the meta-skill: how to write skills (this guide + linter + admission preview)
- `publish-github-release/` — full release procedure: bump version, regenerate changelog, commit, push, tag, gh release create
- `readme-author/` — generate/update README from project metadata
- `architecture-doc-author/` — generate/update ARCHITECTURE.md from indexed code structure
- `setup-instructions-author/` — generate "how to install + run" from package.json + Dockerfile

Copy any of these to your `~/.claude/skills/` (global) or `<project>/.claude/skills/` (project-scoped), customize the project-config file, and the admission gate will admit on next boot.
