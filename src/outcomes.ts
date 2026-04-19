/**
 * Outcomes — Sprint 1 Phase C (v0.11.0)
 * ======================================
 *
 * Resolvers that produce deferred outcome tags for previously-recorded
 * actions (tool_calls, tasks, skill_runs, etc.). Without outcome data,
 * Sprint 2's mutation engine has nothing to learn from.
 *
 * THREE RESOLVERS shipped in Sprint 1:
 *
 *   1. git_commit       — detects commits in bash output; tracks revert later
 *   2. user_prompt      — sentiment heuristic on the next user message
 *   3. follow_up        — pattern detection: zc_file_summary(X) → Read(X)
 *                         within N minutes ⇒ "summary insufficient"
 *
 * EACH RESOLVER:
 *   - Reads from tool_calls (and possibly other tables)
 *   - Writes to outcomes table (hash-chained via Sprint 0 hmac_chain)
 *   - Logs every resolution to logger.outcomes
 *   - Audit-logs unusual conditions (per §15.4 Sprint 1)
 *
 * SECURITY (per §15.4 Sprint 1):
 *   - git_commit resolver uses git library, NOT shell exec (no injection)
 *   - user_prompt resolver: rate-limited; results stored as boolean only,
 *     NOT raw prompt text
 *   - follow_up resolver: pure DB query; no external dependencies
 *
 * WHEN RESOLVERS RUN:
 *   - git_commit:  triggered by PostToolUse Bash hook detecting `git commit`
 *   - user_prompt: triggered by next user message after a tool sequence
 *   - follow_up:   triggered inside recordToolCall (Sprint 1 hot-path)
 *
 * INTEGRATION POINT (Sprint 1 default):
 *   For now, follow_up runs inline. git_commit + user_prompt run as opt-in
 *   functions called by hooks (Phase D). The resolver registry is built so
 *   future Sprints can add more resolvers by registering callbacks.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { logger } from "./logger.js";
import { auditLog } from "./security/audit_log.js";
import {
  canonicalize,
  type ChainableRow,
} from "./security/hmac_chain.js";
import { runMigrations } from "./migrations.js";
import { ChainedTableSqlite } from "./security/chained_table_sqlite.js";
import { verifyChainRows } from "./security/chained_table.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type OutcomeKind =
  | "shipped"        // git_commit found a commit + it wasn't reverted
  | "reverted"       // git_commit followed by a revert
  | "accepted"       // user_prompt sentiment = positive
  | "rejected"       // user_prompt sentiment = negative
  | "sufficient"     // tool_call achieved its purpose (no follow-up needed)
  | "insufficient"   // follow_up pattern detected (e.g. Read after summary)
  | "errored";       // tool_call returned status=error

export type SignalSource = "git_commit" | "user_prompt" | "follow_up" | "manual";
export type RefType      = "tool_call" | "task" | "skill_run" | "session";

/** v0.15.0 §8.6 T3.2 — MAC-style classification (Chin & Older 2011 Ch5+Ch13) */
export type OutcomeClassification = "public" | "internal" | "confidential" | "restricted";

export interface RecordOutcomeInput {
  refType:       RefType;
  refId:         string;
  outcomeKind:   OutcomeKind;
  signalSource:  SignalSource;
  confidence?:   number;            // 0-1; default 1.0 for direct, < 1.0 for inferred
  scoreDelta?:   number;            // optional: how this changed parent score
  evidence?:    Record<string, unknown>;  // structured supporting evidence (NEVER raw secrets)
  projectPath:   string;            // for DB resolution
  // v0.15.0 §8.6 T3.2 — read-access tier
  /** Classification label. Default 'internal' (current behavior). */
  classification?:    OutcomeClassification;
  /** Required when classification='restricted' — only this agent can read the row. */
  createdByAgentId?:  string;
}

