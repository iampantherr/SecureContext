#!/usr/bin/env node
/**
 * scripts/check-env-pinning.mjs — L1 architectural lint (v0.17.1+)
 * =================================================================
 *
 * PURPOSE:
 *   Prevent the class of bugs where an env-inherited config point in
 *   src/ has a "sensible default" (`process.env.X || 'default'`) that
 *   silently inherits from the parent shell when an agent is spawned.
 *   Seen in v0.17.0: ZC_AGENT_ID was left as 'developer' (from the
 *   registration foreach loop) and inherited by EVERY spawned Claude
 *   CLI — all tool_calls tagged with the wrong agent_id, breaking
 *   per-agent HKDF subkey isolation, RLS, and telemetry attribution.
 *
 * WHAT IT CHECKS:
 *   1. Every `process.env.ZC_*` reference in src/**.ts is classified:
 *        CRITICAL          — must be pinned per-agent (ZC_AGENT_ID, ...)
 *        SHARED_PROPAGATED — must appear in both launchers (PG creds, ...)
 *        OPERATIONAL       — operator knobs, inheritance OK
 *   2. For CRITICAL vars: each agent's launch script template (orch +
 *      worker heredocs in A2A_dispatcher/start-agents.ps1) must SET
 *      the var explicitly. Inheritance is not enough — a sibling agent's
 *      env could have poisoned the value.
 *   3. For SHARED_PROPAGATED vars: both the orchestrator heredoc AND
 *      the worker heredoc must propagate the value conditionally
 *      (e.g. if-block based on whether the operator provided it).
 *   4. NEW env vars in src/ not in any whitelist → fail with "please
 *      classify". Forces every new ZC_* var to be reviewed.
 *
 * EXIT CODES:
 *   0 — all checks pass
 *   1 — at least one CRITICAL var missing from a launcher, or new var unclassified
 *   2 — dispatcher repo path not found (can't run the check)
 *
 * USAGE:
 *   npm run check:env
 *   node scripts/check-env-pinning.mjs [--dispatcher-path C:\path\to\A2A_dispatcher]
 *
 * Run as a pre-commit hook, in CI, and before every release.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Classification — UPDATE THIS when adding new ZC_* env vars ──────────────

/** CRITICAL: must be pinned per-agent. Inheritance → silent correctness bug. */
const CRITICAL_PER_AGENT = new Set([
  "ZC_AGENT_ID",
  "ZC_AGENT_ROLE",
  "ZC_AGENT_MODEL",
]);

/** SHARED_PROPAGATED: must appear in both orchestrator + worker launchers. */
const SHARED_PROPAGATED = new Set([
  "ZC_API_URL",
  "ZC_API_KEY",
  "ZC_POSTGRES_HOST",
  "ZC_POSTGRES_PORT",
  "ZC_POSTGRES_USER",
  "ZC_POSTGRES_PASSWORD",
  "ZC_POSTGRES_DB",
  "ZC_TELEMETRY_BACKEND",
]);

/** OPERATIONAL: operator knobs / infra config. Inheritance is fine. */
const OPERATIONAL = new Set([
  "ZC_LOG_LEVEL", "ZC_LOG_DIR", "ZC_LOG_CONSOLE", "ZC_LOG_RAW",
  "ZC_MACHINE_SECRET",
  "ZC_MODEL_TIER_HAIKU", "ZC_MODEL_TIER_SONNET", "ZC_MODEL_TIER_OPUS",
  "ZC_PYTHON_CMD",
  "ZC_POSTGRES_POOL_MAX", "ZC_POSTGRES_SSL",
  "ZC_POSTGRES_SSL_REJECT_UNAUTHORIZED", "ZC_POSTGRES_URL",
  "ZC_TELEMETRY_MODE",
  "ZC_DISABLE_INFRA_ZERO_COST",
  // Ollama / indexing
  "ZC_OLLAMA_URL", "ZC_OLLAMA_ENDPOINT", "ZC_OLLAMA_TIMEOUT",
  "ZC_SUMMARY_MODEL", "ZC_SUMMARY_KEEP_ALIVE", "ZC_SUMMARY_CONCURRENCY",
  "ZC_INDEX_MAX_FILES", "ZC_INDEX_MAX_FILE_BYTES",
  "ZC_READ_DEDUP_ENABLED", "ZC_BASH_CAPTURE_LINES",
  "ZC_AUTOFLIP_BUDGET_TOKENS", "ZC_AUTOFLIP_BUDGET_DOLLARS",
  "ZC_ALLOW_LOCAL_FALLBACK", "ZC_CHANNEL_KEY_REQUIRED",
  "ZC_RBAC_ENFORCE",
  "ZC_PROJECT_PATH",
  // Integrity / testing
  "ZC_STRICT_INTEGRITY",
  "ZC_HOOK_DEBUG",
  "ZC_TEST_DB_DIR",
  "ZC_CTX_DIST", "ZC_REPO_DIR",
  "ZC_API_LOG_LEVEL",
  "ZC_ALLOWED_ORIGINS",
  "ZC_FETCH_BUDGET_PER_SESSION", "ZC_FETCH_TIMEOUT_MS",
  "ZC_MAX_FETCH_RESPONSE_BYTES",
  "ZC_GRAPHIFY_CMD", "ZC_GRAPHIFY_TIMEOUT_MS",
  "ZC_STRICT_PRICING",
  // API-server config (inherited by sc-api Docker container; not by agents)
  "ZC_API_PORT", "ZC_API_HOST", "ZC_API_CORS_ORIGINS",
  // Store selection (operator deployment choice)
  "ZC_STORE", "ZC_PG_POOL_SIZE", "ZC_PG_URL",
]);

