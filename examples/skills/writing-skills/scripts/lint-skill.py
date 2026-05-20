#!/usr/bin/env python3
"""Lint a skill directory against the four invariants and Anthropic frontmatter spec.

Usage:
    lint-skill.py <skill-dir>

Exits 0 if the skill is clean (will admit). Exits non-zero with a list
of errors otherwise. WARN-level findings (hardcoded paths, missing
trigger keywords) print but don't fail.

Checks performed:
    1. SKILL.md exists
    2. Frontmatter parses + matches the Anthropic schema (matches the
       admission gate's strict mode in src/skills/filesystem_skill_import.ts)
    3. Description contains a trigger sentence ("use this whenever")
    4. Body has 3-7 numbered procedural steps (counts both `1.` lists and
       `### Step N` heading styles)
    5. Bundled scripts under scripts/ exist if SKILL.md references them
    6. WARN: scripts contain hardcoded absolute paths or project names
"""
import argparse
import io
import json
import os
import re
import sys
from pathlib import Path


# Force UTF-8 stdout on Windows so unicode marker chars don't crash cp1252.
# This is the cleanest cross-platform fix: stdout always carries UTF-8,
# regardless of the host code page.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        # Python <3.7 fallback (we require 3.10+ but be defensive)
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


VALID_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def parse_frontmatter(raw: str):
    """Extract YAML frontmatter from a SKILL.md. Returns (fm_dict, body_str, error_or_None)."""
    raw = raw.replace("\r\n", "\n")
    if not raw.startswith("---\n"):
        return {}, raw, "missing leading --- delimiter"
    end = raw.find("\n---\n", 4)
    if end == -1:
        return {}, raw, "missing closing --- delimiter"
    fm_text = raw[4:end]
    body = raw[end + 5:]
    fm = {}
    lines = fm_text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.strip().startswith("#"):
            i += 1
            continue
        m = re.match(r"^([a-z_][a-z0-9_-]*)\s*:\s*(.*)$", line, re.IGNORECASE)
        if not m:
            i += 1
            continue
        key, rest = m.group(1), m.group(2).strip()
        if rest == "|":
            block = []
            i += 1
            while i < len(lines) and (lines[i].startswith("  ") or not lines[i].strip()):
                block.append(lines[i][2:] if lines[i].startswith("  ") else lines[i])
                i += 1
            fm[key] = "\n".join(block).rstrip()
            continue
        if rest.startswith("[") and rest.endswith("]"):
            inner = rest[1:-1].strip()
            if inner:
                fm[key] = [s.strip().strip('"').strip("'") for s in inner.split(",")]
            else:
                fm[key] = []
        elif rest in ("true", "false"):
            fm[key] = (rest == "true")
        else:
            fm[key] = rest.strip('"').strip("'")
        i += 1
    return fm, body, None


def validate_frontmatter(fm: dict) -> list[str]:
    """Return a list of error strings (empty = clean). Mirrors the admission gate's checks."""
    errors = []
    name = fm.get("name", "")
    if not isinstance(name, str) or not name:
        errors.append("frontmatter.name must be a non-empty string")
    elif len(name) > 64:
        errors.append(f"frontmatter.name too long ({len(name)} chars; max 64)")
    elif not VALID_NAME_RE.match(name):
        errors.append(f"frontmatter.name must be lowercase alphanumeric with - and _ only (got: {name})")
    desc = fm.get("description", "")
    if not isinstance(desc, str) or not desc:
        errors.append("frontmatter.description must be a non-empty string")
    elif len(desc) > 1024:
        errors.append(f"frontmatter.description too long ({len(desc)} chars; max 1024)")
    if "allowed_tools" in fm:
        v = fm["allowed_tools"]
        if not isinstance(v, list):
            errors.append("frontmatter.allowed_tools must be a list of strings")
        else:
            for t in v:
                if not isinstance(t, str) or not t.strip():
                    errors.append(f"frontmatter.allowed_tools entries must be non-empty strings (got: {t!r})")
    for bool_field in ("user_invocable", "disable_model_invocation", "shell_exec_ok", "unsupported_scripts_ok"):
        if bool_field in fm and not isinstance(fm[bool_field], bool):
            errors.append(f"frontmatter.{bool_field} must be a boolean (got: {type(fm[bool_field]).__name__})")
    return errors


def detect_trigger(description: str) -> bool:
    """Trigger detection: looks for a 'use this whenever' or 'use this when' phrase."""
    if not description:
        return False
    d = description.lower()
    return "use this whenever" in d or "use this when" in d


def count_numbered_steps(body: str) -> int:
    """Count top-level numbered steps in the SKILL.md body.

    Recognizes two styles:
      - Ordered list: lines starting `1.`, `2.`, `3.`, ...
      - Sub-headings: `### Step 1`, `### Step 2`, ... (or `### 1.` / `### 1)`)

    Only counts steps under a heading whose text contains 'procedure', so
    the frontmatter-spec / reference / failure-modes sections' numbered
    lists don't inflate the count.
    """
    in_procedure = False
    in_subheading_under_procedure = False
    step_count = 0
    step_heading_re = re.compile(r"^###\s+(?:step\s+)?(\d+)\b", re.IGNORECASE)
    list_re = re.compile(r"^\s*(\d+)\.\s+\S")

    for line in body.split("\n"):
        stripped = line.strip()
        # Top-level ## heading: are we entering or leaving "## Procedure"?
        if stripped.startswith("## ") and not stripped.startswith("### "):
            in_procedure = "procedure" in stripped.lower()
            in_subheading_under_procedure = False
            continue
        if not in_procedure:
            continue
        # ### Step N style
        h = step_heading_re.match(stripped)
        if h and int(h.group(1)) <= 20:
            step_count += 1
            in_subheading_under_procedure = True
            continue
        # `1. ...` style ordered list — count only if we're NOT inside a subheading
        # (so a sub-list inside Step 1 doesn't double-count)
        if not in_subheading_under_procedure:
            m = list_re.match(line)
            if m and int(m.group(1)) <= 20:
                step_count += 1
    return step_count


