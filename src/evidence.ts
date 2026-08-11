/**
 * Executable evidence records — make a finding's evidence re-runnable.
 *
 * WHY THIS EXISTS
 *
 * Measured on the live A2A project (2026-08-05): a QA sweep reported the SOC
 * compliance page as "silently empty — the page fetches /api/soc/compliance
 * which 404s; the correct URL is /api/soc/compliance/controls". Every individual
 * observation in that finding was TRUE — against the hub. But the page is served
 * by the console, which owns a proxy route translating the first path into the
 * second. So on the console the page's URL returns 200 and the proposed "fix"
 * returns 404: applying it would have broken a working page.
 *
 * The error was not a hallucination. It was a REAL probe run against the WRONG
 * LAYER, written up as prose. And prose is where the failure became permanent:
 * the report said "404" without recording WHERE it was probed, so no reader —
 * human or machine — could tell a hub result from a console result, and nothing
 * could re-run the check.
 *
 * WHAT THIS DOES
 *
 * An evidence record binds four things that prose leaves implicit:
 *   claim           — what is being asserted
 *   probe_command   — how it was observed
 *   observed_output — what came back
 *   target_context  — WHERE the probe ran (host:port / layer). The field whose
 *                     absence caused the incident above.
 *
 * Records are then REPLAYABLE: a verifier re-issues the probe and compares. A
 * finding stops being "trust the author" and becomes "re-run the check".
 *
 * SAFETY — deliberately narrow
 *
 * Replay NEVER executes a shell. A probe_command is stored verbatim as the
 * human-readable record of what was done, but only HTTP probes are parsed and
 * re-issued (via fetch). Anything else is stored and reported as manual-only.
 * Re-running agent-authored shell strings would be remote code execution wearing
 * a verification badge.
 */
import { withClient } from "./pg_pool.js";
import { projectHash as scopedProjectHash } from "./store.js";

export interface EvidenceRecord {
  id?:              number;
  claim:            string;
  probe_command:    string;
  observed_output:  string;
  target_context:   string;
  agent_id?:        string;
  skill_run_id?:    string | null;
  created_at?:      string;
}

export interface ReplayResult {
  id:    number | undefined;
  claim: string;
  /** manual = nothing re-issuable (or nothing to compare); the detail says which. */
  verdict: "match" | "mismatch" | "manual" | "error";
  detail: string;
}

/** Milliseconds a replayed probe may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Extract an HTTP probe from a command string. Handles the shapes agents
 * actually write: curl invocations, bare "GET <url>", and fetch() calls.
 * Returns null for anything we will not re-issue — the honest answer, since a
 * probe we cannot parse must be reported as manual rather than silently skipped.
 */
