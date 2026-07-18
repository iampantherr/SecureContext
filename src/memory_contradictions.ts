/**
 * Memory contradiction detection (Tier-1 B)
 * =========================================
 *
 * Turns flat, accumulating working memory into SELF-CORRECTING memory: a background
 * pass that surfaces SUSPECTED contradictions between facts for operator/agent review.
 * It NEVER auto-deletes — it flags. Modelled on gbrain's "suspected-contradictions".
 *
 * Heuristic: a pair is flagged only when it is BOTH
 *   (1) semantically similar  (cosine ≥ SIM_HIGH on the fact values), AND
 *   (2) carries a CONFLICT SIGNAL:
 *         - resolution_conflict: a near-duplicate claim was marked resolved_incorrect
 *           while the other is still asserted as live,
 *         - decision_reversal:  two `decision`s with high semantic but low textual overlap,
 *         - semantic_conflict:  high similarity with opposite polarity (one negates the other).
 * Cosine alone is similarity, NOT contradiction — the conflict signal is mandatory.
 *
 * Cost control: live facts are NOT pre-embedded (only eviction archives a vector), so the
 * pass embeds on demand, capped at MAX_SCAN_FACTS, and SKIPS CLEANLY when Ollama is down
 * (exactly like search degrading to BM25-only). Recall reads already-stored rows synchronously
 * and kicks a background refresh — so it never adds embedding latency to session startup.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openDb } from "./knowledge.js";
import { recallWorkingMemory, retireFact, type MemoryFact } from "./memory.js";
import { getEmbedding, getEmbeddingQueued, cosineSimilarity } from "./embedder.js";
import { SIM_HIGH, MAX_SCAN_FACTS, detectConflict, autoResolveVictim } from "./contradiction_heuristics.js";
import { Config } from "./config.js";

export interface OpenContradiction {
  key_a:      string;
  key_b:      string;
  similarity: number;
  reason:     string;
  detail:     string;
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_contradictions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL,
      key_a         TEXT NOT NULL,
      key_b         TEXT NOT NULL,
      similarity    REAL NOT NULL,
      reason        TEXT NOT NULL,
      detail        TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      surfaced_by   TEXT NOT NULL,
      surfaced_at   TEXT NOT NULL,
      reviewed_at   TEXT,
      UNIQUE(agent_id, key_a, key_b)
    );
    CREATE INDEX IF NOT EXISTS idx_mc_status ON memory_contradictions(agent_id, status, surfaced_at DESC);
  `);
  try { db.exec(`ALTER TABLE memory_contradictions ADD COLUMN resolution_mode TEXT`); } catch { /* exists */ }
}

/**
 * Run the contradiction scan for one agent. Embeds (capped) live facts on demand,
 * pairwise-compares, upserts flagged pairs as status='open' (never re-opens a dismissed
 * pair). Skips cleanly if Ollama is unavailable. Returns a small summary.
 */
