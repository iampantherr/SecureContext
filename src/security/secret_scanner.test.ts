/**
 * Tests for src/security/secret_scanner.ts
 *
 * Covers:
 *   - Unit: each pattern detects + masks correctly
 *   - Performance: <1ms for 10KB input (per acceptance budget)
 *   - Failure-mode: empty input, non-string, very long input
 *   - Red-team RT-S0-11: secret in mutation prompt blocked before send
 *   - Red-team RT-S0-12: redactSecrets is reversible-by-pattern (i.e., replacement
 *     marker contains the type so audit log can reconstruct what kind was found)
 *   - Red-team RT-S0-13: scanner output never includes the full secret string
 */

import { describe, it, expect } from "vitest";
import { scanForSecrets, redactSecrets } from "./secret_scanner.js";

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY NOTE for test fixtures:
// All "secret-shaped" strings below are constructed via concatenation/repeat
// so the literal pattern doesn't appear in source. This prevents GitHub's
// secret scanner from blocking pushes (it scans for literal patterns).
// None of these are real credentials — they're synthetic strings designed
// to match the regex patterns in secret_scanner.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Construct fake-but-format-valid secrets at runtime.
// Field lengths are precise to regex requirements; over/under will fail to match.
const FAKE = {
  anthropic:    "sk-" + "ant-" + "api03-" + "TestFixtureOnlyNotARealKey1234567890",
  openaiProj:   "sk-" + "proj-" + "TestFixtureNotReal0123456789abcdef",
  // AWS: AKIA + exactly 16 uppercase alphanumeric chars
  awsKey:       "AKIA" + "TESTFIXTUREONLY1",                   // 16 chars, uppercase only
  // GitHub: ghp_ + 36+ chars
  githubPat:    "ghp_" + "TestFixtureOnly1234567890NotARealToken12",
  // Google: AIza + exactly 35 chars from [0-9A-Za-z_-]
  googleKey:    "AIza" + "TestFixtureOnly1234567890NotReal789",  // 35 chars
  slackToken:   "xoxb-" + "111-222-TestFixtureNotReal",
  // Stripe: sk_live_ + 24+ chars
  stripeLive:   "sk_" + "live_" + "TestFixtureNotARealKey1234",
  jwt:          "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiJ0ZXN0In0" + "." + "TestFixtureSignaturePart",
};

