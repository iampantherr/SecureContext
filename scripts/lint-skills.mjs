#!/usr/bin/env node
/**
 * v0.23.0 Phase 1 #4 — Audit all active skills in skills_pg against the
 * new lint. Reports pass/warn/error counts + lists the failing skills.
 *
 * Usage:
 *   node scripts/lint-skills.mjs                    # PG mode (default)
 *   node scripts/lint-skills.mjs --fail-on-error    # exit 1 if any error
 *
 * Reads PG creds from settings.json fallback.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const FAIL_ON_ERROR = process.argv.includes("--fail-on-error");

// Resolve PG creds (settings.json fallback)
const settings = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8"));
const env = settings.mcpServers["zc-ctx"].env;

const { Pool } = pg;
const pool = new Pool({
  host:     env.ZC_POSTGRES_HOST,
  port:     parseInt(env.ZC_POSTGRES_PORT),
  user:     env.ZC_POSTGRES_USER,
  password: env.ZC_POSTGRES_PASSWORD,
  database: env.ZC_POSTGRES_DB,
});

const distPath = `file://${repoRoot.replace(/\\/g, "/")}/dist/skills/lint.js`;
const { lintSkillBody, formatLintResult } = await import(distPath);

const res = await pool.query(
  "SELECT skill_id, frontmatter, body FROM skills_pg WHERE archived_at IS NULL ORDER BY skill_id",
);

let pass = 0, warnOnly = 0, errored = 0;
const errors = [];
const warns  = [];

for (const row of res.rows) {
  const fm = typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter) : row.frontmatter;
  const lr = lintSkillBody(row.body, fm);
  if (!lr.ok) {
    errored++;
    errors.push({ skill_id: row.skill_id, errors: lr.errors, warnings: lr.warnings });
  } else if (lr.warnings.length > 0) {
    warnOnly++;
    warns.push({ skill_id: row.skill_id, warnings: lr.warnings });
  } else {
    pass++;
  }
}

console.log(`Active skills audited: ${res.rows.length}`);
console.log(`  pass (clean):  ${pass}`);
console.log(`  warnings only: ${warnOnly}`);
console.log(`  errors:        ${errored}`);

if (errors.length > 0) {
  console.log("");
  console.log("=== Skills with ERRORS (would be rejected at load/promotion) ===");
  for (const e of errors) {
    console.log(`\n${e.skill_id}:`);
    for (const err of e.errors) console.log(`  ✗ ${err}`);
    for (const w of e.warnings) console.log(`  ⚠ ${w}`);
  }
}

if (warns.length > 0) {
  console.log("");
  console.log("=== Skills with warnings only (still load, but should be improved) ===");
  for (const w of warns.slice(0, 20)) {
    console.log(`\n${w.skill_id}:`);
    for (const warn of w.warnings) console.log(`  ⚠ ${warn}`);
  }
  if (warns.length > 20) console.log(`\n  ... and ${warns.length - 20} more`);
}

await pool.end();

if (FAIL_ON_ERROR && errored > 0) {
  console.error(`\n${errored} skill(s) failed lint. Exiting with code 1.`);
  process.exit(1);
}
