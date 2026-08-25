#!/usr/bin/env node
/**
 * SecureContext ONE-COMMAND installer.
 *
 *   node init.mjs               — full install: Docker stack (Postgres + Ollama +
 *                                 API) + build + Claude Code registration + hooks
 *                                 + end-to-end verification
 *   node init.mjs --sqlite      — no Docker: local SQLite mode (BM25-only until
 *                                 an Ollama is reachable; everything else works)
 *   node init.mjs --join <url> <key>
 *                               — TEAMMATE mode: no Docker, no local stack. Point
 *                                 this machine's Claude Code at a team's existing
 *                                 SecureContext API (a host on your LAN) using
 *                                 your personal zck_… key. Registers MCP + hooks
 *                                 and verifies the connection.
 *   node init.mjs --no-hooks    — skip harness-hook installation
 *   node init.mjs --uninstall   — remove SecureContext from Claude configs
 *
 * Also runs via npx once published: `npx securecontext` (bin: zc-ctx).
 *
 * Idempotent: safe to re-run. An existing docker/.env, running stack, prior MCP
 * registration, or already-installed hooks are detected and reused, not clobbered.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname);
const GREEN = "\x1b[32m", CYAN = "\x1b[36m", RED = "\x1b[31m", YELLOW = "\x1b[33m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const ok   = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const step = (m) => console.log(`\n${CYAN}${BOLD}▶ ${m}${RESET}`);
const info = (m) => console.log(`  ${m}`);
const warn = (m) => console.log(`${YELLOW}⚠${RESET} ${m}`);
const fail = (m) => { console.error(`${RED}✗ ${m}${RESET}`); process.exit(1); };

const args = process.argv.slice(2);
const SQLITE_ONLY = args.includes("--sqlite");
const NO_HOOKS    = args.includes("--no-hooks");
const API_PORT    = process.env.SC_API_PORT ?? "3099";

// --join <url> <key> — teammate mode against an existing team stack.
let JOIN_URL = null, JOIN_KEY = null;
const joinIdx = args.indexOf("--join");
if (joinIdx !== -1) {
  JOIN_URL = args[joinIdx + 1] ?? null;
  JOIN_KEY = args[joinIdx + 2] ?? null;
  if (!JOIN_URL || !JOIN_KEY || !JOIN_URL.startsWith("http")) {
    fail("--join requires two arguments: <api-url> <your-key>\n  Example: node init.mjs --join http://192.168.1.20:3099 zck_yourpersonalkey");
  }
}

if (args.includes("--uninstall")) {
  execSync(`node "${join(ROOT, "install.mjs")}" --uninstall`, { stdio: "inherit" });
  process.exit(0);
}

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "pipe", encoding: "utf8", cwd: ROOT, ...opts });
const has = (cmd) => {
  try { sh(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`); return true; }
  catch { return false; }
};

console.log(`${BOLD}SecureContext installer${RESET} — one command, full stack.\n`);

// ─── 1. Preflight ────────────────────────────────────────────────────────────
step("Preflight checks");
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < 20) fail(`Node 20+ required (you have ${process.versions.node}).`);
ok(`Node ${process.versions.node}`);

let dockerMode = !SQLITE_ONLY && !JOIN_URL;
if (dockerMode && !has("docker")) {
  warn("Docker not found — falling back to local SQLite mode.");
  warn("(Install Docker Desktop and re-run for the full Postgres + Ollama stack.)");
  dockerMode = false;
}
if (dockerMode) {
  try { sh("docker info"); ok("Docker is running"); }
  catch { warn("Docker is installed but not running — falling back to SQLite mode. Start Docker Desktop and re-run for the full stack."); dockerMode = false; }
}
if (!has("claude")) warn("`claude` CLI not found on PATH — config will still be written; install Claude Code to use it.");

// ─── 2. Build ────────────────────────────────────────────────────────────────
step("Build");
if (existsSync(join(ROOT, "dist", "server.js"))) {
  // Published npm package (or previously built checkout) — dist ships prebuilt,
  // dependencies were installed by npm/npx. Nothing to do.
  ok("dist/server.js ready (prebuilt)");
} else {
  if (!existsSync(join(ROOT, "node_modules")) && existsSync(join(ROOT, "package-lock.json"))) {
    info("Installing npm dependencies (first run — this takes a minute)…");
    execSync("npm ci --no-audit --no-fund", { stdio: "inherit", cwd: ROOT });
  }
  if (!existsSync(join(ROOT, "src"))) fail("No dist/ and no src/ — corrupted install? Re-clone or reinstall the package.");
  info("Compiling TypeScript…");
  execSync("npm run build", { stdio: "inherit", cwd: ROOT });
  ok("dist/server.js ready");
}

// ─── 3. Docker stack / team join ─────────────────────────────────────────────
let apiKey = null;
if (JOIN_URL) {
  step(`Join team stack at ${JOIN_URL}`);
  try {
    const h = JSON.parse(sh(`curl -s --max-time 8 ${JOIN_URL.replace(/\/$/, "")}/health`));
    if (!h?.version) throw new Error("no version in /health");
    ok(`Reached team SecureContext v${h.version} (store: ${h.store ?? "?"})`);
  } catch (e) {
    fail(`Cannot reach ${JOIN_URL}/health — is the team stack up and this machine on its network? (${e.message})`);
  }
  apiKey = JOIN_KEY;
} else if (dockerMode) {
  step("Docker stack (Postgres + Ollama + API)");
  const envPath = join(ROOT, "docker", ".env");
  if (!existsSync(envPath)) {
    apiKey = randomBytes(32).toString("hex");
    const pgPass = randomBytes(24).toString("hex");
    writeFileSync(envPath, `# Generated by init.mjs — keep this file private.\nPOSTGRES_PASSWORD=${pgPass}\nZC_API_KEY=${apiKey}\n`);
    ok("Generated docker/.env with fresh secrets");
  } else {
    const env = readFileSync(envPath, "utf8");
    apiKey = (env.match(/^ZC_API_KEY=(.+)$/m) ?? [])[1]?.trim() ?? null;
    if (!apiKey) fail("docker/.env exists but has no ZC_API_KEY — add one or delete the file and re-run.");
    ok("Reusing existing docker/.env");
  }

  // GPU detection: NVIDIA override if nvidia-smi answers; CPU base otherwise.
  let composeFiles = `-f "${join(ROOT, "docker", "docker-compose.yml")}"`;
  if (has("nvidia-smi")) {
    try { sh("nvidia-smi -L"); composeFiles += ` -f "${join(ROOT, "docker", "docker-compose.nvidia.yml")}"`; ok("NVIDIA GPU detected — GPU embeddings enabled"); }
    catch { info("No usable NVIDIA GPU — CPU mode."); }
  } else info("No NVIDIA GPU — CPU mode (embeddings still work, just slower).");

  info("Starting containers (first run builds the API image — a few minutes)…");
  execSync(`docker compose ${composeFiles} up -d --build`, { stdio: "inherit", cwd: ROOT });

  info("Waiting for the API to become healthy…");
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = JSON.parse(sh(`curl -s http://localhost:${API_PORT}/health`));
      if (h && h.version) { healthy = true; ok(`API healthy — SecureContext v${h.version}`); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!healthy) fail(`API did not become healthy on :${API_PORT}. Check: docker logs securecontext-api`);

  // Embedding model — pull if missing.
  try {
    const tags = sh(`docker exec securecontext-ollama ollama list`);
    if (!/nomic-embed-text/.test(tags)) {
      info("Pulling the embedding model (nomic-embed-text, ~270 MB)…");
      execSync("docker exec securecontext-ollama ollama pull nomic-embed-text", { stdio: "inherit" });
    }
    ok("Embedding model ready (nomic-embed-text)");
  } catch { warn("Could not verify the embedding model — semantic search will activate when Ollama has nomic-embed-text."); }
} else {
  step("Local SQLite mode");
  info("No Docker stack. Memory, KB, skills, audit chain: fully functional (SQLite).");
  info("Semantic (vector) search activates automatically if an Ollama with nomic-embed-text");
  info("is reachable at localhost:11434 — otherwise search runs BM25-only.");
}

// ─── 4. Register with Claude Code ────────────────────────────────────────────
step("Register the MCP plugin with Claude Code");
const remoteUrl = JOIN_URL ?? (dockerMode ? `http://localhost:${API_PORT}` : null);
const installArgs = remoteUrl ? ` --remote ${remoteUrl} ${apiKey}` : "";
execSync(`node "${join(ROOT, "install.mjs")}" --cli${installArgs}`, { stdio: "inherit", cwd: ROOT });

// ─── 5. Harness hooks ────────────────────────────────────────────────────────
if (!NO_HOOKS) {
  step("Install harness hooks (token-efficiency + auto-reindex + output capture)");
  const hooksSrc = join(ROOT, "hooks");
  const hooksDst = join(homedir(), ".claude", "hooks");
  mkdirSync(hooksDst, { recursive: true });
  for (const f of readdirSync(hooksSrc).filter((f) => f.endsWith(".mjs") || f.endsWith(".ps1"))) {
    copyFileSync(join(hooksSrc, f), join(hooksDst, f));
  }
  ok(`Hook scripts copied to ${hooksDst}`);

  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* fresh */ }
  settings.hooks = settings.hooks ?? {};
  const hookCmd = (w) => w.runner === "powershell"
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(hooksDst, w.script)}"`
    : `node "${join(hooksDst, w.script)}"`;
  // Issue #5 — the hook set is defined ONCE in hooks/manifest.json (cliHooks).
  // The hardcoded list this replaces had drifted to 5 of the 14 battle-tested
  // registrations: fresh installs silently lacked auto-extract, prewrite impact
  // advisories, learnings indexing and outcome capture. A CI test now asserts
  // no hardcoded list ever returns here.
  const manifest = JSON.parse(readFileSync(join(ROOT, "hooks", "manifest.json"), "utf8"));
  const wanted = manifest.cliHooks.filter((w) => !w.platform || w.platform === process.platform);
  for (const w of wanted) {
    settings.hooks[w.event] = settings.hooks[w.event] ?? [];
    // Dedup per (matcher, script) pair — not per script alone, or the same
    // hook could never be registered under a second matcher.
    // Matcher comparison normalizes absent-vs-empty: entries registered by older
    // versions (and by hand) omit the matcher key entirely for match-all hooks,
    // while the manifest writes "". `undefined === ""` is false — the live
    // verification pass caught this creating double registrations (each Stop /
    // UserPromptSubmit hook firing twice) on its very first run.
    const already = settings.hooks[w.event].some(
      (e) => (e?.matcher ?? "") === (w.matcher ?? "") && JSON.stringify(e).includes(w.script));
    if (already) { info(`${w.script} (${w.matcher}) already registered — skipped`); continue; }
    settings.hooks[w.event].push({ matcher: w.matcher, hooks: [{ type: "command", command: hookCmd(w) }] });
    ok(`Registered ${w.script} (${w.event} → ${w.matcher})`);
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
} else {
  info("Skipping hooks (--no-hooks). See hooks/INSTALL.md to add them later.");
}

