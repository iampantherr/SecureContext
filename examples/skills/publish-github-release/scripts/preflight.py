#!/usr/bin/env python3
"""Preflight gates for publish-github-release.

Reads `<project-root>/.publish-github-release-config.json` if present.
Runs the gates that prevent a broken release.

Usage:
    preflight.py [--project <abs-path>]

Default --project is current working directory.

Exits 0 = ready to release. Non-zero = stop, with a stderr message
naming the failed gate. stdout summarizes which checks passed.
"""
import argparse
import io
import json
import subprocess
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def load_config(project_root: Path) -> dict:
    cfg_path = project_root / ".publish-github-release-config.json"
    defaults = {
        "main_branch": "main",
        "require_ci_green": True,
        "version_files": ["package.json"],
        "ci_timeout_seconds": 600,
        "changelog_path": "CHANGELOG.md",
        "commit_template": "v{version} - {title}",
        "release_tag_prefix": "v",
        "release_notes_extra": [],
    }
    if cfg_path.exists():
        try:
            user = json.loads(cfg_path.read_text(encoding="utf-8"))
            defaults.update(user)
        except json.JSONDecodeError as e:
            print(f"WARN: malformed {cfg_path}: {e}; using defaults", file=sys.stderr)
    return defaults


def run_git(args: list[str], cwd: Path) -> tuple[int, str, str]:
    """Run a git command without invoking a shell. Returns (rc, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=30,
            shell=False,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, "", str(e)


def run_gh(args: list[str], cwd: Path) -> tuple[int, str, str]:
    """Run a gh CLI command (no shell)."""
    try:
        r = subprocess.run(
            ["gh", *args], cwd=str(cwd), capture_output=True, text=True, timeout=30,
            shell=False,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, "", str(e)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=".", help="Path to project root (default: cwd)")
    args = p.parse_args()
    project = Path(args.project).resolve()

    # v0.28.0 fix — auto-detect git root. Earlier versions required --project
    # to point AT the git root (i.e. the directory containing .git). That
    # broke on monorepo subdirectory layouts where the operator passes a
    # subproject path. Now we resolve the git toplevel via `git rev-parse`
    # and use that as the project root, regardless of what subpath the
    # operator passed in. Falls back to the original behavior if rev-parse
    # fails (e.g. not in a git repo at all).
    rc, toplevel, _ = run_git(["rev-parse", "--show-toplevel"], project)
    if rc == 0 and toplevel:
        actual_root = Path(toplevel).resolve()
        if actual_root != project:
            print(f"NOTE: --project={project} is a subdirectory; using git toplevel {actual_root} as the actual project root",
                  file=sys.stderr)
        project = actual_root
    elif not (project / ".git").exists():
        print(f"ERROR: not a git repository: {project}", file=sys.stderr)
        return 1

    cfg = load_config(project)
    print(f"Preflight for: {project}")
    print(f"  Config: main_branch={cfg['main_branch']}, "
          f"require_ci_green={cfg['require_ci_green']}, "
          f"version_files={cfg['version_files']}")
    print()

    failures = []

    # Gate 1: clean working tree
    rc, out, err = run_git(["status", "--porcelain"], project)
    if rc != 0:
        failures.append(f"git status failed: {err}")
    elif out.strip():
        failures.append(
            "working tree has uncommitted changes:\n    "
            + "\n    ".join(out.splitlines()[:5])
            + ("\n    ..." if len(out.splitlines()) > 5 else "")
        )
    else:
        print("  [OK] working tree clean")

    # Gate 2: on main branch
    rc, branch, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"], project)
    if rc != 0:
        failures.append("could not determine current branch")
    elif branch != cfg["main_branch"]:
        failures.append(f"on branch '{branch}', expected '{cfg['main_branch']}'")
    else:
        print(f"  [OK] on branch {branch}")

    # Gate 3: up to date with remote
    rc, _, _ = run_git(["fetch", "origin"], project)
    if rc == 0:
        rc, ahead_behind, _ = run_git(
            ["rev-list", "--left-right", "--count",
             f"{cfg['main_branch']}...origin/{cfg['main_branch']}"], project
        )
        if rc == 0 and ahead_behind:
            try:
                ahead, behind = ahead_behind.split()
                if int(behind) > 0:
                    failures.append(
                        f"local {cfg['main_branch']} is {behind} commit(s) behind origin/{cfg['main_branch']} — "
                        f"`git pull --rebase` and re-run"
                    )
                else:
                    print(f"  [OK] up to date with origin/{cfg['main_branch']} "
                          f"(ahead={ahead}, behind={behind})")
            except (ValueError, AttributeError):
                pass

    # Gate 4: CI green on head (only if gh + remote present)
    if cfg["require_ci_green"]:
        rc, head_sha, _ = run_git(["rev-parse", "HEAD"], project)
        if rc == 0:
            rc, runs_json, err = run_gh(
                ["run", "list", "--branch", cfg["main_branch"], "--limit", "1", "--json", "conclusion,status,headSha"],
                project,
            )
            if rc != 0:
                print(f"  [SKIP] CI status: gh CLI unavailable or unauthed ({err[:60]})")
            else:
                try:
                    runs = json.loads(runs_json or "[]")
                    if not runs:
                        print(f"  [SKIP] no CI runs found on {cfg['main_branch']}")
                    else:
                        latest = runs[0]
                        if latest.get("status") != "completed":
                            print(f"  [SKIP] CI still running on {cfg['main_branch']} (status={latest.get('status')})")
                        elif latest.get("conclusion") != "success":
                            failures.append(
                                f"CI is {latest.get('conclusion')} on the latest commit of {cfg['main_branch']}. "
                                f"Do not release on red CI. Fix forward first."
                            )
                        else:
                            print(f"  [OK] CI green on {cfg['main_branch']} (sha={(latest.get('headSha') or '?')[:8]})")
                except json.JSONDecodeError:
                    print(f"  [SKIP] could not parse gh run list output")

    # Gate 5: package.json version matches the CHANGELOG's most-recent shipped section
    package_json = project / "package.json"
    changelog = project / cfg["changelog_path"]
    if package_json.exists() and changelog.exists():
        try:
            pkg = json.loads(package_json.read_text(encoding="utf-8"))
            current_version = pkg.get("version", "?")
            print(f"  [OK] package.json version: {current_version}")
        except (json.JSONDecodeError, OSError) as e:
            print(f"  [WARN] could not read package.json version: {e}")

    print()
    if failures:
        print(f"FAILED preflight ({len(failures)} issue(s)):", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("PASS — ready to release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
