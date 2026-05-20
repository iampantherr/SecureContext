---
name: writing-skills
description: |
  Use this whenever the user asks to write, author, or scaffold a new
  SecureContext skill (Anthropic-style filesystem skill at
  ~/.claude/skills/<name>/ or <project>/.claude/skills/<name>/). The
  skill walks the agent through the four-invariant checklist, generates
  a SKILL.md from a template, and runs the bundled linter + admission
  preview to confirm the new skill will admit cleanly before the
  operator commits it.
version: 1.0.0
scope: global
intended_roles: [developer, devops, orchestrator, architect]
tags: [meta, skill-authoring, scaffold, linter]
allowed_tools: [Bash, Read, Edit, Write]
user_invocable: true
disable_model_invocation: false
---

# Writing skills

This is the meta-skill: it teaches an agent how to write other skills, and
it ships a linter + admission-preview tool to catch errors before the
admission gate does.

## When to use

Trigger phrases:

- "Write a skill for X"
- "Create a skill that does Y"
- "Scaffold a new skill"
- "Help me author a skill"
- "How do I make a skill that …"
- Anywhere the operator asks for a new `~/.claude/skills/<name>/` or
  `<project>/.claude/skills/<name>/`.

DO NOT use this for:

- Editing an existing skill (use the dashboard "Edit frontmatter" button
  instead).
- Documenting facts (those go in `references/` or `zc_remember`, not in
  a skill).
- One-off tasks (if the procedure isn't worth running ≥3 times, don't
  encode it as a skill).

## Procedure

### Step 1 — confirm the four invariants are satisfiable

Before writing a single line, talk to the operator and confirm:

1. **Trigger** — can you write a one-sentence "use this whenever X" rule?
   If not, stop. The user's request is for a one-off, not a skill.
2. **Procedural** — does the work decompose into 3–7 ordered steps?
   If not, the procedure is either too vague or too narrow.
3. **Single-responsibility scripts** — does each step map to one bundled
   script (or one in-line Bash command)? If a step needs a script that
   does five things, split it.
4. **Project-config-aware** — does the procedure touch project-specific
   values (paths, names, ports)? If yes, the script must read those from
   `<project>/.<skill-name>-config.json` or `zc_remember`, never hardcoded.

If any of the four is shaky, stop and discuss with the operator before
generating any files.

### Step 2 — decide the scope (global vs project-local)

This decision matters. Get it wrong and the skill either pollutes the global
namespace with project-specific assumptions, or it gets duplicated across N
projects when one global skill + per-project config would have sufficed.

**Decision matrix — answer these questions:**

| Question | If YES → | If NO → |
|---|---|---|
| Does the procedure touch only standard files (package.json, CHANGELOG.md, README.md, pyproject.toml, *.test.js)? | Maybe global | Maybe project |
| Does the procedure have ZERO hardcoded paths, project names, ports, DB IDs, internal URLs? | Maybe global | Project |
| Has this exact pattern appeared in ≥2 distinct projects already? | Strong global | Project (for now) |
| Does the procedure reference project-specific files (HANDOFF.md, STRATEGY.md, internal-policies.md)? | Project | Maybe global |
| Does the procedure encode a team-specific convention (commit format, branch naming, deploy URL)? | Project | Maybe global |
| Does the procedure only fire in one repo so far? | Project (promote later) | Maybe global |

**Default tie-breaker: project-local.** Promotion from project → global is
cheap; the reverse is expensive (operators in other projects may have come
to depend on a global skill that quietly made wrong assumptions).

**The "global skill + per-project config" pattern**: when a procedure is
95% generic with a 5% project-specific tail, make it global and read the
5% from `<project>/.<skill-name>-config.json` (or `zc_remember`). One
global skill, N project configs. See `references/scope-decision.md` for
the full pattern + worked examples.

**Concrete examples from the SecureContext repo:**

| Skill | Scope | Why |
|---|---|---|
| `publish-github-release` | global | Touches only package.json + CHANGELOG.md + git + gh CLI. Zero project specifics. |
| `writing-skills` (this one) | global | Meta-skill. Project-agnostic by definition. |
| `revclear-test-creds-injection` | project | RevClear-specific credentials encoded in the procedure. |
| `cleancheck-rls-patch` | project | CleanCheck's specific Supabase Row-Level-Security patch. |
| `readme-author` | global | Generic; reads project metadata from package.json + zc_project_card. |