export function parseHttpProbe(cmd: string): { method: string; url: string } | null {
  if (!cmd) return null;
  // First http(s) URL in the string, minus surrounding quotes/parens.
  const m = cmd.match(/https?:\/\/[^\s"'`)<>]+/i);
  if (!m) return null;
  const url = m[0].replace(/[.,;]+$/, "");
  // Explicit method wins (-X POST / --request POST / leading verb).
  const x = cmd.match(/(?:-X|--request)\s+([A-Z]+)/i);
  const verb = cmd.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\b/i);
  const method = (x?.[1] ?? verb?.[1] ?? "GET").toUpperCase();
  // Only ever replay safe, side-effect-free methods. A recorded POST is real
  // evidence, but re-issuing it could mutate state — report it manual instead.
  if (method !== "GET" && method !== "HEAD") return null;
  return { method, url };
}

/** Pull an HTTP status code out of an observed-output string ("404", "HTTP 404", "→ 200"). */
export function parseStatus(observed: string): number | null {
  const m = String(observed).match(/\b([1-5]\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Re-issue one evidence record's probe and compare with what was observed then.
 * Never throws: a replay that cannot run is a reported verdict, not an exception.
 */
export async function replayProbe(rec: EvidenceRecord): Promise<ReplayResult> {
  const base = { id: rec.id, claim: rec.claim };
  const probe = parseHttpProbe(rec.probe_command);
  if (!probe) {
    return { ...base, verdict: "manual",
      detail: "not a re-issuable GET/HEAD HTTP probe — stored for the record; re-run by hand." };
  }
  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "manual",   // a 307 to /login is a RESULT, not something to follow
    });
    const now = String(resp.status);
    const then = parseStatus(rec.observed_output);
    if (then === null) {
      return { ...base, verdict: "manual",
        detail: `re-ran ${probe.method} ${probe.url} → HTTP ${now}; original evidence records no status to compare.` };
    }
    const match = then === resp.status;
    return {
      ...base, verdict: match ? "match" : "mismatch",
      detail: match
        ? `re-ran ${probe.method} ${probe.url} → HTTP ${now}, same as recorded.`
        : `re-ran ${probe.method} ${probe.url} → HTTP ${now}, but the record says ${then}. ` +
          `The evidence no longer reproduces — the claim built on it is unsafe to act on.`,
    };
  } catch (e) {
    return { ...base, verdict: "error",
      detail: `replay failed: ${String(e).slice(0, 160)}` };
  }
}

// ─── Storage (PG-backed) ────────────────────────────────────────────────────
// PG-only by design, same documented class as the task queue, operator inbox and
// zc_program: an audit trail that only means anything when every agent shares it.

export async function insertEvidence(projectPath: string, rec: EvidenceRecord): Promise<number> {
  const ph = scopedProjectHash(projectPath);
  const r = await withClient(async (c) => c.query<{ id: number }>(
    `INSERT INTO evidence_pg (project_hash, agent_id, claim, probe_command, observed_output, target_context, skill_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ph, rec.agent_id ?? "default", rec.claim, rec.probe_command,
     rec.observed_output, rec.target_context, rec.skill_run_id ?? null]));
  return r.rows[0]!.id;
}

export async function listEvidence(
  projectPath: string, opts: { limit?: number; skill_run_id?: string } = {},
): Promise<EvidenceRecord[]> {
  const ph = scopedProjectHash(projectPath);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
  const r = opts.skill_run_id
    ? await withClient(async (c) => c.query(
        `SELECT id, claim, probe_command, observed_output, target_context, agent_id, skill_run_id, created_at
           FROM evidence_pg WHERE project_hash=$1 AND skill_run_id=$2 ORDER BY id DESC LIMIT $3`,
        [ph, opts.skill_run_id, limit]))
    : await withClient(async (c) => c.query(
        `SELECT id, claim, probe_command, observed_output, target_context, agent_id, skill_run_id, created_at
           FROM evidence_pg WHERE project_hash=$1 ORDER BY id DESC LIMIT $2`, [ph, limit]));
  return r.rows as EvidenceRecord[];
}

/**
 * Prior records that ran the SAME probe against the SAME target but observed
 * something different. That is a contradiction in the strict sense — identical
 * question, different answer — which means one of them is stale and any claim
 * resting on either is suspect until re-run.
 */
export async function contradictingEvidence(
  projectPath: string, rec: EvidenceRecord,
): Promise<EvidenceRecord[]> {
  const ph = scopedProjectHash(projectPath);
  const r = await withClient(async (c) => c.query(
    `SELECT id, claim, probe_command, observed_output, target_context, agent_id, created_at
       FROM evidence_pg
      WHERE project_hash=$1 AND probe_command=$2 AND target_context=$3
        AND observed_output <> $4
      ORDER BY id DESC LIMIT 5`,
    [ph, rec.probe_command, rec.target_context, rec.observed_output]));
  return r.rows as EvidenceRecord[];
}

/**
 * Behavioural assertions embedded in free text: a URL and an explicit status in
 * the same clause ("/api/x → HTTP 404", "GET /y returns 200"). Conservative on
 * purpose — a missed assertion is reported as unverifiable, while a wrongly
 * parsed one would manufacture a false refutation, which is the failure mode
 * this whole module exists to prevent.
 */
export function extractHttpAssertions(text: string): Array<{ url: string; status: number; raw: string }> {
  const out: Array<{ url: string; status: number; raw: string }> = [];
  if (!text) return out;
  for (const clause of String(text).split(/[;\n]|(?:\.\s)/)) {
    const url = clause.match(/https?:\/\/[^\s"'`)<>,]+/i);
    if (!url) continue;
    const st = clause.match(/\b(?:HTTP\s*)?([1-5]\d{2})\b(?!\S)/);
    if (!st) continue;
    out.push({ url: url[0].replace(/[.,;]+$/, ""), status: Number(st[1]), raw: clause.trim().slice(0, 160) });
  }
  return out;
}
