#!/usr/bin/env python3
"""Atomically bump version across all version-bearing files.

Reads the list of files from the project config; defaults to `package.json` only.
Refuses to set a version equal to an existing tag.

Usage:
    bump-version.py --kind {major|minor|patch}        # auto-increment
    bump-version.py --version 1.2.3                   # explicit
    bump-version.py --kind patch --project /abs/path

Exits 0 = bumped. Stdout = new version. Stderr = diagnostics.
"""
import argparse
import io
import json
import re
import subprocess
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def load_config(project_root: Path) -> dict:
    cfg_path = project_root / ".publish-github-release-config.json"
    defaults = {
        "version_files": ["package.json"],
        "release_tag_prefix": "v",
    }
    if cfg_path.exists():
        try:
            user = json.loads(cfg_path.read_text(encoding="utf-8"))
            defaults.update(user)
        except json.JSONDecodeError:
            pass
    return defaults


def read_current_version(project_root: Path) -> str | None:
    """Read version from package.json. Returns None if missing."""
    pkg = project_root / "package.json"
    if not pkg.exists():
        return None
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        v = data.get("version")
        if isinstance(v, str) and SEMVER_RE.match(v):
            return v
    except json.JSONDecodeError:
        pass
    return None


def increment(current: str, kind: str) -> str:
    major, minor, patch = (int(x) for x in current.split("."))
    if kind == "major":
        return f"{major + 1}.0.0"
    elif kind == "minor":
        return f"{major}.{minor + 1}.0"
    elif kind == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"unknown kind: {kind}")


def tag_exists(project_root: Path, tag: str) -> bool:
    try:
        r = subprocess.run(
            ["git", "tag", "-l", tag], cwd=str(project_root),
            capture_output=True, text=True, timeout=15, shell=False,
        )
        return tag in r.stdout.split()
    except (OSError, subprocess.SubprocessError):
        return False


def rewrite_package_json(path: Path, new_version: str) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        data["version"] = new_version
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        return True
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR: failed to rewrite {path}: {e}", file=sys.stderr)
        return False


def rewrite_text_file(path: Path, old_version: str, new_version: str) -> bool:
    """For files like src/config.ts that have a quoted version string."""
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: cannot read {path}: {e}", file=sys.stderr)
        return False

    # Heuristic patterns the bumper recognizes:
    patterns = [
        # JSON-like: "version": "1.2.3"  (covers package.json, plugin.json)
        (re.compile(r'("version"\s*:\s*")' + re.escape(old_version) + r'(")'),
         lambda m: m.group(1) + new_version + m.group(2)),
        # TS-style: VERSION: "1.2.3"
        (re.compile(r'(VERSION\s*[:=]\s*")' + re.escape(old_version) + r'(")'),
         lambda m: m.group(1) + new_version + m.group(2)),
        # Markdown badge URL: badge/version-1.2.3-blue
        (re.compile(r'(badge/version-)' + re.escape(old_version) + r'(-)'),
         lambda m: m.group(1) + new_version + m.group(2)),
    ]
    new_content = content
    rewrites = 0
    for pat, replacer in patterns:
        new_content, n = pat.subn(replacer, new_content)
        rewrites += n

    if rewrites == 0:
        print(f"WARN: no version pattern found in {path} (current version may not be {old_version})", file=sys.stderr)
        return True  # not fatal — caller may have specified extra files that don't have the version

    try:
        path.write_text(new_content, encoding="utf-8")
        return True
    except OSError as e:
        print(f"ERROR: cannot write {path}: {e}", file=sys.stderr)
        return False


def main() -> int:
    p = argparse.ArgumentParser()
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--kind", choices=("major", "minor", "patch"))
    grp.add_argument("--version", help="Explicit new version (semver)")
    p.add_argument("--project", default=".", help="Project root (default: cwd)")
    args = p.parse_args()

    project = Path(args.project).resolve()
    if not (project / ".git").exists():
        print(f"ERROR: not a git repository: {project}", file=sys.stderr)
        return 1

    cfg = load_config(project)
    tag_prefix = cfg.get("release_tag_prefix", "v")

    # Determine current version
    current = read_current_version(project)
    if current is None:
        print(f"ERROR: cannot determine current version (no valid package.json found in {project})", file=sys.stderr)
        return 1
    print(f"Current version: {current}", file=sys.stderr)

    # Compute new version
    if args.version:
        if not SEMVER_RE.match(args.version):
            print(f"ERROR: --version must be semver X.Y.Z (got: {args.version})", file=sys.stderr)
            return 1
        new_version = args.version
    else:
        new_version = increment(current, args.kind)

    # Reject if equal to current
    if new_version == current:
        print(f"ERROR: new version {new_version} equals current; nothing to bump", file=sys.stderr)
        return 1

    # Reject if tag exists
    tag = f"{tag_prefix}{new_version}"
    if tag_exists(project, tag):
        print(f"ERROR: tag {tag} already exists. Pick a higher version.", file=sys.stderr)
        return 1

    print(f"New version: {new_version}", file=sys.stderr)

    # Rewrite each file in config.version_files
    version_files = cfg.get("version_files", ["package.json"])
    print(f"Rewriting {len(version_files)} file(s)...", file=sys.stderr)
    ok = True
    for rel in version_files:
        path = project / rel
        if not path.exists():
            print(f"WARN: {path} does not exist; skipping", file=sys.stderr)
            continue
        if path.name == "package.json" or path.name == "plugin.json":
            ok = rewrite_package_json(path, new_version) and ok
        else:
            ok = rewrite_text_file(path, current, new_version) and ok
        print(f"  rewrote: {rel}", file=sys.stderr)

    if not ok:
        print("ERROR: one or more rewrites failed; review stderr above", file=sys.stderr)
        return 1

    # stdout = the new version (so the agent can parse it cleanly)
    print(new_version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
