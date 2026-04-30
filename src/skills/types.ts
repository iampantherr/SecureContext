/**
 * Skill type definitions (v0.18.0 Sprint 2)
 * ==========================================
 *
 * A "skill" is a versioned, hash-protected markdown document that describes
 * a procedure an agent can execute. Skills are improved over time by the
 * mutation engine: failures and outcomes from past runs feed the proposer,
 * a synthetic-fixture replay validates each candidate, and winners promote.
 *
 * Two scopes:
 *   - global         — `~/.claude/skills/{name}.md`
 *   - project:<hash> — `<project>/.claude/skills/{name}.md` (overrides global)
 *
 * Each skill has:
 *   - structured frontmatter (yaml-ish, parsed as JSON-safe)
 *   - free-form body markdown (the actual procedure)
 *   - HMAC `body_hmac` (per-machine secret) — verified at load to detect
 *     tampering between disk and memory (RT-S2-08 / RT-S2-09)
 *   - acceptance_criteria — composite-score thresholds the skill must hit
 *     to be considered "passing"
 *   - replay fixtures — synthetic inputs the mutation engine validates against
 *
 * Architecture: this file is types-only. Storage / parsing / IO live in
 * sibling modules (storage.ts, loader.ts, scoring.ts, etc.) so the type
 * graph stays small and pluggable.
 */

/** Where a skill lives. Per-project overrides global at resolve time. */
export type SkillScope = "global" | `project:${string}`;

/** Status returned by replay or run. */
export type SkillRunStatus = "succeeded" | "failed" | "timeout";

/**
 * Acceptance criteria — composite score thresholds. The mutation engine
 * uses these to decide if a candidate is a clear winner over the parent.
 *
 * `min_outcome_score`: average of recent skill_runs.outcome_score must
 *   be ≥ this for the skill to be considered healthy.
 * `max_avg_cost_usd`: regression bar — a candidate that costs more than
 *   this on average is rejected even if accuracy is higher.
 * `max_avg_duration_ms`: regression bar for speed.
 * `min_pass_rate`: fraction of replay fixtures that must succeed.
 */
export interface AcceptanceCriteria {
  /** Default 0.7 if unset */
  min_outcome_score?:    number;
  /** Default Infinity if unset (no cost ceiling) */
  max_avg_cost_usd?:     number;
  /** Default Infinity if unset */
  max_avg_duration_ms?:  number;
  /** Default 0.8 if unset */
  min_pass_rate?:        number;
}

/** Replay-fixture descriptor (the synthetic-tests-first approach in D3). */
export interface SkillFixture {
  /** Stable id within the skill (e.g. "happy-path", "edge-empty-input") */
  fixture_id:    string;
  description:   string;
  /** JSON-serializable input passed to the skill at replay time */
  input:         Record<string, unknown>;
  /**
   * Expected outcome shape — used by the scorer. Could be a literal value,
   * a regex pattern, or a composite spec. Kept loose intentionally so
   * different skill kinds (analyze, generate, code-mutate) can each express
   * their own success criterion.
   */
  expected:      Record<string, unknown>;
  /** Optional weight for the composite score. Default 1.0. */
  weight?:       number;
}

/** Frontmatter — structured fields parsed from the top of a skill .md file. */
export interface SkillFrontmatter {
  name:          string;          // e.g. "audit_file"
  version:       string;          // semver-ish: "0.1.0"
  scope:         SkillScope;      // "global" | "project:<hash>"
  description:   string;          // short tagline
  /** v0.18.0: declares whether the skill needs network access (security gate). */
  requires_network?: boolean;
  /** Allowlist of URL prefixes the skill may fetch when requires_network=true. */
  network_allowlist?: string[];
  acceptance_criteria?: AcceptanceCriteria;
  /** Inline fixtures, OR a path-relative `fixtures_dir` for larger sets. */
  fixtures?:     SkillFixture[];
  fixtures_dir?: string;
  /** Inputs the skill expects (informational; not enforced). */
  inputs_schema?: Record<string, unknown>;
  /** Tags for retrieval / categorization. */
  tags?:         string[];
  /**
   * v0.18.4 Sprint 2.7 — agent roles that typically use this skill. Used by
   * the L1 mutation trigger to route the resulting mutator task to the right
   * domain pool (mutator-engineering, mutator-marketing, mutator-legal, etc.)
   * via the mutator_pools mapping in A2A_dispatcher/roles.json.
   *
   * The FIRST role in the array is the primary classifier — that's what gets
   * mapped to a pool. Additional roles are informational. If empty/missing,
   * the skill falls back to mutator-general.
   *
   * Examples:
   *   intended_roles: ["developer"]              → mutator-engineering
   *   intended_roles: ["marketer", "copywriter"] → mutator-marketing
   *   intended_roles: ["legal-counsel"]          → mutator-legal
   */
  intended_roles?: string[];
  /**
   * v0.18.4 Sprint 2.7 — domain-specific guidance the mutator should follow
   * when proposing candidates for THIS skill. Free-form markdown. Injected
   * into the mutator's prompt verbatim, AFTER the pool-level style rules but
   * BEFORE the failure traces.
   *
   * Use this when a skill has genuinely unusual constraints (specific brand
   * voice, regulatory framework, customer segment) that the generic pool
   * prompt can't capture.
   *
   * Example for a legal skill:
   *   mutation_guidance: |
   *     This skill produces customer-facing privacy disclosures.
   *     - Never assert specific obligations as fact; frame as "considerations"
   *     - Reference GDPR Art 13/14 + CCPA §1798.100 by name when relevant
   *     - Always include the "consult counsel" disclaimer at the bottom
   */
  mutation_guidance?: string;
}

