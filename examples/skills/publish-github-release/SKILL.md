---
name: publish-github-release
description: |
  Use this whenever the user asks to ship, publish, release, tag, or cut a
  new version of the project — OR when CHANGELOG.md has an "Unreleased" /
  in-progress section ready to be shipped. The skill bumps the version
  across all version-bearing files, regenerates the CHANGELOG entry from
  git log since the last tag, commits, pushes, waits for green CI, and
  creates a GitHub release with auto-generated notes.
version: 1.0.0
scope: global
intended_roles: [developer, devops, orchestrator]
tags: [release, git, github, ci, automation]
allowed_tools: [Bash, Read, Edit]
user_invocable: true
disable_model_invocation: false
shell_exec_ok: false
unsupported_scripts_ok: true
---

# Publish a GitHub release

Generic procedure for shipping a new version of a project. Reads
project-specific config from `<project>/.publish-github-release-config.json`
if present (see `references/config-schema.md`).

## When to use

Trigger phrases (literal words the user might type):

- "ship v1.2.3"
- "release"
- "tag a new version"
- "publish"
- "cut a release"
- "make a new release"
- "bump version and release"
- "deploy this release to github"

Auto-detect trigger: if `CHANGELOG.md` has a `## [Unreleased]` heading with
entries underneath, and the agent has just finished a coherent unit of work,
suggest invoking this skill.

DO NOT use this for:

- Patch increments without code changes (use `npm version patch` directly).
- Pre-release / RC builds (use the `prerelease-tag` skill instead — coming
  in a later release).
- Repos with no GitHub remote (the skill assumes `gh` CLI auth and a remote
  named `origin` pointing at GitHub).

## Procedure

### Step 1 — Preflight gates

Run `scripts/preflight.py`. Reads project config; fails fast on:

- Working tree dirty (uncommitted changes)
- Branch is not on `main` (or whatever `config.main_branch` says)
- Local is behind remote on main (would force-push)
- CI is currently red on the head commit
- `package.json` version doesn't match the previous CHANGELOG entry header

Exits 0 = ready to release. Non-zero = stop and surface the failure to the
operator.

### Step 2 — Bump version everywhere

Run `python scripts/bump-version.py --kind {major|minor|patch}` (or
`--version 1.2.3` for an explicit version). Reads
`config.version_files` and atomically rewrites the version string in
each. Default version-bearing files:

- `package.json` (`.version`)
- Plus anything listed in `<project>/.publish-github-release-config.json`'s
  `version_files`. SecureContext for example lists
  `[package.json, src/config.ts, .claude-plugin/plugin.json]`.

Refuses to bump if the new version is already a tag.

### Step 3 — Regenerate the CHANGELOG entry

Run `python scripts/regenerate-changelog.py --version X.Y.Z`. Walks
`git log` from the last tag → HEAD, groups commits by type (feat / fix /
docs / refactor / chore), produces a new section formatted to Keep-a-Changelog
spec, and inserts it under the `## [Unreleased]` heading (creating one if
needed). The operator reviews + edits before commit.

### Step 4 — Commit + push

```bash
git add -A
git commit -m "vX.Y.Z — <one-line title>"
git push origin main
```

The commit message follows project convention (controlled by
`config.commit_template` if set; default is `"vX.Y.Z — {title}"`).

### Step 5 — Wait for green CI

Run `bash scripts/wait-for-ci.sh`. Polls `gh run watch --exit-status` on
the just-pushed commit for up to 10 minutes (configurable via
`config.ci_timeout_seconds`). Exits non-zero if CI goes red — operator
fixes forward, never deletes the commit.

### Step 6 — Tag + create GitHub release

Run `bash scripts/create-release.sh vX.Y.Z`. Calls `gh release create
vX.Y.Z` with `--target <pushed-commit-sha>` and release notes pulled from
the CHANGELOG entry created in step 3. If `config.release_notes_extra`
is set in the project config, appends those bullets to the body.

### Step 7 — Verify the release is live

```bash
gh release view vX.Y.Z --json url,name,createdAt
```

Output the URL to stdout so the operator (or another agent) can confirm.

## Bundled scripts

- `scripts/preflight.py` — gate checks (working tree, branch, CI status)
- `scripts/bump-version.py` — atomic multi-file version bump
- `scripts/regenerate-changelog.py` — git log → Keep-a-Changelog section
- `scripts/wait-for-ci.sh` — `gh run watch --exit-status` polling wrapper
- `scripts/create-release.sh` — `gh release create` wrapper

## Reference materials

- `references/config-schema.md` — the `.publish-github-release-config.json` schema
- `references/conventional-commits.md` — commit-type → CHANGELOG-section mapping
- `references/semver-rules.md` — when to bump major/minor/patch

## Failure modes + recovery

| Symptom | Cause | Fix |
|---|---|---|
| Preflight reports working tree dirty | Uncommitted changes | `git stash` or commit them; re-run |
| Preflight reports behind remote | Someone else pushed to main | `git pull --rebase`; re-run |
| Preflight reports CI red | Existing red CI on main | Fix the CI failure first; do not release on red |
| bump-version says "version X.Y.Z already a tag" | You're trying to re-release | Increment further (e.g. patch) |
| regenerate-changelog produces empty section | No commits since last tag | Nothing to release; abort |
| wait-for-ci times out | CI is slow on this commit | Extend `config.ci_timeout_seconds` or wait manually |
| wait-for-ci goes red | A test failed | Fix forward in a new commit; re-run from step 3 |
| create-release.sh "tag already exists" | Previous attempt got partway | Delete local tag (`git tag -d vX.Y.Z`); re-run create-release.sh |

## Notes on safety

- The skill **never** rewrites git history. No `--force`, no `--amend`, no
  `git reset --hard` on remote.
- The skill **never** deletes tags or releases from GitHub.
- If anything goes wrong after step 4 (commit pushed), the standard
  recovery is "fix forward in a new commit." Do not try to undo the push.
- Pre-existing tags are sacrosanct. The release-tag is computed from the
  newly-bumped version, which the bump step refused to set to anything that
  already exists.

## Composition with other skills

After this skill runs successfully, consider invoking:

- `~/.claude/skills/readme-author/` to update README badges with the new version.
- `~/.claude/skills/architecture-doc-author/` to add a section reflecting any
  structural changes in this release.
- Project-specific post-release skills (e.g. `cleancheck-deploy-to-vercel`).

Each of those is a separate skill the orchestrator can ASSIGN after seeing
this skill's COMPLETE broadcast.
