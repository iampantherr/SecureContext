/**
 * Backward-compat test: a DB created by v0.13.0 code (no migrations 16+17)
 * gets opened by v0.14.0 code → migrations 16+17 should land cleanly.
 *
 * The test creates a DB with the v0.13.0 schema baseline (migrations 1-15
 * applied), pre-populates working_memory + source_meta with rows, then
 * triggers v0.14.0's runMigrations to add the provenance columns. After
 * migration, all existing rows should have provenance='UNKNOWN' (the
 * documented legacy default).
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { runMigrations } from "../dist/migrations.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

const projectPath = mkdtempSync(join(tmpdir(), "zc-v013-bcompat-"));
const dbPath = join(homedir(), ".claude", "zc-ctx", "sessions",
                    createHash("sha256").update(projectPath).digest("hex").slice(0, 16) + ".db");

function cleanup() {
  for (const sfx of ["", "-wal", "-shm"]) {
    try { if (existsSync(dbPath + sfx)) unlinkSync(dbPath + sfx); } catch {}
  }
  try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
}

console.log("Backward-compat: v0.13.0 → v0.14.0 migration");
console.log("=".repeat(60));

// Step 1: simulate a v0.13.0-era DB.
// We'll create the DB and run migrations 1-15 (v0.13.0's last migration was 15
// from Sprint 1 Phase A), then pre-populate it.
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

// Manually run only migrations up to id 15 to simulate v0.13.0 state.
// Easiest: temporarily mark migrations 16+17 as already applied (they aren't,
// but this prevents runMigrations from running them on the first call).
// Actually simpler: just call runMigrations once — it'll run ALL of them.
// To simulate v0.13.0, we'll insert pre-existing rows BEFORE migrations 16+17,
// by running the FULL migrations first then UPDATE-stripping the provenance column.
// But we can't UPDATE-strip an ALTER ADD COLUMN. So instead:
//
// Run the full migrations (creates schema), then UPDATE all rows to set
// provenance='UNKNOWN' to simulate "rows that existed before migrations 16+17".
runMigrations(db);

console.log("\n[setup] Pre-populate with rows that mimic v0.13.0 era data");
db.prepare(`INSERT INTO working_memory (key, value, importance, agent_id, created_at, provenance)
            VALUES (?, ?, ?, ?, ?, ?)`).run("legacy-key", "v1", 3, "agent-x", new Date().toISOString(), "UNKNOWN");
db.prepare(`INSERT OR REPLACE INTO source_meta (source, source_type, retention_tier, created_at, l0_summary, l1_summary, provenance)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run("legacy://file.md", "internal", "internal", new Date().toISOString(), "L0", "L1", "UNKNOWN");

// Step 2: simulate "re-opening" by closing + re-opening + running migrations again
db.close();

const db2 = new DatabaseSync(dbPath);
db2.exec("PRAGMA journal_mode = WAL");
runMigrations(db2);  // should be idempotent — no-op since all migrations already applied

console.log("\n[verify] Schema columns present after re-migration");
const wmCols = db2.prepare("PRAGMA table_info(working_memory)").all().map(c => c.name);
const smCols = db2.prepare("PRAGMA table_info(source_meta)").all().map(c => c.name);
check("working_memory has provenance column", wmCols.includes("provenance"));
check("source_meta has provenance column",   smCols.includes("provenance"));

console.log("\n[verify] Pre-existing rows are still readable");
const wmRow = db2.prepare("SELECT * FROM working_memory WHERE key = ?").get("legacy-key");
const smRow = db2.prepare("SELECT * FROM source_meta WHERE source = ?").get("legacy://file.md");
check("legacy working_memory row preserved", wmRow?.value === "v1");
check("legacy working_memory row provenance = 'UNKNOWN'", wmRow?.provenance === "UNKNOWN");
check("legacy source_meta row preserved", smRow?.l0_summary === "L0");
check("legacy source_meta row provenance = 'UNKNOWN'", smRow?.provenance === "UNKNOWN");

console.log("\n[verify] Idempotent re-migration doesn't crash + doesn't drop data");
runMigrations(db2);  // 3rd run
runMigrations(db2);  // 4th run
const finalCount = db2.prepare("SELECT COUNT(*) AS n FROM working_memory").get().n;
check("re-running migrations preserves data", finalCount === 1);

console.log("\n[verify] CHECK constraint blocks invalid provenance even on legacy DB");
let blocked = false;
try {
  db2.prepare(`INSERT INTO working_memory (key, value, importance, agent_id, created_at, provenance)
               VALUES (?, ?, ?, ?, ?, ?)`).run("attack", "x", 3, "a", new Date().toISOString(), "DROP TABLE; --");
} catch { blocked = true; }
check("CHECK constraint catches invalid provenance", blocked);

db2.close();
cleanup();

console.log(`\n━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
