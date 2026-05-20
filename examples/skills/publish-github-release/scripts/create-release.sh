#!/usr/bin/env bash
# create-release.sh — call `gh release create` for the just-bumped version.
#
# Usage:
#   create-release.sh vX.Y.Z
#
# Reads CHANGELOG.md for the section heading matching the version and uses
# that as the release body. Adds any config.release_notes_extra bullets.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: create-release.sh vX.Y.Z" >&2
  exit 1
fi

TAG="$1"
VERSION="${TAG#v}"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not installed" >&2
  exit 1
fi

# Refuse if tag already exists on origin
if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  echo "ERROR: tag $TAG already exists on origin. Pick a higher version or delete the existing tag." >&2
  exit 1
fi

# Extract release notes from CHANGELOG
NOTES_FILE=$(mktemp)
trap 'rm -f "$NOTES_FILE"' EXIT

CHANGELOG_PATH="CHANGELOG.md"
if [ -f .publish-github-release-config.json ]; then
  CHANGELOG_PATH=$(python -c "import json; print(json.load(open('.publish-github-release-config.json')).get('changelog_path', 'CHANGELOG.md'))" 2>/dev/null || echo "CHANGELOG.md")
fi

if [ -f "$CHANGELOG_PATH" ]; then
  # awk extracts the section starting at "## [VERSION]" until the next "## "
  awk -v ver="[$VERSION]" '
    $0 ~ "^## " && index($0, ver) { found=1; next }
    /^## / && found { exit }
    found { print }
  ' "$CHANGELOG_PATH" > "$NOTES_FILE"
fi

if [ ! -s "$NOTES_FILE" ]; then
  echo "WARN: no CHANGELOG section found for $VERSION; using auto-generated notes" >&2
  echo "Release $TAG" > "$NOTES_FILE"
fi

# Append release_notes_extra if config has any
if [ -f .publish-github-release-config.json ]; then
  EXTRA=$(python -c "import json; print('\n'.join('- ' + line for line in json.load(open('.publish-github-release-config.json')).get('release_notes_extra', [])))" 2>/dev/null || echo "")
  if [ -n "$EXTRA" ]; then
    echo "" >> "$NOTES_FILE"
    echo "$EXTRA" >> "$NOTES_FILE"
  fi
fi

# Create the release
TITLE="${TAG} - $(awk '/^## / && /'"\\[${VERSION}\\]"'/ { for (i=4; i<=NF; i++) printf "%s ", $i; print ""; exit }' "$CHANGELOG_PATH" 2>/dev/null | sed 's/—//' | xargs || echo "$TAG")"
[ -z "$TITLE" ] && TITLE="$TAG"

echo "Creating release $TAG..." >&2
gh release create "$TAG" --title "$TITLE" --notes-file "$NOTES_FILE"

echo "Release created: $TAG"
gh release view "$TAG" --json url -q '.url'
