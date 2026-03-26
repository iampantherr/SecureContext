import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNonAsciiChars, indexContent, searchKnowledge } from "./knowledge.js";

const TEST_PATH = mkdtempSync(join(tmpdir(), "zc-kb-test-"));

describe("hasNonAsciiChars", () => {
  it("returns false for plain ASCII", () => {
    expect(hasNonAsciiChars("hello world")).toBe(false);
  });

  it("returns true for non-ASCII chars", () => {
    expect(hasNonAsciiChars("hеllo")).toBe(true);    // Cyrillic е
    expect(hasNonAsciiChars("héllo")).toBe(true);    // é
    expect(hasNonAsciiChars("中文")).toBe(true);      // CJK
  });

  it("returns false for common symbols and numbers", () => {
    expect(hasNonAsciiChars("hello-world_123!@#$%")).toBe(false);
  });
});

describe("indexContent + searchKnowledge", () => {
  it("indexes content and finds it via BM25 search", async () => {
    indexContent(TEST_PATH, "The quick brown fox jumps over the lazy dog", "test-doc-1");
    const results = await searchKnowledge(TEST_PATH, ["quick brown fox"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe("test-doc-1");
  });

  it("replaces existing content for the same source", async () => {
    indexContent(TEST_PATH, "original content here", "replaceable-doc");
    indexContent(TEST_PATH, "completely new content here", "replaceable-doc");
    const results = await searchKnowledge(TEST_PATH, ["completely new"]);
    const found = results.find((r) => r.source === "replaceable-doc");
    expect(found).toBeDefined();
    expect(found!.content).toContain("completely new");
  });

  it("tags external content with sourceType=external", async () => {
    indexContent(TEST_PATH, "web content here", "external-source", "external");
    const results = await searchKnowledge(TEST_PATH, ["web content"]);
    const found = results.find((r) => r.source === "external-source");
    expect(found).toBeDefined();
    expect(found!.sourceType).toBe("external");
    expect(found!.snippet).toContain("[UNTRUSTED EXTERNAL CONTENT");
  });

  it("does NOT prefix internal content with trust warning", async () => {
    indexContent(TEST_PATH, "internal fact content", "internal-source", "internal");
    const results = await searchKnowledge(TEST_PATH, ["internal fact"]);
    const found = results.find((r) => r.source === "internal-source");
    expect(found).toBeDefined();
    expect(found!.snippet).not.toContain("[UNTRUSTED EXTERNAL CONTENT");
  });

  it("flags non-ASCII source labels", async () => {
    const badSource = "hеllo-source"; // Cyrillic е
    indexContent(TEST_PATH, "content with suspicious source label", badSource);
    const results = await searchKnowledge(TEST_PATH, ["suspicious source"]);
    const found = results.find((r) => r.source === badSource);
    if (found) {
      expect(found.nonAsciiSource).toBe(true);
      expect(found.snippet).toContain("[NON-ASCII SOURCE LABEL");
    }
  });

  it("handles malformed FTS5 queries gracefully (no crash)", async () => {
    const results = await searchKnowledge(TEST_PATH, [
      '"unclosed quote',   // unclosed quote
      "AND",               // bare operator
      "OR OR OR",          // multiple bare operators
      "*",                 // bare wildcard
    ]);
    // Should return empty array, not throw
    expect(Array.isArray(results)).toBe(true);
  });

  it("returns empty array when KB has no matches", async () => {
    const results = await searchKnowledge(TEST_PATH, ["zzz-no-match-xyzzy"]);
    expect(results).toHaveLength(0);
  });

  it("handles multiple queries and deduplicates results", async () => {
    indexContent(TEST_PATH, "dedupe test content alpha beta gamma", "dedupe-doc");
    const results = await searchKnowledge(TEST_PATH, ["alpha", "beta", "gamma"]);
    const sources = results.map((r) => r.source);
    const uniqueSources = new Set(sources);
    expect(uniqueSources.size).toBe(sources.length); // no duplicates
  });
});
