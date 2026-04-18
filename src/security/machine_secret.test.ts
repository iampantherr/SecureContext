/**
 * Tests for src/security/machine_secret.ts
 *
 * Covers (from test category matrix §13):
 *   - Unit: getMachineSecret, rotation, info, env override, validation
 *   - Failure-mode: missing file, corrupted file, env override malformed
 *   - Red-team RT-S0-01: file mode tamper detection (POSIX)
 *   - Red-team RT-S0-02: secret-not-leaked-via-info
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync, chmodSync, readFileSync, statSync } from "node:fs";
import {
  getMachineSecret,
  rotateMachineSecret,
  getMachineSecretInfo,
  _resetCacheForTesting,
  MACHINE_SECRET_PATH,
  MACHINE_SECRET_BYTES,
} from "./machine_secret.js";

const isWindows = process.platform === "win32";

function cleanSecretFile(): void {
  if (existsSync(MACHINE_SECRET_PATH)) {
    try { unlinkSync(MACHINE_SECRET_PATH); } catch { /* ignore */ }
  }
}

describe("machine_secret", () => {
  beforeEach(() => {
    delete process.env.ZC_MACHINE_SECRET;
    _resetCacheForTesting();
    cleanSecretFile();
  });

  afterEach(() => {
    delete process.env.ZC_MACHINE_SECRET;
    _resetCacheForTesting();
    cleanSecretFile();
  });

  // ── Unit ─────────────────────────────────────────────────────────────────

  it("generates a 64-byte secret on first call", () => {
    const s = getMachineSecret();
    expect(s).toBeInstanceOf(Buffer);
    expect(s.length).toBe(MACHINE_SECRET_BYTES);
  });

  it("persists the secret to disk on first generation", () => {
    expect(existsSync(MACHINE_SECRET_PATH)).toBe(false);
    getMachineSecret();
    expect(existsSync(MACHINE_SECRET_PATH)).toBe(true);
  });

  it("returns the same secret on repeated calls (in-process cache)", () => {
    const a = getMachineSecret();
    const b = getMachineSecret();
    expect(a.equals(b)).toBe(true);
  });

  it("returns the same secret across cache resets (reads from disk)", () => {
    const a = getMachineSecret();
    _resetCacheForTesting();
    const b = getMachineSecret();
    expect(a.equals(b)).toBe(true);
  });

  it("writes the file with mode 0600 on POSIX", () => {
    if (isWindows) return;  // POSIX-only check
    getMachineSecret();
    const st = statSync(MACHINE_SECRET_PATH);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rotation generates a new different secret", () => {
    const a = getMachineSecret();
    const b = rotateMachineSecret();
    expect(a.equals(b)).toBe(false);
    expect(b.length).toBe(MACHINE_SECRET_BYTES);
  });

  it("rotation persists the new secret + invalidates the old one on disk", () => {
    const a = getMachineSecret();
    rotateMachineSecret();
    _resetCacheForTesting();
    const c = getMachineSecret();
    expect(a.equals(c)).toBe(false);
  });

  it("getMachineSecretInfo returns metadata WITHOUT the secret itself", () => {
    const s = getMachineSecret();
    const info = getMachineSecretInfo();
    const stringified = JSON.stringify(info);
    // The actual secret bytes must not appear in the info output (in any encoding)
    expect(stringified).not.toContain(s.toString("base64"));
    expect(stringified).not.toContain(s.toString("hex"));
    // Sanity-check the info fields
    expect(info.exists).toBe(true);
    expect(info.cached).toBe(true);
    expect(info.envOverride).toBe(false);
    expect(info.path).toBe(MACHINE_SECRET_PATH);
    expect(info.source).toBe("file");
  });

  // ── Env override ──────────────────────────────────────────────────────────

  it("ZC_MACHINE_SECRET env var takes precedence", () => {
    const overrideRaw = Buffer.alloc(64, 0x42);
    process.env.ZC_MACHINE_SECRET = overrideRaw.toString("base64");
    const s = getMachineSecret();
    expect(s.equals(overrideRaw)).toBe(true);
    expect(getMachineSecretInfo().envOverride).toBe(true);
  });

  it("env override does NOT write to disk", () => {
    const overrideRaw = Buffer.alloc(64, 0xAB);
    process.env.ZC_MACHINE_SECRET = overrideRaw.toString("base64");
    getMachineSecret();
    expect(existsSync(MACHINE_SECRET_PATH)).toBe(false);
  });

  it("rotation refuses while env override is active", () => {
    process.env.ZC_MACHINE_SECRET = Buffer.alloc(64, 0x01).toString("base64");
    getMachineSecret();
    expect(() => rotateMachineSecret()).toThrow(/env override is active/);
  });

  it("rejects ZC_MACHINE_SECRET that is too short", () => {
    process.env.ZC_MACHINE_SECRET = Buffer.alloc(16).toString("base64");  // only 16 bytes
    expect(() => getMachineSecret()).toThrow(/too short/);
  });

  // ── Failure-mode ──────────────────────────────────────────────────────────

  it("regenerates when the file is missing on disk", () => {
    getMachineSecret();
    cleanSecretFile();
    _resetCacheForTesting();
    const s = getMachineSecret();
    expect(s.length).toBe(MACHINE_SECRET_BYTES);
    expect(existsSync(MACHINE_SECRET_PATH)).toBe(true);
  });

  it("rejects a corrupted secret file (wrong length after base64-decode)", () => {
    writeFileSync(MACHINE_SECRET_PATH, "not-base64-but-something", { mode: 0o600 });
    if (!isWindows) chmodSync(MACHINE_SECRET_PATH, 0o600);
    _resetCacheForTesting();
    expect(() => getMachineSecret()).toThrow(/length|corrupted/);
  });

  // ── Red-team ──────────────────────────────────────────────────────────────

  it("[RT-S0-01] rejects file with insecure permissions on POSIX", () => {
    if (isWindows) return;  // Windows uses ACLs not POSIX modes
    getMachineSecret();
    chmodSync(MACHINE_SECRET_PATH, 0o644);  // attacker-readable
    _resetCacheForTesting();
    expect(() => getMachineSecret()).toThrow(/insecure permissions/);
  });

  it("[RT-S0-02] getMachineSecretInfo() output never contains the secret bytes", () => {
    const s = getMachineSecret();
    const info = getMachineSecretInfo();
    const stringified = JSON.stringify(info);
    // The secret should NOT appear in info output, in any encoding
    expect(stringified).not.toContain(s.toString("base64"));
    expect(stringified).not.toContain(s.toString("hex"));
    expect(stringified).not.toContain(s.toString("utf8").replace(/[\x00-\x1f]/g, ""));
  });
});
