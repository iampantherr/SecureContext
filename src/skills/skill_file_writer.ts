/**
 * Write an approved skill change back to the FILE (v0.55.0)
 * =========================================================
 *
 * Skills are owned by ~/.claude/skills/<name>/SKILL.md. Before this module the
 * mutation-approval path called upsertSkill(), which inserts a Postgres row —
 * and `upsertSkill` never sets skill_dir, so every approved mutation minted an
 * orphan: a skill row with a body and no file behind it. The operator approved a
 * change and the file on disk never moved.
 *
 * That also broke the security model. The PreToolUse runner verifies the file on
 * disk against the admission HMAC. A change that lives only in Postgres is a
 * change the runner cannot see, and a change to the file that Postgres does not
 * know about is a HMAC mismatch that blocks the skill.
 *
 * So an approval must do exactly two things, in this order:
 *   1. write the new body into SKILL.md (atomically, keeping a backup)
 *   2. re-admit the directory so the stored HMAC matches the new file
 *
 * Anything that cannot do both must fail loudly rather than fall back to a row.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/** Frontmatter fields we round-trip. Unknown keys are preserved verbatim. */
export interface SkillFrontmatterLike {
  name:        string;
  description: string;
  version?:    string;
  [k: string]: unknown;
}

export interface WriteResult {
  skillMdPath: string;
  backupPath:  string;
  bytesBefore: number;
  bytesAfter:  number;
}

/**
 * Serialize frontmatter + body into the exact shape parseFrontmatter expects:
 * `---\n<yaml>\n---\n<body>`.
 *
 * Values containing a newline are emitted as a `|` literal block, because the
 * parser understands block scalars and a raw newline inside a scalar would
 * silently truncate the field.
 */
export function serializeSkillMd(fm: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    } else if (typeof v === "object") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      const s = String(v);
      if (s.includes("\n")) {
        lines.push(`${k}: |`);
        for (const l of s.split("\n")) lines.push(`  ${l}`);
      } else {
        lines.push(`${k}: ${s}`);
      }
    }
  }
  lines.push("---");
  // Exactly one newline between the closing delimiter and the body, matching
  // the parser's `slice(end + 5)`.
  return lines.join("\n") + "\n" + body.replace(/^\n+/, "");
}

/**
 * Replace a skill's body on disk, preserving its frontmatter (with an optional
 * version bump), keeping a timestamped backup, and writing atomically.
 *
 * Throws — deliberately — when the directory or SKILL.md is missing. A silent
 * fallback here is what produced 28 orphan rows.
 */
export function writeSkillBody(
  skillDir: string,
  newBody: string,
  opts: { version?: string; stamp?: string } = {},
): WriteResult {
  if (!skillDir) {
    throw new Error("writeSkillBody: skill_dir is empty — this skill has no file to write. " +
                    "Skills are owned by the filesystem; refusing to create a Postgres-only copy.");
  }
  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(`writeSkillBody: ${skillMdPath} does not exist — refusing to invent a skill file.`);
  }

  const before = readFileSync(skillMdPath, "utf8");
  const norm = before.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) {
    throw new Error(`writeSkillBody: ${skillMdPath} has no frontmatter delimiter; refusing to rewrite it.`);
  }
  const end = norm.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`writeSkillBody: ${skillMdPath} has no closing frontmatter delimiter.`);
  }

  // Keep the original frontmatter text and only touch `version`, so hand-authored
  // formatting, comments and unknown keys survive an approval untouched.
  let fmText = norm.slice(4, end);
  if (opts.version) {
    fmText = /^version\s*:/m.test(fmText)
      ? fmText.replace(/^version\s*:.*$/m, `version: ${opts.version}`)
      : `${fmText}\nversion: ${opts.version}`;
  }

  const next = `---\n${fmText}\n---\n${newBody.replace(/^\n+/, "")}`;

  // Backup first: an operator must be able to undo an approval by hand.
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${skillMdPath}.bak-${stamp}`;
  copyFileSync(skillMdPath, backupPath);

  // Atomic: write a sibling temp then rename, so a crash mid-write cannot leave
  // a half-written SKILL.md that fails frontmatter parsing and quarantines the skill.
  const tmp = `${skillMdPath}.tmp-${stamp}`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, skillMdPath);

  return {
    skillMdPath,
    backupPath,
    bytesBefore: Buffer.byteLength(before, "utf8"),
    bytesAfter:  Buffer.byteLength(next, "utf8"),
  };
}

/**
 * Re-admit one skill directory: re-parse the file, recompute the HMACs, and
 * refresh the admission row so the PreToolUse runner verifies against what is
 * now on disk.
 *
 * MUST run after writeSkillBody. Skipping it leaves the stored HMAC pointing at
 * the previous body, and the runner — correctly — blocks every script in the
 * skill as tampered.
 */
export async function reAdmitSkillDir(skillDir: string): Promise<{ readmitted: boolean; reason?: string }> {
  try {
    const { parseFsSkill, importFilesystemSkills } = await import("./filesystem_skill_import.js");

    // Parse first: if the freshly written file does not parse, re-admitting would
    // quarantine the skill. Better to report it while the backup is still fresh.
    const parsed = await parseFsSkill(skillDir);
    if (parsed.parse_error) {
      return { readmitted: false, reason: `parse failed after write: ${parsed.parse_error}` };
    }

    // importFilesystemSkills takes a ROOT that CONTAINS skill directories, not a
    // single skill directory — so the root is this directory's parent. An earlier
    // version passed { roots: [skillDir], singleDir: true }, options that do not
    // exist; the call type-checked only because of an `as never` cast and would
    // have re-admitted nothing while reporting success.
    //
    // Re-importing the whole root is idempotent (unchanged skills report
    // skipped_same) and reuses the tested admission path rather than duplicating
    // the HMAC write here.
    const root = skillDir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
    if (!root || root === skillDir) {
      return { readmitted: false, reason: `cannot derive skills root from ${skillDir}` };
    }
    const summary = await importFilesystemSkills({ globalRoot: root });
    if (summary.scanned === 0) {
      return { readmitted: false, reason: `admission scan found no skills under ${root}` };
    }
    return { readmitted: true };
  } catch (e) {
    return { readmitted: false, reason: (e as Error).message };
  }
}