/**
 * A skill loaded from disk + DB. The body is the raw markdown after the
 * frontmatter block; body_hmac proves it wasn't tampered between disk
 * write and load.
 */
export interface Skill {
  skill_id:      string;          // "{name}@{version}@{scope}"
  frontmatter:   SkillFrontmatter;
  body:          string;
  body_hmac:     string;          // hex sha256 HMAC over body using machine secret
  source_path:   string | null;   // disk path (null if synthetic)
  promoted_from: string | null;
  created_at:    string;          // ISO timestamp
  archived_at:   string | null;
  archive_reason: string | null;
}

/**
 * One execution of a skill — feeds the scoring + mutation pipeline.
 * outcome_score is composite (accuracy + cost + speed). status records
 * whether the run completed at all.
 */
export interface SkillRun {
  run_id:        string;
  skill_id:      string;
  session_id:    string;
  task_id:       string | null;
  inputs:        Record<string, unknown>;
  outcome_score: number | null;   // null when status=failed/timeout
  total_cost:    number | null;
  total_tokens:  number | null;
  duration_ms:   number | null;
  status:        SkillRunStatus;
  failure_trace: string | null;
  ts:            string;
  // v0.18.2 Sprint 2.6 — retry-cap safeguard. Set true by the worker when it
  // is processing an auto-reassigned retry task (payload had retry_after_promotion=true).
  // The L1 mutation trigger SKIPS mutation when the latest run for a skill was
  // marked this way — preventing infinite mutate→approve→fail→mutate loops.
  was_retry_after_promotion?: boolean;
}

/**
 * A proposed mutation — the candidate + provenance + scoring trail.
 * candidate_hmac proves the body wasn't modified between proposal time
 * and replay time (RT-S2-09).
 */
export interface SkillMutation {
  mutation_id:        string;
  parent_skill_id:    string;
  candidate_body:     string;
  candidate_hmac:     string;
  proposed_by:        string;     // model id, e.g. "claude-sonnet-4-6"
  judged_by:          string | null;
  judge_score:        number | null;
  judge_rationale:    string | null;
  replay_score:       number | null;
  promoted:           boolean;
  promoted_to_skill_id: string | null;
  created_at:         string;
  resolved_at:        string | null;
}

/** Mutator interface — pluggable per D4. */
export interface MutationContext {
  parent:               Skill;
  recent_runs:          SkillRun[];   // last N runs of the parent
  failure_traces:       string[];     // failure_trace[] from those runs
  fixtures:             SkillFixture[]; // for the proposer to consider
  budget?:              { max_cost_usd?: number; max_candidates?: number };
}

export interface MutationCandidate {
  candidate_body:    string;          // proposed new body
  rationale:         string;          // why the proposer thinks this is better
  /** Optional self-rated score 0-1 (some proposers can self-rank) */
  self_rated_score?: number;
}

export interface MutationResult {
  candidates:        MutationCandidate[];
  proposer_model:    string;
  proposer_cost_usd: number;
  /** Selected best candidate index (judges may overlap with proposers) */
  judge_pick_index:  number | null;
  judge_model:       string | null;
  judge_rationale:   string | null;
  /** Aggregate cost (proposer + judge) for this MutationResult */
  total_cost_usd:    number;
}

/** What the orchestrator returns after a full skill→mutate→replay→promote cycle. */
export interface MutationCycleResult {
  skill_id:           string;
  baseline_score:     number;
  candidates_count:   number;
  best_candidate_score: number;
  promoted:           boolean;
  new_skill_id?:      string;
  archived_skill_id?: string;
  total_cost_usd:     number;
  duration_ms:        number;
  reason?:            string;       // for audit (why promoted / why archived)
}
