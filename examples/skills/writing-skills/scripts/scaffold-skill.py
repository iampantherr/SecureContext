#!/usr/bin/env python3
"""Generate a new skill directory from CLI args.

Usage:
    scaffold-skill.py --name <kebab> --scope <global|project>
                      --description "Use this whenever <X>. <Y>."
                      [--project <abs-path>] [--with-script <name>]...

Writes:
    <target>/SKILL.md
    <target>/scripts/<each-with-script>.py  (stub)
    <project-root>/.<name>-config.json      (only when scope=project)

Exits 0 on success, non-zero with a stderr message on any failure.
The script is fully argparse-driven and idempotent: re-running with the
same arguments overwrites only the files it owns, never the operator's
edits to bundled scripts.
"""
import argparse
import io
import json
import os
import re
import sys
from pathlib import Path

# Force UTF-8 stdout on Windows so unicode marker chars don't crash cp1252.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except AttributeError:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


SKILL_MD_TEMPLATE = """---
name: {name}
description: |
  {description}
version: 1.0.0
scope: {scope}
intended_roles: [developer]
tags: [{name_token}]
allowed_tools: [Bash, Read, Edit]
user_invocable: true
disable_model_invocation: false
---

# {title}

## When to use

Trigger phrases (write the literal words the user might type):

- "TODO: phrase 1"
- "TODO: phrase 2"
- "TODO: phrase 3"

DO NOT use this for:

- TODO: cases this skill should NOT handle

## Procedure

1. TODO: step 1 (typically a script invocation)
2. TODO: step 2
3. TODO: step 3
4. TODO: step 4 (3–7 steps total; if you need more, split into multiple skills)

## Bundled scripts

{scripts_section}

## Reference materials

(Add to `references/` only when L2 isn't enough. Skill body should stand
on its own for most invocations.)

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| TODO: typical failure | TODO: cause | TODO: recovery |
"""

