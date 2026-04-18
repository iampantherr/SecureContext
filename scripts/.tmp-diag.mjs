/**
 * Diagnostic: what's the TRUE state of Test_Agent_Coordination's SQLite DB
 * after the session, and would getIndexingStatus correctly trigger indexing?
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const project = String.raw`C:\Users\Amit\AI_projects\Test_Agent_Coordination`;
const h = createHash("sha256").update(project).digest("hex").slice(0, 16);
const dbFile = join(homedir(), ".claude", "zc-ctx", "sessions", h + ".db");

// Open with openDb to run migrations
const { openDb } = await import("../dist/knowledge.js");
const db = openDb(project);

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(t => t.name);
console.log("tables:", tables.join(", "));

const migs = db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all().map(r => r.id);
console.log("applied migrations:", migs.join(", "));

const sm = db.prepare(`SELECT COUNT(*) as n FROM source_meta WHERE source LIKE 'file:%'`).get();
console.log("file:-prefixed source_meta:", sm.n);

const prj = db.prepare(`SELECT COUNT(*) as n FROM project_card`).get();
console.log("project_card rows:", prj.n);

const srl = db.prepare(`SELECT COUNT(*) as n FROM session_read_log`).get();
console.log("session_read_log rows:", srl.n);

const tod = db.prepare(`SELECT COUNT(*) as n FROM tool_output_digest`).get();
console.log("tool_output_digest rows:", tod.n);

const bc = db.prepare(`SELECT COUNT(*) as n FROM broadcasts`).get();
console.log("broadcasts:", bc.n);

db.close();

// Now check: if we ran the hook right now, what would getIndexingStatus return?
const { getIndexingStatus } = await import("../dist/harness.js");
const status = getIndexingStatus(project);
console.log("\ngetIndexingStatus:", JSON.stringify(status));
console.log("\n→ SessionStart hook would", status.state === "not-indexed" ? "SPAWN background-index.mjs" : "NO-OP");
