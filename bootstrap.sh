#!/usr/bin/env bash
# SecureContext one-command bootstrap (macOS / Linux / WSL):
#   curl -fsSL https://raw.githubusercontent.com/iampantherr/SecureContext/main/bootstrap.sh | bash
# Clones (or updates) the repo into ~/SecureContext and runs the full installer.
set -euo pipefail
DEST="${SC_DIR:-$HOME/SecureContext}"
command -v git  >/dev/null || { echo "git is required";  exit 1; }
command -v node >/dev/null || { echo "Node 20+ is required (https://nodejs.org)"; exit 1; }
if [ -d "$DEST/.git" ]; then
  echo "Updating existing checkout at $DEST…"
  git -C "$DEST" pull --ff-only
else
  git clone https://github.com/iampantherr/SecureContext "$DEST"
fi
cd "$DEST"
exec node init.mjs "$@"
