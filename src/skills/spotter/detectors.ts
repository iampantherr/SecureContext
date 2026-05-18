/**
 * v0.28.0-α — Skill-spotter detector library.
 *
 * Pure SQL-driven signal mining over tool_calls_pg + pretool_events_pg +
 * skill_runs_pg + mutation_results_pg. No LLM, no agent process — these
 * functions just produce SkillSignal objects the v0.28.0-β spotter agent
 * (or a human operator) can review.
 *
 * Each detector returns 0..N signals. A signal is a structured observation
 * that some pattern crossed a threshold; it's NOT yet a skill candidate —
 * the β step's LLM applies the four Anthropic skill-quality gates
 * (procedural-not-factual / clear-trigger / ≥3-repeats / progressive-disclosure-leverage)
 * to decide which signals become real candidates in skill_candidates_pg.
 *
 * v0.28.0-α ships:
 *   - repeated_tool_sequence    (real, fires on N-gram repeats in tool_calls_pg)
 *   - repeated_doc_read         (real, fires on same-file repeated Read events)
 *
 * Stubbed (γ adds these once we have bash-command storage):
 *   - external_script_invocation
 *   - uncredited_high_cost_task
 *   - rejected_mutation_cluster
 *   - repeated_prompt_fragment
 *
 * Threshold defaults are conservative — we'd rather miss a few real
 * candidates than flood the operator with low-quality noise.
 */

import { withClient } from "../../pg_pool.js";

export type SignalType =
  | "repeated_tool_sequence"
  | "external_script_invocation"
  | "repeated_prompt_fragment"
  | "uncredited_high_cost_task"
  | "rejected_mutation_cluster"
  | "repeated_doc_read";

export interface SkillSignal {
  signal_type:        SignalType;
  occurrences:        number;
  /** 0.0–1.0. α uses simple heuristics: occurrence count + cross-session ratio. */
  confidence:         number;
  /** Session IDs + tool-call IDs the detector grouped together. Lets reviewer drill in. */
  evidence: {
    session_ids:      string[];
    tool_call_ids?:   string[];
    pretool_event_ids?: number[];
    file_paths?:      string[];
    tool_sequence?:   string[];
  };
  /** Best-guess "use this whenever <X>" sentence. β agent will refine. */
  proposed_trigger?:  string;
  /** Best-guess procedural outline (3–7 bullet steps). β agent will refine. */
  proposed_steps?:    string[];
  /** Best-guess kebab-case skill name. β agent will refine. */
  proposed_name_hint?: string;
  /** "low" | "medium" | "high" — how hard to formalize. */
  effort_estimate?:   "low" | "medium" | "high";
}

export interface DetectorOptions {
  /** Rolling window in days. Default 7. */
  windowDays?: number;
  /** Minimum repeated occurrences to emit a signal. Default 3. */
  minOccurrences?: number;
  /** N-gram length for repeated_tool_sequence (3–5). Default 3. */
  ngram?: number;
  /** Cap on signals per detector — prevents one detector from drowning others. Default 20. */
  maxSignals?: number;
}

/**
 * Detector #1: repeated tool-call N-grams.
 *
 * Mines tool_calls_pg for sliding-window tool_name N-grams. When the same
 * N-gram appears in ≥minOccurrences distinct sessions, it's a candidate
 * procedural pattern.
 *
 * Filters: ignores agent-housekeeping calls (zc_recall_context,
 * zc_remember, zc_search) — those are noise from the harness itself, not
 * procedural patterns from the agent's work.
 */
export async function detectRepeatedToolSequences(opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  const windowDays     = opts.windowDays ?? 7;
  const minOccurrences = opts.minOccurrences ?? 3;
  const ngram          = Math.max(2, Math.min(5, opts.ngram ?? 3));
  const maxSignals     = opts.maxSignals ?? 20;

  // Tools that are agent-internal housekeeping and not "real" procedural work.
  // We exclude them from N-grams so they don't dominate the signal.
  const HOUSEKEEPING = new Set([
    "zc_recall_context",
    "zc_remember",
    "zc_search",
    "zc_search_global",
    "zc_check",
    "zc_context_status",
    "zc_file_summary",
    "zc_status",
    "zc_logs",
    "zc_summarize_session",
  ]);

  // Fetch ordered tool sequences per session
  type Row = { session_id: string; tool_name: string; call_id: string; ts: string };
  const rows = await withClient(async (c) => {
    const r = await c.query<Row>(
      `SELECT session_id, tool_name, call_id, ts::text
         FROM tool_calls_pg
        WHERE ts > now() - ($1::int || ' days')::interval
          AND tool_name IS NOT NULL
        ORDER BY session_id, ts`,
      [windowDays],
    );
    return r.rows;
  });

  // Build sessions: session_id → [(tool_name, call_id)]
  const sessions = new Map<string, Array<{ name: string; call_id: string }>>();
  for (const row of rows) {
    if (HOUSEKEEPING.has(row.tool_name)) continue;
    if (!sessions.has(row.session_id)) sessions.set(row.session_id, []);
    sessions.get(row.session_id)!.push({ name: row.tool_name, call_id: row.call_id });
  }

  // Extract N-grams per session; track per-ngram which sessions saw it
  const ngramIndex = new Map<string, {
    sessions: Set<string>;
    call_ids: string[];
    sequence: string[];
  }>();

  for (const [sid, seq] of sessions.entries()) {
    if (seq.length < ngram) continue;
    for (let i = 0; i <= seq.length - ngram; i++) {
      const slice = seq.slice(i, i + ngram);
      const key = slice.map((s) => s.name).join("→");
      if (!ngramIndex.has(key)) {
        ngramIndex.set(key, {
          sessions: new Set(),
          call_ids: [],
          sequence: slice.map((s) => s.name),
        });
      }
      const idx = ngramIndex.get(key)!;
      idx.sessions.add(sid);
      for (const s of slice) idx.call_ids.push(s.call_id);
    }
  }

  // Filter to N-grams that appear in ≥ minOccurrences distinct sessions
  const candidates = Array.from(ngramIndex.entries())
    .filter(([_, v]) => v.sessions.size >= minOccurrences)
    .sort((a, b) => b[1].sessions.size - a[1].sessions.size)
    .slice(0, maxSignals);

  return candidates.map(([key, v]) => {
    const sessionCount = v.sessions.size;
    // Confidence: scales 0.4 (minimum) → 0.9 by session count
    const confidence = Math.min(0.9, 0.4 + 0.1 * (sessionCount - minOccurrences + 1));
    return {
      signal_type: "repeated_tool_sequence" as const,
      occurrences: sessionCount,
      confidence: Number(confidence.toFixed(2)),
      evidence: {
        session_ids:    Array.from(v.sessions).slice(0, 10),
        tool_call_ids:  v.call_ids.slice(0, 30),
        tool_sequence:  v.sequence,
      },
      proposed_trigger: `When the user asks for an outcome that requires the tool sequence ${key}`,
      proposed_steps:   v.sequence.map((tn, i) => `Step ${i + 1}: invoke ${tn}`),
      proposed_name_hint: slugify(v.sequence.join("-then-")),
      effort_estimate:  v.sequence.length <= 3 ? "low" : "medium",
    };
  });
}

