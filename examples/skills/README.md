# Example skills

Reference filesystem skills you can copy into your `~/.claude/skills/` (global)
or `<project>/.claude/skills/` (project-scoped). Every skill here has been
linted, AST-scanned, and admission-tested.

## Installing

```bash
# Install all globally:
cp -r examples/skills/* ~/.claude/skills/

# Or install one:
cp -r examples/skills/publish-github-release ~/.claude/skills/

# Trigger admission (or wait for the next sc-api boot):
curl -s -X POST \
    -H "Authorization: Bearer $ZC_API_KEY" \
    "$ZC_API_URL/api/v1/skills/import-project?path=$HOME"
```

Verify on the dashboard at `http://localhost:3099/dashboard` — each admitted
skill appears in the Active skills panel with a 📁 filesystem badge, and an
`admitted` event lands in the admission log.

## What ships

| Skill | Purpose | Config file (per-project overrides) |
|---|---|---|
| [writing-skills](./writing-skills/) | The meta-skill: scaffolder + linter + admission-preview. Use this to author every other skill. | _(none — global only)_ |
| [publish-github-release](./publish-github-release/) | Bump version, regenerate CHANGELOG, commit + push, wait for green CI, create GitHub release. | `.publish-github-release-config.json` |

More skills are planned for the next release wave — see [docs/SKILL_AUTHORSHIP_GUIDE.md](../../docs/SKILL_AUTHORSHIP_GUIDE.md) for the structure and how to contribute new ones.

## Customization

Each skill that touches project-specific values reads a JSON config file from
the project root. Schemas are documented inline in each skill's
`references/config-schema.md`.

For `publish-github-release`, that's `<project>/.publish-github-release-config.json`.
See [its config-schema.md](./publish-github-release/references/config-schema.md)
for the full field reference.

## Authoring your own

Read [`docs/SKILL_AUTHORSHIP_GUIDE.md`](../../docs/SKILL_AUTHORSHIP_GUIDE.md) first.
Then run:

```bash
python ~/.claude/skills/writing-skills/scripts/scaffold-skill.py \
    --name my-new-skill \
    --scope global \
    --description "Use this whenever <X>. The skill <Y>." \
    --with-script do-the-thing

python ~/.claude/skills/writing-skills/scripts/lint-skill.py \
    ~/.claude/skills/my-new-skill/

python ~/.claude/skills/writing-skills/scripts/preview-admission.py \
    ~/.claude/skills/my-new-skill/
```

If both lint and preview pass, the admission gate will admit on the next
sc-api boot (or via the import-project endpoint).
