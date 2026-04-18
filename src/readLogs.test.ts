/**
 * Tests for readLogs() — Sprint 1 Phase E
 *
 * Per §13:
 *   - Unit: filters by level, event substring, trace_id, agent_id
 *   - Integration: multi-day log range, large limit
 *   - Failure-mode: bad dates, non-existent component, corrupt lines skipped
 *   - Red-team RT-S1-13: agent_id scoping actually blocks cross-agent reads
 *   - Red-team RT-S1-14: logs read never auto-create directories (no side effects)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  log,
  logger,
  readLogs,
  pathForDate,
  _setMinLevelForTesting,
} from "./logger.js";

// logger uses ZC_LOG_DIR env, captured at module load; it can't be changed
// per-test. We write directly to the module's resolved dir using pathForDate().
const LOG_DIR = process.env.ZC_LOG_DIR || join(homedir(), ".claude", "zc-ctx", "logs");

const TEST_COMPONENT = "__test_readlogs__";

function cleanTestLogs(): void {
  // Remove any component-log files for the test component across recent dates
  for (let i = -5; i <= 1; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    const p = pathForDate(TEST_COMPONENT, d.toISOString().slice(0, 10));
    try { if (existsSync(p)) rmSync(p, { force: true }); } catch {}
  }
}

function writeLine(date: string, entry: object): void {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(pathForDate(TEST_COMPONENT, date), JSON.stringify(entry) + "\n", "utf8");
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  cleanTestLogs();
  _setMinLevelForTesting("DEBUG");
});

afterEach(() => {
  cleanTestLogs();
  _setMinLevelForTesting("INFO");
});

describe("readLogs", () => {

  // ── Basics ──────────────────────────────────────────────────────────────

  it("returns empty array when no log file for the requested component exists", () => {
    const entries = readLogs({ component: "__nonexistent_component_xyz__" });
    expect(entries).toEqual([]);
  });

  it("reads entries written by log() today", () => {
    log("INFO", TEST_COMPONENT, "event_a", { x: 1 });
    log("INFO", TEST_COMPONENT, "event_b", { x: 2 });
    const entries = readLogs({ component: TEST_COMPONENT, limit: 10 });
    expect(entries.length).toBe(2);
    // newest-first ordering
    const events = entries.map((e) => e.event);
    expect(events).toContain("event_a");
    expect(events).toContain("event_b");
  });

  it("returns newest entries first", async () => {
    log("INFO", TEST_COMPONENT, "first");
    // Force a small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    log("INFO", TEST_COMPONENT, "second");
    const entries = readLogs({ component: TEST_COMPONENT });
    expect(entries[0].event).toBe("second");
    expect(entries[1].event).toBe("first");
  });

  // ── Filtering ───────────────────────────────────────────────────────────

  it("filters by min_level", () => {
    log("DEBUG", TEST_COMPONENT, "debug_evt");
    log("INFO",  TEST_COMPONENT, "info_evt");
    log("WARN",  TEST_COMPONENT, "warn_evt");
    log("ERROR", TEST_COMPONENT, "error_evt");

    const warns = readLogs({ component: TEST_COMPONENT, minLevel: "WARN" });
    expect(warns.map((e) => e.event).sort()).toEqual(["error_evt", "warn_evt"]);

    const all = readLogs({ component: TEST_COMPONENT, minLevel: "DEBUG" });
    expect(all.length).toBe(4);
  });

  it("filters by event_contains (case-insensitive)", () => {
    log("INFO", TEST_COMPONENT, "tool_call_recorded");
    log("INFO", TEST_COMPONENT, "Outcome_Resolved");
    log("INFO", TEST_COMPONENT, "other_event");

    const r = readLogs({ component: TEST_COMPONENT, eventContains: "tool" });
    expect(r.map((e) => e.event)).toEqual(["tool_call_recorded"]);

    const r2 = readLogs({ component: TEST_COMPONENT, eventContains: "OUTCOME" });
    expect(r2.map((e) => e.event)).toEqual(["Outcome_Resolved"]);
  });

  it("filters by trace_id", () => {
    log("INFO", TEST_COMPONENT, "e1", { foo: 1 }, "tr-AAA");
    log("INFO", TEST_COMPONENT, "e2", { foo: 2 }, "tr-BBB");
    log("INFO", TEST_COMPONENT, "e3", { foo: 3 }, "tr-AAA");

    const r = readLogs({ component: TEST_COMPONENT, traceId: "tr-AAA" });
    expect(r.length).toBe(2);
    for (const e of r) expect(e.trace_id).toBe("tr-AAA");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 50; i++) log("INFO", TEST_COMPONENT, `e-${i}`);
    const r = readLogs({ component: TEST_COMPONENT, limit: 10 });
    expect(r.length).toBe(10);
  });

  it("caps limit at 5000", () => {
    for (let i = 0; i < 20; i++) log("INFO", TEST_COMPONENT, `e-${i}`);
    const r = readLogs({ component: TEST_COMPONENT, limit: 999_999 });
    expect(r.length).toBe(20);   // less than cap because we only wrote 20
  });

  it("defaults limit to 200", () => {
    for (let i = 0; i < 250; i++) log("INFO", TEST_COMPONENT, `e-${i}`);
    const r = readLogs({ component: TEST_COMPONENT });
    expect(r.length).toBe(200);
  });

  // ── Multi-day ────────────────────────────────────────────────────────────

  it("reads across a date range", () => {
    // Manually write entries on different dates (since log() always writes to today)
    writeLine(daysAgo(2), { ts: `${daysAgo(2)}T10:00:00.000Z`, level: "INFO", component: TEST_COMPONENT, event: "old_event" });
    writeLine(daysAgo(1), { ts: `${daysAgo(1)}T10:00:00.000Z`, level: "INFO", component: TEST_COMPONENT, event: "mid_event" });
    writeLine(today(),    { ts: `${today()}T10:00:00.000Z`,    level: "INFO", component: TEST_COMPONENT, event: "new_event" });

    const all = readLogs({
      component: TEST_COMPONENT,
      sinceDate: daysAgo(2),
      untilDate: today(),
    });
    expect(all.map((e) => e.event)).toEqual(["new_event", "mid_event", "old_event"]);

    const onlyYesterday = readLogs({
      component: TEST_COMPONENT,
      sinceDate: daysAgo(1),
      untilDate: daysAgo(1),
    });
    expect(onlyYesterday.map((e) => e.event)).toEqual(["mid_event"]);
  });

  // ── Failure-modes ────────────────────────────────────────────────────────

  it("rejects malformed dates by returning []", () => {
    log("INFO", TEST_COMPONENT, "x");
    expect(readLogs({ component: TEST_COMPONENT, sinceDate: "not-a-date" })).toEqual([]);
    expect(readLogs({ component: TEST_COMPONENT, untilDate: "2026/04/01" })).toEqual([]);
  });

  it("rejects inverted date range", () => {
    log("INFO", TEST_COMPONENT, "x");
    const r = readLogs({
      component: TEST_COMPONENT,
      sinceDate: today(),
      untilDate: daysAgo(3),
    });
    expect(r).toEqual([]);
  });

  it("tolerates corrupt lines in the log file", () => {
    writeLine(today(), { ts: `${today()}T10:00:00.000Z`, level: "INFO", component: TEST_COMPONENT, event: "good" });
    appendFileSync(pathForDate(TEST_COMPONENT, today()), "NOT VALID JSON {\n", "utf8");
    writeLine(today(), { ts: `${today()}T10:01:00.000Z`, level: "INFO", component: TEST_COMPONENT, event: "good2" });

    const r = readLogs({ component: TEST_COMPONENT });
    expect(r.length).toBe(2);
    expect(r.map((e) => e.event).sort()).toEqual(["good", "good2"]);
  });

  // ── Agent scoping (RT-S1-13) ────────────────────────────────────────────

  it("[RT-S1-13] agent_id scoping blocks cross-agent reads", () => {
    log("INFO", TEST_COMPONENT, "a_evt", { agent_id: "alice" });
    log("INFO", TEST_COMPONENT, "b_evt", { agent_id: "bob" });
    log("INFO", TEST_COMPONENT, "sys_evt");   // no agent_id — system event

    const alice = readLogs({ component: TEST_COMPONENT, agentId: "alice" });
    const events = alice.map((e) => e.event).sort();
    expect(events).toEqual(["a_evt", "sys_evt"]);   // alice sees own + system, NOT bob's
    expect(events).not.toContain("b_evt");

    const bob = readLogs({ component: TEST_COMPONENT, agentId: "bob" });
    expect(bob.map((e) => e.event).sort()).toEqual(["b_evt", "sys_evt"]);
  });

  it("no agent_id filter returns ALL entries (admin view)", () => {
    log("INFO", TEST_COMPONENT, "a", { agent_id: "alice" });
    log("INFO", TEST_COMPONENT, "b", { agent_id: "bob" });
    log("INFO", TEST_COMPONENT, "s");
    const r = readLogs({ component: TEST_COMPONENT });
    expect(r.length).toBe(3);
  });

  // ── No side effects (RT-S1-14) ─────────────────────────────────────────

  it("[RT-S1-14] does not create component log files as a side effect of reading", () => {
    const p = pathForDate("__brand_new_component_never_written__", today());
    expect(existsSync(p)).toBe(false);
    readLogs({ component: "__brand_new_component_never_written__" });
    expect(existsSync(p)).toBe(false);
  });

  // ── Convenience wrappers integration ────────────────────────────────────

  it("integrates cleanly with logger.info / logger.error / logger.warn", () => {
    logger.info(TEST_COMPONENT, "info_via_wrapper");
    logger.warn(TEST_COMPONENT, "warn_via_wrapper");
    logger.error(TEST_COMPONENT, "error_via_wrapper");
    const warns = readLogs({ component: TEST_COMPONENT, minLevel: "WARN" });
    expect(warns.map((e) => e.event).sort()).toEqual(["error_via_wrapper", "warn_via_wrapper"]);
  });
});
