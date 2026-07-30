/**
 * Tests for the canonical project hash (v0.55.0).
 *
 * Context: before normalisation, the same project reached through a different
 * path spelling got a different database. Observed on a real machine: two
 * projects each had TWO databases — a 6.1 MB one under the backslash spelling
 * and a 380 KB one under the forward-slash spelling. Memory written through one
 * was invisible through the other, with no error at any layer.
 *
 * The FIRST test is the one that matters. Normalisation must not move the hash
 * of the path form already on disk, or every existing database is orphaned and
 * every agent loses its memory at once.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { projectHash, normalizeProjectPath } from "./store.js";

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("projectHash — backward compatibility", () => {
  it("does NOT change the hash of an already-canonical path (existing DBs must survive)", () => {
    // The regression that would strand every database on disk: if normalisation
    // altered the canonical Windows or POSIX form, every project hash would move.
    for (const p of [
      "C:\\repos\\my-service",
      "C:\\Users\\dev\\projects\\api-gateway",
      "/home/dev/projects/api-gateway",
      "/var/www/app",
    ]) {
      expect(projectHash(p)).toBe(sha16(p));
    }
  });
});

describe("projectHash — spellings that must converge", () => {
  const canonical = "C:\\repos\\my-service";

  it("maps the forward-slash spelling onto the canonical hash", () => {
    // This is the exact split found on disk: the forward-slash spelling had its
    // own separate database. It must now resolve to the canonical one.
    expect(sha16("C:/repos/my-service")).not.toBe(sha16(canonical));   // genuinely different strings
    expect(projectHash("C:/repos/my-service")).toBe(projectHash(canonical));
  });

  it("ignores a trailing separator, either kind", () => {
    expect(projectHash(canonical + "\\")).toBe(projectHash(canonical));
    expect(projectHash(canonical + "/")).toBe(projectHash(canonical));
    expect(projectHash("/home/dev/app/")).toBe(projectHash("/home/dev/app"));
  });

  it("treats mixed separators as one project", () => {
    expect(projectHash("C:\\repos/my-service")).toBe(projectHash(canonical));
  });
});

describe("normalizeProjectPath — limits, stated rather than assumed", () => {
  it("does NOT fold case, because that would strand every existing database", () => {
    // A real remaining gap on case-insensitive Windows. Asserted so the
    // limitation is visible and deliberate, not discovered later as a surprise.
    expect(projectHash("c:\\repos\\my-service")).not.toBe(projectHash("C:\\repos\\my-service"));
  });

  it("leaves POSIX paths alone — a backslash there is a legal filename character", () => {
    expect(normalizeProjectPath("/home/dev/weird\\name")).toBe("/home/dev/weird\\name");
  });

  it("keeps a bare drive or filesystem root meaningful", () => {
    expect(normalizeProjectPath("C:\\")).toBe("C:\\");
    expect(normalizeProjectPath("/")).toBe("/");
  });

  it("survives empty and nullish input without throwing", () => {
    expect(() => projectHash("")).not.toThrow();
    expect(() => projectHash(undefined as unknown as string)).not.toThrow();
  });
});
