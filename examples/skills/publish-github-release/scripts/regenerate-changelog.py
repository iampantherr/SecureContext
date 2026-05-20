#!/usr/bin/env python3
"""Regenerate the CHANGELOG entry for the new version from git log.

Walks `git log <prev-tag>..HEAD`, groups commits by type
(feat/fix/docs/refactor/chore/test), formats per Keep-a-Changelog spec,
inserts the new section at the top of CHANGELOG.md (under any existing
`## [Unreleased]`, or right under the file's heading).

Usage:
    regenerate-changelog.py --version X.Y.Z [--project /abs/path]

Exits 0 = wrote a CHANGELOG section. stdout = the new section text.
"""
import argparse
import io
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


# Conventional-Commit prefix → CHANGELOG section
TYPE_MAP = {
    "feat":      "Added",
    "feature":   "Added",
    "add":       "Added",
    "fix":       "Fixed",
    "bug":       "Fixed",
    "perf":      "Changed",
    "refactor":  "Changed",
    "change":    "Changed",
    "docs":      "Documentation",
    "doc":       "Documentation",
    "test":      "Tests",
    "tests":     "Tests",
    "chore":     "Chore",
    "build":     "Chore",
    "ci":        "Chore",
}
SECTION_ORDER = ["Added", "Changed", "Fixed", "Removed", "Security", "Documentation", "Tests", "Chore"]


def load_config(project_root: Path) -> dict:
    cfg_path = project_root / ".publish-github-release-config.json"
    defaults = {
        "changelog_path": "CHANGELOG.md",
        "release_tag_prefix": "v",
    }
    if cfg_path.exists():
        try:
            user = json.loads(cfg_path.read_text(encoding="utf-8"))
            defaults.update(user)
        except json.JSONDecodeError:
            pass
    return defaults


def get_previous_tag(project_root: Path, prefix: str) -> str | None:
    try:
        r = subprocess.run(
            ["git", "tag", "-l", f"{prefix}*", "--sort=-version:refname"],
            cwd=str(project_root), capture_output=True, text=True, timeout=15, shell=False,
        )
        tags = [t.strip() for t in r.stdout.splitlines() if t.strip()]
        return tags[0] if tags else None
    except (OSError, subprocess.SubprocessError):
        return None


def get_commits_since(project_root: Path, since: str | None) -> list[dict]:
    """Returns list of {hash, subject, body} for commits since the given tag."""
    range_arg = f"{since}..HEAD" if since else "HEAD"
    try:
        r = subprocess.run(
            ["git", "log", range_arg, "--pretty=format:%H%x00%s%x00%b%x1e"],
            cwd=str(project_root), capture_output=True, text=True, timeout=30, shell=False,
        )
    except (OSError, subprocess.SubprocessError) as e:
        print(f"ERROR: git log failed: {e}", file=sys.stderr)
        return []
    commits = []
    for chunk in r.stdout.split("\x1e"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split("\x00")
        if len(parts) < 2:
            continue
        commits.append({
            "hash":    parts[0].strip()[:8],
            "subject": parts[1].strip(),
            "body":    parts[2].strip() if len(parts) > 2 else "",
        })
    return commits


def classify(subject: str) -> tuple[str, str]:
    """Return (section_name, cleaned_subject). Subjects like 'feat: foo' → ('Added', 'foo')."""
    m = re.match(r"^(\w+)(?:\([^)]+\))?\s*[:!]\s*(.+)$", subject)
    if m:
        type_token = m.group(1).lower()
        body = m.group(2).strip()
        section = TYPE_MAP.get(type_token, "Other")
        return section, body
    return "Other", subject


def format_section(version: str, sections: dict[str, list[str]]) -> str:
    today = date.today().isoformat()
    out = [f"## [{version}] — {today}", ""]
    for name in SECTION_ORDER + ["Other"]:
        items = sections.get(name)
        if not items:
            continue
        out.append(f"### {name}")
        out.append("")
        for item in items:
            out.append(f"- {item}")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def insert_into_changelog(changelog_path: Path, new_section: str) -> str:
    """Insert new_section after the file's leading H1, replacing any [Unreleased]."""
    if not changelog_path.exists():
        # Create a fresh CHANGELOG
        header = "# Changelog\n\nAll notable changes to this project. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n"
        changelog_path.write_text(header + new_section, encoding="utf-8")
        return new_section
    content = changelog_path.read_text(encoding="utf-8")

    # Find where to insert: after the H1 + intro paragraph, before the first ## heading
    lines = content.split("\n")
    insert_at = 0
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            insert_at = i
            break
    else:
        # No existing section headings — append after the H1 block
        insert_at = len(lines)

    # If the first existing section is [Unreleased], REPLACE it
    if insert_at < len(lines) and "[unreleased]" in lines[insert_at].lower():
        # Find end of the [Unreleased] block
        end = insert_at + 1
        while end < len(lines) and not lines[end].startswith("## "):
            end += 1
        # Replace lines[insert_at..end] with new_section
        new_lines = lines[:insert_at] + new_section.split("\n") + lines[end:]
        new_content = "\n".join(new_lines).rstrip() + "\n"
    else:
        # Insert new section before insert_at
        new_lines = lines[:insert_at] + new_section.split("\n") + lines[insert_at:]
        new_content = "\n".join(new_lines).rstrip() + "\n"

    changelog_path.write_text(new_content, encoding="utf-8")
    return new_section


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--version", required=True, help="New version (semver X.Y.Z)")
    p.add_argument("--project", default=".", help="Project root (default: cwd)")
    args = p.parse_args()

    project = Path(args.project).resolve()
    if not (project / ".git").exists():
        print(f"ERROR: not a git repository: {project}", file=sys.stderr)
        return 1
    if not re.match(r"^\d+\.\d+\.\d+$", args.version):
        print(f"ERROR: --version must be semver X.Y.Z (got: {args.version})", file=sys.stderr)
        return 1

    cfg = load_config(project)
    changelog_path = project / cfg["changelog_path"]

    prev_tag = get_previous_tag(project, cfg["release_tag_prefix"])
    print(f"Previous tag: {prev_tag or '(none)'}", file=sys.stderr)

    commits = get_commits_since(project, prev_tag)
    print(f"Commits since {prev_tag or 'initial'}: {len(commits)}", file=sys.stderr)

    if not commits:
        print("ERROR: no commits since previous tag — nothing to release", file=sys.stderr)
        return 1

    # Group
    sections: dict[str, list[str]] = {}
    for c in commits:
        section, body = classify(c["subject"])
        sections.setdefault(section, []).append(f"{body} ({c['hash']})")

    new_section = format_section(args.version, sections)
    insert_into_changelog(changelog_path, new_section)

    print(f"Wrote {changelog_path} (new section is {len(new_section.splitlines())} line(s))", file=sys.stderr)
    print()
    print(new_section)  # stdout = the section text
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