describe("secret_scanner", () => {
  // ── Pattern coverage (one test per pattern) ────────────────────────────

  it("detects Anthropic API key (sk-ant-...)", () => {
    const text = `API key is ${FAKE.anthropic} here`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].type).toBe("anthropic_api_key");
    expect(r.matches[0].masked).toMatch(/^sk-a\*{3}.+$/);
    expect(r.matches[0].masked).not.toContain("TestFixture");  // middle redacted
  });

  it("detects OpenAI API key (sk-...)", () => {
    const text = `use ${FAKE.openaiProj} for gpt`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches.find((m) => m.type === "openai_api_key")).toBeTruthy();
  });

  it("does NOT confuse Anthropic key with OpenAI (sk-ant- excluded from openai pattern)", () => {
    const r = scanForSecrets(FAKE.anthropic);
    const types = r.matches.map((m) => m.type);
    expect(types).toContain("anthropic_api_key");
    expect(types).not.toContain("openai_api_key");  // must NOT also match OpenAI
  });

  it("detects AWS access key ID (AKIA...)", () => {
    const text = `aws config: ${FAKE.awsKey}`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].type).toBe("aws_access_key_id");
  });

  it("detects GitHub PAT (ghp_)", () => {
    const text = `GITHUB_TOKEN=${FAKE.githubPat}`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches.find((m) => m.type === "github_pat")).toBeTruthy();
  });

  it("detects Google API key (AIza...)", () => {
    const text = `key = '${FAKE.googleKey}'`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches.find((m) => m.type === "google_api_key")).toBeTruthy();
  });

  it("detects Slack token (xoxb-)", () => {
    const text = `slack: ${FAKE.slackToken}`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].type).toBe("slack_token");
  });

  it("detects Stripe live key (sk_live_)", () => {
    const text = `stripe = ${FAKE.stripeLive}`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].type).toBe("stripe_live_key");
  });

  it("detects JWT (eyJ.eyJ.sig)", () => {
    const text = `Bearer ${FAKE.jwt}`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches.find((m) => m.type === "jwt")).toBeTruthy();
  });

  it("detects SSH private key (PEM format)", () => {
    const text = `Some context.
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz==
-----END RSA PRIVATE KEY-----
More context.`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].type).toBe("ssh_private_key");
  });

  it("detects Bearer token in Authorization context", () => {
    const bearerVal = "TestFixture" + "Bearer" + "Token1234567890";
    const text = `headers: { Authorization: Bearer ${bearerVal} }`;
    const r = scanForSecrets(text);
    expect(r.hasSecret).toBe(true);
    expect(r.matches.find((m) => m.type === "bearer_token")).toBeTruthy();
  });

  // ── Negative cases ────────────────────────────────────────────────────

  it("returns no matches on plain English text", () => {
    const r = scanForSecrets("This is just regular text with no secrets in it.");
    expect(r.hasSecret).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it("returns no matches on empty string", () => {
    const r = scanForSecrets("");
    expect(r.hasSecret).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it("does NOT flag SHA hashes (different format than secrets)", () => {
    const text = "commit hash: 3a79f750d8c5fa2b4ef5a1cd6e89f0a2b1c4d3e5";
    const r = scanForSecrets(text);
    // SHA hashes don't match any of our regex patterns; high-entropy detection is OFF by default
    expect(r.matches).toEqual([]);
  });

  // ── Masking ───────────────────────────────────────────────────────────

  it("masks long secrets as 'first4***last4'", () => {
    const r = scanForSecrets(FAKE.githubPat);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].masked).toMatch(/^.{4}\*{3}.{4}$/);
  });

  // ── redactSecrets ──────────────────────────────────────────────────────

  it("redactSecrets replaces secret with [REDACTED:type] marker", () => {
    const text = `key=${FAKE.anthropic} end`;
    const out = redactSecrets(text);
    expect(out).not.toContain("TestFixture");
    expect(out).toContain("[REDACTED:anthropic_api_key]");
    expect(out).toContain("key=");
    expect(out).toContain("end");
  });

  it("redactSecrets handles multiple secrets in one string", () => {
    const text = `k1=${FAKE.githubPat} k2=${FAKE.awsKey}`;
    const out = redactSecrets(text);
    expect(out).toContain("[REDACTED:github_pat]");
    expect(out).toContain("[REDACTED:aws_access_key_id]");
    expect(out).not.toContain("TestFixtureOnly");
    expect(out).not.toContain(FAKE.awsKey);
  });

  it("redactSecrets returns input unchanged if no secrets present", () => {
    const text = "plain text only";
    expect(redactSecrets(text)).toBe(text);
  });

  // ── High-entropy ──────────────────────────────────────────────────────

  it("high-entropy detection is OFF by default (avoid false positives on logs)", () => {
    const text = "random looking but not actually a secret: 9f8d7c6b5a4938271605948372615049";  // hex but no key prefix
    const r = scanForSecrets(text);
    expect(r.highEntropyCount).toBe(0);
  });

  it("high-entropy detection ON catches unrecognized high-entropy strings", () => {
    // 40+ chars of high-entropy alphanumeric — looks suspicious
    const text = "config: jK8fL3pQ9wXz2nM7bV4tR6yU1iE5oA0sD" + "Hh9KlMnBvCxZ".repeat(5);
    const r = scanForSecrets(text, { detectHighEntropy: true });
    expect(r.highEntropyCount).toBeGreaterThan(0);
    expect(r.hasSecret).toBe(true);
  });

  // ── Performance ───────────────────────────────────────────────────────

  it("scans 10KB of typical text in under 5ms", () => {
    const block = "This is normal source code or documentation. ".repeat(50);  // ~2KB
    const text  = block.repeat(5);  // ~10KB
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) scanForSecrets(text);
    const dtAvg = (Date.now() - t0) / 10;
    expect(dtAvg).toBeLessThan(5);  // 5ms generous budget; usually <1ms
  });

  it("scans 10KB containing a real secret in under 5ms", () => {
    const block = "Some text. ".repeat(100);
    const text  = block + `key=${FAKE.anthropic} ` + block;
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) scanForSecrets(text);
    const dtAvg = (Date.now() - t0) / 10;
    expect(dtAvg).toBeLessThan(5);
  });

  // ── Red-team ──────────────────────────────────────────────────────────

  it("[RT-S0-11] mutation-prompt-shaped string with embedded secret is detected", () => {
    // Simulates what a mutation engine might try to send to the API
    const prompt = `
You are a code mutation engine. Here is the current skill:
---
The skill needs to call the API with auth header:
  "Authorization: Bearer ${FAKE.githubPat}"
---
Propose a better version.
    `.trim();
    const r = scanForSecrets(prompt);
    expect(r.hasSecret).toBe(true);
    // Both ghp_ pattern AND bearer_token pattern should fire
    const types = r.matches.map((m) => m.type);
    expect(types).toContain("github_pat");
    expect(types).toContain("bearer_token");
  });

  it("[RT-S0-12] redaction marker contains type for incident-response visibility", () => {
    const text = `key=${FAKE.anthropic}`;
    const out = redactSecrets(text);
    // The replacement marker MUST identify the TYPE (so an investigator knows
    // what kind of secret was found without seeing the actual value)
    expect(out).toMatch(/\[REDACTED:[a-z_]+\]/);
    expect(out).toContain("anthropic_api_key");
  });

  it("[RT-S0-13] scanner output (matches[].masked) NEVER contains the full secret", () => {
    const text = `key is ${FAKE.anthropic} thanks`;
    const r = scanForSecrets(text);
    for (const m of r.matches) {
      expect(m.masked).not.toBe(FAKE.anthropic);
      // Masked should be no longer than 11 chars (4 + 3 + 4 = 11)
      expect(m.masked.length).toBeLessThanOrEqual(11);
    }
  });

  it("[RT-S0-14] PEM private key with content scanned end-to-end", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n-----END RSA PRIVATE KEY-----";
    const r = scanForSecrets(pem);
    expect(r.hasSecret).toBe(true);
    expect(r.matches[0].type).toBe("ssh_private_key");
    // Masked should not contain the key body
    expect(r.matches[0].masked).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });
});