export async function detectContradictions(
  projectPath: string,
  agentId: string,
  surfacedBy: "cron" | "manual" = "cron",
): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean; skipped?: number }> {
  const facts = recallWorkingMemory(projectPath, agentId)
    // S1 — floor lowered 3→2: updates are often recorded at LOW importance ("just
    // an update"), which excluded exactly the facts that supersede older ones.
    // S1 — RECENT-first budget (mirrors store-postgres.ts): importance-first let
    // old ★5 facts consume the whole window on mature projects, so new facts —
    // the actual conflict candidates — were never scanned.
    .filter((f) => f.importance >= 2)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, MAX_SCAN_FACTS);
  if (facts.length < 2) return { scanned: facts.length, flagged: 0, ollamaAvailable: true };

  // S1 (v0.44.0) — read STORED vectors first (facts are embedded at write time);
  // only embed the missing few via the background lane. Mirrors store-postgres.ts:
  // re-embedding every fact per scan was slow and hammered Ollama needlessly.
  const vectors = new Map<string, Float32Array>();
  let embFails = 0;
  try {
    const vdb = openDb(projectPath);
    try {
      const { deserializeVector, ACTIVE_MODEL } = await import("./embedder.js");
      const sources = facts.map((f) => `memory:${f.agent_id ?? agentId}:${f.key}`);
      const ph2 = sources.map(() => "?").join(",");
      const rows = vdb.prepare(
        `SELECT source, vector FROM embeddings WHERE model_name = ? AND source IN (${ph2})`
      ).all(ACTIVE_MODEL, ...sources) as Array<{ source: string; vector: Buffer }>;
      const bySource = new Map(rows.map((r) => [r.source, r.vector]));
      for (const f of facts) {
        const buf = bySource.get(`memory:${f.agent_id ?? agentId}:${f.key}`);
        if (buf) vectors.set(f.key, deserializeVector(buf));
      }
    } finally { vdb.close(); }
  } catch { /* embeddings table absent — fall through to live embeds */ }
  for (const f of facts) {
    if (vectors.has(f.key)) continue;
    const emb = await getEmbeddingQueued(f.value); // S1 — background lane
    if (!emb) { embFails++; continue; }
    vectors.set(f.key, emb.vector);
  }
  if (vectors.size < 2) {
    return { scanned: facts.length, flagged: 0, ollamaAvailable: embFails < facts.length, skipped: embFails };
  }

  const found: Array<{ a: MemoryFact; b: MemoryFact; sim: number; reason: string; detail: string; victim: string | null }> = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]!, b = facts[j]!;
      // v0.46.2 (parity with PG) — acceptance_* keys are workflow checklists,
      // not claims; two phases' checklists sharing phrasing is not a conflict.
      if (a.key.startsWith("acceptance_") || b.key.startsWith("acceptance_")) continue;
      const va = vectors.get(a.key), vb = vectors.get(b.key);
      if (!va || !vb) continue;
      const sim = cosineSimilarity(va, vb);
      if (sim < SIM_HIGH) continue;
      const conflict = detectConflict(a, b, sim); // R2 — sim enables numeric_conflict
      if (!conflict) continue;
      // v0.37.0 — clear supersession ⇒ auto-resolve (retire the stale side); else open triage.
      const victim = Config.AUTO_RESOLVE ? autoResolveVictim(a, b, conflict.reason) : null;
      found.push({ a, b, sim, reason: conflict.reason, detail: conflict.detail, victim });
    }
  }

  // TKG-T3 (v0.47.0, parity with PG) — LLM adjudication of ambiguous pairs
  // BEFORE the synchronous write loop: "compatible" suppresses the flag,
  // "update" sets a recency victim, "contradiction"/failure → open triage.
  const suppressed = new Set<(typeof found)[number]>();
  try {
    const { adjudicatePair, adjudicatorEnabled } = await import("./llm_adjudicator.js");
    let budget = parseInt(process.env["ZC_LLM_ADJUDICATE_BUDGET"] ?? "8", 10) || 8;
    if (adjudicatorEnabled()) {
      for (const f of found) {
        if (f.victim || budget <= 0) continue;
        budget--;
        const j = await adjudicatePair({ key: f.a.key, value: f.a.value }, { key: f.b.key, value: f.b.value });
        if (j?.verdict === "compatible") { suppressed.add(f); continue; }
        if (j?.verdict === "update") {
          const older = new Date(f.a.created_at) <= new Date(f.b.created_at) ? f.a : f.b;
          f.victim = older.key;
          f.detail = `LLM adjudicated update; recency invalidated '${older.key}'. ${f.detail}`;
        }
      }
    }
  } catch { /* adjudicator unavailable — all pairs keep legacy behavior */ }

  const db = openDb(projectPath);
  ensureTable(db);
  // v0.46.2 (parity with PG) — sweep zombie flags: an open contradiction whose
  // facts are no longer BOTH live is moot and self-closes.
  try {
    const pruned = db.prepare(`
      UPDATE memory_contradictions SET status = 'dismissed', reviewed_at = ?, resolution_mode = 'auto',
             detail = detail || ' [auto-closed: a side was retired/superseded/evicted]'
       WHERE status = 'open'
         AND (NOT EXISTS (SELECT 1 FROM working_memory w WHERE w.key = key_a
                            AND w.agent_id IN (memory_contradictions.agent_id, 'default') AND w.valid_to IS NULL)
           OR NOT EXISTS (SELECT 1 FROM working_memory w WHERE w.key = key_b
                            AND w.agent_id IN (memory_contradictions.agent_id, 'default') AND w.valid_to IS NULL))
    `).run(new Date().toISOString());
    if (Number(pruned.changes) > 0) console.error(`[contradictions] auto-closed ${pruned.changes} stale flag(s)`);
  } catch { /* pre-migration DB without valid_to — skip pruning */ }
  const now = new Date().toISOString();
  const openStmt = db.prepare(`
    INSERT INTO memory_contradictions(agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by, surfaced_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
    ON CONFLICT(agent_id, key_a, key_b) DO UPDATE SET
      similarity  = excluded.similarity,
      reason      = excluded.reason,
      detail      = excluded.detail,
      surfaced_at = excluded.surfaced_at
  `);
  const autoStmt = db.prepare(`
    INSERT INTO memory_contradictions(agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by, surfaced_at, reviewed_at, resolution_mode)
    VALUES (?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?, 'auto')
    ON CONFLICT(agent_id, key_a, key_b) DO UPDATE SET
      similarity      = excluded.similarity,
      reason          = excluded.reason,
      detail          = excluded.detail,
      status          = 'resolved',
      reviewed_at     = excluded.reviewed_at,
      resolution_mode = 'auto',
      surfaced_at     = excluded.surfaced_at
  `);
  const statusStmt = db.prepare(`SELECT status FROM memory_contradictions WHERE agent_id = ? AND key_a = ? AND key_b = ?`);
  const retirements: Array<{ victim: string; victimAgent: string; winner: string }> = [];
  for (const f of found) {
    const [ka, kb] = f.a.key < f.b.key ? [f.a.key, f.b.key] : [f.b.key, f.a.key];
    // Operator override wins forever: previously-reviewed pairs are never auto-resolved or re-opened.
    const existing = statusStmt.get(agentId, ka, kb) as { status: string } | undefined;
    if (existing && existing.status !== "open") continue;
    if (suppressed.has(f)) {
      // TKG-T3 — LLM said compatible: dismiss so it never re-flags; no operator noise.
      try {
        db.prepare(`INSERT INTO memory_contradictions(agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by, surfaced_at, reviewed_at, resolution_mode)
          VALUES (?, ?, ?, ?, ?, ?, 'dismissed', ?, ?, ?, 'auto-llm')
          ON CONFLICT(agent_id, key_a, key_b) DO UPDATE SET status='dismissed', reviewed_at=excluded.reviewed_at, resolution_mode='auto-llm'`)
          .run(agentId, ka, kb, f.sim, f.reason, `LLM adjudicated compatible (suppressed). ${f.detail}`, surfacedBy, now, now);
      } catch { /* pre-migration */ }
      continue;
    }
    if (f.victim) {
      const winner = f.victim === f.a.key ? f.b.key : f.a.key;
      const victimAgent = (f.victim === f.a.key ? f.a.agent_id : f.b.agent_id) ?? agentId;
      autoStmt.run(agentId, ka, kb, f.sim, f.reason, `Auto-resolved: '${f.victim}' superseded by '${winner}'. ${f.detail}`, surfacedBy, now, now);
      retirements.push({ victim: f.victim, victimAgent, winner });
    } else {
      openStmt.run(agentId, ka, kb, f.sim, f.reason, f.detail, surfacedBy, now);
    }
  }
  db.close();
  // Retire AFTER closing this db handle (retireFact opens its own; avoids nested handles on Windows).
  for (const r of retirements) {
    try { retireFact(projectPath, r.victim, r.victimAgent, r.winner, "superseded"); } catch { /* best-effort */ }
  }

  // Best-effort PG mirror (parity). Contradictions are rare → a handful of rows.
  mirrorContradictionsPgAsync(projectPath, agentId, found.map((f) => {
    const [ka, kb] = f.a.key < f.b.key ? [f.a.key, f.b.key] : [f.b.key, f.a.key];
    return { ka, kb, sim: f.sim, reason: f.reason, detail: f.detail };
  }), surfacedBy).catch(() => undefined);

  // R8 — report transiently-skipped facts: a "clean" scan that skipped facts is
  // INCOMPLETE (measured in the R8 E2E: a numeric conflict went unflagged because
  // one fact's embed failed under load and the tool still said "no contradictions ✓").
  return { scanned: facts.length, flagged: found.length, ollamaAvailable: true, skipped: embFails };
}

