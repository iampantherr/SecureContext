#!/usr/bin/env node
/**
 * SecureContext Installer
 *
 * Usage:
 *   node install.mjs                              — install, local SQLite mode (default)
 *   node install.mjs --cli                        — Claude Code CLI only
 *   node install.mjs --desktop                    — Desktop App only
 *   node install.mjs --remote <url> <key>         — install + configure remote API mode
 *                                                    (use when Docker stack is running)
 *   node install.mjs --uninstall                  — remove SecureContext from all configs
 *
 * What it does:
 *   1. Runs `npm ci && npm run build` to ensure dist/ is up to date
 *   2. Adds zc-ctx to ~/.claude/settings.json (Claude Code CLI)
 *   3. Adds zc-ctx to the Claude Desktop App config (Windows/macOS/Linux)
 *   4. If --remote: injects ZC_API_URL + ZC_API_KEY into the MCP server env block
 *      so the plugin proxies all storage through the Docker API server instead of
 *      reading local SQLite files directly.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname);
const SERVER_JS  = join(PLUGIN_DIR, "dist", "server.js");

// Single source of truth for the installer's version banner — read from package.json
// so installer + banner + curl-expected output never drift from the real version.
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// ─── Parse arguments ──────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const UNINSTALL    = args.includes("--uninstall");
const MODE_CLI     = args.includes("--cli")     || (!args.includes("--desktop") && !UNINSTALL);
const MODE_DESKTOP = args.includes("--desktop") || (!args.includes("--cli")     && !UNINSTALL);

// --remote <url> <key>
let REMOTE_URL = null;
let REMOTE_KEY = null;
const remoteIdx = args.indexOf("--remote");
if (remoteIdx !== -1) {
  REMOTE_URL = args[remoteIdx + 1] ?? null;
  REMOTE_KEY = args[remoteIdx + 2] ?? null;
  if (!REMOTE_URL || !REMOTE_KEY) {
    console.error("\x1b[31m✗\x1b[0m --remote requires two arguments: <api-url> <api-key>");
    console.error("  Example: node install.mjs --remote http://localhost:3099 your-api-key-here");
    process.exit(1);
  }
  if (!REMOTE_URL.startsWith("http")) {
    console.error("\x1b[31m✗\x1b[0m API URL must start with http:// or https://");
    process.exit(1);
  }
}

const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

function log(msg)  { console.log(`${GREEN}✓${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}→${RESET} ${msg}`); }
function warn(msg) { console.log(`${RED}⚠${RESET} ${msg}`); }

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    warn(`Could not parse ${filePath} — backing up and starting fresh`);
    writeFileSync(filePath + ".bak", readFileSync(filePath));
    return {};
  }
}

function writeJson(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Build the MCP server entry (local or remote mode)
function buildMcpEntry() {
  const entry = {
    command: "node",
    args:    [SERVER_JS],
  };
  if (REMOTE_URL && REMOTE_KEY) {
    entry.env = {
      ZC_API_URL: REMOTE_URL,
      ZC_API_KEY: REMOTE_KEY,
    };
  }
  return entry;
}

// ─── Step 1: Build ────────────────────────────────────────────────────────────
if (!UNINSTALL) {
  // v0.46.2 — published npm packages ship a prebuilt dist/ and have no lockfile
  // or tsc; only build when running from a source checkout without dist.
  if (existsSync(SERVER_JS)) {
    log("Using prebuilt dist/server.js");
  } else {
    info("Building SecureContext...");
    try {
      execSync("npm ci", { cwd: PLUGIN_DIR, stdio: "inherit" });
      execSync("npm run build", { cwd: PLUGIN_DIR, stdio: "inherit" });
      log("Build complete");
    } catch {
      warn("Build failed — aborting installation");
      process.exit(1);
    }
  }

  if (!existsSync(SERVER_JS)) {
    warn(`dist/server.js not found at ${SERVER_JS}`);
    warn("Build may have failed. Check TypeScript errors above.");
    process.exit(1);
  }
}

// ─── Step 2: Claude Code CLI (~/.claude/settings.json) ───────────────────────
if (MODE_CLI || UNINSTALL) {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings     = readJsonSafe(settingsPath);

  if (!UNINSTALL) {
    if (!settings.mcpServers) settings.mcpServers = {};
    settings.mcpServers["zc-ctx"] = buildMcpEntry();
    writeJson(settingsPath, settings);
    const modeLabel = REMOTE_URL ? ` (remote: ${REMOTE_URL})` : " (local SQLite)";
    log(`Claude Code CLI: added zc-ctx to ${settingsPath}${modeLabel}`);
  } else {
    let changed = false;
    if (settings.mcpServers?.["zc-ctx"]) {
      delete settings.mcpServers["zc-ctx"];
      changed = true;
      log(`Removed zc-ctx from ${settingsPath}`);
    } else {
      info(`zc-ctx not found in ${settingsPath} — nothing to remove`);
    }

    // Issue #3 — uninstall must undo EVERYTHING init.mjs wired, not just the MCP
    // entry. Before this, 18 hook scripts stayed in ~/.claude/hooks and their 5
    // settings.hooks registrations kept executing on every Read/Edit/Bash after
    // the user believed SecureContext was gone. The removal is scoped to OUR
    // scripts by exact filename (drawn from this repo's hooks/ directory), so a
    // user's own hooks and other tools' hooks are untouched.
    const ourHookFiles = new Set();
    try {
      for (const f of readdirSync(join(__dirname, "hooks")).filter((f) => f.endsWith(".mjs") || f.endsWith(".ps1"))) ourHookFiles.add(f);
    } catch { /* hooks dir absent in this checkout — fall through with empty set */ }

    if (settings.hooks && ourHookFiles.size > 0) {
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((entry) => {
          const cmds = (entry?.hooks ?? []).map((h) => h?.command ?? "");
          return !cmds.some((c) => [...ourHookFiles].some((f) => c.includes(f)));
        });
        const removed = before - settings.hooks[event].length;
        if (removed > 0) { changed = true; log(`Deregistered ${removed} SecureContext hook(s) from ${event}`); }
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    if (changed) writeJson(settingsPath, settings);

    // Delete the copied hook scripts themselves — ours only, by exact name.
    const hooksDst = join(homedir(), ".claude", "hooks");
    let deleted = 0;
    for (const f of ourHookFiles) {
      try {
        const p = join(hooksDst, f);
        if (existsSync(p)) { unlinkSync(p); deleted++; }
      } catch (e) { info(`Could not delete ${f}: ${e.message}`); }
    }
    if (deleted > 0) log(`Deleted ${deleted} SecureContext hook script(s) from ${hooksDst}`);
  }
}

