/**
 * v0.19.0 Step 3 — Skill candidate detector (Option D, MVP).
 *
 * The bootstrap loop's missing piece. The skill mutator can only IMPROVE
 * existing skills. When a role has NO skill governing the rejected
 * behavior, the mutator has nothing to mutate. This detector watches
 * orchestrator REJECT outcomes (recorded by outcomes_reject_resolver.ts)
 * and clusters them: if N+ rejections target the same role and no
 * existing skill has `intended_roles` containing that role + tags
 * matching the rejection theme, queue a `skill_candidate` row for
 * operator review.
 *
 * Conservative defaults (tunable via env):
 *   ZC_SKILL_CANDIDATE_MIN_REJECTS = 3   (need ≥3 rejections to propose)
 *   ZC_SKILL_CANDIDATE_WINDOW_DAYS = 7   (cluster within trailing N days)
 *   ZC_SKILL_CANDIDATE_COOLDOWN_HRS = 12 (don't re-propose for same role
 *                                          within N hours after a previous
 *                                          candidate was created)
 *
 * Detection runs on the API server's snapshotter tick so it's cheap and
 * cooldown-gated. v0.19.0 ships with the detector + storage; the LLM
 * "Generate skill body" action lands in v0.20.0.
 *
 * The detector does NOT generate skill bodies — it just identifies
 * gaps and queues them. The dashboard panel shows pending candidates;
 * the operator chooses to draft + approve.
 */

import { withClient } from "./pg_pool.js";
import { logger } from "./logger.js";
import { randomBytes } from "node:crypto";

const MIN_REJECTS         = parseInt(process.env.ZC_SKILL_CANDIDATE_MIN_REJECTS    ?? "3",  10);
const WINDOW_DAYS         = parseInt(process.env.ZC_SKILL_CANDIDATE_WINDOW_DAYS    ?? "7",  10);
const COOLDOWN_HOURS      = parseInt(process.env.ZC_SKILL_CANDIDATE_COOLDOWN_HRS   ?? "12", 10);

/**
 * Find roles that have ≥ MIN_REJECTS rejections in the trailing window
 * AND no skill candidate (status in ('pending','generating','ready'))
 * proposed for them in the cooldown window.
 *
 * Identifies "role" via the rejected agent's role string in the evidence
 * JSON. The orchestrator REJECT broadcast goes against an agent_id like
 * 'developer' or 'marketer-1'; we strip the trailing -N to get the role.
 */
interface ClusterCandidate {
  target_role:         string;
  project_hash:        string;
  count:               number;
  first_at:            string;
  last_at:             string;
  outcomes:            { id: number; ref_id: string; evidence: Record<string, unknown> }[];
}

async function findClusterCandidates(): Promise<ClusterCandidate[]> {
  return await withClient(async (c) => {
    const rejectionRows = await c.query<{
      id: number; ref_id: string; resolved_at: string; evidence: Record<string, unknown>;
    }>(
      `SELECT o.id, o.ref_id, o.resolved_at, o.evidence
         FROM outcomes_pg o
        WHERE o.outcome_kind  = 'rejected'
          AND o.signal_source = 'orchestrator_reject'
          AND o.resolved_at  > now() - ($1::int || ' days')::interval
        ORDER BY o.resolved_at DESC`,
      [WINDOW_DAYS],
    );

    // Group by (role, project_hash). project_hash isn't on outcomes_pg yet
    // (v0.20+ task to add it via migration), so for v0.19 we parse it from
    // the rejected_agent or fall back to all-projects.
    const byRoleAndProject = new Map<string, ClusterCandidate>();
    for (const row of rejectionRows.rows) {
      const ev = row.evidence ?? {};
      const rejectedAgent = (ev as { rejected_agent?: string }).rejected_agent ?? "unknown";
      const role = rejectedAgent.replace(/-\d+$/, ""); // 'developer-2' → 'developer'
      // We don't have project_hash on outcomes_pg yet — group by role only.
      // The dashboard will show "across projects" wording until v0.20.
      const key = `__project_unknown__::${role}`;
      const ex = byRoleAndProject.get(key);
      if (ex) {
        ex.count++;
        ex.last_at = ex.last_at < row.resolved_at ? row.resolved_at : ex.last_at;
        ex.first_at = ex.first_at > row.resolved_at ? row.resolved_at : ex.first_at;
        ex.outcomes.push({ id: row.id, ref_id: row.ref_id, evidence: ev });
      } else {
        byRoleAndProject.set(key, {
          target_role:  role,
          project_hash: "__project_unknown__",
          count:        1,
          first_at:     row.resolved_at,
          last_at:      row.resolved_at,
          outcomes:     [{ id: row.id, ref_id: row.ref_id, evidence: ev }],
        });
      }
    }

    return [...byRoleAndProject.values()].filter((c) => c.count >= MIN_REJECTS);
  });
}

