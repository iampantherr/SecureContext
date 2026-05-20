/**
 * v0.30.0 — Single source of truth for the Anthropic skill-design standard.
 *
 * This module exists so that the four-invariant rules, script-writing rules,
 * scope-decision matrix, and progressive-disclosure principle are all defined
 * IN ONE PLACE — and consumed by:
 *
 *   - The mutator's proposer prompt (src/skills/mutator.ts:buildProposerPrompt)
 *   - The spotter β LLM filer (src/skills/spotter/llm_filer.ts)
 *   - The writing-skills meta-skill (referenced in SKILL.md / lint-skill.py)
 *   - The skill-candidate review UI (planned: highlight rule violations)
 *
 * The text below is a faithful summary of:
 *   - The Anthropic skill-design guide (skill-design.md)
 *   - The "How Anthropic engineers prompt Claude Code" YouTube video that
 *     the learn-from-youtube skill summarized (4 rules: prompt skills not
 *     Claude; skills are more than prompts; small composable skills not
 *     one mega-skill; continuously update skills after sessions)
 *   - The lessons we encoded in writing-skills/SKILL.md (the scope matrix,
 *     the script-writing rules, the four invariants)
 *
 * When we change the standard, change it HERE. Every consumer picks up
 * the new text automatically.
 */

/**
 * The four invariants every Anthropic-style skill must satisfy. The admission
 * gate's writing-skills/lint-skill.py enforces these; the mutator and spotter
 * must respect them when generating candidates.
 */
export const FOUR_INVARIANTS = `
A skill MUST satisfy ALL FOUR of these. A candidate that fails any one of
these is not a skill — it's either a one-off task, a documentation note,
or a reasoning pattern that doesn't repeat.

1. **PROCEDURAL, not factual.** The body describes HOW TO do something
   repeatable, not WHAT something is. Documentation goes in references/
   or zc_remember; the skill body is steps.

2. **CLEAR TRIGGER.** The description field must let you write a
   one-sentence "Use this whenever <X>" rule with the literal words the
   user might type. Vague descriptions ("a utility for working with
   YouTube videos") fail to fire at runtime. Specific triggers ("Use
   this whenever the user pastes a YouTube URL or asks to learn from /
   summarize / extract content from a YouTube video") fire reliably.

3. **>=3 OCCURRENCES.** Skills are for procedures used 3+ times. One-offs
   stay as task-specific reasoning. The skill-spotter enforces this at
   detection; mutations preserve it (don't remove the trigger boundary
   that made the skill fire reliably).

4. **PROGRESSIVE DISCLOSURE LEVERAGE.** Three layers:
     L1 — frontmatter.description, ~100 tokens, ALWAYS in the agent's
          context. The trigger lives here.
     L2 — SKILL.md body, <5,000 tokens, loaded WHEN THE SKILL FIRES.
          The numbered procedural steps live here.
     L3 — bundled scripts/ + references/, unlimited size, loaded
          ON-DEMAND via bash invocation. The heavy lifting lives here.
   A "skill" that fits entirely in L1 is a one-liner, not a skill —
   it should be a zc_remember fact. A "skill" that has no L3 leverage
   is just a prompt wrapper — invest in the tools layer.
`.trim();

/**
 * Script-writing rules — the patterns that the AST scanner blocks at
 * admission. Bundled scripts that violate these get quarantined.
 * The mutator MUST NOT propose script content that uses these patterns
 * unless the operator has explicitly opted in via the frontmatter flags.
 */
export const SCRIPT_RULES = `
Bundled scripts under scripts/ MUST follow these rules. The admission
gate's AST scanner (py_ast_walker.py for Python, acorn for JS) blocks
any script that violates them.

Python — forbidden patterns:
- eval(...), exec(...), compile(...)
- __import__(user_input)  (dynamic import)
- subprocess.run/Popen/call with shell=True
- os.system(...), os.popen(...)
- pickle.loads(...), pickle.load(...), dill.loads, marshal.loads
- yaml.load(...) without an explicit safe Loader

JavaScript/Node — forbidden patterns:
- eval(...), new Function(...)
- child_process.exec(...), child_process.execSync(...)
- vm.runInNewContext(...), vm.runInThisContext(...)

Operator opt-ins (only after MANUAL review of the script content):
- shell_exec_ok: true             — downgrades subprocess(shell=True) +
                                    os.system findings from block→warn
- unsupported_scripts_ok: true    — admits .sh / .rb / etc. scripts the
                                    AST scanner doesn't yet handle

Style rules for ALL bundled scripts:
- Args via argparse (Python) or process.argv (Node).
- stdout = the answer the agent reads.
- stderr = diagnostics / progress / warnings.
- Exit code 0 = success; non-zero = failure with stderr explanation.
- Idempotent where possible (re-runnable with same inputs).
- No interactive prompts (no input(), no TTY reads). Everything via args
  or stdin.
- Read project-specific config from <project>/.<skill-name>-config.json
  or zc_remember. NEVER hardcode project paths, names, ports, DB IDs.
`.trim();