// ─── Step 3: Claude Desktop App ──────────────────────────────────────────────
function getDesktopConfigPath() {
  const os = platform();
  if (os === "win32") {
    const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  } else if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else {
    // Linux
    const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
    return join(xdgConfig, "Claude", "claude_desktop_config.json");
  }
}

if (MODE_DESKTOP || UNINSTALL) {
  const desktopConfigPath = getDesktopConfigPath();
  const desktopConfig     = readJsonSafe(desktopConfigPath);

  if (!UNINSTALL) {
    if (!desktopConfig.mcpServers) desktopConfig.mcpServers = {};
    desktopConfig.mcpServers["zc-ctx"] = buildMcpEntry();
    writeJson(desktopConfigPath, desktopConfig);
    const modeLabel = REMOTE_URL ? ` (remote: ${REMOTE_URL})` : " (local SQLite)";
    log(`Claude Desktop: added zc-ctx to ${desktopConfigPath}${modeLabel}`);
    info("Restart Claude Desktop for changes to take effect");
  } else {
    if (desktopConfig.mcpServers?.["zc-ctx"]) {
      delete desktopConfig.mcpServers["zc-ctx"];
      writeJson(desktopConfigPath, desktopConfig);
      log(`Removed zc-ctx from ${desktopConfigPath}`);
    } else {
      info(`zc-ctx not found in ${desktopConfigPath} — nothing to remove`);
    }
  }
}

// ─── Done ─────────────────────────────────────────────────────────────────────
console.log();
if (!UNINSTALL) {
  console.log(`${GREEN}${BOLD}SecureContext v${PKG_VERSION} installed successfully.${RESET}`);
  console.log();

  if (REMOTE_URL) {
    // ── Remote / production mode ─────────────────────────────────────────────
    console.log(`${CYAN}Mode: Remote API (Docker stack)${RESET}`);
    console.log(`  API server: ${REMOTE_URL}`);
    console.log();
    console.log(`${DIM}Next steps:${RESET}`);
    console.log(`  1. Confirm the Docker stack is running:`);
    console.log(`       curl ${REMOTE_URL}/health`);
    console.log(`       # Expected: {"status":"ok","version":"${PKG_VERSION}"}`);
    console.log(`  2. Start a new Claude Code session`);
    console.log(`  3. Call: zc_recall_context()  — confirm remote mode is active`);
    console.log(`  4. Call: zc_status()           — verify PostgreSQL store is connected`);
    console.log();
    console.log(`${DIM}To switch back to local SQLite mode:${RESET}`);
    console.log(`  node install.mjs --uninstall && node install.mjs`);
  } else {
    // ── Local SQLite mode ────────────────────────────────────────────────────
    console.log(`${CYAN}Mode: Local SQLite (single-developer)${RESET}`);
    console.log();
    console.log(`${DIM}Next steps:${RESET}`);
    console.log(`  1. Start a new Claude Code session`);
    console.log(`  2. Call: zc_recall_context()  — to verify the plugin is active`);
    console.log(`  3. Call: zc_status()           — to see DB health and fetch budget`);
    console.log();
    console.log(`${DIM}Optional: enable Ollama for semantic vector search:${RESET}`);
    console.log(`  ollama pull nomic-embed-text`);
    console.log(`  ollama serve`);
    console.log(`  # SecureContext auto-detects Ollama — no config needed`);
    console.log();
    console.log(`${DIM}Optional: upgrade to production mode (PostgreSQL + Docker):${RESET}`);
    console.log(`  # 1. Start the Docker stack:`);
    console.log(`  #    Windows:      .\\docker\\start.ps1`);
    console.log(`  #    Linux/macOS:  ./docker/start.sh`);
    console.log(`  # 2. Re-run the installer with your API key:`);
    console.log(`  #    node install.mjs --remote http://localhost:3099 <your-ZC_API_KEY>`);
  }
} else {
  console.log(`${GREEN}SecureContext uninstalled.${RESET}`);
  console.log(`${DIM}Your KB data remains at ~/.claude/zc-ctx/ — delete manually if desired.${RESET}`);
}
