/**
 * Plugin Integrity Verification — detects post-install tampering.
 *
 * SECURITY MODEL:
 * On first run, compute SHA256 of all dist/ files and store a baseline in
 * ~/.claude/zc-ctx/integrity.json. On every subsequent startup, recompute
 * and compare. Any mismatch means a file was modified after installation —
 * either by an attacker or by an unexpected auto-update.
 *
 * This does NOT prevent a sophisticated attacker who also updates the baseline,
 * but it defends against the most common tampering scenario: a supply chain
 * attack that modifies plugin files on disk without triggering reinstall.
 *
 * The check is advisory (logs warning, does not refuse to start) to avoid
 * breaking legitimate development workflows where dist/ is rebuilt often.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = __dirname; // integrity.ts compiles to dist/integrity.js → __dirname = dist/
const INTEGRITY_DIR = join(homedir(), ".claude", "zc-ctx");
const INTEGRITY_FILE = join(INTEGRITY_DIR, "integrity.json");

interface IntegrityBaseline {
  version: string;
  computed_at: string;
  files: Record<string, string>; // filename → sha256
}

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function getDistFiles(): string[] {
  if (!existsSync(DIST_DIR)) return [];
  return readdirSync(DIST_DIR)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .sort();
}

function computeHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of getDistFiles()) {
    const fp = join(DIST_DIR, file);
    if (statSync(fp).isFile()) {
      hashes[file] = sha256File(fp);
    }
  }
  return hashes;
}

export interface IntegrityResult {
  ok: boolean;
  firstRun: boolean;
  warnings: string[];
}

/**
 * Run integrity check on startup.
 * First run: establish baseline. Subsequent runs: compare against baseline.
 */
export function checkIntegrity(version: string): IntegrityResult {
  const warnings: string[] = [];

  try {
    const current = computeHashes();

    if (!existsSync(INTEGRITY_FILE)) {
      // First run — establish baseline
      mkdirSync(INTEGRITY_DIR, { recursive: true });
      const baseline: IntegrityBaseline = {
        version,
        computed_at: new Date().toISOString(),
        files: current,
      };
      writeFileSync(INTEGRITY_FILE, JSON.stringify(baseline, null, 2), "utf8");
      return { ok: true, firstRun: true, warnings: [] };
    }

    // Subsequent runs — compare
    const stored: IntegrityBaseline = JSON.parse(readFileSync(INTEGRITY_FILE, "utf8"));

    if (stored.version !== version) {
      // Version changed → re-baseline (legitimate update)
      const baseline: IntegrityBaseline = {
        version,
        computed_at: new Date().toISOString(),
        files: current,
      };
      writeFileSync(INTEGRITY_FILE, JSON.stringify(baseline, null, 2), "utf8");
      return { ok: true, firstRun: false, warnings: [] };
    }

    // Same version — check for file modifications
    const storedFiles = stored.files;
    for (const [file, hash] of Object.entries(current)) {
      if (!(file in storedFiles)) {
        warnings.push(`New file added to dist/: ${file}`);
      } else if (storedFiles[file] !== hash) {
        warnings.push(`TAMPERED: dist/${file} hash mismatch (stored: ${storedFiles[file]!.slice(0, 8)}…, current: ${hash.slice(0, 8)}…)`);
      }
    }
    for (const file of Object.keys(storedFiles)) {
      if (!(file in current)) {
        warnings.push(`File removed from dist/: ${file}`);
      }
    }

    return { ok: warnings.length === 0, firstRun: false, warnings };
  } catch {
    // Never crash the plugin due to an integrity check failure
    return { ok: true, firstRun: false, warnings: ["Integrity check could not run — skipping"] };
  }
}
