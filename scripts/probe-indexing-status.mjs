#!/usr/bin/env node
/**
 * Probe the indexing status of a project. Output is a single JSON line on
 * stdout, suitable for parsing by the SessionStart hook or other wrappers.
 *
 * Usage:
 *   node scripts/probe-indexing-status.mjs <projectPath>
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distUrl   = "file://" + resolve(__dirname, "..", "dist").replace(/\\/g, "/");

const { getIndexingStatus } = await import(`${distUrl}/harness.js`);

const projectPath = process.argv[2] ?? process.cwd();

try {
  const status = getIndexingStatus(projectPath);
  process.stdout.write(JSON.stringify(status));
  process.exit(0);
} catch (err) {
  // Migration failure / corrupt DB / etc. — emit a sentinel so the hook can
  // log it (stderr) while still returning a valid JSON on stdout.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[probe] getIndexingStatus failed: ${msg}\n`);
  process.stdout.write(JSON.stringify({ state: "error", error: msg }));
  process.exit(0);  // don't crash — hook decides what to do
}
