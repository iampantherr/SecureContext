# `.publish-github-release-config.json` schema

Drop this file at the project root to override the skill's defaults.

## Full example

```json
{
  "main_branch": "main",
  "require_ci_green": true,
  "version_files": [
    "package.json",
    "src/config.ts",
    ".claude-plugin/plugin.json"
  ],
  "changelog_path": "CHANGELOG.md",
  "commit_template": "v{version} - {title}",
  "release_tag_prefix": "v",
  "ci_timeout_seconds": 600,
  "release_notes_extra": [
    "Built with [SecureContext](https://github.com/iampantherr/SecureContext)"
  ]
}
```

## Field reference

| Field | Default | Description |
|---|---|---|
| `main_branch` | `"main"` | Branch to release from. Preflight refuses if HEAD isn't here. |
| `require_ci_green` | `true` | If true, preflight checks `gh run list` for green status on the most recent run. |
| `version_files` | `["package.json"]` | Files to rewrite the version in. Order matters only for diff readability. |
| `changelog_path` | `"CHANGELOG.md"` | Where to find / insert the CHANGELOG. |
| `commit_template` | `"v{version} - {title}"` | Commit message format. `{version}` and `{title}` substituted. |
| `release_tag_prefix` | `"v"` | Tag prefix. Most projects use `v` (e.g. `v1.2.3`). |
| `ci_timeout_seconds` | `600` | How long `wait-for-ci.sh` waits before giving up. |
| `release_notes_extra` | `[]` | Bullets appended to the GitHub release body after the CHANGELOG section. |

## Per-project examples

### SecureContext

```json
{
  "version_files": [
    "package.json",
    "src/config.ts",
    ".claude-plugin/plugin.json"
  ],
  "release_notes_extra": [
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
  ]
}
```

### A typical Next.js app

```json
{
  "version_files": ["package.json"],
  "ci_timeout_seconds": 1200
}
```

### A monorepo with multiple packages

```json
{
  "version_files": [
    "package.json",
    "packages/web/package.json",
    "packages/api/package.json"
  ],
  "commit_template": "Release {version}: {title}"
}
```

## What the script does NOT touch

- Anything in `node_modules/`, `dist/`, `build/`, `.next/` (caches)
- Files not listed in `version_files`
- The CHANGELOG section for any *previous* version (only inserts the new one)
- Existing tags (refuses to overwrite)
- Existing GitHub releases (refuses to overwrite)
