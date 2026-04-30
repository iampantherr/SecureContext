#!/usr/bin/env node
/**
 * v0.19.0 Step 1 — Role-to-skill extractor.
 *
 * Reads C:/Users/Amit/AI_projects/A2A_dispatcher/roles.json and splits each
 * role's `deepPrompt` into:
 *
 *   1. IDENTITY content (stays in role) — "You are X", communication
 *      protocols, boundaries, routing config.
 *   2. PROCEDURAL content (extracted to .skill.md) — checklists, workflows,
 *      pre-action verifications, debugging protocols.
 *
 * Output goes to a STAGING directory by default — operator reviews + edits
 * before any move into production. Run with --apply to ALSO write a slimmed
 * roles.json (with .bak backup) and copy approved skills to the skills/ dir.
 *
 * Heuristics:
 *   - Split deepPrompt on '## ' markdown H2 headers (most roles use this format)
 *   - Classify each section by title + body keywords:
 *       PROCEDURAL  if title matches /protocol|checklist|workflow|flow|rules|
 *                   instincts|prime directives|when (you|to)|before|how to/i
 *                   OR body has ≥3 numbered lists (1. ... 2. ... 3.) OR ≥5 imperative bullets
 *       IDENTITY    if title matches /role|charter|who you are|background|values|persona/i
 *                   OR body has no numbered lists AND ≤3 imperative bullets
 *       AMBIGUOUS   otherwise — flagged for manual review (NOT extracted)
 *
 * Manual review note: large multi-section blobs like "PRIME DIRECTIVES" can
 * legitimately stay in the role (foundational constraints) OR split (becomes
 * a "developer-prime-directives.skill.md"). The script proposes; the operator
 * decides.
 *
 * Usage:
 *   node scripts/extract-skills-from-roles.mjs            # dry-run, all roles
 *   node scripts/extract-skills-from-roles.mjs --role=developer  # single role
 *   node scripts/extract-skills-from-roles.mjs --apply          # WRITE staged skills + slimmed roles.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ROLE_ARG = args.find((a) => a.startsWith("--role="));
const ONLY_ROLE = ROLE_ARG ? ROLE_ARG.split("=")[1] : null;
const ROLES_PATH = "C:\\Users\\Amit\\AI_projects\\A2A_dispatcher\\roles.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const STAGING_DIR = join(REPO_ROOT, "skills", "_staging_v0_19");
const PRODUCTION_SKILLS_DIR = join(REPO_ROOT, "skills");
const ROLES_BACKUP = ROLES_PATH + ".v0_19_backup";

// ── Classification rules ──────────────────────────────────────────────────
const PROCEDURAL_TITLE_PATTERNS = [
  /protocol/i, /checklist/i, /workflow/i, /\bflow\b/i, /\brules\b/i,
  /instincts/i, /directives/i, /\bwhen\b.{0,30}(you|to)/i, /\bbefore\b/i,
  /\bhow to\b/i, /procedure/i, /steps/i, /method/i, /technique/i,
  /\bdo\b.{0,15}\bnot\b/i, /pitfalls?/i, /pattern/i, /\bguard\b/i,
];
const IDENTITY_TITLE_PATTERNS = [
  /^role/i, /charter/i, /who you are/i, /background/i, /values/i,
  /persona/i, /style/i, /voice/i, /who am i/i, /experience/i, /^about/i,
];

function classifySection(title, body) {
  const t = title.trim();
  // Quick title-based classification
  for (const p of IDENTITY_TITLE_PATTERNS) if (p.test(t)) return { kind: "identity", reason: `title matches identity pattern ${p}` };
  for (const p of PROCEDURAL_TITLE_PATTERNS) if (p.test(t)) return { kind: "procedural", reason: `title matches procedural pattern ${p}` };
  // Body-based fallback
  const numberedLists = (body.match(/^\s*\d+\.\s/gm) ?? []).length;
  const imperativeBullets = (body.match(/^\s*-\s+(Always|Never|Before|After|If|Use|Avoid|Do|Don't|Make|Treat|Prefer|Default)/gim) ?? []).length;
  const totalBullets = (body.match(/^\s*-\s/gm) ?? []).length;
  if (numberedLists >= 3 || imperativeBullets >= 5) {
    return { kind: "procedural", reason: `${numberedLists} numbered + ${imperativeBullets} imperative bullets` };
  }
  if (numberedLists === 0 && totalBullets <= 3) {
    return { kind: "identity", reason: `mostly prose, no procedural structure` };
  }
  return { kind: "ambiguous", reason: `${numberedLists} numbered lists, ${imperativeBullets} imperatives, ${totalBullets} bullets` };
}

// ── Skill file generation ─────────────────────────────────────────────────
function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function generateSkillFile(roleName, sectionTitle, body) {
  const slug = slugify(sectionTitle);
  const filename = `${roleName}-${slug}.skill.md`;
  const skillId = `${roleName}-${slug}@1@global`;

  const frontmatter = [
    "---",
    `id: ${skillId}`,
    `name: ${roleName}-${slug}`,
    `version: 1`,
    `scope: global`,
    `description: ${sectionTitle} — extracted from roles.json deepPrompt for ${roleName}`,
    `intended_roles: [${roleName}]`,
    `mutation_guidance: |`,
    `  This skill encodes a behavioral procedure originally embedded in the`,
    `  ${roleName} role's deepPrompt. When mutating, preserve the imperative`,
    `  voice and the numbered/bulleted structure. Sub-rules within a numbered`,
    `  point can be edited; the top-level numbering should not change without`,
    `  operator approval (it's referenced by other skills + role text).`,
    `tags: [${roleName}, role-extracted, v0-19-bootstrap]`,
    `acceptance_criteria:`,
    `  min_outcome_score: 0.6`,
    `  completes_in_seconds: 600`,
    "---",
    "",
  ].join("\n");

  const heading = `# ${sectionTitle}\n\n_(Extracted from \`roles.json\` deepPrompt for the **${roleName}** role during the v0.19.0 role/skill split. Original content preserved verbatim. Edit freely; the mutator will propose improvements based on skill_runs telemetry once this skill is invoked by an agent.)_\n\n---\n\n`;

  return { filename, content: frontmatter + heading + body.trim() + "\n" };
}

// ── Section parsing ───────────────────────────────────────────────────────
function splitDeepPromptIntoSections(deepPrompt) {
  // Split on lines starting with '## ' (markdown H2)
  const lines = deepPrompt.split("\n");
  const sections = [];
  let current = { title: "(preamble)", body: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.body.length > 0) sections.push(current);
      current = { title: line.replace(/^##\s+/, "").trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length > 0) sections.push(current);
  // Body string
  return sections.map((s) => ({ title: s.title, body: s.body.join("\n") }));
}

// ── Main flow ─────────────────────────────────────────────────────────────
console.log(`v0.19.0 Step 1 — Role-to-skill extractor`);
console.log(`  roles.json: ${ROLES_PATH}`);
console.log(`  staging:    ${STAGING_DIR}`);
console.log(`  apply:      ${APPLY}`);
console.log(`  only role:  ${ONLY_ROLE ?? "(all)"}`);
console.log("");

if (!existsSync(ROLES_PATH)) {
  console.error(`roles.json not found at ${ROLES_PATH}`);
  process.exit(1);
}

const roles = JSON.parse(readFileSync(ROLES_PATH, "utf-8"));
const roleNames = ONLY_ROLE ? [ONLY_ROLE] : Object.keys(roles).filter((n) => roles[n].deepPrompt && !n.startsWith("mutator"));

if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });

const summary = {
  rolesProcessed: 0,
  sectionsTotal: 0,
  proceduralExtracted: 0,
  identityKept: 0,
  ambiguousFlagged: 0,
  filesWritten: 0,
};

const reportLines = [`# v0.19.0 Step 1 — Role/Skill Split Report`, ``, `Generated: ${new Date().toISOString()}`, ``];

for (const roleName of roleNames) {
  const role = roles[roleName];
  if (!role || !role.deepPrompt) {
    console.log(`  ⚠ ${roleName}: no deepPrompt, skipping`);
    continue;
  }
  summary.rolesProcessed++;
  reportLines.push(`---`, ``, `## Role: \`${roleName}\``, ``);

  const sections = splitDeepPromptIntoSections(role.deepPrompt);
  console.log(`  ▸ ${roleName}: ${sections.length} sections, ${role.deepPrompt.length} chars (~${Math.round(role.deepPrompt.length/4)} tokens)`);
  reportLines.push(`Original size: **${role.deepPrompt.length} chars** (~${Math.round(role.deepPrompt.length/4)} tokens)`, ``, `${sections.length} sections detected.`, ``);
  reportLines.push(`| # | Section | Classification | Reason | Status |`);
  reportLines.push(`|---|---|---|---|---|`);

  let identityRebuild = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    // Skip the preamble — it's already prepended below as identity content,
    // re-adding it via identityRebuild would duplicate it in the slimmed text.
    if (section.title === "(preamble)") continue;
    summary.sectionsTotal++;
    const cls = classifySection(section.title, section.body);
    const escTitle = section.title.replace(/\|/g, "\\|");

    if (cls.kind === "procedural") {
      summary.proceduralExtracted++;
      const skill = generateSkillFile(roleName, section.title, section.body);
      const fullPath = join(STAGING_DIR, skill.filename);
      writeFileSync(fullPath, skill.content, "utf-8");
      summary.filesWritten++;
      console.log(`     ✂ procedural: "${section.title}" → ${skill.filename}`);
      reportLines.push(`| ${i + 1} | ${escTitle} | **PROCEDURAL** | ${cls.reason} | extracted → \`${skill.filename}\` |`);
    } else if (cls.kind === "identity") {
      summary.identityKept++;
      // Re-add to identity rebuild
      identityRebuild.push(`## ${section.title}\n\n${section.body.trim()}`);
      reportLines.push(`| ${i + 1} | ${escTitle} | identity | ${cls.reason} | kept in role |`);
    } else {
      summary.ambiguousFlagged++;
      // For now keep ambiguous in identity rebuild (safer); operator can later move to skill
      identityRebuild.push(`## ${section.title}\n\n${section.body.trim()}`);
      console.log(`     ? AMBIGUOUS: "${section.title}" — kept in role (review needed)`);
      reportLines.push(`| ${i + 1} | ${escTitle} | ambiguous | ${cls.reason} | **MANUAL REVIEW** — kept in role for now |`);
    }
  }

  // Compute slimmed deepPrompt
  const slimmed = sections[0].title === "(preamble)" && sections[0].body.trim()
    ? sections[0].body.trim() + "\n\n" + identityRebuild.join("\n\n")
    : identityRebuild.join("\n\n");

  // Write the proposed slimmed deepPrompt to staging
  const slimPath = join(STAGING_DIR, `_role_${roleName}.slimmed-deepprompt.md`);
  writeFileSync(slimPath, slimmed, "utf-8");

  const sizeBefore = role.deepPrompt.length;
  const sizeAfter = slimmed.length;
  const reduction = ((sizeBefore - sizeAfter) / sizeBefore * 100).toFixed(1);
  reportLines.push(``, `**Size reduction: ${sizeBefore} → ${sizeAfter} chars (${reduction}% smaller).** Slimmed deepPrompt staged at \`_role_${roleName}.slimmed-deepprompt.md\`.`, ``);
}

// Write the summary report
const reportPath = join(STAGING_DIR, `_REPORT.md`);
reportLines.push(`---`, ``, `## Summary`, ``);
reportLines.push(`- Roles processed:        **${summary.rolesProcessed}**`);
reportLines.push(`- Sections analyzed:      **${summary.sectionsTotal}**`);
reportLines.push(`- Procedural (extracted): **${summary.proceduralExtracted}**`);
reportLines.push(`- Identity (kept):        **${summary.identityKept}**`);
reportLines.push(`- Ambiguous (flagged):    **${summary.ambiguousFlagged}**`);
reportLines.push(`- Skill files written:    **${summary.filesWritten}**`);
reportLines.push(``);
reportLines.push(`## Next steps`, ``);
reportLines.push(`1. **Review the staged skills** in \`${STAGING_DIR}\`. Each \`*.skill.md\` is a proposed extraction.`);
reportLines.push(`2. **Review the slimmed deepPrompts** in \`_role_*.slimmed-deepprompt.md\`. These are what \`roles.json\` would become after the split.`);
reportLines.push(`3. **Edit / merge / split** any skills that need refinement.`);
reportLines.push(`4. **Re-run with \`--apply\`** to:`);
reportLines.push(`   - Copy approved skills from staging to \`skills/\``);
reportLines.push(`   - Replace each role's \`deepPrompt\` with the slimmed version`);
reportLines.push(`   - Backup original \`roles.json\` to \`${ROLES_BACKUP}\``);
reportLines.push(``);
writeFileSync(reportPath, reportLines.join("\n"), "utf-8");

console.log("");
console.log(`──── Summary ────`);
console.log(`  Roles processed:        ${summary.rolesProcessed}`);
console.log(`  Sections analyzed:      ${summary.sectionsTotal}`);
console.log(`  Procedural (extracted): ${summary.proceduralExtracted}`);
console.log(`  Identity (kept):        ${summary.identityKept}`);
console.log(`  Ambiguous (flagged):    ${summary.ambiguousFlagged}`);
console.log(`  Skill files written:    ${summary.filesWritten}`);
console.log("");
console.log(`Report: ${reportPath}`);
console.log(`Staged skills: ${STAGING_DIR}`);
console.log("");

if (APPLY) {
  console.log(`──── APPLY MODE ────`);
  // Backup original roles.json
  if (!existsSync(ROLES_BACKUP)) {
    copyFileSync(ROLES_PATH, ROLES_BACKUP);
    console.log(`  Backup written: ${ROLES_BACKUP}`);
  } else {
    console.log(`  Backup already exists: ${ROLES_BACKUP}`);
  }
  // Replace deepPrompts
  for (const roleName of roleNames) {
    const slimPath = join(STAGING_DIR, `_role_${roleName}.slimmed-deepprompt.md`);
    if (!existsSync(slimPath)) continue;
    const slimmed = readFileSync(slimPath, "utf-8");
    roles[roleName].deepPrompt = slimmed;
  }
  writeFileSync(ROLES_PATH, JSON.stringify(roles, null, 2), "utf-8");
  console.log(`  roles.json updated.`);
  // Copy skills to production
  if (!existsSync(PRODUCTION_SKILLS_DIR)) mkdirSync(PRODUCTION_SKILLS_DIR, { recursive: true });
  let copied = 0;
  for (const fname of (await import("node:fs/promises")).then ? [] : []) {
    /* placeholder; using sync below */
  }
  const fs = await import("node:fs");
  for (const f of fs.readdirSync(STAGING_DIR)) {
    if (f.endsWith(".skill.md")) {
      copyFileSync(join(STAGING_DIR, f), join(PRODUCTION_SKILLS_DIR, f));
      copied++;
    }
  }
  console.log(`  Copied ${copied} skill files to ${PRODUCTION_SKILLS_DIR}`);
  console.log(`  ⚠ Running orchestrator/developer agents WILL NOT see the new role text until they restart.`);
  console.log(`     Their cached prompt was loaded at spawn. Restart Claude Code window to refresh.`);
} else {
  console.log(`(dry-run; pass --apply to write changes)`);
}