/**
 * Recall-ready section: kicks a once-per-session BACKGROUND refresh, then synchronously
 * reads existing open contradictions and renders the ⚠️ section. Returns "" when there are
 * none (so a clean memory's recall output is unchanged). NEVER embeds on this call.
 */
export function formatContradictionsSection(projectPath: string, agentId: string): string {
  maybeScanContradictions(projectPath, agentId);
  const open = listOpenContradictions(projectPath, agentId);
  if (open.length === 0) return "";
  const lines: string[] = [
    `\n## ⚠️ Suspected Contradictions (${open.length})`,
    `These memory pairs look like they conflict — review and resolve (zc_forget one, re-zc_remember with a resolution, or zc_memory_contradictions to manage). NEVER auto-applied.`,
  ];
  for (const c of open) {
    lines.push(`  • \`${c.key_a}\` ⇄ \`${c.key_b}\`  [${c.reason}, sim=${c.similarity.toFixed(2)}] — ${c.detail}`);
  }
  return lines.join("\n");
}

/** Synchronous read of OPEN contradictions (used by recall + the tool — never embeds). */
export function listOpenContradictions(projectPath: string, agentId: string): OpenContradiction[] {
  const db = openDb(projectPath);
  let rows: OpenContradiction[] = [];
  try {
    rows = db.prepare(`
      SELECT key_a, key_b, similarity, reason, detail
      FROM memory_contradictions
      WHERE (agent_id = ? OR agent_id = 'default') AND status = 'open'
      ORDER BY surfaced_at DESC
      LIMIT 20
    `).all(agentId) as unknown as OpenContradiction[];
  } catch { /* table absent on a pre-migration DB */ }
  db.close();
  return rows;
}