// ─── 6. Verify ───────────────────────────────────────────────────────────────
step("Verify");
const settingsTxt = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
if (!settingsTxt.includes("zc-ctx")) fail("zc-ctx missing from ~/.claude/settings.json after install — please report this.");
ok("MCP plugin registered in ~/.claude/settings.json");
if (JOIN_URL) {
  try {
    const r = sh(`curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${apiKey}" ${JOIN_URL.replace(/\/$/, "")}/api/v1/team/workspaces`);
    if (r.trim() === "200") ok("Your key authenticates against the team API");
    else warn(`Key check returned HTTP ${r.trim()} — ask your operator to verify the key (dashboard → team keys).`);
  } catch { warn("Could not test the key — non-fatal."); }
} else if (dockerMode) {
  try {
    const chain = JSON.parse(sh(`curl -s -H "Authorization: Bearer ${apiKey}" http://localhost:${API_PORT}/api/v1/chain-verify`));
    if (chain.broken_at === null || chain.broken_at === undefined) ok(`Audit chain verified (${chain.total_rows ?? 0} rows, no breaks)`);
    else warn(`Audit chain reports a break at row ${chain.broken_at} — investigate before trusting history.`);
  } catch { warn("Could not run chain verification (endpoint variant?) — non-fatal."); }
}

// ─── Done ────────────────────────────────────────────────────────────────────
console.log(`\n${GREEN}${BOLD}══════════════════════════════════════════════════${RESET}`);
console.log(`${GREEN}${BOLD}  SecureContext is installed.${RESET}`);
console.log(`${GREEN}${BOLD}══════════════════════════════════════════════════${RESET}\n`);
info(`Mode: ${JOIN_URL ? `team member → ${JOIN_URL}` : dockerMode ? "Docker stack (Postgres + Ollama + API on :" + API_PORT + ")" : "local SQLite"}`);
info("Next steps:");
info("  1. Restart Claude Code (the MCP plugin loads at startup).");
info("  2. In any project, ask Claude to run zc_status — you should see the store, chain, and skill counts.");
info("  3. Start working. Session memory, file summaries, and the audit chain are now automatic.");
if (dockerMode) info(`  Dashboard: http://localhost:${API_PORT}/dashboard`);
