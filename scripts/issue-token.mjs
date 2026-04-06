#!/usr/bin/env node
/**
 * issue-token.mjs — CLI for pre-issuing RBAC session tokens
 * Called by start-agents.ps1 before launching each agent.
 *
 * Usage: node scripts/issue-token.mjs --project <path> --agent-id <id> --role <role> [--ttl-hours <hours>]
 * Outputs: the token string to stdout
 *
 * Token format: zcst.{base64url(JSON_payload)}.{hmac_sha256_hex}
 * Interoperable with access-control.ts issueToken() — uses the same algorithm.
 *
 * Valid roles: orchestrator | developer | marketer | researcher | worker
 */

import { DatabaseSync } from "node:sqlite";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

const projectPath = getArg("--project");
const agentId     = getArg("--agent-id");
const role        = getArg("--role");
const ttlHoursStr = getArg("--ttl-hours");
const ttlHours    = ttlHoursStr ? parseInt(ttlHoursStr, 10) : 24;

const VALID_ROLES = ["orchestrator", "developer", "marketer", "researcher", "worker"];

if (!projectPath || !agentId || !role) {
  process.stderr.write(
    "Usage: node scripts/issue-token.mjs --project <path> --agent-id <id> --role <role> [--ttl-hours <n>]\n" +
    `Valid roles: ${VALID_ROLES.join(", ")}\n`
  );
  process.exit(1);
}

if (!VALID_ROLES.includes(role)) {
  process.stderr.write(`Error: invalid role '${role}'. Valid: ${VALID_ROLES.join(", ")}\n`);
  process.exit(1);
}

if (isNaN(ttlHours) || ttlHours < 1 || ttlHours > 168) {
  process.stderr.write("Error: --ttl-hours must be between 1 and 168\n");
  process.exit(1);
}

// ── DB path (mirrors memory.ts dbPath()) ─────────────────────────────────────
const DB_DIR = join(homedir(), ".claude", "zc-ctx", "sessions");

function dbPath(projectPathArg) {
  const hash = createHash("sha256").update(projectPathArg).digest("hex").slice(0, 16);
  return join(DB_DIR, `${hash}.db`);
}

// ── Helpers (mirrors access-control.ts) ──────────────────────────────────────

function b64urlEncode(data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function uuidV4() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20,32)].join("-");
}

function projectHash(pPath) {
  return createHash("sha256").update(pPath).digest("hex").slice(0, 16);
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const path = dbPath(projectPath);

  if (!existsSync(path)) {
    process.stderr.write(
      `Error: project DB not found at ${path}\n` +
      `Ensure the SecureContext plugin has been initialized for this project first.\n` +
      `Run: zc_recall_context() in Claude Code for this project.\n`
    );
    process.exit(1);
  }

  mkdirSync(DB_DIR, { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // Ensure agent_sessions table exists (may not exist on pre-v0.8.0 DBs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      token_id    TEXT    PRIMARY KEY,
      agent_id    TEXT    NOT NULL,
      role        TEXT    NOT NULL,
      token_hmac  TEXT    NOT NULL,
      issued_at   TEXT    NOT NULL,
      expires_at  TEXT    NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_as_agent ON agent_sessions(agent_id, revoked);
  `);

  // Ensure project_meta table exists
  db.exec(`CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

  // Get or generate signing key
  const keyRow = db.prepare("SELECT value FROM project_meta WHERE key = 'zc_token_signing_key'").get();
  let signingKey;
  if (keyRow) {
    signingKey = Buffer.from(keyRow.value, "hex");
  } else {
    signingKey = randomBytes(32);
    db.prepare("INSERT OR REPLACE INTO project_meta(key, value) VALUES ('zc_token_signing_key', ?)").run(signingKey.toString("hex"));
  }

  // Build token payload
  const ttlSeconds = ttlHours * 60 * 60;
  const nowSec     = Math.floor(Date.now() / 1000);
  const tid        = uuidV4();
  const ph         = projectHash(projectPath);

  const payload = {
    tid,
    aid:  agentId,
    role,
    ph,
    iat:  nowSec,
    exp:  nowSec + ttlSeconds,
  };

  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", signingKey).update(payloadB64).digest("hex");
  const token = `zcst.${payloadB64}.${sig}`;

  const issuedAt  = new Date(nowSec * 1000).toISOString();
  const expiresAt = new Date((nowSec + ttlSeconds) * 1000).toISOString();

  // Store session record
  db.prepare(`
    INSERT OR REPLACE INTO agent_sessions(token_id, agent_id, role, token_hmac, issued_at, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(tid, agentId, role, sig, issuedAt, expiresAt);

  db.close();

  // Output token to stdout (caller captures this)
  process.stdout.write(token + "\n");

  process.stderr.write(
    `Token issued: agent='${agentId}' role='${role}' expires='${expiresAt}'\n`
  );

  process.exit(0);
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}