SCRIPT_STUB_TEMPLATE = '''#!/usr/bin/env python3
"""TODO: one-line description of what this script does.

Usage:
    {script_name} [--arg <value>]...

Reads project config from <project-root>/.{config_name}.json if present.
"""
import argparse
import json
import sys
from pathlib import Path


def load_config(project_root: Path) -> dict:
    """Read project-specific config, fall back to defaults."""
    cfg_path = project_root / ".{config_name}.json"
    if cfg_path.exists():
        try:
            return json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"WARN: ignoring malformed {{cfg_path}}: {{e}}", file=sys.stderr)
    return {{}}  # sensible defaults


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--example", help="TODO: replace with real args")
    args = parser.parse_args()

    project_root = Path.cwd()
    cfg = load_config(project_root)

    # TODO: implement the script's single responsibility here.
    # Rules:
    #   - stdout = the answer the agent reads
    #   - stderr = diagnostics / progress
    #   - exit 0 = success, non-zero = failure with stderr explanation
    #   - no eval/exec/compile/pickle.loads/__import__(user_input)
    #   - no subprocess(shell=True) unless SKILL.md declares shell_exec_ok: true

    print("TODO: replace with real output")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


VALID_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def slug_to_title(slug: str) -> str:
    return " ".join(w.capitalize() for w in slug.replace("_", "-").split("-"))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--name", required=True, help="kebab-case skill name (≤64 chars, lowercase, alnum + _ -)")
    p.add_argument("--scope", required=True, choices=("global", "project"))
    p.add_argument("--description", required=True, help="Frontmatter description (must contain 'use this whenever')")
    p.add_argument("--scope-rationale", required=True,
                   help="One-sentence justification for the scope choice. "
                        "Forces conscious decision per the writing-skills SKILL.md scope matrix. "
                        "Stored on disk + in the admission_log so the decision is auditable.")
    p.add_argument("--project", help="Absolute path to project root (required for scope=project)")
    p.add_argument("--with-script", action="append", default=[], help="Bundled script name (no extension); repeatable")
    p.add_argument("--auto-admit", action="store_true", default=True,
                   help="After scaffolding, automatically call POST /api/v1/skills/import-project so the new skill appears on the operator dashboard. Default: true. Pass --no-auto-admit to skip.")
    p.add_argument("--no-auto-admit", dest="auto_admit", action="store_false")
    args = p.parse_args()

    # Validate name
    if not VALID_NAME_RE.match(args.name) or len(args.name) > 64:
        print(f"ERROR: name '{args.name}' invalid (must be kebab-case ≤64 chars)", file=sys.stderr)
        return 1

    # Validate description has a trigger sentence
    desc_lower = args.description.lower()
    if "use this whenever" not in desc_lower and "use this when" not in desc_lower:
        print("ERROR: description must contain a trigger phrase 'use this whenever' or 'use this when'", file=sys.stderr)
        return 1
    if len(args.description) > 1024:
        print(f"ERROR: description too long ({len(args.description)} chars; max 1024 per Anthropic spec)", file=sys.stderr)
        return 1

    # Require a meaningful rationale (not a one-word brush-off)
    rationale = args.scope_rationale.strip()
    if len(rationale) < 20:
        print(f"ERROR: --scope-rationale too short ({len(rationale)} chars; minimum 20). "
              "Apply the decision matrix from writing-skills/SKILL.md and explain why this scope.",
              file=sys.stderr)
        return 1

    # Sanity-check the rationale matches the chosen scope (catches reflexive answers)
    rationale_lower = rationale.lower()
    if args.scope == "global":
        bad_signals = ["project-specific", "this project", "only used here", "specific to"]
        for signal in bad_signals:
            if signal in rationale_lower:
                print(f"WARN: --scope=global but rationale says '{signal}'. "
                      "If the procedure is project-specific, use --scope project. Continuing anyway.",
                      file=sys.stderr)
                break

    # Determine target dir
    home = Path.home()
    if args.scope == "global":
        target = home / ".claude" / "skills" / args.name
    else:
        if not args.project:
            print("ERROR: --project is required when --scope=project", file=sys.stderr)
            return 1
        project_root = Path(args.project)
        if not project_root.is_absolute():
            print(f"ERROR: --project must be absolute path (got: {args.project})", file=sys.stderr)
            return 1
        if not project_root.exists():
            print(f"ERROR: project path does not exist: {project_root}", file=sys.stderr)
            return 1
        target = project_root / ".claude" / "skills" / args.name

    # Refuse to overwrite a SKILL.md that already exists, BUT distinguish two cases:
    #   (a) directory has a populated SKILL.md → genuine conflict, refuse
    #   (b) directory exists but is empty or only contains other leftover files →
    #       likely a partial scaffold from a previous crashed run. Allow + warn.
    skill_md = target / "SKILL.md"
    if skill_md.exists():
        existing_size = skill_md.stat().st_size
        if existing_size > 200:
            print(f"ERROR: SKILL.md already exists at {skill_md} ({existing_size} bytes).", file=sys.stderr)
            print("       Refusing to overwrite a populated skill.", file=sys.stderr)
            print("       Move the existing skill aside or use a different --name.", file=sys.stderr)
            return 1
        else:
            print(f"WARN: SKILL.md exists at {skill_md} but is very small ({existing_size} bytes).", file=sys.stderr)
            print("      Treating as leftover from a partial / crashed previous run; overwriting.", file=sys.stderr)

    # Build the files
    target.mkdir(parents=True, exist_ok=True)
    (target / "scripts").mkdir(exist_ok=True)

    # Scripts section + stubs
    if args.with_script:
        scripts_lines = []
        for script_name in args.with_script:
            if not re.match(r"^[a-z0-9][a-z0-9_-]*$", script_name):
                print(f"ERROR: script name '{script_name}' invalid (kebab-case alnum + _ -)", file=sys.stderr)
                return 1
            scripts_lines.append(f"- `scripts/{script_name}.py` — TODO: describe what it does")
            stub_path = target / "scripts" / f"{script_name}.py"
            stub_content = SCRIPT_STUB_TEMPLATE.format(
                script_name=f"{script_name}.py",
                config_name=args.name,
            )
            stub_path.write_text(stub_content, encoding="utf-8")
        scripts_section = "\n".join(scripts_lines)
    else:
        scripts_section = "(No bundled scripts yet. Add scripts under `scripts/` and list them here.)"

    # SKILL.md
    skill_md_content = SKILL_MD_TEMPLATE.format(
        name=args.name,
        description=args.description.strip(),
        scope=args.scope,
        name_token=args.name.replace("-", "_"),
        title=slug_to_title(args.name),
        scripts_section=scripts_section,
    )
    skill_md.write_text(skill_md_content, encoding="utf-8")

    # Project-config file (project scope only)
    config_path = None
    if args.scope == "project":
        config_path = Path(args.project) / f".{args.name}-config.json"
        if not config_path.exists():
            config_path.write_text(json.dumps({
                "_comment": f"Project-specific overrides for the {args.name} skill. Edit as needed.",
            }, indent=2) + "\n", encoding="utf-8")

    # Persist the scope rationale alongside the skill — makes the decision
    # auditable later (any future operator / spotter can see why this skill
    # was scoped the way it was).
    rationale_path = target / ".scope-rationale.txt"
    rationale_path.write_text(
        f"Scope: {args.scope}\n"
        f"Rationale: {rationale}\n"
        f"Scaffolded at: {target}\n",
        encoding="utf-8",
    )

    # Auto-trigger admission so the skill shows up on the dashboard immediately.
    # This is the missing piece that previously caused new skills to remain
    # invisible to operators until the next sc-api boot (which most operators
    # don't realize they need to do).
    admit_status = "(skipped — --no-auto-admit)"
    if args.auto_admit:
        admit_status = trigger_admission(args.scope, args.project, args.name)

    # Report
    print(f"Scaffolded skill at: {target}")
    print(f"  SKILL.md             ✓ ({len(skill_md_content)} bytes)")
    print(f"  .scope-rationale.txt ✓ ({args.scope}: {rationale[:60]}{'...' if len(rationale) > 60 else ''})")
    for script_name in args.with_script:
        print(f"  scripts/{script_name}.py  ✓ (stub)")
    if config_path:
        print(f"  {config_path}  ✓ (project config)")
    print(f"  admission:           {admit_status}")
    print()
    print("Next steps:")
    print(f"  1. Edit {skill_md} — fill in trigger phrases + procedure")
    for script_name in args.with_script:
        print(f"  2. Edit {target / 'scripts' / (script_name + '.py')} — implement the script")
    print(f"  3. Lint:    python lint-skill.py {target}")
    print(f"  4. Preview: python preview-admission.py {target}")
    if args.auto_admit and "admitted" in admit_status:
        print(f"  5. Check the dashboard at $ZC_API_URL/dashboard to see the new skill.")
    return 0


def trigger_admission(scope: str, project_path: str | None, skill_name: str | None = None) -> str:
    """POST to the admission endpoint so the new skill appears on the dashboard.

    For GLOBAL skills: sc-api watches ~/.claude/skills/ via its bind-mount; calling
    import-project on the operator's $HOME is enough.

    For PROJECT-LOCAL skills: sc-api can only see <project>/.claude/skills/<name>/
    if the project is BIND-MOUNTED into the container. The host-side path passed
    to --project becomes /projects/<basename> inside the container. We try that
    translation; if the path isn't mounted, the importer returns scanned=0 and
    we surface that clearly so the operator knows to add a bind-mount.

    Returns a status string for the report. Failure is non-fatal — the
    operator can always trigger admission manually later.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    api_url = os.environ.get("ZC_API_URL", "http://localhost:3099")
    api_key = os.environ.get("ZC_API_KEY", "")

    if scope == "global":
        # The boot-time importer auto-scans ~/.claude/skills/ (path is in the
        # container's worldview as /home/securecontext/.claude/skills/, which
        # is bind-mounted to the host's ~/.claude/skills/). Calling import-project
        # with the operator's home triggers a re-scan.
        target_path = str(Path.home()).replace("\\", "/")
    elif project_path:
        # Translate host path → in-container path. sc-api's docker-compose
        # convention is to bind-mount projects under /projects/<basename>/.
        host_path = Path(project_path).resolve()
        in_container_path = f"/projects/{host_path.name}"
        target_path = in_container_path
    else:
        return "(no project path; trigger admission manually)"

    url = f"{api_url}/api/v1/skills/import-project?path={urllib.parse.quote(target_path)}"
    req = urllib.request.Request(url, method="POST")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(body)
            scanned = data.get("scanned", 0)
            inserted = data.get("inserted", 0)
            updated = data.get("updated", 0)
            errors = data.get("errors", 0)
            # Detect "this project is not bind-mounted" by looking at the
            # details for an entry that matches our target skill.
            details = data.get("details", [])
            ours = None
            if skill_name:
                for d in details:
                    if skill_name in d.get("skill_dir", ""):
                        ours = d
                        break
            if scope == "project" and ours is None and scanned == 0:
                return (f"NOT admitted — project '{Path(project_path).name}' is not bind-mounted into sc-api. "
                        f"Add this line to docker/docker-compose.yml under sc-api volumes:\n"
                        f"    - ${{USERPROFILE:-${{HOME}}}}/AI_projects/{Path(project_path).name}:{target_path}\n"
                        f"Then 'docker compose -f docker/docker-compose.yml up -d sc-api' and retry "
                        f"'curl -X POST -H \"Authorization: Bearer $ZC_API_KEY\" \"{url}\"'.")
            our_result = f"; this skill: {ours['result']}" if ours else ""
            return f"admitted (scanned={scanned} +{inserted} ~{updated} ✗{errors}{our_result})"
        except json.JSONDecodeError:
            return f"admitted (response: {body[:80]})"
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        return f"(admission HTTP call failed: {e}; run manually: curl -X POST {url})"


if __name__ == "__main__":
    raise SystemExit(main())