def find_hardcoded_paths(scripts_dir: Path) -> list[tuple[str, int, str]]:
    """Scan bundled scripts for likely PROJECT-SPECIFIC hardcoded paths.

    Tuned to flag user-home paths (`/home/<u>/`, `C:\\Users\\<u>\\`) and
    project-named paths — NOT generic system paths like `/dev/null`,
    `/tmp/`, `/app/`, `/etc/`. Those are legitimate fallback locations
    in cross-platform fallback chains.
    """
    findings = []
    if not scripts_dir.is_dir():
        return findings
    # Match user-home paths only (the signal that says "this script is
    # bound to one operator's machine layout"):
    user_path_re = re.compile(
        r'["\']('
        r'/home/[A-Za-z][\w-]+/'                 # /home/user/...
        r'|/Users/[A-Za-z][\w-]+/'               # macOS /Users/user/...
        r'|[A-Za-z]:[/\\]Users[/\\][A-Za-z][\w-]+[/\\]'  # Windows C:\Users\user\...
        r')[^"\']*["\']'
    )
    for script in scripts_dir.glob("**/*.py"):
        try:
            content = script.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(content.splitlines(), start=1):
            # Skip comments
            if line.strip().startswith("#"):
                continue
            m = user_path_re.search(line)
            if m:
                findings.append((str(script), lineno, m.group()))
    return findings


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("skill_dir", help="Path to the skill directory to lint")
    args = p.parse_args()

    skill_dir = Path(args.skill_dir).resolve()
    if not skill_dir.is_dir():
        print(f"ERROR: not a directory: {skill_dir}", file=sys.stderr)
        return 2

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        print(f"ERROR: SKILL.md not found at {skill_md}", file=sys.stderr)
        return 2

    raw = skill_md.read_text(encoding="utf-8")
    fm, body, fm_err = parse_frontmatter(raw)

    errors = []
    warnings = []

    # 1. Frontmatter parse
    if fm_err:
        errors.append(f"frontmatter parse: {fm_err}")
        # Continue anyway so we surface as many issues as possible

    # 2. Frontmatter validation
    errors.extend(validate_frontmatter(fm))

    # 3. Trigger sentence
    if not detect_trigger(fm.get("description", "")):
        warnings.append(
            "description does not contain 'use this whenever' (or 'use this when'). "
            "Without a clear trigger phrase, agents may not match the skill to user requests."
        )

    # 4. Procedural step count
    step_count = count_numbered_steps(body)
    if step_count == 0:
        errors.append("no numbered procedural steps detected under '## Procedure' heading")
    elif step_count > 12:
        warnings.append(
            f"procedure has {step_count} steps (>12). Consider splitting into multiple "
            "composable skills per the 'small composable skills' principle."
        )

    # 5. Bundled scripts referenced in body must exist
    scripts_dir = skill_dir / "scripts"
    referenced_scripts = set(re.findall(r"scripts/([\w./-]+\.(?:py|js|mjs|cjs|sh))", body))
    if scripts_dir.is_dir():
        present_scripts = set(
            str(p.relative_to(scripts_dir)).replace("\\", "/")
            for p in scripts_dir.glob("**/*")
            if p.is_file()
        )
    else:
        present_scripts = set()
    missing = referenced_scripts - present_scripts
    if missing:
        for m in sorted(missing):
            errors.append(f"SKILL.md references scripts/{m} but file is missing")

    # 6. WARN: hardcoded paths
    hardcoded = find_hardcoded_paths(scripts_dir)
    for path, lineno, snippet in hardcoded:
        warnings.append(
            f"hardcoded absolute path at {path}:{lineno}: {snippet} — "
            "read from project config (.{name}-config.json) instead"
        )

    # Report
    print(f"Skill: {skill_dir}")
    print(f"  name:        {fm.get('name', '?')}")
    print(f"  description: {(fm.get('description', '')[:80] + '…') if len(fm.get('description', '')) > 80 else fm.get('description', '?')}")
    print(f"  scope:       {fm.get('scope', '?')}")
    print(f"  scripts:     {len([s for s in present_scripts if s.endswith(('.py', '.js', '.mjs', '.cjs', '.sh'))])} bundled")
    print(f"  procedure:   {step_count} numbered step(s)")
    print()
    if errors:
        print(f"ERRORS ({len(errors)}) — admission gate will REJECT:")
        for e in errors:
            print(f"  ✗ {e}")
    if warnings:
        print(f"WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"  ⚠ {w}")
    if not errors and not warnings:
        print("✓ Clean — admission gate will admit.")
    elif not errors:
        print("✓ Will admit (warnings are advisory).")
    else:
        print("✗ Will be rejected by admission gate. Fix errors above.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
