#!/usr/bin/env node
/**
 * v0.26.0 Step 4 — PreToolUse hook: HMAC verify-before-execute for skill scripts.
 *
 * Triggered by Claude Code on every Bash tool call. If the command invokes a
 * script under ~/.claude/skills/<name>/scripts/, we ask the API server to
 * verify the on-disk HMAC matches the admission-time HMAC stored in skills_pg.
 *
 * SERVER-SIDE VERIFICATION (v0.26.0 final):
 *   The machine_secret lives only inside the container (api_state volume) for
 *   security; this hook does NOT need access to it. It just asks the server
 *   /api/v1/skills/<name>/verify-script?path=scripts/<rel> and reads the
 *   returned { verified, has_admission, quarantined, reason } payload.
 *
 * Outcomes (exit codes are PreToolUse contract):
 *   - PreToolUse hook exits 0 → tool call proceeds normally
 *   - PreToolUse hook exits 2 + stderr message → tool call BLOCKED
 *
 * Fail-CLOSED on:
 *   - API unreachable (we can't verify, block)
 *   - Skill missing in PG (no admission record)
 *   - Quarantined skill
 *   - HMAC mismatch (tampered post-admission)
 *
 * Fail-OPEN on:
 *   - Bash command that doesn't touch a skill script (out of scope, allow)
 *   - Hook itself crashes (logged, allow — don't break the agent over a hook bug)
 *
 * Audit: every block (and every pass) is logged to ~/.claude/zc-ctx/logs/audit.log.
 *
 * Bypass (operator escape hatch): ZC_SKILL_HMAC_BYPASS=1 lets the call proceed
 * even when API is unreachable; logged AUDIT.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// PreToolUse contract: read tool input from stdin as JSON, exit 0 to allow,
// exit 2 to deny (with stderr explaining why).
let payload;
try {
  const raw = readFileSync(0, "utf8");
  payload = JSON.parse(raw);
} catch {
  // No payload / bad JSON — fail open (don't break agent over a hook quirk)
  process.exit(0);
}

const toolName  = payload?.tool_name ?? payload?.toolName ?? "";
const toolInput = payload?.tool_input ?? payload?.toolInput ?? {};

// v0.50.1 — TODO_v0.28.1 bypass 2 CLOSED: intercept EVERY shell-capable tool,
// not just Bash. The documented bypass was `PowerShell python <skill>/scripts/x.py`
// sailing past a Bash-only matcher — the tamper check never fired. The
// skill-script path regex below is already tool- and OS-agnostic; the tool-name
// gate was the only hole. Registration must pair with this: init.mjs registers
// the hook under BOTH matchers ("Bash" and "PowerShell").
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
if (!SHELL_TOOLS.has(toolName)) {
  // Not a shell-capable tool — out of scope.
  process.exit(0);
}

const cmd = String(toolInput?.command ?? "");
if (!cmd) process.exit(0);

// Detect skill-script invocation. Patterns we recognize:
//   python ~/.claude/skills/X/scripts/Y.py [args...]
//   python /home/.../.claude/skills/X/scripts/Y.py
//   ~/.claude/skills/X/scripts/Y.py    (shebang-direct)
//   node .claude/skills/X/scripts/Y.js
//
// Match strategy: pull the FIRST token in the command that looks like a
// path under .claude/skills/. We DON'T try to parse the whole shell command;
// instead we look for any substring matching the skill-script pattern.
const skillScriptPattern = /(?:[\w./~\\:-]*\.claude[\/\\]skills[\/\\]([\w.-]+)[\/\\]scripts[\/\\]([\w./\\-]+\.(?:py|js|mjs|cjs|sh)))/;
const match = cmd.match(skillScriptPattern);
if (!match) {
  // Not a skill-script call. Out of scope.
  process.exit(0);
}

const [, skillName, scriptRelPathRaw] = match;
const scriptRelPath = scriptRelPathRaw.replace(/\\/g, "/");
const scriptRelPathFull = `scripts/${scriptRelPath}`;

const apiUrl = process.env.ZC_API_URL || "http://localhost:3099";
const apiKey = process.env.ZC_API_KEY || "";

async function verifyScript() {
  const url = `${apiUrl}/api/v1/skills/${encodeURIComponent(skillName)}/verify-script?path=${encodeURIComponent(scriptRelPathFull)}`;
  const res = await fetch(url, {
    headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(3000),
  });
  // Server returns 404 with a body for unknown skill; still parse it.
  if (!res.ok && res.status !== 404) throw new Error(`API ${res.status}`);
  return res.json();
}

function auditLog(line) {
  try {
    const logDir = join(homedir(), ".claude", "zc-ctx", "logs");
    mkdirSync(logDir, { recursive: true });
    const path = join(logDir, "audit.log");
    appendFileSync(path, `${new Date().toISOString()} skill-script-hmac-verify ${line}\n`);
  } catch { /* best effort */ }
}

(async () => {
  let result;
  try {
    result = await verifyScript();
  } catch (e) {
    // API unreachable — fail CLOSED. We can't verify, so we block.
    auditLog(`BLOCK api_unreachable skill=${skillName} script=${scriptRelPathFull} error=${e.message}`);
    if (process.env.ZC_SKILL_HMAC_BYPASS === "1") {
      auditLog(`BYPASS_OPERATOR skill=${skillName} script=${scriptRelPathFull}`);
      process.exit(0);
    }
    process.stderr.write(`[zc-ctx] HMAC verification API unreachable (${apiUrl}). Refusing to execute ${scriptRelPathFull}. Start sc-api or set ZC_SKILL_HMAC_BYPASS=1.\n`);
    process.exit(2);
  }

  if (result.verified === true) {
    auditLog(`PASS skill=${skillName} script=${scriptRelPathFull}`);
    process.exit(0);
  }

  // Various block reasons:
  if (result.quarantined === true) {
    auditLog(`BLOCK quarantined skill=${skillName} script=${scriptRelPathFull} reason=${result.reason}`);
    process.stderr.write(`[zc-ctx] Skill '${skillName}' is QUARANTINED. Refusing to execute. ${result.reason ?? ""}\n`);
    process.exit(2);
  }

  if (result.has_admission === false) {
    auditLog(`BLOCK no_admission skill=${skillName} script=${scriptRelPathFull} reason=${result.reason}`);
    process.stderr.write(`[zc-ctx] ${result.reason ?? "No admission record"} for ${skillName}/${scriptRelPathFull}. Run skill auto-import (or wait for the watcher) so the admission gate registers this script.\n`);
    process.exit(2);
  }

  // Has admission + not quarantined + not verified = HMAC mismatch (tamper)
  auditLog(`BLOCK hmac_mismatch skill=${skillName} script=${scriptRelPathFull} reason=${result.reason}`);
  process.stderr.write(`[zc-ctx] HMAC MISMATCH on ${scriptRelPathFull}. ${result.reason ?? "Script changed after admission scan"} — refusing to execute. Re-run the auto-import scanner to re-admit if the change is legitimate.\n`);
  process.exit(2);
})().catch((err) => {
  // Hook itself crashed — fail OPEN to not break the agent over our bug
  auditLog(`HOOK_CRASH error=${err.message}`);
  process.exit(0);
});
