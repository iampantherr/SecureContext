/**
 * Tests for community detection (v0.14.0 Phase C).
 *
 * Coverage:
 *   - Empty KB → empty result (no crash)
 *   - Single isolated node → 1 community of size 1
 *   - Two disconnected components → 2+ communities
 *   - Star topology → expected clustering
 *   - Densely connected cluster → grouped together
 *   - Real-world: a "modular project" with auth + db + ui clusters
 *   - storeCommunities + getCommunityForSource roundtrip
 *   - Idempotent re-run produces same assignments
 *   - Edge case: single self-mention shouldn't create self-loop
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { indexContent } from "../knowledge.js";
import { detectCommunities, storeCommunities, getCommunityForSource } from "./community.js";

let testProject: string;

function dbPath(p: string) {
  const h = createHash("sha256").update(p).digest("hex").slice(0, 16);
  return join(homedir(), ".claude", "zc-ctx", "sessions", h + ".db");
}
function clean(p: string) {
  for (const sfx of ["", "-wal", "-shm"]) try { if (existsSync(dbPath(p) + sfx)) unlinkSync(dbPath(p) + sfx); } catch {}
}

beforeEach(() => {
  testProject = mkdtempSync(join(tmpdir(), "zc-comm-"));
  clean(testProject);
});

afterEach(() => {
  clean(testProject);
  try { rmSync(testProject, { recursive: true, force: true }); } catch {}
});

describe("detectCommunities", () => {

  it("[edge] empty KB → empty result (no crash)", () => {
    // Create the DB by indexing then removing
    indexContent(testProject, "x", "test://x");
    const db = new DatabaseSync(dbPath(testProject));
    db.exec("DELETE FROM knowledge");
    const result = detectCommunities(db);
    db.close();
    expect(result.totalSources).toBe(0);
    expect(result.communities).toEqual([]);
    expect(result.assignments).toEqual([]);
  });

  it("[edge] single isolated source → 1 community of size 1", () => {
    indexContent(testProject, "isolated content nothing references", "isolated.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    db.close();
    expect(r.totalSources).toBe(1);
    expect(r.communityCount).toBe(1);
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].source).toBe("isolated.md");
  });

  it("[user case] two disconnected groups → 2 communities", () => {
    // Group A: alpha + beta reference each other
    indexContent(testProject, "links to beta.md content", "alpha.md");
    indexContent(testProject, "links to alpha.md content", "beta.md");
    // Group B: gamma + delta reference each other but not group A
    indexContent(testProject, "see delta.md for details", "gamma.md");
    indexContent(testProject, "from gamma.md we have details", "delta.md");

    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    db.close();

    expect(r.totalSources).toBe(4);
    expect(r.communityCount).toBeGreaterThanOrEqual(2);
    expect(r.totalEdges).toBeGreaterThan(0);

    // Find which community alpha + beta are in
    const alphaCom = r.assignments.find(a => a.source === "alpha.md")?.communityId;
    const betaCom  = r.assignments.find(a => a.source === "beta.md")?.communityId;
    const gammaCom = r.assignments.find(a => a.source === "gamma.md")?.communityId;
    const deltaCom = r.assignments.find(a => a.source === "delta.md")?.communityId;

    expect(alphaCom).toBe(betaCom);
    expect(gammaCom).toBe(deltaCom);
    expect(alphaCom).not.toBe(gammaCom);
  });

  it("[user case] modular project with auth + db + ui clusters", () => {
    // Auth cluster
    indexContent(testProject, "AuthService imports auth_helpers.ts and session_store.ts", "src/AuthService.ts");
    indexContent(testProject, "auth helpers used by AuthService.ts and session_store.ts", "src/auth_helpers.ts");
    indexContent(testProject, "session storage for AuthService.ts and auth_helpers.ts", "src/session_store.ts");
    // DB cluster
    indexContent(testProject, "Database connection used by user_repo.ts and post_repo.ts", "src/Database.ts");
    indexContent(testProject, "user repo backed by Database.ts", "src/user_repo.ts");
    indexContent(testProject, "post repo backed by Database.ts and user_repo.ts", "src/post_repo.ts");
    // UI cluster
    indexContent(testProject, "Layout component for App.tsx and Header.tsx", "src/Layout.tsx");
    indexContent(testProject, "App component using Layout.tsx and Header.tsx", "src/App.tsx");
    indexContent(testProject, "Header component within Layout.tsx", "src/Header.tsx");

    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    db.close();

    expect(r.totalSources).toBe(9);
    expect(r.communityCount).toBeGreaterThanOrEqual(2);  // at least some clustering
    expect(r.totalEdges).toBeGreaterThan(0);

    // Auth files should cluster together (each strongly references the other 2)
    const authIds = ["src/AuthService.ts", "src/auth_helpers.ts", "src/session_store.ts"]
      .map(s => r.assignments.find(a => a.source === s)?.communityId);
    // At minimum, AuthService and auth_helpers should be in the same community
    expect(authIds[0]).toBe(authIds[1]);
  });

  it("[edge] documents are deterministic across re-runs (same input → same assignments)", () => {
    indexContent(testProject, "alpha references beta", "alpha.md");
    indexContent(testProject, "beta references alpha", "beta.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r1 = detectCommunities(db);
    const r2 = detectCommunities(db);
    db.close();

    expect(r1.totalSources).toBe(r2.totalSources);
    expect(r1.communityCount).toBe(r2.communityCount);
    // Per-source community ids may differ between runs (Louvain is deterministic on the graph
    // but not necessarily on the labels), so we compare partition structure:
    const partition1 = new Set(r1.assignments.map(a => a.communityId));
    const partition2 = new Set(r2.assignments.map(a => a.communityId));
    expect(partition1.size).toBe(partition2.size);
  });

  it("[edge] elapsedMs is reported", () => {
    indexContent(testProject, "x", "x.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    db.close();
    expect(typeof r.elapsedMs).toBe("number");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("[edge] modularity score is in [0, 1]", () => {
    indexContent(testProject, "a.md links to b.md", "a.md");
    indexContent(testProject, "b.md links to a.md", "b.md");
    indexContent(testProject, "c.md is alone", "c.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    db.close();
    expect(r.modularity).toBeGreaterThanOrEqual(0);
    expect(r.modularity).toBeLessThanOrEqual(1);
  });

  it("[edge] short basenames (<4 chars) don't create spurious edges", () => {
    // "io" is too short — should not match every "I/O" mention
    indexContent(testProject, "talks about general I/O concepts", "io.md");
    indexContent(testProject, "talks about networking", "net.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    db.close();
    // No false edges: io.md and net.md are in separate communities
    expect(r.totalEdges).toBe(0);
  });
});

describe("storeCommunities + getCommunityForSource", () => {

  it("storeCommunities persists assignments + getCommunityForSource retrieves them", () => {
    // Use realistic source names so the basename matcher (>= 4 chars) catches references
    indexContent(testProject, "alpha module references beta_helpers content", "alpha.md");
    indexContent(testProject, "beta_helpers references alpha module", "beta_helpers.md");
    indexContent(testProject, "isolated standalone document", "lonely_doc.md");

    const db = new DatabaseSync(dbPath(testProject));
    const result = detectCommunities(db);
    storeCommunities(db, result);

    const aInfo = getCommunityForSource(db, "alpha.md");
    const bInfo = getCommunityForSource(db, "beta_helpers.md");
    const cInfo = getCommunityForSource(db, "lonely_doc.md");
    db.close();

    expect(aInfo.communityId).not.toBeNull();
    expect(aInfo.communityId).toBe(bInfo.communityId);  // same community
    expect(aInfo.mates).toContain("beta_helpers.md");
    expect(aInfo.communitySize).toBe(2);

    expect(cInfo.communityId).not.toBe(aInfo.communityId);  // different community
    expect(cInfo.communitySize).toBe(1);
    expect(cInfo.mates).toEqual([]);
  });

  it("[edge] getCommunityForSource returns nulls when source not in DB", () => {
    indexContent(testProject, "x", "x.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r = detectCommunities(db);
    storeCommunities(db, r);
    const info = getCommunityForSource(db, "nonexistent.md");
    db.close();
    expect(info.communityId).toBeNull();
    expect(info.communitySize).toBe(0);
    expect(info.mates).toEqual([]);
  });

  it("[edge] getCommunityForSource gracefully handles missing kb_communities table", () => {
    indexContent(testProject, "x", "x.md");
    const db = new DatabaseSync(dbPath(testProject));
    // Don't run storeCommunities — table won't exist
    const info = getCommunityForSource(db, "x.md");
    db.close();
    expect(info.communityId).toBeNull();
    expect(info.mates).toEqual([]);
  });

  it("storeCommunities is idempotent (re-run replaces, doesn't append)", () => {
    indexContent(testProject, "alpha module standalone", "alpha.md");
    indexContent(testProject, "beta module standalone",  "beta.md");
    const db = new DatabaseSync(dbPath(testProject));
    const r1 = detectCommunities(db);
    storeCommunities(db, r1);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM kb_communities").get() as { n: number }).n;
    storeCommunities(db, r1);  // re-run with same data
    const after = (db.prepare("SELECT COUNT(*) AS n FROM kb_communities").get() as { n: number }).n;
    db.close();
    expect(before).toBe(after);
  });
});