/**
 * Scope-decision matrix — how to decide global vs project-local.
 * Mutations should preserve the scope of the parent skill UNLESS the
 * mutation specifically addresses generality (e.g. removing hardcoded
 * project specifics → propose promotion to global, log rationale).
 */
export const SCOPE_DECISION = `
Global vs project-local — apply the six-question matrix:

  Q1. Procedure touches only standard files (package.json, CHANGELOG.md,
      README.md)?  YES → maybe global  | NO → maybe project
  Q2. Procedure has ZERO hardcoded paths, project names, ports, DB IDs?
      YES → maybe global  | NO → project
  Q3. Pattern has appeared in >=2 distinct projects?
      YES → strong global | NO → project (for now; promote later)
  Q4. Procedure references project-specific files (e.g. HANDOFF.md,
      STRATEGY.md, project-policies.md)?
      YES → project | NO → maybe global
  Q5. Procedure encodes team-specific conventions (commit format, branch
      naming, deploy URL)?  YES → project | NO → maybe global
  Q6. Procedure only fires in one repo so far?  YES → project (promote
      later) | NO → maybe global

Default tie-breaker: PROJECT-LOCAL. Promotion from project → global is
cheap; the reverse is expensive (operators in other projects depend on
the global skill quietly making wrong assumptions).

The "global skill + per-project config" pattern: when a procedure is
95% generic with a 5% project-specific tail, make it global and read
the 5% from <project>/.<skill-name>-config.json. One global skill, N
project configs. Examples: publish-github-release reads
.publish-github-release-config.json; readme-author reads
.readme-author-config.json.
`.trim();

/**
 * Composition principle from the YouTube video / Anthropic guide:
 * "small composable skills, not one mega-skill".
 */
export const COMPOSITION_RULES = `
Skill composition:

- Prefer SMALL, FOCUSED, COMPOSABLE skills over one mega-skill.
  A skill whose procedure has >10 steps is probably two skills.
- Skills can invoke other skills via Bash. The admission gate
  HMAC-verifies each script per invocation, so composition is safe.
- When mutating a skill that has sprawled into many responsibilities,
  consider proposing a DECOMPOSITION into smaller skills rather than a
  bigger body (this is sometimes the best mutation).
- Reuse bundled scripts from sibling skills. A publish-github-release
  could invoke readme-author/scripts/regenerate.py as a preflight step
  ("ensure README is current before tagging"). This is the chaining
  pattern Anthropic engineers prefer.
`.trim();

/**
 * Full standard text — used as a system-prompt block by the mutator and
 * spotter. Order matters: put the invariants first so the model
 * internalizes them before the rules.
 */
export const ANTHROPIC_SKILL_STANDARD = [
  "# The v0.29.0 Anthropic skill-design standard",
  "",
  "When you propose mutations (or new candidates) for a skill, you MUST",
  "respect this standard. Candidates that violate any of these rules will",
  "be rejected by the admission gate or scored low by the replay engine.",
  "",
  "## The four invariants",
  FOUR_INVARIANTS,
  "",
  "## Script-writing rules",
  SCRIPT_RULES,
  "",
  "## Scope-decision matrix",
  SCOPE_DECISION,
  "",
  "## Composition principles",
  COMPOSITION_RULES,
].join("\n");

/**
 * Short-form summary — used in places where the full text is too verbose
 * but a reminder is still useful (e.g., dashboard tooltips, lint output).
 */
export const STANDARD_TLDR = [
  "Four invariants: (1) procedural-not-factual, (2) clear trigger,",
  "(3) ≥3 occurrences, (4) progressive disclosure (L1/L2/L3).",
  "Scripts: no eval/exec/shell=True/pickle; argparse + stdout; idempotent;",
  "read project config from .<name>-config.json, never hardcode.",
  "Scope: project-local by default; promote to global when proven in ≥2 projects.",
  "Composition: prefer small composable skills; chain via Bash.",
].join(" ");