/**
 * Check if any skill exists for the target role with `intended_roles`
 * containing it. If yes, the mutator path applies — don't propose a new
 * skill, let the existing skills' mutations handle it.
 */
async function roleHasAnySkill(targetRole: string): Promise<boolean> {
  return await withClient(async (c) => {
    const r = await c.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM skills_pg
        WHERE frontmatter::text ILIKE '%intended_roles%'
          AND frontmatter::text ILIKE $1`,
      [`%${targetRole}%`],
    );
    return parseInt(r.rows[0]?.count ?? "0", 10) > 0;
  });
}

/**
 * Don't re-propose for the same role within the cooldown window.
 */
async function recentCandidateExists(targetRole: string): Promise<boolean> {
  return await withClient(async (c) => {
    const r = await c.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM skill_candidates_pg
        WHERE target_role = $1
          AND status IN ('pending','generating','ready')
          AND created_at > now() - ($2::int || ' hours')::interval`,
      [targetRole, COOLDOWN_HOURS],
    );
    return parseInt(r.rows[0]?.count ?? "0", 10) > 0;
  });
}

/**
 * Insert a new skill_candidate row.
 */
async function insertCandidate(c: ClusterCandidate): Promise<string | null> {
  const id = `cand-${Date.now()}-${randomBytes(4).toString("hex")}`;
  // Build a headline from the rejection reasons
  const reasons = c.outcomes
    .map((o) => (o.evidence as { reject_reason?: string; reject_summary?: string }).reject_reason
              ?? (o.evidence as { reject_summary?: string }).reject_summary)
    .filter((s): s is string => Boolean(s));
  const sample = reasons.slice(0, 2).join(" | ");
  const headline = `${c.count} rejections of ${c.target_role} role in last ${WINDOW_DAYS}d. Sample reasons: ${sample.slice(0, 200)}${sample.length > 200 ? "…" : ""}`;

  try {
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO skill_candidates_pg (
            candidate_id, project_hash, target_role, rejection_count,
            first_rejection_at, last_rejection_at, rejection_outcomes,
            headline, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending')`,
        [
          id, c.project_hash, c.target_role, c.count,
          c.first_at, c.last_at,
          JSON.stringify(c.outcomes), headline,
        ],
      );
    });
    return id;
  } catch (e) {
    logger.error("skills", "skill_candidate_insert_failed", {
      error: (e as Error).message, target_role: c.target_role,
    });
    return null;
  }
}

/**
 * Top-level: detect clusters, filter, queue candidates.
 * Returns { proposed, skipped_existing_skill, skipped_cooldown }.
 */
export async function detectAndQueueSkillCandidates(): Promise<{
  proposed:                number;
  skipped_existing_skill:  number;
  skipped_cooldown:        number;
  candidates:              string[];
}> {
  const result = { proposed: 0, skipped_existing_skill: 0, skipped_cooldown: 0, candidates: [] as string[] };
  try {
    const clusters = await findClusterCandidates();
    for (const cluster of clusters) {
      // Skip if role already has skills — mutator path applies
      if (await roleHasAnySkill(cluster.target_role)) {
        result.skipped_existing_skill++;
        continue;
      }
      // Skip if recently proposed
      if (await recentCandidateExists(cluster.target_role)) {
        result.skipped_cooldown++;
        continue;
      }
      const id = await insertCandidate(cluster);
      if (id) {
        result.proposed++;
        result.candidates.push(id);
        logger.info("skills", "skill_candidate_queued", {
          candidate_id: id, target_role: cluster.target_role,
          rejection_count: cluster.count,
        });
      }
    }
  } catch (e) {
    logger.error("skills", "skill_candidate_detector_failed", {
      error: (e as Error).message, stack: (e as Error).stack,
    });
  }
  return result;
}
