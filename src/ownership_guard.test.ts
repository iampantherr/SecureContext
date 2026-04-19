/**
 * Tests for v0.17.0 §8.2 — file-ownership overlap guard at /api/v1/broadcast.
 *
 * Red-team IDs:
 *   RT-S4-05: second ASSIGN with overlapping file_ownership_exclusive on an
 *             unmerged task is rejected with HTTP 409 Conflict — prevents
 *             two workers being assigned the same file simultaneously.
 *   RT-S4-06: ASSIGN with disjoint exclusive set succeeds even with prior
 *             in-flight ASSIGN.
 *   RT-S4-07: ASSIGN on a file previously claimed but since MERGEd is allowed
 *             (conflict window ends at MERGE).
 */

import { vi } from "vitest";

// Disable RBAC + channel-key enforcement so these tests isolate the
// ownership-guard behavior from auth concerns (covered in rbac-broadcast.test.ts
// and reference_monitor.test.ts).
vi.hoisted(() => {
  process.env["ZC_RBAC_ENFORCE"]         = "0";
  process.env["ZC_CHANNEL_KEY_REQUIRED"] = "0";
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createApiServer } from "./api-server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any;
let port: number;
let baseUrl: string;
let apiKey: string;

function projectDbPath(p: string): string {
  const hash = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", hash + ".db");
}
function cleanProjectDb(p: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    try { if (existsSync(projectDbPath(p) + sfx)) unlinkSync(projectDbPath(p) + sfx); } catch { /* noop */ }
  }
}

beforeAll(async () => {
  port       = 14500 + Math.floor(Math.random() * 500);
  apiKey     = randomBytes(32).toString("hex");
  process.env.ZC_API_KEY = apiKey;
  baseUrl    = `http://localhost:${port}`;
  const { app } = await createApiServer();
  await new Promise<void>((resolve, reject) => {
    app.listen({ port, host: "127.0.0.1" }, (err) => err ? reject(err) : resolve());
  });
  serverApp = app;
});

afterAll(async () => {
  try { await serverApp.close(); } catch { /* noop */ }
  delete process.env.ZC_API_KEY;
});

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "zc-own-"));
  cleanProjectDb(project);
});

async function postBroadcast(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/v1/broadcast`, {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

describe("v0.17.0 §8.2 — file-ownership overlap guard", () => {

  it("[RT-S4-05] second ASSIGN with OVERLAPPING exclusive files → HTTP 409", async () => {
    const a1 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-1", file_ownership_exclusive: ["src/auth.ts"],
    });
    expect(a1.status).toBe(200);

    const a2 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-2", file_ownership_exclusive: ["src/auth.ts", "src/other.ts"],
    });
    expect(a2.status).toBe(409);
    const err = await a2.json() as { error: string; overlapping_files: string[] };
    expect(err.error).toMatch(/conflict/i);
    expect(err.overlapping_files).toContain("src/auth.ts");
  });

  it("[RT-S4-06] second ASSIGN with DISJOINT exclusive files → 200 OK", async () => {
    const a1 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-1", file_ownership_exclusive: ["src/auth.ts"],
    });
    expect(a1.status).toBe(200);

    const a2 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-2", file_ownership_exclusive: ["src/unrelated.ts"],
    });
    expect(a2.status).toBe(200);
  });

  it("[RT-S4-07] re-ASSIGN on a file after MERGE of the prior task → 200 OK", async () => {
    const a1 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-1", file_ownership_exclusive: ["src/auth.ts"],
    });
    expect(a1.status).toBe(200);

    const m = await postBroadcast({
      projectPath: project, type: "MERGE", agentId: "worker-1",
      task: "task-1", summary: "done", files: ["src/auth.ts"],
    });
    expect(m.status).toBe(200);

    const a2 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-2", file_ownership_exclusive: ["src/auth.ts"],
    });
    expect(a2.status).toBe(200);  // prior task merged → no conflict
  });

  it("ASSIGN without file_ownership_exclusive skips the check (back-compat)", async () => {
    const a1 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-1",
    });
    expect(a1.status).toBe(200);
    const a2 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-2",
    });
    expect(a2.status).toBe(200);
  });

  it("Non-ASSIGN types (STATUS, MERGE, DEPENDENCY) are not subject to the guard", async () => {
    const a1 = await postBroadcast({
      projectPath: project, type: "ASSIGN", agentId: "orch",
      task: "task-1", file_ownership_exclusive: ["src/auth.ts"],
    });
    expect(a1.status).toBe(200);

    // STATUS with same file → allowed (type isn't ASSIGN, so guard skips)
    const s = await postBroadcast({
      projectPath: project, type: "STATUS", agentId: "worker-1",
      task: "task-1", state: "in_progress", files: ["src/auth.ts"],
    });
    expect(s.status).toBe(200);
  });
});
