# Skill scope: global vs project-local

## Decision matrix

| Signal | Global | Project-local |
|---|---|---|
| Procedure works on standard files (`package.json`, `CHANGELOG.md`, `README.md`, `pyproject.toml`) | ✅ | |
| Procedure has zero hardcoded paths, project names, ports, DB IDs | ✅ | |
| Pattern has appeared in ≥2 distinct projects already | ✅ | |
| Procedure references project-specific files (e.g. `HANDOFF.md`, `STRATEGY.md`, `CleanCheck-policies.md`) | | ✅ |
| Procedure hardcodes a project's URLs, hostnames, or DB schemas | | ✅ |
| Procedure has only appeared in one project | | ✅ |
| Procedure encodes a team-specific convention (commit message format, branch naming) | | ✅ |

## When in doubt: start project-local

Promotion from project-local → global is cheap. The reverse is expensive
(operators in other projects may have come to depend on a global skill
that's been quietly making project-specific assumptions).

The skill-spotter agent (v0.28.0-β onward) surfaces promotion candidates
automatically when it sees the same skill-shaped pattern appear in
multiple project_hashes with no project-binding artifacts.

## Examples

| Skill name | Scope | Why |
|---|---|---|
| `publish-github-release` | global | Touches only `package.json`, `CHANGELOG.md`, `git`, `gh release`. No project-specific files. |
| `cleancheck-rls-policy-fix` | project-local | Encodes the specific RLS patch CleanCheck needed. |
| `readme-author` | global | Generates README from project metadata. Project specifics come from `package.json` + `zc_project_card`. |
| `revclear-publish` | project-local | RevClear has custom test-creds-injection + signed-release process. |
| `writing-skills` (this skill) | global | Meta-skill: teaches authoring. Project-agnostic. |
| `agent-shield-deploy-staging` | project-local | AgentShield-specific staging server + DB credentials. |

## The "global skill with project config" pattern

For procedures that are 95% generic with a 5% project-specific tail:

1. Make the skill **global** (`~/.claude/skills/<name>/`)
2. Scripts read project specifics from `<project>/.<name>-config.json`
   (or `zc_remember(key='<name>_config')` for ephemeral overrides)
3. Defaults in the script handle the 95% case; the config handles the 5%

Example (`publish-github-release`):

```json
// <project>/.publish-config.json
{
  "version_files": ["package.json", "src/config.ts", ".claude-plugin/plugin.json"],
  "commit_prefix": "",
  "release_tag_prefix": "v",
  "changelog_path": "CHANGELOG.md",
  "extra_preflight_checks": ["scripts/check-secrets.py"]
}
```

The script's defaults (only `package.json`, no prefix, `v` tag) cover most
projects. CleanCheck's config might add a `scripts/check-stripe-webhook.py`
extra preflight check; RevClear's might use `commit_prefix: "RevClear:"`.
**One global skill, N project configs.**
