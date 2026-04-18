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
const status = getIndexingStatus(projectPath);
process.stdout.write(JSON.stringify(status));
