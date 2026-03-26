/**
 * Plugin Integrity Verification — detects post-install tampering.
 *
 * SECURITY MODEL:
 * On first run, compute SHA256 of all dist/ files and store a baseline in
 * ~/.claude/zc-ctx/integrity.json. On every subsequent startup, recompute
 * and compare. Any mismatch means a file was modified after installation.
 *
 * STRICT MODE (ZC_STRICT_INTEGRITY=1):
 * By default, integrity failures are logged as warnings and the server continues.
 * In strict mode, a tampered file causes the server to refuse to start.
 * Enable for production / shared machine deployments:
 *   ZC_STRICT_INTEGRITY=1 node dist/server.js
 *
 * This does NOT prevent a sophisticated attacker who also updates the baseline,
 * but it defends against the most common tampering: supply chain attacks that
 * modify plugin files on disk without triggering reinstall.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "./config.js";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DIST_DIR     = __dirname;
const INTEGRITY_FILE = join(Config.GLOBAL_DIR, "integrity.json");

interface IntegrityBaseline {
  version:     string;
  computed_at: string;
  strict_mode: boolean;
  files:       Record<string, string>; // filename → sha256
}

export interface IntegrityResult {
  ok:        boolean;
  firstRun:  boolean;
  warnings:  string[];
  strictMode: boolean;
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

/**
 * Run integrity check on startup.
 * First run: establish baseline.
 * Subsequent runs: compare against baseline.
 *
 * In STRICT MODE (ZC_STRICT_INTEGRITY=1):
 * - Returns ok:false with warnings for any mismatch
 * - Caller (server.ts) should exit(1) when ok is false in strict mode
 */
export function checkIntegrity(version: string): IntegrityResult {
  const warnings:   string[] = [];
  const strictMode: boolean  = Config.STRICT_INTEGRITY;

  try {
    const current = computeHashes();

    if (!existsSync(INTEGRITY_FILE)) {
      // First run — establish baseline
      mkdirSync(Config.GLOBAL_DIR, { recursive: true });
      const baseline: IntegrityBaseline = {
        version,
        computed_at: new Date().toISOString(),
        strict_mode: strictMode,
        files:       current,
      };
      writeFileSync(INTEGRITY_FILE, JSON.stringify(baseline, null, 2), "utf8");
      return { ok: true, firstRun: true, warnings: [], strictMode };
    }

    const stored: IntegrityBaseline = JSON.parse(readFileSync(INTEGRITY_FILE, "utf8"));

    if (stored.version !== version) {
      // Version changed → re-baseline (legitimate update or upgrade)
      const baseline: IntegrityBaseline = {
        version,
        computed_at: new Date().toISOString(),
        strict_mode: strictMode,
        files:       current,
      };
      writeFileSync(INTEGRITY_FILE, JSON.stringify(baseline, null, 2), "utf8");
      return { ok: true, firstRun: false, warnings: [], strictMode };
    }

    // Same version — check for file modifications
    for (const [file, hash] of Object.entries(current)) {
      if (!(file in stored.files)) {
        warnings.push(`New file added to dist/: ${file}`);
      } else if (stored.files[file] !== hash) {
        warnings.push(
          `TAMPERED: dist/${file} hash mismatch ` +
          `(stored: ${stored.files[file]!.slice(0, 8)}…, current: ${hash.slice(0, 8)}…)`
        );
      }
    }
    for (const file of Object.keys(stored.files)) {
      if (!(file in current)) {
        warnings.push(`File removed from dist/: ${file}`);
      }
    }

    return { ok: warnings.length === 0, firstRun: false, warnings, strictMode };
  } catch {
    // Never crash the plugin due to an integrity check failure (unless strict)
    return {
      ok:         !strictMode, // in strict mode, a broken check is itself a failure
      firstRun:   false,
      warnings:   ["Integrity check could not run — skipping"],
      strictMode,
    };
  }
}
