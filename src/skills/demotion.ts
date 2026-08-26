/**
 * Live-outcome demotion (v0.61.0 — mutation engine M3d)
 * =======================================================
 *
 * The operator's anti-Goodhart backstop: fixtures and judges are pre-filters,
 * REAL run outcomes are the truth. After an operator-approved promotion, the
 * new version's live scores are compared against the parent's historical
 * baseline once enough runs accumulate. A regression triggers ROLLBACK TO THE
 * PARENT BODY — restoring a previously operator-approved state, which is why
 * this one autonomous write is principled: it returns to known-good, it never
 * advances state. ZC_AUTO_DEMOTE=0 downgrades it to an operator-inbox
 * advisory (inform-only).
 *
 * Called from the skill-outcome recording path (same hook point as the L1
 * mutation trigger): cheap no-op unless the skill is a recent promotion with
 * enough post-promotion runs.
 */
import type { DatabaseSync } from "node:sqlite";
import { getSkillById, getRecentSkillRuns, archiveSkill } from "./storage_dual.js";
import { aggregateScore } from "./scoring.js";

export interface DemotionCheckResult {
  checked:    boolean;
  regressed?: boolean;
  action?:    "rolled_back" | "advisory_only" | "none";
  detail?:    string;
}

const MIN_POST_RUNS   = parseInt(process.env["ZC_DEMOTE_MIN_RUNS"] ?? "", 10) || 5;
const REGRESSION_GAP  = parseFloat(process.env["ZC_DEMOTE_GAP"] ?? "") || 0.1;

/**
 * Check one skill for post-promotion regression. Never throws.
 * `name` + `scope` identify the active version; lineage is followed via
 * frontmatter.promoted_from → mutation result → parent skill row.
 */
