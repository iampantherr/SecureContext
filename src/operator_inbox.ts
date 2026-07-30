/**
 * Operator inbox (v0.50.0) — durable questions from orchestrators to the HUMAN
 * operator, answered from the dashboard and delivered back into the agent's
 * terminal by the dispatcher.
 *
 * Born from a live incident (2026-07-27, broadcast #2840): an orchestrator
 * asked the operator a blocking question via the broadcast channel; the
 * dispatcher's worker-targeted routing matched no worker and silently dropped
 * it. Only the operator happening to tail the dispatcher log prevented an
 * indefinite block. The inbox makes that class of message durable and
 * answerable.
 *
 * State machine (enforced in SQL, not app code):
 *
 *   pending ──answer──▶ answered ──delivered──▶ delivered
 *      │
 *      └──dismiss──▶ dismissed
 *
 * Each transition updates only from its exact predecessor state and reports
 * whether a row actually moved — callers surface a conflict (409) instead of
 * silently double-applying. Delivery is at-least-once by design: the
 * dispatcher marks `delivered` only after the terminal send succeeds, so a
 * crash between send and mark re-delivers rather than losing the answer.
 *
 * PG-only, same documented class as the task queue and zc_program.
 */
import { withClient } from "./pg_pool.js";

export interface OperatorInboxEntry {
  id: number;
  created_at: string;
  project_path: string;
  project_hash: string;
  broadcast_id: number | null;
  from_agent: string;
  question: string;
  status: "pending" | "answered" | "delivered" | "dismissed";
  answer: string | null;
  answered_at: string | null;
  answered_by: string | null;
  delivered_at: string | null;
}

export type InboxStatusFilter = OperatorInboxEntry["status"] | "all";

export async function createInboxEntry(input: {
  projectPath: string;
  question: string;
  projectHash?: string;
  broadcastId?: number | null;
  fromAgent?: string;
}): Promise<number> {
  const question = input.question.trim();
  if (!question) throw new Error("question required");
  return await withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO operator_inbox_pg (project_path, project_hash, broadcast_id, from_agent, question)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.projectPath, input.projectHash ?? "", input.broadcastId ?? null,
       input.fromAgent ?? "orchestrator", question],
    );
    return Number(r.rows[0].id);
  });
}

export async function listInbox(status: InboxStatusFilter = "pending", limit = 100): Promise<OperatorInboxEntry[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  return await withClient(async (c) => {
    const r = status === "all"
      ? await c.query(`SELECT * FROM operator_inbox_pg ORDER BY created_at DESC LIMIT $1`, [lim])
      // Oldest first for actionable states: the operator (and the dispatcher's
      // delivery poll) should see the longest-waiting entry at the top.
      : await c.query(`SELECT * FROM operator_inbox_pg WHERE status = $2 ORDER BY created_at ASC LIMIT $1`, [lim, status]);
    return r.rows as OperatorInboxEntry[];
  });
}

/** pending → answered. Returns false if the entry is missing or not pending. */
export async function answerInboxEntry(id: number, answer: string, answeredBy = "operator"): Promise<boolean> {
  const a = answer.trim();
  if (!a) throw new Error("answer required");
  return await withClient(async (c) => {
    const r = await c.query(
      `UPDATE operator_inbox_pg SET status = 'answered', answer = $2, answered_at = now(), answered_by = $3
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, a, answeredBy],
    );
    return r.rows.length > 0;
  });
}

/** answered → delivered. Returns false if the entry is missing or not answered. */
export async function markInboxDelivered(id: number): Promise<boolean> {
  return await withClient(async (c) => {
    const r = await c.query(
      `UPDATE operator_inbox_pg SET status = 'delivered', delivered_at = now()
       WHERE id = $1 AND status = 'answered' RETURNING id`, [id],
    );
    return r.rows.length > 0;
  });
}