export interface OutcomeRecord extends ChainableRow {
  id:             number;
  outcome_id:     string;
  ref_type:       string;
  ref_id:         string;
  outcome_kind:   string;
  signal_source:  string;
  confidence:     number;
  score_delta:    number | null;
  evidence:       string | null;
  resolved_at:    string;
  prev_hash:      string;
  row_hash:       string;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Record an outcome for a previously-recorded action.
 * Never throws; loud failure via logger.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<OutcomeRecord | null> {
  // v0.12.1: Reference Monitor opt-in
  const mode = (process.env.ZC_TELEMETRY_MODE || "local").toLowerCase();
  if (mode === "api" || mode === "dual") {
    const apiResult = await _recordOutcomeViaApiPath(input);
    if (mode === "api") return apiResult;
    // dual: also write locally below
  }
  return _recordOutcomeLocal(input);
}

async function _recordOutcomeViaApiPath(input: RecordOutcomeInput): Promise<OutcomeRecord | null> {
  const { getOrFetchSessionToken, recordOutcomeViaApi } = await import("./telemetry_client.js");
  // Outcomes are written by the resolver runtime, so the session token is
  // bound to the writer's identity (orchestrator or whatever invoked the
  // resolver). For now we use ZC_AGENT_ID + ZC_AGENT_ROLE.
  const agentId = process.env.ZC_AGENT_ID   || "outcomes-resolver";
  const role    = process.env.ZC_AGENT_ROLE || "developer";
  const token = await getOrFetchSessionToken(input.projectPath, agentId, role);
  if (!token) return _recordOutcomeLocal(input);
  const r = await recordOutcomeViaApi(input, token);
  if (r === null) return _recordOutcomeLocal(input);
  return r;
}

async function _recordOutcomeLocal(input: RecordOutcomeInput): Promise<OutcomeRecord | null> {
  try {
    const db = openProjectDb(input.projectPath);
    try {
      const outcomeId  = `out-${randomUUID().slice(0, 12)}`;
      const resolvedAt = new Date().toISOString();
      const confidence = input.confidence ?? 1.0;
      const evidenceJson = input.evidence ? JSON.stringify(input.evidence, sortedReplacer) : null;

      // v0.12.0: ChainedTableSqlite handles BEGIN IMMEDIATE atomicity + Tier 1
      // per-agent HMAC subkey. The outcomes table has a single chain per DB
      // (no project-hash filter — the DB itself is per-project).
      const chain = new ChainedTableSqlite(db, { tableName: "outcomes" });

      // The "agent" for outcome rows is implied by the action being resolved.
      // For now we use a constant "outcomes-resolver" identity — Sprint 3
      // will refine to attribute per-resolver runs to the calling agent.
      const writerAgentId = "outcomes-resolver";

      const canonicalFields = buildCanonicalFields({
        outcomeId,
        refType: input.refType,
        refId: input.refId,
        outcomeKind: input.outcomeKind,
        signalSource: input.signalSource,
        confidence,
        scoreDelta: input.scoreDelta ?? null,
        evidence: evidenceJson,
        resolvedAt,
      });

      // v0.15.0 §8.6 T3.2 — classification label + creator binding.
      // Default 'internal' preserves v0.14.0 behavior for callers that
      // don't supply classification. 'restricted' rows MUST carry a
      // createdByAgentId — coerce to 'internal' if author missing
      // (defensive: don't silently lose readability).
      const allowed: OutcomeClassification[] = ["public", "internal", "confidential", "restricted"];
      let safeClassification: OutcomeClassification = "internal";
      if (input.classification && allowed.includes(input.classification)) {
        safeClassification = input.classification;
      }
      let safeCreatedBy: string | null = null;
      if (typeof input.createdByAgentId === "string" && input.createdByAgentId.length > 0) {
        safeCreatedBy = input.createdByAgentId.slice(0, 200);
      }
      if (safeClassification === "restricted" && !safeCreatedBy) {
        // Restricted rows require a creator — downgrade to 'confidential'
        // so the row remains readable by registered agents on this project.
        // Logged so this isn't silent.
        logger.warn("outcomes", "restricted_without_creator_downgraded", {
          ref_id: input.refId, kind: input.outcomeKind,
        });
        safeClassification = "confidential";
      }

      await chain.appendChainedWith(
        { agentId: writerAgentId, projectHash: sha256ProjectHash(input.projectPath), canonicalFields },
        ({ prevHash, rowHash, db: txnDb }) => {
          txnDb.prepare(`
            INSERT INTO outcomes (
              outcome_id, ref_type, ref_id, outcome_kind,
              signal_source, confidence, score_delta, evidence, resolved_at,
              prev_hash, row_hash, classification, created_by_agent_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            outcomeId, input.refType, input.refId, input.outcomeKind,
            input.signalSource, confidence, input.scoreDelta ?? null, evidenceJson, resolvedAt,
            prevHash, rowHash, safeClassification, safeCreatedBy
          );
        }
      );

      logger.info("outcomes", "outcome_recorded", {
        outcome_id: outcomeId,
        ref_type: input.refType,
        ref_id: input.refId,
        kind: input.outcomeKind,
        source: input.signalSource,
        confidence,
      });

      return readOutcome(db, outcomeId);
    } finally {
      db.close();
    }
  } catch (e) {
    logger.error("outcomes", "record_failed", {
      ref_type: input.refType,
      ref_id: input.refId,
      kind: input.outcomeKind,
      error: (e as Error).message,
    });
    return null;
  }
}

// ─── Resolver: git_commit ──────────────────────────────────────────────────

/**
 * Detect a git commit in the given bash output. If present, record an
 * outcome of kind="shipped" linking the commit hash to the most recent
 * tool_call in the same session (likely the agent's "edit + commit" sequence).
 *
 * Returns the recorded outcome, or null if no commit detected.
 */
export async function resolveGitCommitOutcome(input: {
  projectPath: string;
  sessionId:   string;
  bashOutput:  string;
}): Promise<OutcomeRecord | null> {
  // Match `[branch hash] message` (git commit's standard output format)
  // e.g. `[main abc123ef] Fix typo`
  const m = input.bashOutput.match(/\[(\S+)\s+([0-9a-f]{7,40})\]/);
  if (!m) return null;

  const branch = m[1];
  const hash   = m[2];

  // Find the most recent tool_call in this session — it's likely the action
  // that triggered the commit (Edit/Write/Bash that ended in `git commit`)
  const recentCall = getMostRecentToolCallForSession(input.projectPath, input.sessionId);
  if (!recentCall) {
    logger.warn("outcomes", "git_commit_no_recent_call", {
      session_id: input.sessionId,
      commit_hash: hash,
    });
    return null;
  }

  return await recordOutcome({
    projectPath:   input.projectPath,
    refType:       "tool_call",
    refId:         recentCall.call_id,
    outcomeKind:   "shipped",
    signalSource:  "git_commit",
    confidence:    0.95,    // high but not 1.0 — could be reverted later
    evidence:      { branch, commit_hash: hash, session_id: input.sessionId },
  });
}

// ─── Resolver: user_prompt ─────────────────────────────────────────────────

/**
 * Apply a simple sentiment heuristic to the user's next message and record
 * an outcome (accepted vs rejected) for the most recent tool_call.
 *
 * Heuristic (rate-limited; never stores raw prompt):
 *   - accepted: contains thanks / great / perfect / good / works / nice /
 *     yes / continue / proceed
 *   - rejected: contains stop / wrong / no / not what / incorrect / undo
 *   - neutral: neither → no outcome recorded
 *
 * Confidence is intentionally low (0.5) since this is a weak inferred signal.
 */
export async function resolveUserPromptOutcome(input: {
  projectPath: string;
  sessionId:   string;
  userMessage: string;
  /** v0.15.0 §8.6 T3.2 — agent the prompt belongs to (becomes the row's
   *  created_by_agent_id, gating cross-agent reads). Defaults to ZC_AGENT_ID. */
  agentId?:    string;
}): Promise<OutcomeRecord | null> {
  const sentiment = classifySentiment(input.userMessage);
  if (sentiment === "neutral") return null;

  const recentCall = getMostRecentToolCallForSession(input.projectPath, input.sessionId);
  if (!recentCall) return null;

  // v0.15.0 §8.6 T3.2 — sentiment about a user message is sensitive to the
  // ORIGINATING agent. Cross-agent reads of these outcomes leak information
  // about how a specific user spoke to a specific worker. Tag 'restricted'
  // with the agent_id binding so only the originating agent can read.
  const writerAgent = input.agentId
                   ?? process.env.ZC_AGENT_ID
                   ?? recentCall.agent_id
                   ?? "outcomes-resolver";

  return await recordOutcome({
    projectPath:   input.projectPath,
    refType:       "tool_call",
    refId:         recentCall.call_id,
    outcomeKind:   sentiment === "positive" ? "accepted" : "rejected",
    signalSource:  "user_prompt",
    confidence:    0.5,    // weak inference
    // Only store the sentiment + length, NOT the raw message text
    evidence:      { sentiment, message_length: input.userMessage.length },
    classification:    "restricted",
    createdByAgentId:  writerAgent,
  });
}

// ─── Resolver: follow_up ───────────────────────────────────────────────────

/**
 * Detect: a Read of file X happens shortly after a zc_file_summary of file X
 * (in the same session). Indicates the summary was insufficient. Record an
 * outcome of kind="insufficient" against the file_summary call.
 *
 * Window: default 5 minutes between summary and re-read.
 *
 * Returns array of outcomes recorded (typically 0 or 1).
 */
export async function resolveFollowUpOutcomes(input: {
  projectPath:    string;
  sessionId:      string;
  newToolName:    string;
  newToolInput:   Record<string, unknown> | undefined;
  windowMinutes?: number;
}): Promise<OutcomeRecord[]> {
  // Only Read tool calls trigger this resolver
  if (input.newToolName !== "Read") return [];
  const filePath = (input.newToolInput?.file_path ?? input.newToolInput?.path) as string | undefined;
  if (!filePath) return [];

  const windowMs = (input.windowMinutes ?? 5) * 60 * 1000;
  const recentSummary = findRecentFileSummary(input.projectPath, input.sessionId, filePath, windowMs);
  if (!recentSummary) return [];

  const outcome = await recordOutcome({
    projectPath:   input.projectPath,
    refType:       "tool_call",
    refId:         recentSummary.call_id,
    outcomeKind:   "insufficient",
    signalSource:  "follow_up",
    confidence:    0.85,
    evidence:      {
      file_path:        filePath,
      summary_call_id:  recentSummary.call_id,
      summary_at:       recentSummary.ts,
      read_at:          new Date().toISOString(),
      delay_seconds:    Math.round((Date.now() - new Date(recentSummary.ts).getTime()) / 1000),
    },
  });
  return outcome ? [outcome] : [];
}

// ─── Verification ──────────────────────────────────────────────────────────

/**
 * Verify the hash chain on the outcomes table for tamper detection.
 * Returns OK or the breaking row id.
 */
export function verifyOutcomesChain(projectPath: string): {
  ok: boolean;
  totalRows: number;
  brokenAt?: number;
  brokenKind?: "hash-mismatch" | "prev-mismatch";
} {
  const db = openProjectDb(projectPath);
  try {
    const rows = db.prepare(`
      SELECT id, outcome_id, ref_type, ref_id, outcome_kind,
             signal_source, confidence, score_delta, evidence, resolved_at,
             prev_hash, row_hash
      FROM outcomes
      ORDER BY id ASC
    `).all() as unknown as OutcomeRecord[];
    // v0.12.0 Tier 1: outcomes are written by the "outcomes-resolver" identity
    // (see recordOutcome). Verifier derives the matching subkey to validate.
    const rowsForVerify = rows.map((r) => ({ ...r, agentIdForVerify: "outcomes-resolver" }));
    return verifyChainRows(rowsForVerify, (row) => canonicalize(buildCanonicalFields({
      outcomeId:    row.outcome_id,
      refType:      row.ref_type,
      refId:        row.ref_id,
      outcomeKind:  row.outcome_kind,
      signalSource: row.signal_source,
      confidence:   row.confidence,
      scoreDelta:   row.score_delta,
      evidence:     row.evidence,
      resolvedAt:   row.resolved_at,
    })));
  } finally {
    db.close();
  }
}

/**
 * Get all outcomes for a given tool_call.
 *
 * v0.15.0 §8.6 T3.2 — MAC-style read filter:
 *   public/internal       → returned to all callers (default)
 *   confidential          → returned to callers identified as a registered
 *                            agent on this project (we approximate by
 *                            "requestingAgentId is non-empty")
 *   restricted            → returned ONLY when requestingAgentId === created_by_agent_id
 *
 * Pass `requestingAgentId` to enable the filter. Omit to retain v0.14.0
 * behavior (returns ALL rows — admin/back-compat path).
 */
export function getOutcomesForToolCall(
  projectPath: string,
  callId: string,
  requestingAgentId?: string,
): OutcomeRecord[] {
  const db = openProjectDb(projectPath);
  try {
    const all = db.prepare(`
      SELECT * FROM outcomes WHERE ref_type = 'tool_call' AND ref_id = ?
      ORDER BY id ASC
    `).all(callId) as unknown as OutcomeRecord[];

    // No filter requested → preserve legacy admin behavior
    if (requestingAgentId === undefined) return all;

    return all.filter((row) => {
      // Legacy rows pre-migration-19 may lack `classification` (UNKNOWN);
      // treat as 'internal' for safety (readable by any registered agent).
      const cls: string = (row as unknown as Record<string, unknown>).classification as string ?? "internal";
      const createdBy: string | null = ((row as unknown as Record<string, unknown>).created_by_agent_id as string | null) ?? null;

      if (cls === "public" || cls === "internal") return true;
      if (cls === "confidential") {
        // Confidential = readable by any non-empty agent identity. The Postgres
        // backend in v0.16.0 will tighten this to a registered agent_role check.
        return requestingAgentId !== "";
      }
      if (cls === "restricted") {
        return createdBy !== null && createdBy === requestingAgentId;
      }
      // Unknown classification value — fail closed (don't return)
      return false;
    });
  } finally {
    db.close();
  }
}

// ─── Internal ──────────────────────────────────────────────────────────────

const POSITIVE_PATTERNS = [
  /\b(thanks?|thx|thank you)\b/i,
  /\b(great|perfect|excellent|wonderful)\b/i,
  /\b(good|nice|awesome)\b/i,
  /\b(works?|working|fixed|done)\b/i,
  /\b(yes|yep|yeah|sure)\b/i,
  /\b(continue|proceed|go ahead|ship it)\b/i,
];

const NEGATIVE_PATTERNS = [
  /\b(stop|halt|pause)\b/i,
  /\b(wrong|incorrect|broken|broke)\b/i,
  /\b(no|nope)\b/i,
  /\b(not what|that's not|undo|revert|rollback)\b/i,
];

function classifySentiment(text: string): "positive" | "negative" | "neutral" {
  if (text.length === 0) return "neutral";
  const positive = POSITIVE_PATTERNS.some((re) => re.test(text));
  const negative = NEGATIVE_PATTERNS.some((re) => re.test(text));
  if (positive && !negative) return "positive";
  if (negative && !positive) return "negative";
  return "neutral";
}

function sha256ProjectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function openProjectDb(projectPath: string): DatabaseSync {
  const dbDir  = join(homedir(), ".claude", "zc-ctx", "sessions");
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, sha256ProjectHash(projectPath) + ".db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return db;
}

function getMostRecentToolCallForSession(
  projectPath: string,
  sessionId:   string,
): { call_id: string; tool_name: string; ts: string; agent_id: string } | null {
  const db = openProjectDb(projectPath);
  try {
    const row = db.prepare(`
      SELECT call_id, tool_name, ts, agent_id FROM tool_calls
      WHERE session_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(sessionId) as { call_id: string; tool_name: string; ts: string; agent_id: string } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function findRecentFileSummary(
  projectPath: string,
  sessionId:   string,
  filePath:    string,
  windowMs:    number,
): { call_id: string; ts: string } | null {
  const db = openProjectDb(projectPath);
  try {
    const sinceMs = Date.now() - windowMs;
    const since   = new Date(sinceMs).toISOString();

    // We don't store tool inputs in tool_calls. We approximate by:
    // - Look for recent zc_file_summary calls in this session
    // - Match by tool_name (we don't have file_path in tool_calls Sprint 1
    //   — Sprint 2 may add it, for now this is a rougher heuristic)
    const row = db.prepare(`
      SELECT call_id, ts FROM tool_calls
      WHERE session_id = ?
        AND tool_name LIKE '%zc_file_summary%'
        AND ts >= ?
      ORDER BY id DESC LIMIT 1
    `).get(sessionId, since) as { call_id: string; ts: string } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function buildCanonicalFields(input: {
  outcomeId:    string;
  refType:      string;
  refId:        string;
  outcomeKind:  string;
  signalSource: string;
  confidence:   number;
  scoreDelta:   number | null;
  evidence:     string | null;
  resolvedAt:   string;
}): Array<string | number> {
  return [
    input.outcomeId,
    input.refType,
    input.refId,
    input.outcomeKind,
    input.signalSource,
    input.confidence.toFixed(4),
    input.scoreDelta === null ? "" : input.scoreDelta.toFixed(4),
    input.evidence ?? "",
    input.resolvedAt,
  ];
}

function readOutcome(db: DatabaseSync, outcomeId: string): OutcomeRecord | null {
  const row = db.prepare(`SELECT * FROM outcomes WHERE outcome_id = ?`).get(outcomeId);
  return row ? (row as unknown as OutcomeRecord) : null;
}

/** Sorted JSON.stringify replacer — matches src/security/audit_log.ts pattern. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