export async function checkPromotionRegression(
  db: DatabaseSync,
  skillId: string,
): Promise<DemotionCheckResult> {
  try {
    const current = await getSkillById(db, skillId);
    if (!current) return { checked: false, detail: "skill not found" };
    // Lineage lives in the column when set by buildSkill, or in frontmatter
    // when the row was rebuilt from the file at re-admission (the normal
    // post-approval path — writeSkillBody stamps it there).
    const promotedFrom = current.promoted_from
      ?? ((current.frontmatter as { promoted_from?: string }).promoted_from ?? null);
    if (!promotedFrom) return { checked: false, detail: "not a promotion" };

    // Post-promotion live runs of the NEW version.
    const newRuns = await getRecentSkillRuns(db, current.skill_id, 20);
    const scored = newRuns.filter((r) => r.outcome_score !== null);
    if (scored.length < MIN_POST_RUNS) {
      return { checked: true, regressed: false, action: "none", detail: `only ${scored.length}/${MIN_POST_RUNS} post-promotion runs — too early` };
    }
    const newAvg = aggregateScore(scored).avg_score;

    // Parent baseline: the archived predecessor's run history. Find it by
    // name+scope among archived versions (the promotion archived exactly one).
    const name  = (current.frontmatter as { name?: string }).name ?? "";
    const scope = (current.frontmatter as { scope?: string }).scope ?? "global";
    const parentId = await findArchivedPredecessorId(db, name, scope, current.skill_id);
    if (!parentId) return { checked: true, regressed: false, action: "none", detail: "no archived predecessor found" };
    const parentRuns = (await getRecentSkillRuns(db, parentId, 50)).filter((r) => r.outcome_score !== null);
    if (parentRuns.length < 3) return { checked: true, regressed: false, action: "none", detail: "parent has too little history to compare" };
    const parentAvg = aggregateScore(parentRuns).avg_score;

    if (newAvg >= parentAvg - REGRESSION_GAP) {
      return { checked: true, regressed: false, action: "none", detail: `holding: new ${newAvg.toFixed(2)} vs parent ${parentAvg.toFixed(2)}` };
    }

    // REGRESSION. Roll back to the parent body (known-good) unless disabled.
    const detailBase = `live regression: ${current.skill_id} avg ${newAvg.toFixed(2)} over ${scored.length} runs vs parent ${parentAvg.toFixed(2)} (gap ${REGRESSION_GAP})`;
    if (process.env["ZC_AUTO_DEMOTE"] === "0") {
      await inboxAdvisory(`AUTO-DEMOTE (advisory only, ZC_AUTO_DEMOTE=0): ${detailBase}. Recommend rolling back to ${parentId}.`);
      return { checked: true, regressed: true, action: "advisory_only", detail: detailBase };
    }

    const parent = await getSkillById(db, parentId);
    const skillDir = (current as { skill_dir?: string | null }).skill_dir ?? null;
    if (!parent || !skillDir) {
      await inboxAdvisory(`AUTO-DEMOTE BLOCKED (no parent body or skill_dir): ${detailBase}. Manual rollback needed.`);
      return { checked: true, regressed: true, action: "advisory_only", detail: detailBase + " — rollback blocked, advisory sent" };
    }
    const { writeSkillBody, reAdmitSkillDir } = await import("./skill_file_writer.js");
    const bump = bumpPatchLocal((current.frontmatter as { version?: string }).version ?? "0.0.0");
    const written = writeSkillBody(skillDir, parent.body, { version: bump });
    const readmit = await reAdmitSkillDir(skillDir);
    if (!readmit.readmitted) {
      // File is rolled back but no new row was admitted. Do NOT archive the
      // current row — leave state visibly inconsistent (HMAC mismatch blocks
      // the skill) and tell the operator, rather than silently vanishing it.
      await inboxAdvisory(`AUTO-DEMOTE PARTIAL: ${detailBase}. SKILL.md was rolled back to the parent body (backup: ${written.backupPath}) but re-admission FAILED: ${readmit.reason}. The skill is blocked until re-imported; fix the file or restore the backup.`);
      return { checked: true, regressed: true, action: "advisory_only", detail: `${detailBase} — rollback written but re-admission failed: ${readmit.reason}` };
    }
    await archiveSkill(db, current.skill_id, `auto-demoted: live regression (${detailBase})`);
    await inboxAdvisory(`AUTO-DEMOTED ${current.skill_id} → rolled back to parent body as v${bump}. ${detailBase}. This restores the previously operator-approved version; review at leisure.`);
    return { checked: true, regressed: true, action: "rolled_back", detail: detailBase };
  } catch (e) {
    return { checked: false, detail: `demotion check error: ${(e as Error).message.slice(0, 200)}` };
  }
}

async function findArchivedPredecessorId(db: DatabaseSync, name: string, scope: string, excludeId: string): Promise<string | null> {
  try {
    const { withClient } = await import("../pg_pool.js");
    const row = await withClient(async (c) => {
      const r = await c.query<{ skill_id: string }>(
        `SELECT skill_id FROM skills_pg
          WHERE name = $1 AND scope = $2 AND archived_at IS NOT NULL AND skill_id <> $3
          ORDER BY archived_at DESC LIMIT 1`,
        [name, scope, excludeId]);
      return r.rows[0] ?? null;
    });
    if (row) return row.skill_id;
  } catch { /* fall through to SQLite */ }
  try {
    const r = db.prepare(
      `SELECT skill_id FROM skills WHERE json_extract(frontmatter,'$.name') = ? AND archived_at IS NOT NULL AND skill_id <> ? ORDER BY archived_at DESC LIMIT 1`,
    ).get(name, excludeId) as { skill_id: string } | undefined;
    return r?.skill_id ?? null;
  } catch { return null; }
}

function bumpPatchLocal(v: string): string {
  const parts = v.split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join(".");
}

async function inboxAdvisory(text: string): Promise<void> {
  try {
    const { createInboxEntry } = await import("../operator_inbox.js");
    await createInboxEntry({
      projectPath: process.env["ZC_PROJECT_PATH"] ?? "global",
      question: text,
      projectHash: "",
      broadcastId: null,
      fromAgent: "mutation-engine",
    });
  } catch { /* advisory is best-effort — the demotion result still reports it */ }
}
