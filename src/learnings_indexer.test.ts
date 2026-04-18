/**
 * Tests for hooks/learnings-indexer.mjs — Sprint 1 Phase D
 *
 * Per §13:
 *   - Unit: correct category inference, path containment, idempotency
 *   - Integration: real JSONL writes get mirrored to learnings table
 *   - Failure-mode: non-learnings paths ignored, missing DB tolerated,
 *                   non-existent file tolerated, crashes never bubble
 *   - Red-team RT-S1-12: symlinks escaping the project dir are rejected
 *                         (security — learnings paths are attacker-controllable
 *                         in the hook payload, so path containment matters)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync, unlinkSync, rmSync, mkdtempSync, mkdirSync, writeFileSync,
  symlinkSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { runMigrations } from "./migrations.js";

const HOOK_PATH = join(process.cwd(), "hooks", "learnings-indexer.mjs");

let testProject: string;
let learningsDir: string;

function projectDbPath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}

function cleanProjectDb(projectPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = projectDbPath(projectPath) + suffix;
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function ensureProjectDb(projectPath: string): void {
  // Precreate DB with current schema so the indexer finds a ready target
  const dbPath = projectDbPath(projectPath);
  mkdirSync(join(homedir(), ".claude", "zc-ctx", "sessions"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  db.close();
}

function runHook(payload: object): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function readLearnings(projectPath: string): Array<{
  category: string;
  payload: string;
  source_path: string;
  source_line: number;
}> {
  const db = new DatabaseSync(projectDbPath(projectPath));
  try {
    return db.prepare(
      `SELECT category, payload, source_path, source_line
       FROM learnings
       ORDER BY source_path ASC, source_line ASC`
    ).all() as Array<{ category: string; payload: string; source_path: string; source_line: number }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-lrn-"));
  learningsDir = join(testProject, "learnings");
  mkdirSync(learningsDir, { recursive: true });
  cleanProjectDb(testProject);
  ensureProjectDb(testProject);
});

afterEach(() => {
  cleanProjectDb(testProject);
  try { rmSync(testProject, { recursive: true, force: true }); } catch {}
});

describe("learnings-indexer hook", () => {

  it("mirrors a metrics.jsonl write into the learnings table", () => {
    const f = join(learningsDir, "metrics.jsonl");
    writeFileSync(f, `{"metric":"pass_rate","value":0.95}\n{"metric":"cycle_time","value":42}\n`);

    const r = runHook({
      tool_name: "Write",
      tool_input: { file_path: f },
      cwd: testProject,
    });
    expect(r.status).toBe(0);

    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(2);
    expect(rows[0].category).toBe("metric");
    expect(rows[0].source_path).toBe("learnings/metrics.jsonl");
    expect(rows[0].source_line).toBe(1);
    expect(rows[1].source_line).toBe(2);
    expect(JSON.parse(rows[0].payload).metric).toBe("pass_rate");
  });

  it("infers category correctly across category stems", () => {
    const cases: Array<[string, string]> = [
      ["metrics.jsonl",           "metric"],
      ["decisions.jsonl",         "decision"],
      ["failures.jsonl",          "failure"],
      ["experiments.jsonl",       "experiment"],
      ["insights.jsonl",          "insight"],
      ["customer-insights.jsonl", "insight"],
      ["cross-project.jsonl",     "insight"],
      ["random-other.jsonl",      "insight"],
    ];
    for (const [name] of cases) {
      const f = join(learningsDir, name);
      writeFileSync(f, `{"k":"${name}"}\n`);
      const r = runHook({ tool_name: "Edit", tool_input: { file_path: f }, cwd: testProject });
      expect(r.status).toBe(0);
    }

    const rows = readLearnings(testProject);
    const byPath = new Map(rows.map(r => [r.source_path, r.category]));
    for (const [name, expected] of cases) {
      expect(byPath.get(`learnings/${name}`)).toBe(expected);
    }
  });

  it("is idempotent — re-firing on same file does not duplicate rows", () => {
    const f = join(learningsDir, "decisions.jsonl");
    writeFileSync(f, `{"decision":"use-sqlite"}\n{"decision":"hmac-chain"}\n`);

    for (let i = 0; i < 5; i++) {
      runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    }
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(2);
  });

  it("indexes newly-appended lines on subsequent writes (idempotent + additive)", () => {
    const f = join(learningsDir, "failures.jsonl");
    writeFileSync(f, `{"failure":"first"}\n`);
    runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    expect(readLearnings(testProject)).toHaveLength(1);

    writeFileSync(f, `{"failure":"first"}\n{"failure":"second"}\n`);
    runHook({ tool_name: "Edit", tool_input: { file_path: f }, cwd: testProject });
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(2);
    expect(rows[1].source_line).toBe(2);
  });

  it("ignores non-learnings Write events", () => {
    const f = join(testProject, "src", "foo.ts");
    mkdirSync(join(testProject, "src"), { recursive: true });
    writeFileSync(f, `console.log("hi");\n`);

    const r = runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    expect(r.status).toBe(0);
    expect(readLearnings(testProject)).toHaveLength(0);
  });

  it("ignores non-.jsonl files inside learnings/", () => {
    const f = join(learningsDir, "README.md");
    writeFileSync(f, `# Learnings\n`);
    const r = runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    expect(r.status).toBe(0);
    expect(readLearnings(testProject)).toHaveLength(0);
  });

  it("ignores non-Write/Edit tool names", () => {
    const f = join(learningsDir, "metrics.jsonl");
    writeFileSync(f, `{"m":1}\n`);
    const r = runHook({ tool_name: "Bash", tool_input: { command: "cat " + f }, cwd: testProject });
    expect(r.status).toBe(0);
    expect(readLearnings(testProject)).toHaveLength(0);
  });

  it("tolerates non-existent file", () => {
    const f = join(learningsDir, "vanished.jsonl");
    const r = runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    expect(r.status).toBe(0);
  });

  it("tolerates malformed hook payload (invalid JSON)", () => {
    const r = spawnSync("node", [HOOK_PATH], {
      input: "{not json",
      encoding: "utf8",
      timeout: 5000,
    });
    expect(r.status ?? -1).toBe(0);
  });

  it("tolerates missing project DB (does not create one)", () => {
    cleanProjectDb(testProject);
    const f = join(learningsDir, "metrics.jsonl");
    writeFileSync(f, `{"m":1}\n`);

    const r = runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    expect(r.status).toBe(0);
    // DB should NOT have been created
    expect(existsSync(projectDbPath(testProject))).toBe(false);
  });

  it("skips empty/whitespace-only lines", () => {
    const f = join(learningsDir, "metrics.jsonl");
    writeFileSync(f, `{"a":1}\n\n   \n{"b":2}\n`);

    runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].payload).a).toBe(1);
    expect(JSON.parse(rows[1].payload).b).toBe(2);
    // Line numbers preserved (1-indexed)
    expect(rows[0].source_line).toBe(1);
    expect(rows[1].source_line).toBe(4);
  });

  it("handles BOM at start of file", () => {
    const f = join(learningsDir, "insights.jsonl");
    writeFileSync(f, "\uFEFF" + `{"i":"with bom"}\n`);

    runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).i).toBe("with bom");
  });

  it("[RT-S1-12] rejects symlinks that escape the project directory", () => {
    // Create a target file OUTSIDE the project that looks like a learning
    const escapeTarget = mkdtempSync(join(tmpdir(), "zc-esc-"));
    const escFile = join(escapeTarget, "metrics.jsonl");
    writeFileSync(escFile, `{"escaped":true,"secret":"leak"}\n`);

    // Create a symlink inside learnings/ that points to the external file
    const linkPath = join(learningsDir, "metrics.jsonl");
    try {
      symlinkSync(escFile, linkPath);
    } catch {
      // Windows may refuse symlink creation without admin — skip gracefully
      try { rmSync(escapeTarget, { recursive: true, force: true }); } catch {}
      return;
    }

    const r = runHook({ tool_name: "Write", tool_input: { file_path: linkPath }, cwd: testProject });
    expect(r.status).toBe(0);

    // Indexer must reject — no rows created
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(0);

    try { rmSync(escapeTarget, { recursive: true, force: true }); } catch {}
  });

  it("caps oversized lines at 64 KB", () => {
    const f = join(learningsDir, "metrics.jsonl");
    const huge = "x".repeat(100_000);
    writeFileSync(f, `{"data":"${huge}"}\n`);

    runHook({ tool_name: "Write", tool_input: { file_path: f }, cwd: testProject });
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("MultiEdit is also recognized", () => {
    const f = join(learningsDir, "experiments.jsonl");
    writeFileSync(f, `{"exp":"A"}\n`);
    const r = runHook({ tool_name: "MultiEdit", tool_input: { file_path: f }, cwd: testProject });
    expect(r.status).toBe(0);
    const rows = readLearnings(testProject);
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("experiment");
  });
});
