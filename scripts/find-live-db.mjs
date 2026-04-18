/**
 * Scan ~/.claude/zc-ctx/sessions/*.db for DBs that:
 *  1. Actually contain a tool_calls table with the Sprint 1 schema (has 'id' column)
 *  2. Have at least 1 row
 *  3. Were modified recently (today)
 *
 * Prints a summary of which DBs show live telemetry activity.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSIONS_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");
const today = new Date().toISOString().slice(0, 10);

const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".db"));

const results = [];
for (const f of files) {
  const p = join(SESSIONS_DIR, f);
  const s = statSync(p);
  const mtime = s.mtime.toISOString();
  if (!mtime.startsWith(today)) continue;

  let info = { file: f, mtime, size: s.size, tools: 0, schemaHasId: false, tables: 0 };
  try {
    const db = new DatabaseSync(p);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    info.tables = tables.length;

    const hasTC = tables.some((t) => t.name === "tool_calls");
    if (hasTC) {
      // Check columns
      const cols = db.prepare(`PRAGMA table_info(tool_calls)`).all();
      info.schemaHasId = cols.some((c) => c.name === "id");
      // Row count
      try {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls`).get();
        info.tools = n?.n ?? 0;
      } catch {}
    }
    db.close();
  } catch (e) {
    info.error = String(e).slice(0, 80);
  }
  results.push(info);
}

results.sort((a, b) => (b.tools || 0) - (a.tools || 0));

console.log(`Found ${results.length} DBs modified today (${today}) in ${SESSIONS_DIR}`);
console.log(`${"file".padEnd(22)} ${"size".padStart(10)} ${"tables".padStart(6)} ${"hasId".padStart(5)} ${"tool_calls_n".padStart(12)} mtime`);
for (const r of results.slice(0, 25)) {
  console.log(
    `${r.file.padEnd(22)} ${String(r.size).padStart(10)} ${String(r.tables).padStart(6)} ` +
    `${String(r.schemaHasId).padStart(5)} ${String(r.tools).padStart(12)} ${r.mtime}${r.error ? ' ERR:' + r.error : ''}`
  );
}
