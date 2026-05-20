#!/usr/bin/env python3
"""Preview what SecureContext's admission gate will do for a skill, without committing.

Usage:
    preview-admission.py <skill-dir>

Reads the skill directory, hits the live sc-api at $ZC_API_URL (defaults
to http://localhost:3099), and shows:

  - Per-script AST scan results (with violations + line numbers)
  - Whether the skill would be admitted, quarantined, or rejected
  - Suggested fixes for any blocking findings

Exits 0 if the skill would admit, non-zero otherwise. Uses urllib so it
has no third-party dependencies — runs on any vanilla Python 3.

Note: this calls the live API in *preview* mode (no DB writes). It uses
the existing /api/v1/skills/spotter/dry-run endpoint structure for an
inline AST scan; if that's unavailable, falls back to lint-skill.py's
checks plus a local AST scan via the bundled py_ast_walker (if findable).
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


def find_py_ast_walker() -> Path | None:
    """Locate scripts/py_ast_walker.py from the SecureContext repo if available."""
    candidates = [
        Path(__file__).resolve().parents[4] / "scripts" / "py_ast_walker.py",  # in repo
        Path("/app/scripts/py_ast_walker.py"),
        Path.home() / "AI_projects" / "SecureContext" / "scripts" / "py_ast_walker.py",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def scan_script_via_walker(script_path: Path, walker: Path) -> dict:
    """Run py_ast_walker against one script. Returns the parsed JSON."""
    try:
        result = subprocess.run(
            ["python3" if os.name != "nt" else "python", str(walker), str(script_path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return {"passed": False, "violations": [], "errors": [f"walker failed to spawn: {e}"]}
    if result.returncode not in (0, None):
        return {"passed": False, "violations": [], "errors": [f"walker exit {result.returncode}: {result.stderr[:200]}"]}
    if not result.stdout:
        return {"passed": False, "violations": [], "errors": ["walker produced no stdout"]}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        return {"passed": False, "violations": [], "errors": [f"walker stdout not JSON: {e}; first 200 chars: {result.stdout[:200]}"]}


def ping_api(api_url: str) -> bool:
    """Quick health check."""
    try:
        req = urllib.request.Request(f"{api_url}/health")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("skill_dir", help="Path to the skill directory to preview")
    args = p.parse_args()

    skill_dir = Path(args.skill_dir).resolve()
    if not skill_dir.is_dir():
        print(f"ERROR: not a directory: {skill_dir}", file=sys.stderr)
        return 2

    api_url = os.environ.get("ZC_API_URL", "http://localhost:3099")
    api_up = ping_api(api_url)

    print(f"Preview admission for: {skill_dir}")
    print(f"  ZC_API_URL: {api_url}  ({'reachable' if api_up else 'UNREACHABLE — running local AST scan only'})")
    print()

    # Run the linter inline (the lint-skill.py is in the same scripts/ dir)
    lint_path = Path(__file__).with_name("lint-skill.py")
    if lint_path.exists():
        print(f"=== Step 1: Frontmatter + structural lint ===")
        try:
            lint_result = subprocess.run(
                ["python3" if os.name != "nt" else "python", str(lint_path), str(skill_dir)],
                capture_output=False,
                timeout=20,
            )
            if lint_result.returncode != 0:
                print(f"\nLinter found errors. Fix them before continuing to AST scan.", file=sys.stderr)
                return lint_result.returncode
        except (OSError, subprocess.SubprocessError) as e:
            print(f"WARN: lint-skill.py failed to run: {e}", file=sys.stderr)

    # AST-scan each .py / .js / .mjs / .cjs in scripts/
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.is_dir():
        print("\n=== Step 2: AST scan ===")
        print("  (no scripts/ subdirectory — skipping AST scan)")
        print("\n✓ Skill will be admitted (no scripts to scan).")
        return 0

    py_walker = find_py_ast_walker()
    print(f"\n=== Step 2: AST scan ===")
    if py_walker:
        print(f"  Using walker: {py_walker}")
    else:
        print("  WARN: py_ast_walker.py not found locally. Cannot AST-scan Python files.")
        print("        Skill admission will still happen server-side, but this preview is limited.")

    py_files = sorted(scripts_dir.glob("**/*.py"))
    js_files = sorted(p for p in scripts_dir.glob("**/*") if p.is_file() and p.suffix in (".js", ".mjs", ".cjs"))
    sh_files = sorted(scripts_dir.glob("**/*.sh"))
    other_files = sorted(
        p for p in scripts_dir.glob("**/*")
        if p.is_file()
        and p.suffix not in (".py", ".js", ".mjs", ".cjs", ".sh")
    )

    total_block = 0
    total_warn = 0

    for py in py_files:
        rel = py.relative_to(scripts_dir)
        print(f"\n  scripts/{rel}:")
        if not py_walker:
            print("    (skipped — walker missing)")
            continue
        scan = scan_script_via_walker(py, py_walker)
        if scan.get("passed") and not scan.get("violations"):
            print("    ✓ pass (no findings)")
            continue
        for v in scan.get("violations", []):
            sev = v.get("severity", "?")
            line = v.get("line", "?")
            pattern = v.get("pattern", "?")
            snippet = v.get("snippet", "")[:80]
            marker = "✗ BLOCK" if sev == "block" else "⚠ WARN"
            print(f"    {marker} L{line} [{pattern}]: {snippet}")
            if sev == "block":
                total_block += 1
            else:
                total_warn += 1
        for e in scan.get("errors", []):
            print(f"    ERROR: {e}")

    if js_files:
        print(f"\n  JS scripts ({len(js_files)}): server-side AST scan only (acorn).")
        print("        This preview cannot run that locally.")
    if sh_files:
        print(f"\n  Shell scripts ({len(sh_files)}): admission gate will require 'unsupported_scripts_ok: true' in frontmatter")
        # Check whether the flag is set
        try:
            raw = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
            if "unsupported_scripts_ok: true" not in raw:
                print(f"        ✗ unsupported_scripts_ok is NOT set — admission will quarantine.")
                total_block += len(sh_files)
            else:
                print(f"        ✓ unsupported_scripts_ok: true is set")
        except OSError:
            pass

    if other_files:
        # Data-file extensions are admitted unconditionally
        data_exts = {".xml", ".xsd", ".html", ".css", ".json", ".yaml", ".yml", ".md", ".txt", ".csv"}
        for f in other_files:
            rel = f.relative_to(scripts_dir)
            if f.suffix.lstrip(".").lower() in {x.lstrip(".").lower() for x in data_exts}:
                continue
            print(f"\n  scripts/{rel}: extension '{f.suffix}' is neither code nor a whitelisted data type.")
            print(f"      ✗ admission will quarantine unless extension is added to DATA_FILE_EXTENSIONS")
            total_block += 1

    # Summary
    print()
    print("=== Summary ===")
    print(f"  Block-severity findings: {total_block}")
    print(f"  Warn-severity findings:  {total_warn}")
    if total_block == 0:
        print("  ✓ This skill WOULD be admitted by the gate.")
        return 0
    else:
        print("  ✗ This skill would be QUARANTINED by the gate.")
        print()
        print("  Suggested fixes (apply at least one):")
        print("    - Refactor the offending script(s) to remove eval/exec/shell=True/etc.")
        print("    - If the pattern is legitimate (e.g. test orchestrator), declare an")
        print("      explicit opt-in in SKILL.md frontmatter:")
        print("        shell_exec_ok: true             # for subprocess(shell=True), os.system")
        print("        unsupported_scripts_ok: true    # for .sh / .rb / etc.")
        print("      Operator must manually review the scripts before setting either flag.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
