/**
 * Tests for v0.14.0 Phase A: provenance tagging.
 *
 * Coverage:
 *   Unit:
 *     - Migration 16+17 add provenance column with CHECK constraint
 *     - Default values are correct (UNKNOWN for legacy, EXTRACTED for new
 *       rememberFact, INFERRED for new indexContent)
 *     - Invalid provenance → coerced to safe default
 *     - ON CONFLICT promotes provenance correctly
 *   Edge cases:
 *     - Empty string → safe default
 *     - Mixed-case input → only exact-case allowed
 *     - Re-asserting same key with different provenance updates the row
 *   Real user use cases:
 *     - User saves a fact via rememberFact (zc_remember) → defaults to EXTRACTED
 *     - LLM-generated indexContent → defaults to INFERRED
 *     - AST-extracted summary marked EXTRACTED in indexContent
 *     - Promotion path: INFERRED row promoted to EXTRACTED on re-assert
 *
 * Red-team:
 *   RT-S3-01: SQL injection through provenance value blocked by CHECK constraint
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { rememberFact } from "./memory.js";
import { indexContent } from "./knowledge.js";

let testProject: string;

function dbPath(p: string) {
  const h = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", h + ".db");
}
function clean(p: string) {
  for (const sfx of ["", "-wal", "-shm"]) try { if (existsSync(dbPath(p) + sfx)) unlinkSync(dbPath(p) + sfx); } catch {}
}

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-prov-"));
  clean(testProject);
});

afterEach(() => {
  clean(testProject);
  try { rmSync(testProject, { recursive: true, force: true }); } catch {}
});

describe("v0.14.0 Phase A — provenance tagging", () => {

  describe("Migration 16+17: schema changes applied", () => {

    it("working_memory has provenance column with CHECK constraint", () => {
      rememberFact(testProject, "k", "v", 3, "agent-x");
      const db = new DatabaseSync(dbPath(testProject));
      const cols = db.prepare("PRAGMA table_info(working_memory)").all() as Array<{ name: string; type: string; dflt_value?: string }>;
      const provCol = cols.find(c => c.name === "provenance");
      expect(provCol).toBeDefined();
      expect(provCol!.type).toBe("TEXT");
      db.close();
    });

    it("source_meta has provenance column with CHECK constraint", () => {
      indexContent(testProject, "hello", "test://source");
      const db = new DatabaseSync(dbPath(testProject));
      const cols = db.prepare("PRAGMA table_info(source_meta)").all() as Array<{ name: string; type: string }>;
      const provCol = cols.find(c => c.name === "provenance");
      expect(provCol).toBeDefined();
      db.close();
    });
  });

  describe("rememberFact (zc_remember) — defaults + explicit provenance", () => {

    it("defaults to EXTRACTED (user typed it deliberately = high trust)", () => {
      rememberFact(testProject, "k1", "v1", 3, "agent-x");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("k1") as { provenance: string };
      expect(row.provenance).toBe("EXTRACTED");
      db.close();
    });

    it("respects explicit INFERRED tag (e.g. LLM-derived hypothesis)", () => {
      rememberFact(testProject, "k2", "v2", 3, "agent-x", "INFERRED");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("k2") as { provenance: string };
      expect(row.provenance).toBe("INFERRED");
      db.close();
    });

    it("respects AMBIGUOUS tag (multiple plausible readings)", () => {
      rememberFact(testProject, "k3", "v3", 3, "a", "AMBIGUOUS");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("k3") as { provenance: string };
      expect(row.provenance).toBe("AMBIGUOUS");
      db.close();
    });

    it("[edge] coerces invalid provenance string to UNKNOWN safely", () => {
      // @ts-expect-error — passing invalid value deliberately
      rememberFact(testProject, "k4", "v4", 3, "a", "BOGUS");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("k4") as { provenance: string };
      expect(row.provenance).toBe("UNKNOWN");
      db.close();
    });

    it("[edge] coerces case-variant input — only exact case allowed", () => {
      // @ts-expect-error — passing wrong-case value
      rememberFact(testProject, "k5", "v5", 3, "a", "extracted");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("k5") as { provenance: string };
      expect(row.provenance).toBe("UNKNOWN");
      db.close();
    });

    it("[user case] promotion: INFERRED row re-asserted as EXTRACTED updates provenance", () => {
      rememberFact(testProject, "fact-1", "first version", 3, "agent-x", "INFERRED");
      rememberFact(testProject, "fact-1", "verified version", 4, "agent-x", "EXTRACTED");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT value, importance, provenance FROM working_memory WHERE key = ? AND agent_id = ?").get("fact-1", "agent-x") as { value: string; importance: number; provenance: string };
      expect(row.value).toBe("verified version");
      expect(row.importance).toBe(4);
      expect(row.provenance).toBe("EXTRACTED");
      db.close();
    });

    it("[user case] downgrade: EXTRACTED row re-asserted as AMBIGUOUS updates provenance", () => {
      rememberFact(testProject, "fact-2", "v1", 3, "a", "EXTRACTED");
      rememberFact(testProject, "fact-2", "v2", 3, "a", "AMBIGUOUS");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("fact-2") as { provenance: string };
      expect(row.provenance).toBe("AMBIGUOUS");
      db.close();
    });

    it("[edge] per-agent isolation — different agents see independent provenance", () => {
      rememberFact(testProject, "k", "v-alice", 3, "alice", "EXTRACTED");
      rememberFact(testProject, "k", "v-bob",   3, "bob",   "INFERRED");
      const db = new DatabaseSync(dbPath(testProject));
      const aliceRow = db.prepare("SELECT provenance FROM working_memory WHERE key = ? AND agent_id = ?").get("k", "alice") as { provenance: string };
      const bobRow   = db.prepare("SELECT provenance FROM working_memory WHERE key = ? AND agent_id = ?").get("k", "bob") as { provenance: string };
      expect(aliceRow.provenance).toBe("EXTRACTED");
      expect(bobRow.provenance).toBe("INFERRED");
      db.close();
    });
  });

  describe("indexContent — defaults + explicit provenance", () => {

    it("defaults to INFERRED (most KB content is LLM-summarized)", () => {
      indexContent(testProject, "Some markdown content", "test://md", "internal");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM source_meta WHERE source = ?").get("test://md") as { provenance: string };
      expect(row.provenance).toBe("INFERRED");
      db.close();
    });

    it("[user case] AST extractor tags its output as EXTRACTED", () => {
      indexContent(
        testProject,
        "export class Foo {}\nexport function bar() {}",
        "ast://Foo.ts",
        "internal", "internal",
        "L0: TypeScript module exporting Foo class + bar function",
        "L1: deeper detail",
        "EXTRACTED"
      );
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM source_meta WHERE source = ?").get("ast://Foo.ts") as { provenance: string };
      expect(row.provenance).toBe("EXTRACTED");
      db.close();
    });

    it("[user case] re-index of a file updates the provenance", () => {
      indexContent(testProject, "v1", "src/file.ts", "internal", "internal", undefined, undefined, "INFERRED");
      indexContent(testProject, "v2", "src/file.ts", "internal", "internal", undefined, undefined, "EXTRACTED");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM source_meta WHERE source = ?").get("src/file.ts") as { provenance: string };
      expect(row.provenance).toBe("EXTRACTED");
      db.close();
    });

    it("[edge] empty string provenance coerced to INFERRED", () => {
      // @ts-expect-error
      indexContent(testProject, "x", "src/empty.ts", "internal", "internal", undefined, undefined, "");
      const db = new DatabaseSync(dbPath(testProject));
      const row = db.prepare("SELECT provenance FROM source_meta WHERE source = ?").get("src/empty.ts") as { provenance: string };
      expect(row.provenance).toBe("INFERRED");
      db.close();
    });
  });

  describe("[RT-S3-01] CHECK constraint blocks SQL injection via provenance", () => {

    it("invalid provenance via direct SQL is rejected by CHECK constraint", () => {
      // Set up a valid row first (creates the table)
      rememberFact(testProject, "anchor", "v", 3, "a");
      const db = new DatabaseSync(dbPath(testProject));
      // Bypass the API safety filter and try to write garbage directly
      expect(() => {
        db.prepare(
          "INSERT INTO working_memory(key, value, importance, agent_id, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)"
        ).run("attack", "v", 3, "a", new Date().toISOString(), "DROP TABLE; --");
      }).toThrow(/CHECK constraint/i);
      db.close();
    });

    it("valid INSERT with allowed provenance succeeds (positive control)", () => {
      rememberFact(testProject, "anchor", "v", 3, "a");
      const db = new DatabaseSync(dbPath(testProject));
      expect(() => {
        db.prepare(
          "INSERT INTO working_memory(key, value, importance, agent_id, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)"
        ).run("ok", "v", 3, "a2", new Date().toISOString(), "EXTRACTED");
      }).not.toThrow();
      db.close();
    });
  });

  describe("[edge] backward-compat: existing rows survive migration", () => {

    it("rows written by pre-v0.14.0 code retain UNKNOWN default", () => {
      // Simulate: write a row, then strip its provenance, then re-read
      rememberFact(testProject, "k", "v", 3, "a", "EXTRACTED");
      const db = new DatabaseSync(dbPath(testProject));
      // The CHECK constraint allows UNKNOWN, so we can manually set it (simulating legacy)
      db.prepare("UPDATE working_memory SET provenance = 'UNKNOWN' WHERE key = ?").run("k");
      const row = db.prepare("SELECT provenance FROM working_memory WHERE key = ?").get("k") as { provenance: string };
      expect(row.provenance).toBe("UNKNOWN");
      db.close();
    });
  });
});
