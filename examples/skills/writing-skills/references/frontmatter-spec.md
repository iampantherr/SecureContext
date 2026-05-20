# Frontmatter spec

Every `SKILL.md` starts with YAML frontmatter between `---` delimiters.
The admission gate validates this at admission and refuses to admit any
skill that violates the spec.

## Required fields (Anthropic spec)

```yaml
name: kebab-case-name
description: |
  Use this whenever <X>. The skill <Y>.
```

- `name`: ≤64 characters, must match `^[a-z0-9][a-z0-9_-]*$` (lowercase
  alphanumeric + `-` + `_`)
- `description`: ≤1024 characters. **Must contain a trigger phrase**
  (`use this whenever` or `use this when`). This is the L1 metadata the
  agent reads to decide whether to load the skill.

## Optional fields (Anthropic spec)

```yaml
allowed_tools: [Bash, Read, Edit]
user_invocable: true
disable_model_invocation: false
```

- `allowed_tools`: array of tool names this skill may call. Surfaced in
  the dashboard. (Not yet enforced at runtime — that's a future hardening.)
- `user_invocable`: boolean, default `true`. If `false`, the skill only
  fires on explicit user requests (slash commands), not from the model's
  judgment.
- `disable_model_invocation`: boolean, default `false`. If `true`, the
  model cannot auto-invoke this skill even if the description matches.
  Use for skills that touch destructive operations.

## SecureContext extensions

```yaml
version: 1.0.0
scope: global
intended_roles: [developer, devops]
tags: [release, git]
```

- `version`: semver string. Bump when you edit the skill — admission gate
  preserves the version in `skill_admission_log_pg` for audit.
- `scope`: `global` | `project` | `quarantine`. Auto-set by the admission
  importer; you usually don't set this manually.
- `intended_roles`: array of role names. The orchestrator uses this to
  inject the skill into matching workers' system prompts at spawn time.
- `tags`: array of strings. Free-form. Used for discovery + the marketplace
  filter.

## Admission-gate opt-ins

These flags exist because some legitimate skills need patterns the AST
scanner would otherwise reject. Operator must manually review the scripts
before setting either flag.

```yaml
shell_exec_ok: true             # admits scripts using subprocess(shell=True), os.system
unsupported_scripts_ok: true    # admits .sh / .rb / etc. scripts the AST scanner can't parse
```

When set, the admission gate downgrades the corresponding block-severity
findings to warn-severity for *this skill only*. Other block findings
(eval, pickle, dynamic_import) still block.

## Strict type validation

The validator enforces these types (not just "present"):

| Field | Required type |
|---|---|
| `name` | non-empty string |
| `description` | non-empty string |
| `allowed_tools` | array of non-empty strings (if present) |
| `user_invocable` | boolean (if present) |
| `disable_model_invocation` | boolean (if present) |
| `shell_exec_ok` | boolean (if present) |
| `unsupported_scripts_ok` | boolean (if present) |

YAML quirks to watch for:

- `yes` / `no` parse as strings in our parser (not as booleans). Use
  `true` / `false` explicitly.
- `1` / `0` parse as strings. Use `true` / `false`.
- Multiline descriptions need `description: |` followed by indented lines.

## Example: minimal valid frontmatter

```yaml
---
name: my-skill
description: Use this whenever the user wants to do X.
---
```

That's it. Everything else has sensible defaults.

## Example: maximalist valid frontmatter

```yaml
---
name: publish-github-release
description: |
  Use this whenever the user asks to ship, publish, release, or tag a new
  version, or when CHANGELOG.md has an "Unreleased" section ready to ship.
  Bumps version everywhere, regenerates the CHANGELOG entry from git log,
  commits, pushes, waits for green CI, and creates a GitHub release.
version: 1.0.0
scope: global
intended_roles: [developer, devops, orchestrator]
tags: [release, git, github, ci, automation]
allowed_tools: [Bash, Read, Edit]
user_invocable: true
disable_model_invocation: false
shell_exec_ok: false
unsupported_scripts_ok: false
---
```
