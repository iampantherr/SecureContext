/**
 * Lightweight cron-style scheduler (v0.18.0 Sprint 2)
 * ====================================================
 *
 * In-process scheduler primitive used by the nightly mutation cycle and
 * other recurring tasks (chain re-verify, log rotation, etc.).
 *
 * Scope:
 *   - Daily / weekly / N-minute intervals (NO cron-expression parsing for v1)
 *   - Persistent next-run state saved to disk so a process restart resumes
 *   - Run history (last N) kept in-memory for diagnostics
 *
 * Why not depend on `node-cron` / `croner`: zero-deps + we control the
 * persistence + we want the testability of injected clocks.
 *
 * For unattended overnight automation OUTSIDE the running SC process,
 * operators should still use OS cron / Windows Task Scheduler to wake the
 * mutation runner script. This in-process scheduler is for tasks that
 * benefit from running inside SC (DB connections, in-memory caches, etc.).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ScheduledJob {
  /** Stable id used in persistence + logs */
  id:           string;
  /** Human-readable description for diagnostics */
  description:  string;
  /** When this job is next due (ms epoch). Computed from interval_ms or daily_at_local. */
  next_run_ms:  number;
  /** Recurrence: simple interval in ms — set this OR daily_at_local. */
  interval_ms?: number;
  /** Recurrence: daily at HH:MM in local time, e.g. "02:00". */
  daily_at_local?: string;
  /** The work to do. Should be idempotent + non-throwing (errors are caught + logged). */
  work:        () => Promise<void>;
}

export interface JobRunRecord {
  job_id:    string;
  started_at: string;
  ended_at:   string;
  ok:         boolean;
  error?:     string;
}

interface PersistedState {
  last_run_at:  Record<string, number>;  // job_id → ms epoch of last run
  next_run_ms:  Record<string, number>;
}

/**
 * Compute the next time HH:MM occurs in local time, ≥ `now`. Pure function.
 */
export function nextDailyAt(hhmm: string, now: number = Date.now()): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid daily_at_local: ${hhmm}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error(`invalid HH:MM: ${hhmm}`);
  const d = new Date(now);
  const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
  if (candidate > now) return candidate;
  // Already passed today → tomorrow
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hh, mm, 0, 0).getTime();
}

/** Compute the next run time given a job's recurrence policy. */
export function computeNextRun(job: ScheduledJob, now: number = Date.now()): number {
  if (job.daily_at_local) return nextDailyAt(job.daily_at_local, now);
  if (job.interval_ms)    return now + job.interval_ms;
  throw new Error(`job ${job.id}: needs either daily_at_local or interval_ms`);
}

/**
 * In-process scheduler. Constructed with an optional state file path; if
 * provided, the scheduler persists `next_run_ms` per job so a restart
 * picks up where it left off.
 */
export class Scheduler {
  private jobs:       Map<string, ScheduledJob> = new Map();
  private timer:      NodeJS.Timeout | null = null;
  private running:    boolean = false;
  private history:    JobRunRecord[] = [];
  private stateFile:  string | null;
  private maxHistory: number;
  private clock:      () => number;

  constructor(opts: { stateFile?: string; maxHistory?: number; clock?: () => number } = {}) {
    this.stateFile  = opts.stateFile  ?? null;
    this.maxHistory = opts.maxHistory ?? 100;
    this.clock      = opts.clock      ?? Date.now;
  }

  /** Register a job. If state file has a stored next_run_ms for this job_id, that wins. */
  register(job: ScheduledJob): void {
    // Only auto-compute if caller didn't provide a value at all. Note: 0 is a
    // valid sentinel meaning "due now" so we use `=== undefined` not `!val`.
    // (TS treats next_run_ms as required so undefined only happens via JS callers.)
    const provided = (job as unknown as { next_run_ms?: number }).next_run_ms;
    if (provided === undefined || provided === null) {
      job.next_run_ms = computeNextRun(job, this.clock());
    }
    // Restore from persistent state if any (this overrides the caller's value
    // intentionally — that's the point of persistence).
    if (this.stateFile && existsSync(this.stateFile)) {
      try {
        const persisted = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersistedState;
        if (typeof persisted.next_run_ms?.[job.id] === "number") {
          job.next_run_ms = persisted.next_run_ms[job.id];
        }
      } catch { /* corrupt state → keep computed/provided */ }
    }
    this.jobs.set(job.id, job);
  }

  /** Start the scheduler loop. Polls every `tickIntervalMs` (default 1s for tests, 30s for prod). */
  start(tickIntervalMs: number = 30_000): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this._tick(); }, tickIntervalMs);
  }

  /** Stop the loop. Doesn't cancel an in-flight job; that runs to completion. */
  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Run all due jobs once. Public so tests can step the clock manually. */
  async tick(): Promise<JobRunRecord[]> {
    return this._tick();
  }

  private async _tick(): Promise<JobRunRecord[]> {
    const now = this.clock();
    const due = [...this.jobs.values()].filter((j) => j.next_run_ms <= now);
    const results: JobRunRecord[] = [];
    for (const job of due) {
      const startedAt = new Date(now).toISOString();
      let ok = true;
      let error: string | undefined;
      try {
        await job.work();
      } catch (e) {
        ok = false;
        error = (e as Error).message;
      }
      const endedAt = new Date(this.clock()).toISOString();
      const rec: JobRunRecord = { job_id: job.id, started_at: startedAt, ended_at: endedAt, ok, error };
      this.history.push(rec);
      if (this.history.length > this.maxHistory) this.history.shift();
      results.push(rec);
      // Schedule next
      job.next_run_ms = computeNextRun(job, this.clock());
    }
    if (due.length > 0) this._persist();
    return results;
  }

  /** Inspect run history (newest last). */
  getHistory(): JobRunRecord[] {
    return [...this.history];
  }

  /** Inspect registered jobs + their next-run times (for /healthz / dashboards). */
  getJobs(): Array<Pick<ScheduledJob, "id" | "description" | "next_run_ms">> {
    return [...this.jobs.values()].map((j) => ({
      id:           j.id,
      description:  j.description,
      next_run_ms:  j.next_run_ms,
    }));
  }

  private _persist(): void {
    if (!this.stateFile) return;
    try {
      const state: PersistedState = { last_run_at: {}, next_run_ms: {} };
      for (const [id, job] of this.jobs) {
        state.next_run_ms[id]  = job.next_run_ms;
        state.last_run_at[id]  = this.clock();  // approximate
      }
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // Persistence is best-effort; never throw.
    }
  }
}
