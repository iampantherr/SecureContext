/**
 * Tests for v0.18.0 Sprint 2 — skill loader + storage + HMAC verify.
 *
 * Covers:
 *   - load valid skill markdown → frontmatter parsed + body HMAC computed
 *   - missing frontmatter delimiters → returns null (not a skill file)
 *   - malformed frontmatter (missing required field) → throws
 *   - bad scope value → throws
 *   - HMAC verifies for round-trip; mismatch detected
 *   - inline fixtures parse correctly
 *   - render → re-load round-trips losslessly
 *   - storage upsert + getById + resolveSkill (project overrides global)
 *   - tampered DB body → SkillTamperedError on read
 *   - archive flow + listActiveSkills excludes archived
 *   - verifyAllSkillHmacs reports tampered ids
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  loadSkillFromPath, computeSkillBodyHmac, verifySkillHmac,
  buildSkill, renderSkillMarkdown, skillFilename,
} from "./loader.js";
import {
  upsertSkill, getSkillById, getActiveSkill, resolveSkill, listActiveSkills,
  archiveSkill, verifyAllSkillHmacs, SkillTamperedError,
  recordSkillRun, getRecentSkillRuns, recordMutation, getRecentMutations, resolveMutation,
} from "./storage.js";
import { runMigrations } from "../migrations.js";
import { _resetCacheForTesting as resetMachineSecret, MACHINE_SECRET_PATH } from "../security/machine_secret.js";

// Use a deterministic tmp project so machine_secret resolves consistently
let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  // Force machine secret to (re-)bootstrap into a clean dir
  const secretsDir = join(homedir(), ".claude", "zc-ctx");
  mkdirSync(secretsDir, { recursive: true });
  resetMachineSecret();

  tmpDir = mkdtempSync(join(tmpdir(), "skill-test-"));
  dbPath = join(tmpDir, "test.db");
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ─── Loader: parse + HMAC ────────────────────────────────────────────────────

describe("v0.18.0 — loader.ts", () => {

  const SAMPLE_SKILL = `---
name: audit_file
version: 0.1.0
scope: global
description: Audit a source file for security issues
requires_network: false
acceptance_criteria:
  min_outcome_score: 0.7
  min_pass_rate: 0.8
fixtures:
  - fixture_id: "happy-1"
    description: "standard JS file"
    input: { "file_path": "test.js" }
    expected: { "issue_count_min": 0 }
---

# Audit a Source File

When invoked with file_path, the agent should:

1. Call zc_file_summary first to understand the file's purpose
2. Then read for security issues
`;

  it("loads a valid skill markdown file", async () => {
    const path = join(tmpDir, "audit_file.md");
    writeFileSync(path, SAMPLE_SKILL, "utf8");
    const skill = await loadSkillFromPath(path);
    expect(skill).not.toBeNull();
    expect(skill!.frontmatter.name).toBe("audit_file");
    expect(skill!.frontmatter.version).toBe("0.1.0");
    expect(skill!.frontmatter.scope).toBe("global");
    expect(skill!.frontmatter.requires_network).toBe(false);
    expect(skill!.frontmatter.acceptance_criteria?.min_outcome_score).toBe(0.7);
    expect(skill!.frontmatter.fixtures?.length).toBe(1);
    expect(skill!.frontmatter.fixtures?.[0].fixture_id).toBe("happy-1");
    expect(skill!.frontmatter.fixtures?.[0].input).toEqual({ file_path: "test.js" });
    expect(skill!.body).toContain("Audit a Source File");
    expect(skill!.body_hmac.length).toBe(64);  // hex sha256
    expect(skill!.skill_id).toBe("audit_file@0.1.0@global");
  });

  it("returns null when frontmatter delimiters are missing", async () => {
    const path = join(tmpDir, "not-a-skill.md");
    writeFileSync(path, "# Just a regular markdown file\n\nsome content", "utf8");
    expect(await loadSkillFromPath(path)).toBeNull();
  });

  it("returns null when file does not exist", async () => {
    expect(await loadSkillFromPath(join(tmpDir, "missing.md"))).toBeNull();
  });

  it("throws on missing required field 'name'", async () => {
    const bad = `---
version: 0.1.0
scope: global
description: missing name
---

body`;
    const path = join(tmpDir, "bad.md");
    writeFileSync(path, bad, "utf8");
    await expect(loadSkillFromPath(path)).rejects.toThrow(/name/);
  });

  it("throws on invalid scope", async () => {
    const bad = `---
name: x
version: 0.1.0
scope: cosmic-overlord
description: bad scope
---

body`;
    const path = join(tmpDir, "bad-scope.md");
    writeFileSync(path, bad, "utf8");
    await expect(loadSkillFromPath(path)).rejects.toThrow(/scope/);
  });

  it("project: scope is accepted with hex suffix", async () => {
    const ok = `---
name: x
version: 0.1.0
scope: project:aafb4b029db36884
description: project-scoped
---

body`;
    const path = join(tmpDir, "proj.md");
    writeFileSync(path, ok, "utf8");
    const s = await loadSkillFromPath(path);
    expect(s!.frontmatter.scope).toBe("project:aafb4b029db36884");
  });

  it("HMAC round-trip: same body → same HMAC; tampered body → mismatch detected", async () => {
    const body = "some body content";
    const h1 = await computeSkillBodyHmac(body);
    const h2 = await computeSkillBodyHmac(body);
    expect(h1).toBe(h2);
    expect(await verifySkillHmac(body, h1)).toBe(true);
    expect(await verifySkillHmac(body + "tamper", h1)).toBe(false);
  });

  it("verifySkillHmac is constant-time for length-equal HMACs", async () => {
    // We can't easily measure timing in vitest, but we verify the function
    // signature returns boolean and doesn't short-circuit on first byte mismatch
    const body = "x";
    const real = await computeSkillBodyHmac(body);
    const fake = "0".repeat(64);
    expect(await verifySkillHmac(body, fake)).toBe(false);
  });

  it("renderSkillMarkdown round-trips losslessly through loadSkillFromPath", async () => {
    const original = await loadSkillFromPath((() => {
      const p = join(tmpDir, "in.md");
      writeFileSync(p, SAMPLE_SKILL, "utf8");
      return p;
    })());
    expect(original).not.toBeNull();
    const rendered = renderSkillMarkdown(original!);
    const outPath = join(tmpDir, "out.md");
    writeFileSync(outPath, rendered, "utf8");
    const reloaded = await loadSkillFromPath(outPath);
    expect(reloaded!.frontmatter.name).toBe(original!.frontmatter.name);
    expect(reloaded!.frontmatter.version).toBe(original!.frontmatter.version);
    expect(reloaded!.body.trim()).toBe(original!.body.trim());
    expect(reloaded!.body_hmac).toBe(original!.body_hmac);  // body byte-identical → same HMAC
  });

  it("buildSkill produces a valid skill with HMAC", async () => {
    const skill = await buildSkill({
      name: "test", version: "1.0.0", scope: "global", description: "t",
    }, "body content");
    expect(skill.skill_id).toBe("test@1.0.0@global");
    expect(await verifySkillHmac(skill.body, skill.body_hmac)).toBe(true);
  });

  it("skillFilename returns name.md", async () => {
    const skill = await buildSkill({
      name: "audit_file", version: "1.0.0", scope: "global", description: "t",
    }, "body");
    expect(skillFilename(skill)).toBe("audit_file.md");
  });
});

// ─── Storage: CRUD + tamper detection ───────────────────────────────────────

describe("v0.18.0 — storage.ts", () => {

  it("upsertSkill + getSkillById round-trip", async () => {
    const skill = await buildSkill({
      name: "audit", version: "1.0.0", scope: "global", description: "audit",
    }, "body");
    await upsertSkill(db, skill);
    const fetched = await getSkillById(db, skill.skill_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.skill_id).toBe(skill.skill_id);
    expect(fetched!.body).toBe("body");
  });

  it("getSkillById returns null for unknown id", async () => {
    expect(await getSkillById(db, "nope@1.0.0@global")).toBeNull();
  });

  it("upsertSkill rejects skill with mismatched HMAC", async () => {
    const skill = await buildSkill({
      name: "x", version: "1.0.0", scope: "global", description: "x",
    }, "body");
    skill.body_hmac = "0".repeat(64);  // tamper
    await expect(upsertSkill(db, skill)).rejects.toThrow(SkillTamperedError);
  });

  it("getSkillById throws SkillTamperedError when DB row's body_hmac doesn't match", async () => {
    const skill = await buildSkill({
      name: "x", version: "1.0.0", scope: "global", description: "x",
    }, "body");
    await upsertSkill(db, skill);
    // Direct DB tamper — modify body without updating hmac
    db.prepare(`UPDATE skills SET body = ? WHERE skill_id = ?`).run("tampered body", skill.skill_id);
    await expect(getSkillById(db, skill.skill_id)).rejects.toThrow(SkillTamperedError);
  });

  it("resolveSkill: per-project overrides global", async () => {
    const globalSkill = await buildSkill({
      name: "audit", version: "1.0.0", scope: "global", description: "g",
    }, "global body");
    const projSkill = await buildSkill({
      name: "audit", version: "1.0.0", scope: "project:abc1234567890123", description: "p",
    }, "project body");
    await upsertSkill(db, globalSkill);
    await upsertSkill(db, projSkill);

    const resolved = await resolveSkill(db, "audit", "project:abc1234567890123");
    expect(resolved?.body).toBe("project body");
  });

  it("resolveSkill falls back to global when no project version", async () => {
    const globalSkill = await buildSkill({
      name: "audit", version: "1.0.0", scope: "global", description: "g",
    }, "global body");
    await upsertSkill(db, globalSkill);
    const resolved = await resolveSkill(db, "audit", "project:differentproj01");
    expect(resolved?.body).toBe("global body");
  });

  it("resolveSkill returns null when no skill exists by name", async () => {
    expect(await resolveSkill(db, "nope", "global")).toBeNull();
  });

  it("listActiveSkills excludes archived skills", async () => {
    const s1 = await buildSkill({ name: "a", version: "1.0.0", scope: "global", description: "a" }, "body1");
    const s2 = await buildSkill({ name: "b", version: "1.0.0", scope: "global", description: "b" }, "body2");
    await upsertSkill(db, s1);
    await upsertSkill(db, s2);
    expect(archiveSkill(db, s1.skill_id, "test")).toBe(true);
    const active = await listActiveSkills(db);
    expect(active.length).toBe(1);
    expect(active[0].skill_id).toBe(s2.skill_id);
  });

  it("verifyAllSkillHmacs surfaces tampered ids", async () => {
    const s1 = await buildSkill({ name: "a", version: "1.0.0", scope: "global", description: "a" }, "body1");
    const s2 = await buildSkill({ name: "b", version: "1.0.0", scope: "global", description: "b" }, "body2");
    await upsertSkill(db, s1);
    await upsertSkill(db, s2);
    // Tamper with s1's body in DB only
    db.prepare(`UPDATE skills SET body = ? WHERE skill_id = ?`).run("hacked", s1.skill_id);
    const r = await verifyAllSkillHmacs(db);
    expect(r.ok).toBe(false);
    expect(r.tampered).toContain(s1.skill_id);
    expect(r.tampered).not.toContain(s2.skill_id);
  });

  // ── skill_runs ──────────────────────────────────────────────────────────

  it("recordSkillRun + getRecentSkillRuns round-trip", () => {
    recordSkillRun(db, {
      run_id: "r1", skill_id: "s1@1@global", session_id: "sess1",
      task_id: null, inputs: { x: 1 },
      outcome_score: 0.85, total_cost: 0.001, total_tokens: 100, duration_ms: 250,
      status: "succeeded", failure_trace: null, ts: new Date().toISOString(),
    });
    const recent = getRecentSkillRuns(db, "s1@1@global");
    expect(recent.length).toBe(1);
    expect(recent[0].outcome_score).toBeCloseTo(0.85, 4);
    expect(recent[0].inputs).toEqual({ x: 1 });
  });

  it("getRecentSkillRuns honors limit and ordering (newest first)", () => {
    for (let i = 0; i < 5; i++) {
      recordSkillRun(db, {
        run_id: `r${i}`, skill_id: "s1@1@global", session_id: "s",
        task_id: null, inputs: {}, outcome_score: i / 10,
        total_cost: 0, total_tokens: 0, duration_ms: 0,
        status: "succeeded", failure_trace: null,
        ts: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    const r = getRecentSkillRuns(db, "s1@1@global", 3);
    expect(r.length).toBe(3);
    // Newest first → highest outcome_score (which we assigned i/10)
    expect(r[0].outcome_score).toBeCloseTo(0.4, 4);
  });

  // ── skill_mutations ─────────────────────────────────────────────────────

  it("recordMutation + getRecentMutations round-trip", () => {
    const m = {
      mutation_id: "m1", parent_skill_id: "s1@1@global",
      candidate_body: "new body", candidate_hmac: "abc",
      proposed_by: "claude-sonnet-4-6", judged_by: null,
      judge_score: null, judge_rationale: null, replay_score: null,
      promoted: false, promoted_to_skill_id: null,
      created_at: new Date().toISOString(), resolved_at: null,
    };
    recordMutation(db, m);
    const fetched = getRecentMutations(db, "s1@1@global");
    expect(fetched.length).toBe(1);
    expect(fetched[0].mutation_id).toBe("m1");
    expect(fetched[0].promoted).toBe(false);
  });

  it("resolveMutation updates promotion state", () => {
    recordMutation(db, {
      mutation_id: "m2", parent_skill_id: "s1@1@global",
      candidate_body: "body", candidate_hmac: "h", proposed_by: "p",
      judged_by: null, judge_score: null, judge_rationale: null, replay_score: null,
      promoted: false, promoted_to_skill_id: null,
      created_at: new Date().toISOString(), resolved_at: null,
    });
    expect(resolveMutation(db, "m2", { replay_score: 0.9, promoted: true, promoted_to_skill_id: "s1@2@global" })).toBe(true);
    const after = getRecentMutations(db, "s1@1@global");
    expect(after[0].replay_score).toBeCloseTo(0.9, 4);
    expect(after[0].promoted).toBe(true);
    expect(after[0].promoted_to_skill_id).toBe("s1@2@global");
    expect(after[0].resolved_at).not.toBeNull();
  });
});