/**
 * Detector #2: repeated file reads across sessions.
 *
 * Mines pretool_events_pg for the same file_path being Read in ≥N
 * distinct sessions. Strong signal that the file IS a reference doc and
 * agents are re-reading it to follow a procedure — could become a skill
 * that bakes the relevant chunk into L2 + cites the source.
 *
 * Filters out very common files (SKILL.md, CLAUDE.md, README.md) since
 * those are infrastructure reads, not user-procedure reads.
 */
export async function detectRepeatedDocReads(opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  const windowDays     = opts.windowDays ?? 7;
  const minOccurrences = opts.minOccurrences ?? 3;
  const maxSignals     = opts.maxSignals ?? 20;

  // Aggregate Read events: per file_path, count distinct sessions
  type Row = { file_path: string; session_count: string; pretool_event_ids: number[] };
  const rows = await withClient(async (c) => {
    const r = await c.query<Row>(
      `SELECT
          file_path,
          COUNT(DISTINCT (agent_id, project_hash))::text AS session_count,
          array_agg(id ORDER BY ts DESC) FILTER (WHERE id IS NOT NULL) AS pretool_event_ids
         FROM pretool_events_pg
        WHERE ts > now() - ($1::int || ' days')::interval
          AND tool_name = 'Read'
          AND file_path IS NOT NULL
          AND file_path NOT ILIKE '%CLAUDE.md'
          AND file_path NOT ILIKE '%SKILL.md'
          AND file_path NOT ILIKE '%README.md'
        GROUP BY file_path
        HAVING COUNT(DISTINCT (agent_id, project_hash)) >= $2
        ORDER BY 2 DESC
        LIMIT $3`,
      [windowDays, minOccurrences, maxSignals],
    );
    return r.rows;
  });

  return rows.map((row) => {
    const sessionCount = Number(row.session_count);
    const confidence = Math.min(0.85, 0.4 + 0.08 * (sessionCount - minOccurrences + 1));
    const fileBasename = row.file_path.split(/[/\\]/).pop() ?? row.file_path;
    return {
      signal_type: "repeated_doc_read" as const,
      occurrences: sessionCount,
      confidence: Number(confidence.toFixed(2)),
      evidence: {
        session_ids:       [],
        pretool_event_ids: (row.pretool_event_ids ?? []).slice(0, 20),
        file_paths:        [row.file_path],
      },
      proposed_trigger:  `When the user's task requires consulting ${fileBasename}`,
      proposed_steps:    [
        `Step 1: load relevant chunk of ${fileBasename} (cache as L2 reference)`,
        `Step 2: extract the user-task-relevant section`,
        `Step 3: apply the procedure declared in that section`,
      ],
      proposed_name_hint: slugify(`use-${fileBasename.replace(/\.[^.]+$/, "")}`),
      effort_estimate:   "low",
    };
  });
}

/**
 * γ stub — external script invocations (python /path/script.py …).
 *
 * Will read bash command bodies once we have a Bash-capture table.
 * For now returns empty so the API contract is stable.
 */
export async function detectExternalScriptInvocations(_opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  return [];
}

/** γ stub — high-cost tasks that completed without zc_record_skill_outcome. */
export async function detectUncreditedHighCostTasks(_opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  return [];
}

/** γ stub — clusters of rejected skill candidates pointing at the same gap. */
export async function detectRejectedMutationClusters(_opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  return [];
}

/** γ stub — repeated user-prompt fragments (needs prompt-text storage). */
export async function detectRepeatedPromptFragments(_opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  return [];
}

/**
 * Run every detector and return the aggregated, deduplicated list.
 * Detectors run in parallel — they hit different tables and don't conflict.
 */
export async function runAllDetectors(opts: DetectorOptions = {}): Promise<SkillSignal[]> {
  const results = await Promise.all([
    detectRepeatedToolSequences(opts),
    detectRepeatedDocReads(opts),
    detectExternalScriptInvocations(opts),
    detectUncreditedHighCostTasks(opts),
    detectRejectedMutationClusters(opts),
    detectRepeatedPromptFragments(opts),
  ]);
  return results.flat();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
