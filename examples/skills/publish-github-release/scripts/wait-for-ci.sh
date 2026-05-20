#!/usr/bin/env bash
# wait-for-ci.sh — poll `gh run watch` until CI completes or timeout.
#
# Usage:
#   wait-for-ci.sh [timeout-seconds]
#
# Reads .publish-github-release-config.json for ci_timeout_seconds if no arg given.
# Defaults to 600 seconds (10 min).
#
# Exits 0 = CI green. Non-zero = CI red, in-progress past timeout, or gh unavailable.

set -euo pipefail

TIMEOUT="${1:-}"
if [ -z "$TIMEOUT" ] && [ -f .publish-github-release-config.json ]; then
  TIMEOUT=$(python -c "import json,sys; print(json.load(open('.publish-github-release-config.json')).get('ci_timeout_seconds', 600))" 2>/dev/null || echo 600)
fi
TIMEOUT="${TIMEOUT:-600}"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not installed or not on PATH" >&2
  exit 1
fi

# Get the most recent run ID on this branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Polling CI on branch: $BRANCH (timeout ${TIMEOUT}s)" >&2

# Wait up to 30s for a run to appear (push-triggered runs take a few seconds to register)
RUN_ID=""
for i in $(seq 1 15); do
  RUN_ID=$(gh run list --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
  if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
    break
  fi
  sleep 2
done

if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "ERROR: no CI run found on branch $BRANCH after 30s" >&2
  exit 1
fi

echo "Watching run $RUN_ID..." >&2

# gh run watch blocks until the run completes, exits non-zero if the run fails
# --exit-status: non-zero exit on failure
# --interval=10: poll every 10s
if ! timeout "$TIMEOUT" gh run watch "$RUN_ID" --exit-status --interval 10; then
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "ERROR: CI did not complete within ${TIMEOUT}s" >&2
    exit 2
  fi
  echo "ERROR: CI run $RUN_ID failed (gh exit $rc)" >&2
  exit "$rc"
fi

echo "CI green on run $RUN_ID"
