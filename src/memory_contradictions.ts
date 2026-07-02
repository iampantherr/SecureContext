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
import { getEmbedding, cosineSimilarity } from "./embedder.js";
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
): Promise<{ scanned: number; flagged: number; ollamaAvailable: boolean }> {
  const facts = recallWorkingMemory(projectPath, agentId)
    .filter((f) => f.importance >= 3)
    .slice(0, MAX_SCAN_FACTS);
  if (facts.length < 2) return { scanned: facts.length, flagged: 0, ollamaAvailable: true };

  // Embed each fact value on demand; bail cleanly the moment Ollama is unavailable.
  const vectors = new Map<string, Float32Array>();
  for (const f of facts) {
    const emb = await getEmbedding(f.value);
    if (!emb) return { scanned: facts.length, flagged: 0, ollamaAvailable: false };
    vectors.set(f.key, emb.vector);
  }

  const found: Array<{ a: MemoryFact; b: MemoryFact; sim: number; reason: string; detail: string; victim: string | null }> = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]!, b = facts[j]!;
      const va = vectors.get(a.key), vb = vectors.get(b.key);
      if (!va || !vb) continue;
      const sim = cosineSimilarity(va, vb);
      if (sim < SIM_HIGH) continue;
      const conflict = detectConflict(a, b);
      if (!conflict) continue;
      // v0.37.0 — clear supersession ⇒ auto-resolve (retire the stale side); else open triage.
      const victim = Config.AUTO_RESOLVE ? autoResolveVictim(a, b, conflict.reason) : null;
      found.push({ a, b, sim, reason: conflict.reason, detail: conflict.detail, victim });
    }
  }

  const db = openDb(projectPath);
  ensureTable(db);
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

  return { scanned: facts.length, flagged: found.length, ollamaAvailable: true };
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
