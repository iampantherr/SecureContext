// One-shot reprocess: re-run the β filer's persistence step against an
// already-existing mutation_results_pg row. Used to validate the type-coercion
// bug fix without burning another Sonnet call.
//
// Usage: node scripts/_reprocess_spotter_filer.mjs <run_id>

import { withClient } from "/app/dist/pg_pool.js";
import { randomUUID } from "node:crypto";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: node _reprocess_spotter_filer.mjs <run_id>");
  process.exit(1);
}

// 1. Fetch the existing mutation_results row.
const row = await withClient(async (c) => {
  const r = await c.query(
    `SELECT result_id, bodies, bodies_hash, candidate_count
       FROM mutation_results_pg
      WHERE mutation_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  return r.rows[0] ?? null;
});
if (!row) {
  console.error(`No mutation_results row for run_id=${runId}`);
  process.exit(1);
}

console.log(`Found result_id=${row.result_id} with ${row.candidate_count} bodies`);

// 2. Decode bodies as decisions, applying the new lenient validation.
const bodies = JSON.parse(row.bodies);
const VALID_OUTCOMES = new Set([
  "filed_candidate", "rejected_low_signal", "rejected_not_procedural",
  "rejected_fits_in_prompt", "rejected_duplicate", "rejected_variable_instances",
]);

const decisions = [];
for (const body of bodies) {
  let parsed;
  try { parsed = JSON.parse(body.candidate_body); }
  catch (e) { console.warn("malformed body, skip:", e.message); continue; }
  const coercedId = typeof parsed.signal_id === "number"
    ? parsed.signal_id
    : (typeof parsed.signal_id === "string" && /^-?\d+$/.test(parsed.signal_id)
        ? parseInt(parsed.signal_id, 10)
        : NaN);
  if (!Number.isFinite(coercedId)) {
    console.warn(`skip: bad signal_id=${JSON.stringify(parsed.signal_id)}`);
    continue;
  }
  if (!VALID_OUTCOMES.has(parsed.outcome)) {
    console.warn(`skip: bad outcome=${parsed.outcome}`);
    continue;
  }
  decisions.push({ ...parsed, signal_id: coercedId });
}

console.log(`Decoded ${decisions.length} valid decisions`);

// 3. Apply decisions to skill_spotter_signals_pg + skill_candidates_pg.
const byOutcome = {
  filed_candidate: 0, rejected_low_signal: 0, rejected_not_procedural: 0,
  rejected_fits_in_prompt: 0, rejected_duplicate: 0, rejected_variable_instances: 0,
};
let candidatesFiled = 0;

for (const d of decisions) {
  byOutcome[d.outcome]++;
  if (d.outcome === "filed_candidate" && d.candidate) {
    const candidateId = randomUUID();
    const cand = d.candidate;
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO skill_candidates_pg (
           candidate_id, project_hash, target_role, rejection_count,
           first_rejection_at, last_rejection_at, rejection_outcomes,
           headline, proposed_skill_body, proposed_at, status
         ) VALUES ($1, $2, $3, $4, now(), now(), $5::jsonb,
                   $6, $7, now(), 'ready')`,
        [
          candidateId, "spotter-global", "developer", 0,
          JSON.stringify({ source: "skill-spotter", signal_id: d.signal_id, scope: cand.scope, result_id: row.result_id, bodies_hash: row.bodies_hash }),
          `[spotter] ${cand.skill_name}: ${(cand.description ?? "").slice(0, 140)}`,
          `---\nname: ${cand.skill_name}\ndescription: |\n  ${cand.description}\nscope: ${cand.scope}\n---\n\n${cand.proposed_skill_body}`,
        ],
      );
      await c.query(
        `UPDATE skill_spotter_signals_pg
            SET outcome = 'filed_candidate', outcome_reason = $2, candidate_id = $3::uuid
          WHERE signal_id = $1`,
        [d.signal_id, d.outcome_reason ?? "", candidateId],
      );
    });
    candidatesFiled++;
    console.log(`  filed: signal_id=${d.signal_id} as ${cand.skill_name}`);
  } else {
    await withClient(async (c) => {
      await c.query(
        `UPDATE skill_spotter_signals_pg
            SET outcome = $2, outcome_reason = $3
          WHERE signal_id = $1`,
        [d.signal_id, d.outcome, d.outcome_reason ?? ""],
      );
    });
    console.log(`  signal_id=${d.signal_id}: ${d.outcome}`);
  }
}

// 4. Update the spotter run row.
await withClient(async (c) => {
  await c.query(
    `UPDATE skill_spotter_runs_pg
        SET mode = 'llm-proposed', candidates_filed = $2
      WHERE run_id = $1`,
    [runId, candidatesFiled],
  );
});

console.log("");
console.log("=== REPROCESS COMPLETE ===");
console.log(`signals_processed: ${decisions.length}`);
console.log(`candidates_filed:  ${candidatesFiled}`);
console.log("by_outcome:        ", JSON.stringify(byOutcome));
process.exit(0);