// ─── Implementation ───────────────────────────────────────────────────────────

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(name)) continue;
      walk(full, files);
    } else if (s.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      if (full.endsWith(".test.ts") || full.endsWith(".d.ts")) continue;
      files.push(full);
    }
  }
  return files;
}

function findEnvRefs(srcRoot) {
  const refs = new Map();  // var → [{file, line}, ...]
  const files = walk(srcRoot);
  // match process.env.ZC_XXX AND process.env["ZC_XXX"]
  const rxDot    = /process\.env\.(ZC_[A-Z0-9_]+)/g;
  const rxBracket= /process\.env\[\s*["'](ZC_[A-Z0-9_]+)["']\s*\]/g;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines   = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      for (const rx of [rxDot, rxBracket]) {
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(ln)) !== null) {
          const name = m[1];
          if (!refs.has(name)) refs.set(name, []);
          refs.get(name).push({ file: file.replace(srcRoot + "\\", "").replace(srcRoot + "/", ""), line: i + 1 });
        }
      }
    }
  }
  return refs;
}

function extractHeredoc(content, anchor) {
  // Find `$XLauncher = @"` ... `"@` block. anchor is e.g. "orchLauncher" / "workerLauncher"
  const startRx = new RegExp(`\\$${anchor}\\s*=\\s*@"`);
  const startMatch = content.match(startRx);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  // Find the closing `"@` on its own line (typically)
  const endMatch = content.slice(startIdx).match(/"@/);
  if (!endMatch) return null;
  return content.slice(startIdx, startIdx + endMatch.index);
}

function checkLauncher(heredoc, requiredVars, launcherName) {
  const missing = [];
  for (const v of requiredVars) {
    // Accept either always-set (`$env:X = 'val'`) or conditionally-set inside an if block
    // Pattern: `$env:V = 'something'`  or  `$env:V =`  anywhere in the heredoc
    // Note the heredoc's $env needs backtick escape in PS syntax → `$env: will appear literally
    const rx = new RegExp(`\`?\\$env:${v}\\s*=`);
    if (!rx.test(heredoc)) missing.push(v);
  }
  return missing;
}

function checkLauncherConditional(bodyAroundHeredoc, vars) {
  // Some SHARED_PROPAGATED vars are set via a conditional pattern outside the heredoc
  // (e.g. `if ($zcApiUrl) { $orchEnvBlock += "..." }`). Return vars present in the outer
  // launcher-building code.
  const present = new Set();
  for (const v of vars) {
    // Look for `$env:V` either in the heredoc OR in the env-block builder
    const rx = new RegExp(`\\$env:${v}\\s*=`);
    if (rx.test(bodyAroundHeredoc)) present.add(v);
  }
  return present;
}

function classify(varName) {
  if (CRITICAL_PER_AGENT.has(varName)) return "CRITICAL";
  if (SHARED_PROPAGATED.has(varName))  return "SHARED";
  if (OPERATIONAL.has(varName))        return "OPERATIONAL";
  return "UNCLASSIFIED";
}

function resolveDispatcherPath(argv) {
  const i = argv.indexOf("--dispatcher-path");
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  // Try common sibling locations
  const here = fileURLToPath(import.meta.url);
  const scRoot = resolve(here, "..", "..");
  const candidates = [
    resolve(scRoot, "..", "A2A_dispatcher"),
    "C:/Users/Amit/AI_projects/A2A_dispatcher",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function main() {
  const here = fileURLToPath(import.meta.url);
  const scRoot = resolve(here, "..", "..");
  const srcRoot = join(scRoot, "src");
  if (!existsSync(srcRoot)) {
    console.error(`src/ not found at ${srcRoot}`);
    process.exit(1);
  }
  const dispatcherPath = resolveDispatcherPath(process.argv.slice(2));
  if (!dispatcherPath) {
    console.error("A2A_dispatcher repo not found. Pass --dispatcher-path or place at ../A2A_dispatcher.");
    process.exit(2);
  }
  const startAgentsPath = join(dispatcherPath, "start-agents.ps1");
  if (!existsSync(startAgentsPath)) {
    console.error(`start-agents.ps1 not found at ${startAgentsPath}`);
    process.exit(2);
  }

  const refs = findEnvRefs(srcRoot);
  const startAgents = readFileSync(startAgentsPath, "utf8");
  const orchHeredoc   = extractHeredoc(startAgents, "orchLauncher");
  const workerHeredoc = extractHeredoc(startAgents, "workerLauncher");

  if (!orchHeredoc || !workerHeredoc) {
    console.error("Could not extract orchLauncher / workerLauncher heredocs from start-agents.ps1");
    process.exit(1);
  }

  // Combine heredoc + surrounding env-block builder (e.g. `$orchEnvBlock += ...`)
  // to catch conditional env injection.
  const orchScope   = orchHeredoc + "\n" + startAgents;
  const workerScope = workerHeredoc + "\n" + startAgents;

  const problems = [];
  const warnings = [];
  const unclassified = [];

  for (const [name, locs] of refs) {
    const cat = classify(name);
    if (cat === "UNCLASSIFIED") {
      unclassified.push({ name, locs });
      continue;
    }
    if (cat === "CRITICAL") {
      // Both launchers MUST pin this explicitly
      const orchPresent   = new RegExp(`\\$env:${name}\\s*=`).test(orchHeredoc);
      const workerPresent = new RegExp(`\\$env:${name}\\s*=`).test(workerHeredoc);
      if (!orchPresent)   problems.push(`CRITICAL ${name} NOT pinned in orchLauncher heredoc`);
      if (!workerPresent) problems.push(`CRITICAL ${name} NOT pinned in workerLauncher heredoc`);
    }
    if (cat === "SHARED") {
      // Must be present in orch + worker SCOPE (heredoc + surrounding builder)
      const orchPresent   = new RegExp(`\\$env:${name}\\s*=`).test(orchScope);
      const workerPresent = new RegExp(`\\$env:${name}\\s*=`).test(workerScope);
      if (!orchPresent)   warnings.push(`SHARED ${name} missing from orchestrator-side propagation`);
      if (!workerPresent) warnings.push(`SHARED ${name} missing from worker-side propagation`);
    }
  }

  // Report
  const header = `\n=== check-env-pinning.mjs ===\n` +
                 `src files scanned: ${walk(srcRoot).length}\n` +
                 `ZC_* vars found:   ${refs.size}\n` +
                 `  critical (must be pinned per-agent): ${[...refs.keys()].filter(v => classify(v) === "CRITICAL").length}\n` +
                 `  shared (must be propagated):         ${[...refs.keys()].filter(v => classify(v) === "SHARED").length}\n` +
                 `  operational (inheritance OK):        ${[...refs.keys()].filter(v => classify(v) === "OPERATIONAL").length}\n` +
                 `  unclassified (NEED REVIEW):          ${unclassified.length}\n`;
  console.log(header);

  if (unclassified.length > 0) {
    console.log("\n⚠️  UNCLASSIFIED vars — please classify in scripts/check-env-pinning.mjs:");
    for (const { name, locs } of unclassified) {
      const preview = locs.slice(0, 3).map(l => `${l.file}:${l.line}`).join(", ");
      console.log(`  ${name}  (referenced at ${preview}${locs.length > 3 ? ", ..." : ""})`);
    }
  }

  if (warnings.length > 0) {
    console.log("\n⚠️  SHARED-propagation warnings (review):");
    for (const w of warnings) console.log(`  ${w}`);
  }

  if (problems.length > 0) {
    console.log("\n❌ CRITICAL-pin violations:");
    for (const p of problems) console.log(`  ${p}`);
    console.log("\nFix: add explicit `$env:VAR = '...'` line to the affected launcher heredoc in");
    console.log(`     ${startAgentsPath}`);
    console.log("     (inheritance from parent shell is NOT safe — sibling agents can poison the value).");
  }

  const fail = problems.length > 0 || unclassified.length > 0;
  if (!fail) {
    console.log("\n✓ All CRITICAL env vars are pinned; all referenced vars are classified.");
  }
  process.exit(fail ? 1 : 0);
}

main();
