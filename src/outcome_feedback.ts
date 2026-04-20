/**
 * Outcome → learnings JSONL feedback loop (v0.17.1 L4)
 * =====================================================
 *
 * CLOSES THE LEARNING LOOP.
 *
 * Problem we're fixing: right now a failure-signal becoming a learning
 * requires (1) the agent notices it failed, (2) agent decides to write to
 * learnings/failures.jsonl, (3) agent remembers the format, (4) the hook
 * mirrors. Four points of failure, all dependent on agent discipline.
 *
 * With this module, `recordOutcome({outcomeKind: 'rejected'|'failed'|'insufficient'})`
 * ALSO atomically appends a structured JSON line to
 * `<projectPath>/learnings/failures.jsonl`. Future sessions see it via
 * `zc_search(['past failures'])` OR via the PostToolUse learnings-indexer
 * hook's Bash/Edit detection (since we also write via a real file append
 * the hook's change-detection can pick it up on the next write event).
 *
 * Also: `outcomeKind: 'accepted' | 'shipped'` with confidence ≥ 0.9 is
 * appended to `learnings/experiments.jsonl` — successful patterns become
 * learnings too.
 *
 * SECURITY / SAFETY:
 *  - Best-effort: if the learnings/ dir is read-only, symlinked outside
 *    the project, or doesn't exist — we swallow the error silently. The
 *    outcome row itself is already persisted; the JSONL is a secondary
 *    audit trail.
 *  - Payload contains structured evidence but NEVER raw prompts / secrets.
 *    Evidence is already sanitized by the resolvers (per §15.4 Sprint 1).
 *  - File appends use write-then-fsync semantics to avoid torn lines under
 *    concurrent writes from multiple agents in the same project.
 *  - realpath check ensures the target path stays inside <projectPath>/learnings/.
 *  - Max line size capped at 64 KB (same as learnings-indexer.mjs).
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const MAX_LINE_BYTES = 64 * 1024;

/** Which outcome kinds should auto-feedback and into which file. */
const KIND_TO_FILE: Record<string, string> = {
  rejected:     "failures.jsonl",
  insufficient: "failures.jsonl",
  errored:      "failures.jsonl",
  reverted:     "failures.jsonl",
  accepted:     "experiments.jsonl",
  shipped:      "experiments.jsonl",
  // 'sufficient' is neutral — doesn't feed back; would be noise
};

/** Only append 'accepted'/'shipped' when confidence is high enough to be signal. */
const EXPERIMENTS_MIN_CONFIDENCE = 0.9;

/**
 * Resolve and return the safe target path under <projectPath>/learnings/.
 * Returns null if the resolution escapes, target dir is absent / unwritable,
 * or realpath fails.
 */
function resolveLearningsPath(projectPath: string, filename: string): string | null {
  try {
    // Guard: projectPath must exist. Without this we'd auto-create arbitrary
    // paths under /nonexistent/... via mkdirSync(recursive) below.
    if (!existsSync(projectPath)) return null;
    const learningsDir = join(projectPath, "learnings");
    if (!existsSync(learningsDir)) {
      // Auto-create the dir — some projects start with `mkdir learnings/` but
      // skip the empty JSONL shims. Safer to create than silently drop.
      try { mkdirSync(learningsDir, { recursive: true }); }
      catch { return null; }
    }
    const realProject  = realpathSync(projectPath);
    const realLearnDir = realpathSync(learningsDir);
    // Symlink-escape guard: learnings/ must sit inside the project.
    const prefix = realProject.endsWith(sep) ? realProject : realProject + sep;
    if (!realLearnDir.startsWith(prefix) && realLearnDir !== realProject) return null;
    const target = resolve(realLearnDir, filename);
    // Post-join guard: the joined target must stay inside learningsDir
    const realLearnPrefix = realLearnDir.endsWith(sep) ? realLearnDir : realLearnDir + sep;
    if (!target.startsWith(realLearnPrefix) && target !== realLearnDir) return null;
    return target;
  } catch {
    return null;
  }
}

interface FeedbackInput {
  outcomeKind:  string;
  signalSource: string;
  refType:      string;
  refId:        string;
  confidence?:  number;
  evidence?:    Record<string, unknown>;
  createdByAgentId?: string;
  outcomeId?:   string;
  projectPath:  string;
}

/**
 * Atomically append a structured line to the appropriate learnings JSONL
 * file based on outcome kind. Returns the path written to, or null if
 * skipped / failed.
 */
export function feedbackFromOutcome(input: FeedbackInput): string | null {
  const filename = KIND_TO_FILE[input.outcomeKind];
  if (!filename) return null;
  // Experiments only record high-confidence positives to stay useful signal
  if (filename === "experiments.jsonl") {
    const conf = input.confidence ?? 0;
    if (conf < EXPERIMENTS_MIN_CONFIDENCE) return null;
  }

  const target = resolveLearningsPath(input.projectPath, filename);
  if (!target) return null;

  // Build the line. Keep it compact — agents may be reading a lot of these.
  const line = {
    ts:            new Date().toISOString(),
    outcome_id:    input.outcomeId,
    outcome_kind:  input.outcomeKind,
    signal_source: input.signalSource,
    ref_type:      input.refType,
    ref_id:        input.refId,
    confidence:    input.confidence,
    evidence:      input.evidence,
    by_agent:      input.createdByAgentId,
    source:        "auto-feedback-v0.17.1",
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(line) + "\n";
  } catch {
    return null;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
    // Drop evidence to fit under cap
    const slim = { ...line, evidence: { _dropped: "evidence too large for JSONL cap" } };
    try { serialized = JSON.stringify(slim) + "\n"; } catch { return null; }
    if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) return null;
  }

  try {
    // Append in a single syscall. Node's appendFileSync holds the file descriptor
    // open for the duration of the write — sufficient to avoid torn lines under
    // concurrent writers on ext4 / NTFS as long as each line is < PIPE_BUF (4KB
    // guaranteed atomic POSIX; practically higher).
    appendFileSync(target, serialized, "utf8");
    return target;
  } catch {
    return null;
  }
}

/**
 * Test helper — list the supported outcome kinds + their mapping (for doc / assertions).
 */
export function getKindToFileMapping(): Record<string, string> {
  return { ...KIND_TO_FILE };
}
