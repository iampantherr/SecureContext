/**
 * D1 (v0.46.1) — PROGRAM MEMORY: long-horizon delivery state.
 *
 * Evidence this exists to fix: A2A_communication accumulated 18 HAND-WRITTEN
 * CHECKPOINT_*.md files — the operator manually compensating for the tool
 * having no program-level state. A PROGRAM is a named, multi-phase delivery
 * effort over one project. Phases carry an acceptance-checklist memory key
 * (from the acceptance-gate skill), and closing a phase AUTO-GENERATES the
 * checkpoint (from phase metadata + acceptance facts + MERGE broadcasts +
 * spend) — indexed into the KB (`checkpoint:` source, summary retention) so
 * it is durable and retrievable, and returned as markdown for the repo.
 *
 * The acceptance test for this module is the HANDOFF TEST: a fresh
 * orchestrator, given nothing but the project, resumes mid-phase from
 * `zc_program({action:"status"})` + one recall.
 */
import { withClient } from "./pg_pool.js";
import { createHash } from "node:crypto";

const ph = (projectPath: string): string =>
  createHash("sha256").update(projectPath).digest("hex").slice(0, 16);

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PhaseDef { phase_id: string; title: string }

export async function defineProgram(
  projectPath: string, programId: string, name: string, phases: PhaseDef[],
): Promise<{ program_id: string; phases: number }> {
  if (!SLUG.test(programId)) throw new Error("programId must match [a-z0-9][a-z0-9_-]{0,63}");
  if (!phases.length) throw new Error("at least one phase is required");
  const projectHash = ph(projectPath);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO programs_pg(program_id, project_hash, name) VALUES ($1, $2, $3)
       ON CONFLICT (program_id) DO UPDATE SET name = EXCLUDED.name`,
      [programId, projectHash, name],
    );
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i]!;
      if (!SLUG.test(p.phase_id)) throw new Error(`phase_id '${p.phase_id}' must match [a-z0-9][a-z0-9_-]{0,63}`);
      await c.query(
        `INSERT INTO program_phases_pg(program_id, phase_id, ordinal, title, acceptance_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (program_id, phase_id) DO UPDATE SET title = EXCLUDED.title, ordinal = EXCLUDED.ordinal`,
        [programId, p.phase_id, i + 1, p.title, `acceptance_${p.phase_id}`],
      );
    }
  });
  return { program_id: programId, phases: phases.length };
}

export async function openPhase(programId: string, phaseId: string): Promise<void> {
  await withClient(async (c) => {
    const r = await c.query(
      `UPDATE program_phases_pg SET status = 'open', opened_at = COALESCE(opened_at, NOW())
        WHERE program_id = $1 AND phase_id = $2 AND status <> 'closed'`,
      [programId, phaseId],
    );
    if (r.rowCount === 0) throw new Error(`phase '${phaseId}' not found in program '${programId}' (or already closed)`);
  });
}

/**
 * Close a phase: stamps closed_at, generates + stores the checkpoint markdown.
 * `evidenceSummary` is the orchestrator's acceptance-table text (from the
 * acceptance-gate skill) — required, because a checkpoint without evidence is
 * exactly the failure mode this feature exists to end.
 */
export async function closePhase(
  projectPath: string, programId: string, phaseId: string, evidenceSummary: string,
): Promise<{ checkpoint: string; source: string }> {
  if (!evidenceSummary || evidenceSummary.trim().length < 40) {
    throw new Error("closePhase requires an evidence summary (the acceptance table) — 'done' without evidence is not done");
  }
  const projectHash = ph(projectPath);
  const md = await withClient(async (c) => {
    const phase = (await c.query<{ title: string; ordinal: number; opened_at: Date | null; acceptance_key: string | null }>(
      `SELECT title, ordinal, opened_at, acceptance_key FROM program_phases_pg
        WHERE program_id = $1 AND phase_id = $2`,
      [programId, phaseId],
    )).rows[0];
    if (!phase) throw new Error(`phase '${phaseId}' not found in program '${programId}'`);
    const prog = (await c.query<{ name: string }>(
      `SELECT name FROM programs_pg WHERE program_id = $1`, [programId],
    )).rows[0];
    const openedAt = phase.opened_at ? new Date(phase.opened_at) : null;

    // Acceptance checklist fact (written by the acceptance-gate skill).
    const acc = (await c.query<{ value: string }>(
      `SELECT value FROM working_memory
        WHERE project_hash = $1 AND key = $2 AND valid_to IS NULL ORDER BY created_at DESC LIMIT 1`,
      [projectHash, phase.acceptance_key ?? `acceptance_${phaseId}`],
    )).rows[0];

    // MERGE broadcasts during the phase window (the deliverables record).
    const merges = (await c.query<{ agent_id: string; summary: string | null; state: string | null; created_at: string }>(
      `SELECT agent_id, summary, state, created_at::text AS created_at FROM broadcasts
        WHERE project_hash = $1 AND type = 'MERGE' ${openedAt ? "AND created_at::timestamptz >= $2" : ""}
        ORDER BY id DESC LIMIT 15`,
      openedAt ? [projectHash, openedAt] : [projectHash],
    )).rows;

    // Spend during the phase window.
    const spend = (await c.query<{ cost: string; calls: string }>(
      `SELECT COALESCE(SUM(cost_usd),0)::text AS cost, COUNT(*)::text AS calls FROM tool_calls_pg
        WHERE project_hash = $1 ${openedAt ? "AND ts >= $2" : ""}`,
      openedAt ? [projectHash, openedAt] : [projectHash],
    )).rows[0];

    const now = new Date().toISOString();
    const lines: string[] = [];
    lines.push(`# CHECKPOINT — ${prog?.name ?? programId} · Phase ${phase.ordinal}: ${phase.title}`);
    lines.push("");
    lines.push(`- **Program:** ${programId} · **Phase:** ${phaseId} · **Closed:** ${now}`);
    if (openedAt) lines.push(`- **Opened:** ${openedAt.toISOString()} (${Math.round((Date.now() - openedAt.getTime()) / 3_600_000)}h elapsed)`);
    lines.push(`- **Spend (window):** $${Number(spend?.cost ?? 0).toFixed(4)} across ${spend?.calls ?? 0} tool calls`);
    lines.push("");
    lines.push(`## Acceptance evidence`);
    lines.push(evidenceSummary.trim());
    if (acc) {
      lines.push("");
      lines.push(`## Acceptance checklist (as stored at phase start)`);
      lines.push(acc.value);
    }
    if (merges.length) {
      lines.push("");
      lines.push(`## Deliverables (MERGE broadcasts in window)`);
      for (const m of merges) {
        lines.push(`- ${m.created_at.slice(0, 16)} **${m.agent_id}**: ${(m.summary ?? m.state ?? "").slice(0, 200)}`);
      }
    }
    lines.push("");
    lines.push(`_Auto-generated by SecureContext program memory (zc_program close_phase)._`);
    const md = lines.join("\n");

    await c.query(
      `UPDATE program_phases_pg SET status = 'closed', closed_at = NOW(), checkpoint = $3
        WHERE program_id = $1 AND phase_id = $2`,
      [programId, phaseId, md],
    );
    // Auto-complete the program when every phase is closed.
    await c.query(
      `UPDATE programs_pg SET status = 'completed', completed_at = NOW()
        WHERE program_id = $1 AND NOT EXISTS (
          SELECT 1 FROM program_phases_pg WHERE program_id = $1 AND status <> 'closed')`,
      [programId],
    );
    return md;
  });
  return { checkpoint: md, source: `checkpoint:${programId}:${phaseId}` };
}