/** Mark a contradiction reviewed (dismissed / acknowledged / resolved). Returns rows changed. */
export function reviewContradiction(
  projectPath: string,
  agentId: string,
  keyA: string,
  keyB: string,
  status: "dismissed" | "acknowledged" | "resolved",
  mode?: string,
): number {
  const [ka, kb] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
  const db = openDb(projectPath);
  ensureTable(db);
  let changed = 0;
  try {
    const r = db.prepare(`
      UPDATE memory_contradictions SET status = ?, reviewed_at = ?, resolution_mode = ?
      WHERE agent_id = ? AND key_a = ? AND key_b = ?
    `).run(status, new Date().toISOString(), mode ?? null, agentId, ka, kb) as { changes: number };
    changed = r.changes;
  } catch { /* table absent */ }
  db.close();
  return changed;
}

// ─── Per-process background-scan guard ──────────────────────────────────────

const scannedThisProcess = new Set<string>();

/**
 * Fire-and-forget background scan, AT MOST ONCE per (project, agent) per server PROCESS.
 * The in-process MCP server is short-lived (one per agent session), so here this is
 * effectively once-per-session; the long-lived api-server daemon re-arms its own guard
 * on every write. Called by zc_recall_context so surfaced contradictions stay fresh
 * WITHOUT adding embedding latency to recall (recall reads existing rows synchronously).
 *
 * The guard means "scanned SUCCESSFULLY": if Ollama is down (no embeddings computed) the
 * key is released so a later recall retries — one outage must not disable auto-scan for
 * the life of the process.
 */
export function maybeScanContradictions(projectPath: string, agentId: string): void {
  const key = `${projectPath}::${agentId}`;
  if (scannedThisProcess.has(key)) return;
  scannedThisProcess.add(key); // optimistic — avoids a double-kick within one recall burst
  detectContradictions(projectPath, agentId, "cron")
    .then((r) => { if (!r || r.ollamaAvailable === false) scannedThisProcess.delete(key); })
    .catch(() => { scannedThisProcess.delete(key); });
}

/**
 * Re-arm the scan for a (project, agent) so the next recall re-scans — called after a
 * working-memory write so a newly-recorded fact's contradictions are detected within the
 * same process (in-process parity with the daemon's write-time re-arm). When agentId is
 * omitted, re-arms every agent on the project (a write under the shared 'default' pool can
 * conflict with any agent's facts).
 */
export function rearmContradictionScan(projectPath: string, agentId?: string): void {
  if (agentId) { scannedThisProcess.delete(`${projectPath}::${agentId}`); return; }
  for (const k of scannedThisProcess) if (k.startsWith(projectPath + "::")) scannedThisProcess.delete(k);
}

// ─── Best-effort PG mirror ──────────────────────────────────────────────────

async function mirrorContradictionsPgAsync(
  projectPath: string,
  agentId: string,
  rows: Array<{ ka: string; kb: string; sim: number; reason: string; detail: string }>,
  surfacedBy: string,
): Promise<void> {
  if (!process.env.ZC_POSTGRES_HOST && !process.env.ZC_POSTGRES_PASSWORD) return;
  if (rows.length === 0) return;
  try {
    const { withClient } = await import("./pg_pool.js");
    const projectHash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
    await withClient(async (c) => {
      for (const r of rows) {
        await c.query(
          `INSERT INTO memory_contradictions_pg(project_hash, agent_id, key_a, key_b, similarity, reason, detail, status, surfaced_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8)
           ON CONFLICT (project_hash, agent_id, key_a, key_b) DO UPDATE SET
             similarity = EXCLUDED.similarity, reason = EXCLUDED.reason,
             detail = EXCLUDED.detail, surfaced_at = NOW()`,
          [projectHash, agentId, r.ka, r.kb, r.sim, r.reason, r.detail, surfacedBy],
        );
      }
    });
  } catch {
    // best-effort — SQLite is authoritative for the agent's own reads
  }
}
