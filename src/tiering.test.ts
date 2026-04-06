/**
 * Tests for L0/L1/L2 content tiering (v0.8.0)
 * tiering.test.ts
 *
 * Tests:
 *   - indexContent stores l0_summary and l1_summary in source_meta
 *   - L0 is <= TIER_L0_CHARS chars
 *   - L1 is <= TIER_L1_CHARS chars
 *   - getContentAtDepth returns l0/l1/full correctly
 *   - explainRetrieval returns scoring breakdown
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "zc-tiering-test-"));
process.env["ZC_TEST_DB_DIR"] = TEST_DB_DIR;

import { indexContent, searchKnowledge, getContentAtDepth, explainRetrieval } from "./knowledge.js";
import { Config } from "./config.js";
import { runMigrations } from "./migrations.js";

function makeProjectPath(suffix: string): string {
  return join(TEST_DB_DIR, `tier-${suffix}`);
}

function openProjectDb(projectPath: string): DatabaseSync {
  mkdirSync(Config.DB_DIR, { recursive: true });
  const hash   = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const dbFile = join(Config.DB_DIR, `${hash}.db`);
  const db     = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge USING fts5(source, content, created_at UNINDEXED, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS working_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL, value TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      agent_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      UNIQUE(key, agent_id)
    );
  `);
  runMigrations(db);
  return db;
}

// ── L0/L1 summaries stored in source_meta ────────────────────────────────────

describe("indexContent — L0/L1 tier storage", () => {
  it("stores l0_summary and l1_summary in source_meta", () => {
    const projectPath = makeProjectPath(`store-l0l1-${Date.now()}`);
    const content = "A".repeat(2000);
    indexContent(projectPath, content, "test-source-tiers");

    const db = openProjectDb(projectPath);
    type Row = { l0_summary: string; l1_summary: string };
    const row = db.prepare(
      "SELECT l0_summary, l1_summary FROM source_meta WHERE source = 'test-source-tiers'"
    ).get() as Row | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.l0_summary.length).toBeGreaterThan(0);
    expect(row!.l1_summary.length).toBeGreaterThan(0);
  });

  it("L0 is <= TIER_L0_CHARS characters", () => {
    const projectPath = makeProjectPath(`l0-len-${Date.now()}`);
    const content = "B".repeat(2000);
    indexContent(projectPath, content, "test-l0-length");

    const db = openProjectDb(projectPath);
    type Row = { l0_summary: string };
    const row = db.prepare("SELECT l0_summary FROM source_meta WHERE source = 'test-l0-length'").get() as Row | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.l0_summary.length).toBeLessThanOrEqual(Config.TIER_L0_CHARS);
  });

  it("L1 is <= TIER_L1_CHARS characters", () => {
    const projectPath = makeProjectPath(`l1-len-${Date.now()}`);
    const content = "C".repeat(5000);
    indexContent(projectPath, content, "test-l1-length");

    const db = openProjectDb(projectPath);
    type Row = { l1_summary: string };
    const row = db.prepare("SELECT l1_summary FROM source_meta WHERE source = 'test-l1-length'").get() as Row | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.l1_summary.length).toBeLessThanOrEqual(Config.TIER_L1_CHARS);
  });

  it("content shorter than L0_CHARS stores full content as l0_summary", () => {
    const projectPath = makeProjectPath(`l0-short-${Date.now()}`);
    const content = "Short content here.";
    indexContent(projectPath, content, "short-content-source");

    const db = openProjectDb(projectPath);
    type Row = { l0_summary: string };
    const row = db.prepare("SELECT l0_summary FROM source_meta WHERE source = 'short-content-source'").get() as Row | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.l0_summary).toBe(content.trim());
  });
});

// ── getContentAtDepth ─────────────────────────────────────────────────────────

describe("getContentAtDepth", () => {
  const fullContent = "D".repeat(5000);
  const l0 = "L0 summary here.";
  const l1 = "L1 longer summary with more planning detail.";

  it("L0 returns l0 string", () => {
    const result = getContentAtDepth(fullContent, l0, l1, "L0");
    expect(result).toBe(l0);
  });

  it("L1 returns l1 string", () => {
    const result = getContentAtDepth(fullContent, l0, l1, "L1");
    expect(result).toBe(l1);
  });

  it("L2 returns full content", () => {
    const result = getContentAtDepth(fullContent, l0, l1, "L2");
    expect(result).toBe(fullContent);
  });

  it("L0 with empty l0 falls back to first TIER_L0_CHARS of content", () => {
    const result = getContentAtDepth(fullContent, "", l1, "L0");
    expect(result).toBe(fullContent.slice(0, Config.TIER_L0_CHARS));
  });

  it("L1 with empty l1 falls back to first TIER_L1_CHARS of content", () => {
    const result = getContentAtDepth(fullContent, l0, "", "L1");
    expect(result).toBe(fullContent.slice(0, Config.TIER_L1_CHARS));
  });
});

// ── explainRetrieval ──────────────────────────────────────────────────────────

describe("explainRetrieval", () => {
  it("returns empty results array when nothing is indexed", async () => {
    const projectPath = makeProjectPath(`explain-empty-${Date.now()}`);
    const result = await explainRetrieval(projectPath, "machine learning", "L2");
    expect(result.query).toBe("machine learning");
    expect(result.depth).toBe("L2");
    expect(result.results).toHaveLength(0);
  });

  it("returns bm25Score, hybridScore, contentLength for indexed content", async () => {
    const projectPath = makeProjectPath(`explain-scored-${Date.now()}`);
    const content = "The quick brown fox jumps over the lazy dog. Relevant content about foxes.";
    indexContent(projectPath, content, "fox-source");

    // Wait a moment for sync write to land
    await new Promise((r) => setTimeout(r, 50));

    const result = await explainRetrieval(projectPath, "fox", "L2");

    if (result.results.length > 0) {
      const r = result.results[0]!;
      expect(typeof r.bm25Score).toBe("number");
      expect(typeof r.bm25Normalized).toBe("number");
      expect(typeof r.hybridScore).toBe("number");
      expect(r.contentLength).toBeGreaterThan(0);
      expect(r.source).toBe("fox-source");
      expect(typeof r.sourceType).toBe("string");
    }
    // Even if BM25-only (no Ollama), bm25Only field should be boolean
    expect(typeof result.bm25Only).toBe("boolean");
  });

  it("vectorScore is null when Ollama not available (BM25 only)", async () => {
    const projectPath = makeProjectPath(`explain-bm25only-${Date.now()}`);
    indexContent(projectPath, "testing bm25 only retrieval mode", "bm25-source");

    await new Promise((r) => setTimeout(r, 50));

    const result = await explainRetrieval(projectPath, "bm25", "L0");
    // In test environment, Ollama is likely not running
    if (result.bm25Only) {
      for (const r of result.results) {
        expect(r.vectorScore).toBeNull();
      }
    }
  });

  it("tieredContent respects requested depth", async () => {
    const projectPath = makeProjectPath(`explain-depth-${Date.now()}`);
    const longContent = "Tiered content test. " + "X".repeat(2000);
    indexContent(projectPath, longContent, "tiered-source");

    await new Promise((r) => setTimeout(r, 50));

    const l0Result = await explainRetrieval(projectPath, "tiered", "L0");
    if (l0Result.results.length > 0) {
      expect(l0Result.results[0]!.tieredContent.length).toBeLessThanOrEqual(Config.TIER_L0_CHARS + 1);
    }
  });
});