/** The handoff view: everything a fresh orchestrator needs, one call. */
export async function programStatus(projectPath: string, programId?: string): Promise<string> {
  const projectHash = ph(projectPath);
  return withClient(async (c) => {
    const progs = (await c.query<{ program_id: string; name: string; status: string; created_at: Date }>(
      programId
        ? `SELECT program_id, name, status, created_at FROM programs_pg WHERE program_id = $1`
        : `SELECT program_id, name, status, created_at FROM programs_pg WHERE project_hash = $1 ORDER BY created_at DESC LIMIT 3`,
      [programId ?? projectHash],
    )).rows;
    if (!progs.length) return "No programs defined for this project. Define one with zc_program({action:'define', ...}).";

    const out: string[] = [];
    for (const p of progs) {
      const phases = (await c.query<{
        phase_id: string; ordinal: number; title: string; status: string;
        acceptance_key: string | null; opened_at: Date | null; closed_at: Date | null;
      }>(
        `SELECT phase_id, ordinal, title, status, acceptance_key, opened_at, closed_at
           FROM program_phases_pg WHERE program_id = $1 ORDER BY ordinal`,
        [p.program_id],
      )).rows;
      const closed = phases.filter((x) => x.status === "closed").length;
      out.push(`## Program: ${p.name} (${p.program_id}) — ${p.status} · ${closed}/${phases.length} phases closed`);
      for (const x of phases) {
        const mark = x.status === "closed" ? "✅" : x.status === "open" ? "🔵 OPEN" : "⬜";
        const when = x.status === "closed" && x.closed_at ? ` (closed ${new Date(x.closed_at).toISOString().slice(0, 10)})`
          : x.status === "open" && x.opened_at ? ` (since ${new Date(x.opened_at).toISOString().slice(0, 10)})` : "";
        out.push(`${x.ordinal}. ${mark} ${x.title} [${x.phase_id}]${when}`);
        if (x.status === "open" && x.acceptance_key) {
          const acc = (await c.query<{ value: string }>(
            `SELECT value FROM working_memory WHERE project_hash = $1 AND key = $2 AND valid_to IS NULL LIMIT 1`,
            [projectHash, x.acceptance_key],
          )).rows[0];
          out.push(acc
            ? `   Acceptance checklist (${x.acceptance_key}):\n   ${acc.value.slice(0, 700).replace(/\n/g, "\n   ")}`
            : `   ⚠ No acceptance checklist stored yet under '${x.acceptance_key}' — run the acceptance-gate skill.`);
        }
      }
      const open = phases.find((x) => x.status === "open");
      out.push(open
        ? `NEXT: continue phase '${open.phase_id}' — check zc_plan_status for its task graph, recall with focus '${open.title}', close via zc_program({action:'close_phase', ...}) with the evidence table.`
        : p.status === "active"
          ? `NEXT: open the first pending phase with zc_program({action:'open_phase', ...}).`
          : `Program ${p.status}.`);
      out.push("");
    }
    return out.join("\n");
  });
}
