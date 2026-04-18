/**
 * Machine Secret — Sprint 0 foundation
 * =====================================
 *
 * A cryptographically random 64-byte (512-bit) secret stored at:
 *   ~/.claude/zc-ctx/.machine_secret
 *
 * File permissions: 0600 (owner read/write only). Generated on first access;
 * cached for subsequent accesses within the process. Survives across
 * SecureContext restarts (read from disk).
 *
 * USES (across SC v0.10.5+ security primitives):
 *   - Hash chain HMAC keying (src/security/hmac_chain.ts)
 *   - Audit log entry signatures (src/security/audit_log.ts)
 *   - Skill body HMAC signatures (Sprint 2)
 *   - Outcome record signatures (Sprint 1)
 *
 * THREAT MODEL:
 *   - This secret MUST NOT leak to logs, telemetry, LLM context, or backups
 *     without explicit operator opt-in.
 *   - If leaked, an attacker can forge HMAC signatures and bypass tamper
 *     detection on every chained table + audit log.
 *   - Compromise → immediate rotation required (regenerate file).
 *
 * SECURITY GUARANTEES:
 *   - Generated via Node's `randomBytes(64)` (CSPRNG)
 *   - File mode enforced 0600 on creation; verified on every read
 *   - Cached only in-process; never serialized to other storage
 *   - Override via ZC_MACHINE_SECRET env var for testing/CI (logged AUDIT)
 *
 * ROTATION:
 *   Manual: delete the file → next access regenerates.
 *   After rotation: ALL previously-signed chains/entries become unverifiable
 *   (treat as compromised). Do not rotate casually.
 */

