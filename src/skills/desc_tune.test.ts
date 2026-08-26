/**
 * v0.62.0 M6 — description-tune tests: prompt branches, the forced judge-only
 * cycle with the DESC-TUNE headline contract, deterministic over-limit
 * enforcement, and writeSkillDescription edge cases (single-line, block
 * scalar, multiline replacement, over-limit refusal, body integrity).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runMutationCycle } from "./orchestrator.js";
import { buildProposerPrompt, type Mutator } from "./mutator.js";
import { buildJudgePrompt } from "./judge.js";
import { writeSkillDescription, dirToMarker, applyDescTune } from "./skill_file_writer.js";
import { buildSkill } from "./loader.js";
import { upsertSkill, getRecentMutations } from "./storage.js";
import { runMigrations } from "../migrations.js";
import { _resetCacheForTesting as resetMachineSecret } from "../security/machine_secret.js";
import type { MutationContext, Skill } from "./types.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  mkdirSync(join(homedir(), ".claude", "zc-ctx"), { recursive: true });
  resetMachineSecret();
  tmpDir = mkdtempSync(join(tmpdir(), "desctune-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

async function makeParent(desc = "Use when auditing source files for security and style problems in any project."): Promise<Skill> {
  return buildSkill(
    { name: "audit", version: "1.0.0", scope: "global", description: desc },
    "# Audit\n\nWhen invoked, audit the file and return findings.\n## Steps\n1. Validate input\n2. Run the audit\n3. Return findings\n",
  );
}

function mockDescMutator(bodies: string[]): Mutator {
  return {
    id: "mock-desc",
    mutate: async (_ctx: MutationContext) => ({
      candidates: bodies.map((b, i) => ({ candidate_body: b, rationale: `desc variant ${i}`, self_rated_score: 0.8 - i * 0.05 })),
      proposer_model: "mock-desc",
      total_cost_usd: 0,
    }),
  } as unknown as Mutator;
}

describe("M6 — prompt branches", () => {
  it("proposer prompt flips to description-rewrite mission with the 1024 limit", async () => {
    const parent = await makeParent();
    const ctx = { parent, recent_runs: [], failure_traces: [], fixtures: [], description_tune: true } as unknown as MutationContext;
    const p = buildProposerPrompt(ctx);
    expect(p).toMatch(/rewriting the DESCRIPTION/);
    expect(p).toMatch(/1024/);
    expect(p).toMatch(/replacement DESCRIPTION TEXT ONLY/);
    expect(p).not.toMatch(/full replacement for the parent body/);
  });

  it("judge prompt uses the description rubric with the over-limit hard rule", async () => {
    const parent = await makeParent();
    const ctx = { parent, recent_runs: [], failure_traces: [], fixtures: [], description_tune: true } as unknown as MutationContext;
    const p = buildJudgePrompt(ctx, [{ candidate_body: "Use when X.", rationale: "r", self_rated_score: 0.8 }]);
    expect(p).toMatch(/DESCRIPTION rewrites/);
    expect(p).toMatch(/Over 1024 characters/);
    expect(p).not.toMatch(/proposed replacement body/);
  });
});

describe("M6 — desc-tune cycle", () => {
  it("forces judge-only, queues with the DESC-TUNE headline contract", async () => {
    process.env.ZC_JUDGE_ONLY_MIN = "0.5";
    try {
      const parent = await makeParent();
      await upsertSkill(db, parent);
      const r = await runMutationCycle(db, parent, {
        mutator: mockDescMutator(["Use when auditing source files; covers security and style findings.", "Audit skill: security + style checks on demand."]),
        description_tune: true,
      });
      expect(r.promoted).toBe(false);
      expect(r.pending_result_id).toMatch(/^mres-/);
      expect(r.reason).toMatch(/JUDGE-ONLY/);
      const { fetchByResultId } = await import("./mutation_results.js");
      const row = await fetchByResultId(db, r.pending_result_id!);
      expect(row?.headline).toMatch(/^DESC-TUNE /);
      // desc-tune skips the uplift A/B entirely
      expect(r.uplift).toBeUndefined();
    } finally { delete process.env.ZC_JUDGE_ONLY_MIN; }
  });

  it("even a fixture-carrying parent skips replay in desc-tune mode", async () => {
    process.env.ZC_JUDGE_ONLY_MIN = "0.5";
    try {
      const parent = await buildSkill(
        { name: "audit", version: "1.0.0", scope: "global",
          description: "Use when auditing source files for security and style problems.",
          fixtures: [{ fixture_id: "f1", description: "d", input: { x: 1 }, expected: { ok: true } }] },
        "# Audit\n\nAudit the file.\n## Steps\n1. Validate\n2. Audit\n3. Report\n",
      );
      await upsertSkill(db, parent);
      const r = await runMutationCycle(db, parent, {
        mutator: mockDescMutator(["Use when auditing source files; security and style."]),
        description_tune: true,
      });
      // If replay had run, the reason would name replay/baseline; judge-only proves fixtures were ignored.
      expect(r.reason).toMatch(/JUDGE-ONLY/);
    } finally { delete process.env.ZC_JUDGE_ONLY_MIN; }
  });

  it("over-limit candidates are deterministically overfit-capped and never win", async () => {
    process.env.ZC_JUDGE_ONLY_MIN = "0.5";
    try {
      const over = "Use when auditing. " + "x".repeat(1100);   // > 1024 — mock self-rates it HIGHEST
      const under = "Use when auditing source files for security and style problems (concise).";
      const parent = await makeParent();
      await upsertSkill(db, parent);
      const mutator: Mutator = {
        id: "mock-desc",
        mutate: async () => ({
          candidates: [
            { candidate_body: over,  rationale: "verbose", self_rated_score: 0.95 },
            { candidate_body: under, rationale: "tight",   self_rated_score: 0.80 },
          ],
          proposer_model: "mock-desc", total_cost_usd: 0,
        }),
      } as unknown as Mutator;
      const r = await runMutationCycle(db, parent, { mutator, description_tune: true });
      expect(r.pending_result_id).toMatch(/^mres-/);
      const muts = getRecentMutations(db, parent.skill_id, 10);
      const overRow = muts.find((m) => m.candidate_body === over);
      expect(overRow?.judge_rationale).toMatch(/\[OVER-LIMIT\]/);
      expect(overRow?.judge_score ?? 1).toBeLessThanOrEqual(0.2);
      // the queued bundle excludes overfit candidates → winner is the under-limit one
      const { fetchByResultId } = await import("./mutation_results.js");
      const row = await fetchByResultId(db, r.pending_result_id!);
      expect(row?.bodies[0].candidate_body).toBe(under);
      expect(row?.bodies.some((b) => b.candidate_body === over)).toBe(false);
    } finally { delete process.env.ZC_JUDGE_ONLY_MIN; }
  });
});

describe("M6 — writeSkillDescription edge cases", () => {
  function makeSkillDir(fmAndBody: string): string {
    const dir = join(tmpDir, `sk-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), fmAndBody, "utf8");
    return dir;
  }

  it("replaces a single-line description, bumps version, stamps lineage, keeps body byte-identical", () => {
    const body = "# Body\n\nUnchanged content with trailing newline.\n";
    const dir = makeSkillDir(`---\nname: x\ndescription: old one-liner\nversion: 1.0.0\nscope: global\n---\n${body}`);
    writeSkillDescription(dir, "new tight description", { version: "1.0.1", promoted_from: "mres-test" });
    const after = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(after).toMatch(/^description: new tight description$/m);
    expect(after).not.toMatch(/old one-liner/);
    expect(after).toMatch(/^version: 1.0.1$/m);
    expect(after).toMatch(/^promoted_from: mres-test$/m);
    expect(after.endsWith(`---\n${body}`)).toBe(true);
  });

  it("swallows a folded block-scalar description entirely (no orphan lines)", () => {
    const dir = makeSkillDir([
      "---", "name: x", "description: >-", "  long folded line one", "", "  and paragraph two", "version: 1.0.0", "scope: global", "---", "body text here", "",
    ].join("\n"));
    writeSkillDescription(dir, "replacement", { version: "1.0.1" });
    const after = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(after).toMatch(/^description: replacement$/m);
    expect(after).not.toMatch(/folded line one|paragraph two/);
    expect(after).toMatch(/^version: 1.0.1$/m);   // key AFTER the block survives
    expect(after).toMatch(/body text here/);
  });

  it("multiline replacement is emitted as a literal block the parser round-trips", async () => {
    const dir = makeSkillDir(`---\nname: x\ndescription: old\nversion: 1.0.0\nscope: global\n---\nbody\n`);
    writeSkillDescription(dir, "line one\nline two");
    const { parseFsSkill } = await import("./filesystem_skill_import.js");
    const p = await parseFsSkill(dir);
    expect(p.parse_error).toBeNull();
    expect(p.fm.description).toBe("line one\nline two");
  });

  it("refuses an over-limit replacement outright (file untouched)", () => {
    const dir = makeSkillDir(`---\nname: x\ndescription: old\nversion: 1.0.0\nscope: global\n---\nbody\n`);
    const before = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(() => writeSkillDescription(dir, "y".repeat(1025))).toThrow(/1024/);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(before);
  });

  it("throws on a frontmatter without a description key", () => {
    const dir = makeSkillDir(`---\nname: x\nversion: 1.0.0\nscope: global\n---\nbody\n`);
    expect(() => writeSkillDescription(dir, "anything")).toThrow(/no description key/);
  });
});

describe("M6 — dir markers + applyDescTune edge cases", () => {
  it("dirToMarker classifies skills / quarantine / custom roots (both slash styles)", () => {
    expect(dirToMarker("C:\\Users\\x\\.claude\\skills\\my-skill")).toBe("skills:my-skill");
    expect(dirToMarker("/home/u/.claude/skills.quarantine/my-skill__2026")).toBe("quarantine:my-skill__2026");
    expect(dirToMarker("C:/Users/x/.claude/skills/my-skill/")).toBe("skills:my-skill");
    expect(dirToMarker("C:\\somewhere\\else\\dir")).toBe("abs:C:\\somewhere\\else\\dir");
    expect(dirToMarker(null)).toBeNull();
    expect(dirToMarker("")).toBeNull();
  });

  it("refuses a marker containing path separators (traversal defense)", async () => {
    await expect(applyDescTune({ dirMarker: "skills:../../etc", description: "d", resultId: "mres-t" }))
      .rejects.toThrow(/path separators/);
    await expect(applyDescTune({ dirMarker: "quarantine:a/b", description: "d", resultId: "mres-t" }))
      .rejects.toThrow(/path separators/);
  });

  it("refuses an unrecognized marker scheme and an unresolvable dir", async () => {
    await expect(applyDescTune({ dirMarker: "ftp:whatever", description: "d", resultId: "mres-t" }))
      .rejects.toThrow(/unrecognized dir marker/);
    await expect(applyDescTune({ dirMarker: null, fallbackDir: join(tmpDir, "does-not-exist"), description: "d", resultId: "mres-t" }))
      .rejects.toThrow(/not resolvable/);
    await expect(applyDescTune({ dirMarker: null, fallbackDir: null, description: "d", resultId: "mres-t" }))
      .rejects.toThrow(/not resolvable/);
  });

  it("abs: marker on a non-quarantine dir rewrites in place, bumps version from the FILE", async () => {
    const dir = join(tmpDir, "abs-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: abs-skill\ndescription: old words\nversion: 2.3.7\nscope: global\n---\n# Body\n\nStays.\n`, "utf8");
    // Non-quarantine path re-admits via importFilesystemSkills against the
    // PARENT dir — tmpDir contains only skill dirs, so this is safe here and
    // exercises the real re-admission call. It may fail on lint (short body)
    // — that failure mode must SURFACE, not pass silently.
    let threw = null;
    try {
      await applyDescTune({ dirMarker: `abs:${dir}`, description: "new tight words", resultId: "mres-abs" });
    } catch (e) { threw = e; }
    const after = readFileSync(join(dir, "SKILL.md"), "utf8");
    // Whatever re-admission decided, the FILE write semantics must hold:
    expect(after).toMatch(/^description: new tight words$/m);
    expect(after).toMatch(/^version: 2.3.8$/m);
    expect(after).toMatch(/^promoted_from: mres-abs$/m);
    expect(after).toMatch(/Stays\./);
    if (threw) expect(String(threw)).toMatch(/re-admission failed/);
  });

  it("quarantine restore: copies to the clean name, refuses on collision", async () => {
    // Build a fake HOME layout inside tmpDir? applyDescTune resolves against
    // the real homedir for named markers — so exercise the collision arm via
    // fallbackDir carrying a skills.quarantine path (quarantine detection is
    // path-based for fallback dirs too).
    const quarRoot = join(tmpDir, ".claude", "skills.quarantine");
    const quarDir = join(quarRoot, "resto-skill__stamp");
    mkdirSync(quarDir, { recursive: true });
    writeFileSync(join(quarDir, "SKILL.md"),
      `---\nname: resto-skill\ndescription: ${"x".repeat(1100)}\nversion: 1.0.0\nscope: global\n---\nbody\n`, "utf8");
    // Force the COLLISION arm deterministically: pre-create the restore
    // target in the real skills root, expect the loud refusal (which fires
    // BEFORE any write to the real root), then remove the placeholder. This
    // keeps the test from actually admitting anything into the live root.
    const { homedir } = await import("node:os");
    const target = join(homedir(), ".claude", "skills", "resto-skill");
    expect(existsSync(target)).toBe(false);   // guard: never clobber a real skill
    mkdirSync(target, { recursive: true });
    try {
      await expect(applyDescTune({ dirMarker: null, fallbackDir: quarDir, description: "fixed short description", resultId: "mres-q" }))
        .rejects.toThrow(/already exists/);
      // The quarantine-file write half still happened (description fixed in place):
      const after = readFileSync(join(quarDir, "SKILL.md"), "utf8");
      expect(after).toMatch(/^description: fixed short description$/m);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