When you scaffold, you MUST pass `--scope-rationale "..."` justifying the
choice. The scaffolder refuses to proceed without one. This forces the
decision to be conscious + auditable rather than reflexive.

### Step 3 — generate the skill scaffold

Run the scaffolder:

```bash
python ~/.claude/skills/writing-skills/scripts/scaffold-skill.py \
    --name <kebab-case-name> \
    --scope <global|project> \
    --description "Use this whenever <X>. The skill <does Y>." \
    --project <abs-path-if-project-scoped> \
    [--with-script <script-name>] ...
```

The scaffolder creates:

- `<target>/SKILL.md` with the four-invariant template filled in
- `<target>/scripts/<script-name>.py` skeletons (one per `--with-script`)
- `<target>/.<skill-name>-config.json` (in the project root, if project-scoped)

### Step 4 — fill in the procedure + scripts

The operator (or you, with the operator's guidance) edits:

- `SKILL.md` body — the 3–7 numbered procedural steps
- Each `scripts/<n>.py` — single-responsibility, argparse-driven, stdout=answer

While editing, follow the script-writing rules in
`references/script-rules.md`:

- No `eval`/`exec`/`compile`/`pickle.loads`/dynamic `__import__`
- No `subprocess(shell=True)` unless you declare `shell_exec_ok: true`
- Args via `argparse`, stdout=answer, stderr=diagnostics, exit-code 0=success

### Step 5 — lint locally

Before admission, run the linter:

```bash
python ~/.claude/skills/writing-skills/scripts/lint-skill.py <target>
```

Reports:

- Frontmatter validation errors (matches admission gate's strict mode)
- Trigger sentence detection (regex for "use this whenever")
- Step-count check (3–7 steps required)
- Bundled-script presence check
- Hardcoded-path / project-name detection (warns; not blocking)

Exits non-zero on any error. Operator iterates until clean.

### Step 6 — preview admission

Confirm the admission gate will admit:

```bash
python ~/.claude/skills/writing-skills/scripts/preview-admission.py <target>
```

This calls a dry-run mode against the live SecureContext API. Reports:

- Frontmatter validation result
- Per-script AST scan results (with violations, severities, line numbers)
- Whether the skill would be admitted or quarantined
- Suggested fixes for any blocking findings

### Step 7 — install + verify

```bash
# Global skill:
cp -r <staging-dir> ~/.claude/skills/<name>/

# Project-local skill (operator runs from project root):
cp -r <staging-dir> .claude/skills/<name>/

# Trigger admission (if not at sc-api boot):
curl -s -X POST \
    -H "Authorization: Bearer $ZC_API_KEY" \
    "$ZC_API_URL/api/v1/skills/import-project?path=$(pwd)"
```

Confirm in the dashboard at `http://localhost:3099/dashboard`:
- Active skills panel lists the new skill with a 📁 filesystem badge
- Admission log shows an `admitted` event
- Chain banner stays green

## Bundled scripts

- `scripts/scaffold-skill.py` — generates a new skill directory from arguments
- `scripts/lint-skill.py` — checks an existing skill against the four invariants
  (matches the admission gate's strict mode + adds operator-friendly hints)
- `scripts/preview-admission.py` — calls the live API in dry-run mode to
  preview what admission would do

## Reference materials

- `references/scope-decision.md` — global-vs-project-local decision matrix
- `references/script-rules.md` — the AST-scanner's blocked-pattern list
- `references/frontmatter-spec.md` — Anthropic frontmatter + SecureContext extensions

## Failure modes + recovery

| Symptom | Cause | Fix |
|---|---|---|
| `lint-skill.py` says "no trigger detected" | Description doesn't have "use this whenever" or "Use this whenever" | Rewrite description sentence one |
| `preview-admission.py` says "block_severity: eval" | A `scripts/*.py` uses `eval()` or `exec()` | Refactor — never legitimate in a skill |
| Skill imports but never fires | L1 description too vague | Make trigger more specific (literal words / phrases the user types) |
| Admitted skill blocked at runtime | Script was edited after admission | Re-trigger admission via `POST /api/v1/skills/import-project` |

## Reference

The full guide lives at `docs/SKILL_AUTHORSHIP_GUIDE.md` in the SecureContext
repo. This skill's body is the operational summary; the doc is the rationale.