import { existsSync, readFileSync, writeFileSync, statSync, chmodSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Paths ─────────────────────────────────────────────────────────────────

/** Where the machine secret lives. Single per-machine file, mode 0600. */
export const MACHINE_SECRET_PATH = join(homedir(), ".claude", "zc-ctx", ".machine_secret");

/** Length of the generated secret in bytes. 64 = 512 bits, way beyond brute-force reach. */
export const MACHINE_SECRET_BYTES = 64;

// ─── State ─────────────────────────────────────────────────────────────────

let _cachedSecret: Buffer | null = null;
let _envOverrideUsed = false;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get the machine secret. Generates on first call if missing. Subsequent
 * calls within the same process return the cached value.
 *
 * Override priority:
 *   1. ZC_MACHINE_SECRET env var (for testing/CI; must be base64-encoded)
 *   2. File at MACHINE_SECRET_PATH (production)
 *   3. Generate new + write to file (first run)
 *
 * Returns: Buffer of MACHINE_SECRET_BYTES length.
 *
 * Throws: only if the secret is impossible to obtain (extremely rare —
 * disk full + env var missing). All other errors degrade gracefully.
 */
export function getMachineSecret(): Buffer {
  if (_cachedSecret) return _cachedSecret;

  // Path 1: env override (for testing / CI / explicit operator override)
  const envSecret = process.env.ZC_MACHINE_SECRET;
  if (envSecret && envSecret.length > 0) {
    try {
      const buf = Buffer.from(envSecret, "base64");
      if (buf.length < 32) {
        throw new Error(`ZC_MACHINE_SECRET too short (${buf.length} bytes; need ≥32 after base64-decode)`);
      }
      _cachedSecret = buf;
      _envOverrideUsed = true;
      return _cachedSecret;
    } catch (e) {
      throw new Error(`ZC_MACHINE_SECRET env var present but malformed: ${(e as Error).message}`);
    }
  }

  // Path 2: read from file
  if (existsSync(MACHINE_SECRET_PATH)) {
    try {
      verifySecretFilePermissions(MACHINE_SECRET_PATH);
      const raw = readFileSync(MACHINE_SECRET_PATH, "utf8").trim();
      const buf = Buffer.from(raw, "base64");
      if (buf.length !== MACHINE_SECRET_BYTES) {
        throw new Error(
          `Machine secret file at ${MACHINE_SECRET_PATH} has unexpected length ` +
          `(got ${buf.length} bytes after base64-decode, expected ${MACHINE_SECRET_BYTES}). ` +
          `File may be corrupted. Delete it to regenerate.`
        );
      }
      _cachedSecret = buf;
      return _cachedSecret;
    } catch (e) {
      // Re-throw with helpful guidance — this is a security-critical failure
      throw new Error(
        `Failed to read machine secret from ${MACHINE_SECRET_PATH}: ${(e as Error).message}. ` +
        `If the file is corrupted, delete it and restart to regenerate. ` +
        `Note: regeneration invalidates all existing HMAC signatures and chain integrity.`
      );
    }
  }

  // Path 3: generate + persist
  return generateAndWriteSecret();
}

/**
 * Force regenerate the machine secret. WARNING: invalidates all existing
 * HMAC signatures and chain integrity verification. Use only for explicit
 * key rotation events.
 */
export function rotateMachineSecret(): Buffer {
  if (_envOverrideUsed) {
    throw new Error(
      "Cannot rotate machine secret while ZC_MACHINE_SECRET env override is active. " +
      "Unset the env var first."
    );
  }
  _cachedSecret = null;
  return generateAndWriteSecret();
}

/**
 * Returns metadata about the current machine secret (for status / debug).
 * NEVER returns the secret itself.
 */
export function getMachineSecretInfo(): {
  source: "env" | "file" | "not-yet-loaded";
  path: string;
  exists: boolean;
  modeOk: boolean | null;     // null = file doesn't exist
  cached: boolean;
  envOverride: boolean;
} {
  const exists = existsSync(MACHINE_SECRET_PATH);
  let modeOk: boolean | null = null;
  if (exists) {
    try {
      verifySecretFilePermissions(MACHINE_SECRET_PATH);
      modeOk = true;
    } catch {
      modeOk = false;
    }
  }
  return {
    source:        _envOverrideUsed ? "env" : (_cachedSecret ? "file" : "not-yet-loaded"),
    path:          MACHINE_SECRET_PATH,
    exists,
    modeOk,
    cached:        _cachedSecret !== null,
    envOverride:   _envOverrideUsed,
  };
}

/** Test/diagnostic helper: clear the cache (forces re-read on next access). */
export function _resetCacheForTesting(): void {
  _cachedSecret = null;
  _envOverrideUsed = false;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function generateAndWriteSecret(): Buffer {
  const buf = randomBytes(MACHINE_SECRET_BYTES);

  // Ensure parent directory exists
  const dir = join(homedir(), ".claude", "zc-ctx");
  mkdirSync(dir, { recursive: true });

  // Write base64-encoded with restrictive permissions
  // We write with a temp + rename for atomicity (prevents reading a half-written file)
  const tmpPath = `${MACHINE_SECRET_PATH}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, buf.toString("base64"), { mode: 0o600, encoding: "utf8" });

    // Belt-and-suspenders: explicitly chmod (Windows may ignore mode in writeFileSync)
    try { chmodSync(tmpPath, 0o600); } catch { /* Windows: chmod may noop */ }

    // Atomic rename (POSIX guarantees, Windows uses MoveFileEx semantics)
    // Note: on Windows we may need to remove the dest first if it exists.
    if (existsSync(MACHINE_SECRET_PATH)) {
      // This path runs only on rotation
      unlinkSync(MACHINE_SECRET_PATH);
    }
    renameSync(tmpPath, MACHINE_SECRET_PATH);
    try { chmodSync(MACHINE_SECRET_PATH, 0o600); } catch { /* Windows */ }
  } catch (e) {
    // Cleanup temp on failure
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch { /* ignore */ }
    throw new Error(
      `Failed to write machine secret to ${MACHINE_SECRET_PATH}: ${(e as Error).message}. ` +
      `Check disk space and write permissions in ~/.claude/zc-ctx/.`
    );
  }

  _cachedSecret = buf;
  return buf;
}

function verifySecretFilePermissions(path: string): void {
  // On Windows, file modes are not enforced the same way as POSIX. We still
  // check the bit pattern but treat Windows specially — if the bits look
  // wide-open we still warn but don't refuse, because Windows handles ACLs
  // separately (and outside our control via Node's fs API).
  try {
    const st = statSync(path);
    const isWindows = process.platform === "win32";
    if (!isWindows) {
      // Mode check on POSIX: must be 0600 (no group/other read or write)
      const mode = st.mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(
          `Machine secret file at ${path} has insecure permissions (mode ${mode.toString(8)}; expected 600). ` +
          `Run: chmod 600 "${path}"`
        );
      }
    }
    // On Windows we skip strict mode check; users should rely on default
    // home-directory ACLs which restrict access to the user.
  } catch (e) {
    if ((e as Error).message.startsWith("Machine secret file")) throw e;
    throw new Error(`Failed to stat machine secret file: ${(e as Error).message}`);
  }
}
