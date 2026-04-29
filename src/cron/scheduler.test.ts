/**
 * Tests for v0.18.0 — cron Scheduler.
 *
 * Covers:
 *   - nextDailyAt: today vs tomorrow logic
 *   - computeNextRun: interval + daily branches; throws when neither set
 *   - tick(): runs jobs that are due, skips not-yet-due
 *   - tick(): captures errors as ok=false in history
 *   - registered jobs persist across new Scheduler instances via stateFile
 *   - getJobs / getHistory return diagnostic shape
 *   - start/stop lifecycle (no leaks, idempotent)
 *   - clock injection lets us step time deterministically
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler, nextDailyAt, computeNextRun } from "./scheduler.js";

let tmp: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "cron-test-")); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

describe("v0.18.0 cron — nextDailyAt", () => {

  it("schedules today when HH:MM is later today", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();  // 10:00
    const next = nextDailyAt("14:00", now);
    expect(new Date(next).getHours()).toBe(14);
    expect(new Date(next).toDateString()).toBe(new Date(now).toDateString());
  });

  it("schedules tomorrow when HH:MM has already passed today", () => {
    const now = new Date(2026, 0, 1, 14, 0, 0).getTime();
    const next = nextDailyAt("10:00", now);
    expect(new Date(next).getHours()).toBe(10);
    // One day later
    const expectedDay = new Date(2026, 0, 2).toDateString();
    expect(new Date(next).toDateString()).toBe(expectedDay);
  });

  it("rejects malformed HH:MM", () => {
    expect(() => nextDailyAt("not-a-time")).toThrow();
    expect(() => nextDailyAt("25:00")).toThrow();
    expect(() => nextDailyAt("01:99")).toThrow();
  });
});

describe("v0.18.0 cron — computeNextRun", () => {

  it("uses interval_ms when set", () => {
    const now = 1_000_000;
    const job = { id: "j", description: "", next_run_ms: 0, interval_ms: 5000, work: async () => {} };
    expect(computeNextRun(job, now)).toBe(1_005_000);
  });

  it("uses daily_at_local when set", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const job = { id: "j", description: "", next_run_ms: 0, daily_at_local: "14:00", work: async () => {} };
    expect(new Date(computeNextRun(job, now)).getHours()).toBe(14);
  });

  it("throws when neither set", () => {
    const job = { id: "j", description: "", next_run_ms: 0, work: async () => {} };
    expect(() => computeNextRun(job)).toThrow();
  });
});

describe("v0.18.0 cron — Scheduler.tick", () => {

  it("runs a due job and updates next_run_ms", async () => {
    let clock = 0;
    const sched = new Scheduler({ clock: () => clock });
    let ran = 0;
    sched.register({
      id: "j1", description: "", next_run_ms: 100, interval_ms: 1000,
      work: async () => { ran++; },
    });
    clock = 200;
    const r = await sched.tick();
    expect(ran).toBe(1);
    expect(r.length).toBe(1);
    expect(r[0].ok).toBe(true);
    expect(sched.getJobs()[0].next_run_ms).toBe(1200);  // 200 + 1000
  });

  it("skips a job that's not yet due", async () => {
    let clock = 0;
    const sched = new Scheduler({ clock: () => clock });
    let ran = 0;
    sched.register({ id: "j", description: "", next_run_ms: 1000, interval_ms: 1000, work: async () => { ran++; } });
    clock = 500;
    await sched.tick();
    expect(ran).toBe(0);
  });

  it("captures thrown errors as ok=false; does not crash subsequent ticks", async () => {
    let clock = 0;
    const sched = new Scheduler({ clock: () => clock });
    let ran = 0;
    sched.register({
      id: "fail", description: "", next_run_ms: 0, interval_ms: 1000,
      work: async () => { ran++; throw new Error("boom"); },
    });
    const r = await sched.tick();
    expect(ran).toBe(1);
    expect(r[0].ok).toBe(false);
    expect(r[0].error).toBe("boom");
    // History recorded
    expect(sched.getHistory().length).toBe(1);
    // Subsequent tick still runs (job rescheduled)
    clock = 1500;
    await sched.tick();
    expect(ran).toBe(2);
  });

  it("multiple due jobs run in registration order", async () => {
    let clock = 100;
    const sched = new Scheduler({ clock: () => clock });
    const order: string[] = [];
    sched.register({ id: "a", description: "", next_run_ms: 0, interval_ms: 1000, work: async () => { order.push("a"); } });
    sched.register({ id: "b", description: "", next_run_ms: 0, interval_ms: 1000, work: async () => { order.push("b"); } });
    sched.register({ id: "c", description: "", next_run_ms: 200, interval_ms: 1000, work: async () => { order.push("c"); } });  // not due
    await sched.tick();
    expect(order).toEqual(["a", "b"]);
  });
});

describe("v0.18.0 cron — persistence", () => {

  it("next_run_ms persists across Scheduler instances", async () => {
    const stateFile = join(tmp, "state.json");
    let clock = 100;
    {
      const s1 = new Scheduler({ stateFile, clock: () => clock });
      s1.register({ id: "j", description: "", next_run_ms: 0, interval_ms: 5000, work: async () => {} });
      await s1.tick();  // runs once → next_run_ms = 5100
    }
    expect(existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted.next_run_ms.j).toBe(5100);

    // New Scheduler picks up persisted next_run_ms
    let ran = 0;
    const s2 = new Scheduler({ stateFile, clock: () => clock });
    s2.register({ id: "j", description: "", next_run_ms: 0, interval_ms: 5000, work: async () => { ran++; } });
    expect(s2.getJobs()[0].next_run_ms).toBe(5100);
    // At t=100 it shouldn't run yet
    await s2.tick();
    expect(ran).toBe(0);
    // Advance past 5100 — runs
    clock = 5500;
    await s2.tick();
    expect(ran).toBe(1);
  });
});

describe("v0.18.0 cron — Scheduler lifecycle", () => {

  it("start() then stop() doesn't leak", () => {
    const s = new Scheduler();
    s.start(10_000);
    s.stop();
    s.stop();  // idempotent
  });

  it("getJobs returns diagnostic shape", () => {
    const s = new Scheduler();
    s.register({ id: "j", description: "test job", next_run_ms: 100, interval_ms: 1000, work: async () => {} });
    const jobs = s.getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]).toEqual({ id: "j", description: "test job", next_run_ms: 100 });
  });

  it("history is bounded to maxHistory", async () => {
    let clock = 0;
    const s = new Scheduler({ maxHistory: 3, clock: () => clock });
    s.register({ id: "j", description: "", next_run_ms: 0, interval_ms: 1, work: async () => {} });
    for (let i = 0; i < 10; i++) {
      clock += 10;  // each tick the job is due
      await s.tick();
    }
    const h = s.getHistory();
    expect(h.length).toBeLessThanOrEqual(3);
  });
});
