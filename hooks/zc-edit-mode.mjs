#!/usr/bin/env node
/**
 * Edit mode for the summary redirect (v0.55.3)
 * ============================================
 *
 * The operator's scenario: an agent edits a file, the summary regenerates and
 * the block returns — but the edit had a bug, the agent needs the bytes again,
 * and pays another summary round-trip mid-fix. Repeat per iteration. The mtime
 * lifecycle handles "work finished"; this handles "work in progress".
 *
 * The agent engages the mode explicitly:
 *
 *   node ~/.claude/hooks/zc-edit-mode.mjs on [minutes] [file ...]
 *   node ~/.claude/hooks/zc-edit-mode.mjs off
 *   node ~/.claude/hooks/zc-edit-mode.mjs status
 *
 * While active, Reads in this project pass through untouched (scoped to the
 * named files when given, all files otherwise). Blast radius is still enforced:
 * the prewrite-impact hook fires on the first Edit/Write of each file
 * regardless of this mode, so the agent sees the cross-file callers before
 * changing anything.
 *
 * The mode EXPIRES (default 30 minutes) — the blocks come back by themselves,
 * so a forgotten mode cannot quietly disable the redirect forever.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { projectHash as sharedProjectHash } from "./_project-hash.mjs";

function projectRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const p = resolve(dir, "..");
    if (p === dir) break;
    dir = p;
  }
  return resolve(start);
}

const root = projectRoot(process.cwd());
const ph = sharedProjectHash(root);
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
// v0.55.4 — PER-AGENT scope. Keyed by project hash alone, one agent engaging
// edit mode suspended summaries for EVERY agent on the project. A2A agents
// carry ZC_AGENT_ID; solo/desktop sessions fall back to "default", which keeps
// single-agent behaviour unchanged.
const agent = (process.env.ZC_AGENT_ID ?? "default").replace(/[^A-Za-z0-9_-]/g, "_");
const modePath = join(home, ".claude", "zc-ctx", "edit-mode", `${ph}-${agent}.json`);

const [cmd = "status", ...rest] = process.argv.slice(2);

if (cmd === "on") {
  const minutes = /^\d+$/.test(rest[0] ?? "") ? Number(rest.shift()) : 30;
  const files = rest.map((f) => f.replace(/\\/g, "/"));
  mkdirSync(dirname(modePath), { recursive: true });
  writeFileSync(modePath, JSON.stringify({
    root, files, expires: new Date(Date.now() + minutes * 60_000).toISOString(),
  }), "utf8");
  console.log(`edit mode ON for ${root} [agent: ${agent}]` +
    (files.length ? ` (files: ${files.join(", ")})` : " (all files)") +
    `, expires in ${minutes} min. Summaries suspended; the write-hook blast radius still applies.`);
} else if (cmd === "off") {
  try { writeFileSync(modePath, JSON.stringify({ root, files: [], expires: new Date(0).toISOString() }), "utf8"); } catch { /* absent is off */ }
  console.log(`edit mode OFF for ${root}. Summary blocks restored.`);
} else {
  try {
    const m = JSON.parse(readFileSync(modePath, "utf8"));
    const live = new Date(m.expires) > new Date();
    console.log(live
      ? `edit mode ACTIVE until ${m.expires}` + (m.files?.length ? ` for: ${m.files.join(", ")}` : " (all files)")
      : "edit mode off (expired)");
  } catch { console.log("edit mode off"); }
}
