/**
 * Tests for the canonical project hash (v0.55.0).
 *
 * Context: before normalisation, the same project reached through a different
 * path spelling got a different database. Measured on a real machine:
 *   RevClear                 6160 KB (backslash)  +  380 KB (forward slash)
 *   Test_Agent_Coordination  1336 KB (backslash)  +  352 KB (forward slash)
 * Memory written through one spelling was invisible through the other.
 *
 * The FIRST test is the one that matters. Normalisation must not move the hash
 * of the path form already on disk, or every existing database is orphaned and
 * every agent loses its memory at once. Those constants are real hashes read
 * off a live machine, not values copied from the implementation.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { projectHash, normalizeProjectPath } from "./store.js";

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("projectHash — backward compatibility", () => {
  it("does NOT change the hash of the canonical Windows form (existing DBs must survive)", () => {
    // Observed on disk before this change.
    expect(projectHash("C:\\Users\\Amit\\AI_projects\\RevClear")).toBe("86283ac464e3f79c");
    expect(projectHash("C:\\Users\\Amit\\AI_projects\\Test_Agent_Coordination")).toBe("aafb4b029db36884");
  });

  it("agrees with a plain sha256 for any already-canonical path", () => {
    for (const p of [
      "C:\\Users\\Amit\\AI_projects\\SecureContext",
      "C:\\repos\\thing",
      "/home/user/project",
      "/var/www",
    ]) {
      expect(projectHash(p)).toBe(sha16(p));
    }
  });
});

describe("projectHash — spellings that must converge", () => {
  const canonical = "C:\\Users\\Amit\\AI_projects\\Test_Agent_Coordination";

  it("maps the forward-slash spelling onto the canonical hash", () => {
    // This is the exact split found on disk: 223bc78cd8cf20e0 was a SECOND
    // database for this project. It must now resolve to the canonical one.
    expect(sha16("C:/Users/Amit/AI_projects/Test_Agent_Coordination")).toBe("223bc78cd8cf20e0");
    expect(projectHash("C:/Users/Amit/AI_projects/Test_Agent_Coordination")).toBe("aafb4b029db36884");
  });

  it("ignores a trailing separator, either kind", () => {
    expect(projectHash(canonical + "\\")).toBe(projectHash(canonical));
    expect(projectHash(canonical + "/")).toBe(projectHash(canonical));
    expect(projectHash("/home/user/project/")).toBe(projectHash("/home/user/project"));
  });

  it("treats mixed separators as one project", () => {
    expect(projectHash("C:\\Users/Amit\\AI_projects/Test_Agent_Coordination"))
      .toBe(projectHash(canonical));
  });
});

describe("normalizeProjectPath — limits, stated rather than assumed", () => {
  it("does NOT fold case, because that would strand every existing database", () => {
    // A real remaining gap on case-insensitive Windows. Asserted so the
    // limitation is visible and deliberate, not discovered later as a surprise.
    expect(projectHash("c:\\users\\amit\\ai_projects\\revclear"))
      .not.toBe(projectHash("C:\\Users\\Amit\\AI_projects\\RevClear"));
  });

  it("leaves POSIX paths alone — a backslash there is a legal filename character", () => {
    expect(normalizeProjectPath("/home/user/weird\\name")).toBe("/home/user/weird\\name");
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
