/**
 * S10 (v0.46.0) — COMPLIANCE REPORT export from the HMAC audit chain.
 *
 * One call turns a project's tamper-evident telemetry into an auditor-ready
 * report: chain integrity verdict (S6's multi-key verification over every
 * row), per-agent activity, session counts, skill-admission security events,
 * and memory-write attribution (S3's created_by). JSON for machines,
 * markdown for humans. The report never exposes secrets — only verdict
 * labels and aggregate counts (row hashes are already public columns).
 */
import { withClient } from "./pg_pool.js";
import { walkChainVerdicts, type ChainRow } from "./replay.js";
import { readFileSync } from "node:fs";
import { getMachineSecret } from "./security/machine_secret.js";

export interface ComplianceReport {
  project: string;
  windowDays: number;
  generatedAt: string;
  auditChain: {
    totalRows: number;
    windowRows: number;
    verified: number;
    unsigned: number;
    hashMismatches: number;
    linkBreaks: number;
    chainOk: boolean;
    keysTried: string[];
    firstBrokenId: number | null;
  };
  agents: Array<{ agent_id: string; calls: number; failures: number; first_seen: string; last_seen: string }>;
  sessions: number;
  skillSecurity: {
    admissionEvents: number;
    quarantines: number;
  };
  memory: {
    liveFacts: number;
    writtenInWindow: number;
    byUser: Record<string, number>;
  };
}

/** Candidate verification secrets — same model as replay.ts (container + host mount). */
function verifySecrets(): Array<{ label: string; secret: Buffer }> {
  const out: Array<{ label: string; secret: Buffer }> = [];
  try { out.push({ label: "container", secret: getMachineSecret() }); } catch { /* none */ }
  const extPath = process.env["ZC_VERIFY_SECRET_PATH"];
  if (extPath) {
    try {
      const text = readFileSync(extPath, "utf8").trim();
      const secret = /^[0-9a-f]+$/i.test(text) && text.length >= 64 && text.length % 2 === 0
        ? Buffer.from(text, "hex")
        : /^[A-Za-z0-9+/]+={0,2}$/.test(text) && Buffer.from(text, "base64").length >= 32
          ? Buffer.from(text, "base64")
          : Buffer.from(text);
      out.push({ label: "host", secret });
    } catch { /* mount absent */ }
  }
  return out;
}

export async function buildComplianceReport(projectHash: string, windowDays: number): Promise<ComplianceReport> {
  const secrets = verifySecrets();
  return withClient(async (c) => {
    // Full chain (verification MUST walk every row — linkage crosses the window).
    const rows = (await c.query<ChainRow>(
      `SELECT id, call_id, session_id, agent_id, tool_name, model,
              input_tokens, output_tokens, cost_usd, latency_ms, status, ts,
              prev_hash, row_hash, task_id, skill_id, error_class
         FROM tool_calls_pg WHERE project_hash = $1 ORDER BY id ASC`,
      [projectHash],
    )).rows;
    const verdicts = walkChainVerdicts(rows, projectHash, secrets);

    const since = new Date(Date.now() - windowDays * 86_400_000);
    let verified = 0, unsigned = 0, mismatches = 0, breaks = 0, windowRows = 0;
    let firstBrokenId: number | null = null;
    rows.forEach((r, i) => {
      const inWindow = new Date(r.ts).getTime() >= since.getTime();
      if (inWindow) windowRows++;
      const v = verdicts[i]!.chain;
      if (v === "verified") verified++;
      else if (v === "unsigned") unsigned++;
      else {
        if (v === "hash-mismatch") mismatches++; else breaks++;
        if (firstBrokenId === null) firstBrokenId = Number(r.id);
      }
    });

    const agents = (await c.query<{ agent_id: string; calls: string; failures: string; first_seen: Date; last_seen: Date }>(
      `SELECT agent_id, COUNT(*)::text AS calls,
              COUNT(*) FILTER (WHERE status <> 'ok' AND status <> 'success')::text AS failures,
              MIN(ts) AS first_seen, MAX(ts) AS last_seen
         FROM tool_calls_pg WHERE project_hash = $1 AND ts >= $2
        GROUP BY agent_id ORDER BY COUNT(*) DESC`,
      [projectHash, since],
    )).rows.map((r) => ({
      agent_id: r.agent_id, calls: parseInt(r.calls, 10), failures: parseInt(r.failures, 10),
      first_seen: new Date(r.first_seen).toISOString(), last_seen: new Date(r.last_seen).toISOString(),
    }));

    const sessions = parseInt((await c.query<{ n: string }>(
      `SELECT COUNT(DISTINCT session_id)::text AS n FROM tool_calls_pg WHERE project_hash = $1 AND ts >= $2`,
      [projectHash, since],
    )).rows[0]!.n, 10);

    // Skill-admission security events (global table — chained + externally anchored).
    let admissionEvents = 0, quarantines = 0;
    try {
      const adm = (await c.query<{ n: string; q: string }>(
        `SELECT COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE event_type ILIKE '%quarantine%')::text AS q
           FROM skill_admission_log_pg WHERE created_at >= $1`,
        [since],
      )).rows[0];
      admissionEvents = parseInt(adm?.n ?? "0", 10);
      quarantines = parseInt(adm?.q ?? "0", 10);
    } catch { /* table absent (pre-v0.26 store) */ }

    // Memory attribution (S3 created_by).
    let liveFacts = 0, writtenInWindow = 0;
    const byUser: Record<string, number> = {};
    try {
      const mem = (await c.query<{ live: string; win: string }>(
        `SELECT COUNT(*) FILTER (WHERE valid_to IS NULL)::text AS live,
                COUNT(*) FILTER (WHERE created_at::timestamptz >= $2)::text AS win
           FROM working_memory WHERE project_hash = $1`,
        [projectHash, since],
      )).rows[0];
      liveFacts = parseInt(mem?.live ?? "0", 10);
      writtenInWindow = parseInt(mem?.win ?? "0", 10);
      const attr = (await c.query<{ created_by: string; n: string }>(
        `SELECT created_by, COUNT(*)::text AS n FROM working_memory
          WHERE project_hash = $1 AND created_by IS NOT NULL AND created_at::timestamptz >= $2
          GROUP BY created_by`,
        [projectHash, since],
      )).rows;
      for (const r of attr) byUser[r.created_by] = parseInt(r.n, 10);
    } catch { /* pre-migration */ }

    return {
      project: projectHash,
      windowDays,
      generatedAt: new Date().toISOString(),
      auditChain: {
        totalRows: rows.length, windowRows, verified, unsigned,
        hashMismatches: mismatches, linkBreaks: breaks,
        chainOk: mismatches === 0 && breaks === 0,
        keysTried: secrets.map((s) => s.label),
        firstBrokenId,
      },
      agents, sessions,
      skillSecurity: { admissionEvents, quarantines },
      memory: { liveFacts, writtenInWindow, byUser },
    };
  });
}

/** Human-readable markdown rendering — pure, unit-testable. */
export function renderComplianceMarkdown(r: ComplianceReport, projectName?: string | null): string {
  const c = r.auditChain;
  const pct = c.totalRows ? ((100 * c.verified) / c.totalRows).toFixed(1) : "0";
  const lines: string[] = [];
  lines.push(`# SecureContext Compliance Report`);
  lines.push("");
  lines.push(`- **Project:** ${projectName ? `${projectName} (${r.project})` : r.project}`);
  lines.push(`- **Window:** last ${r.windowDays} day(s) · generated ${r.generatedAt}`);
  lines.push("");
  lines.push(`## Audit-chain integrity — ${c.chainOk ? "✅ INTACT" : "⚠️ ISSUES FOUND"}`);
  lines.push("");
  lines.push(`Every tool call is HMAC-chained at write time with a per-agent derived key; this`);
  lines.push(`report re-verified the FULL chain (${c.totalRows} rows; linkage crosses sessions)`);
  lines.push(`against ${c.keysTried.length} candidate machine key(s): ${c.keysTried.join(", ") || "none"}.`);
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Rows (all time) | ${c.totalRows} |`);
  lines.push(`| Rows in window | ${c.windowRows} |`);
  lines.push(`| Cryptographically verified | ${c.verified} (${pct}%) |`);
  lines.push(`| Unsigned (pre-chain history) | ${c.unsigned} |`);
  lines.push(`| Hash mismatches (modified or unknown key) | ${c.hashMismatches} |`);
  lines.push(`| Link breaks (inserted/deleted rows) | ${c.linkBreaks} |`);
  if (c.firstBrokenId !== null) lines.push(`| First non-verifying row id | ${c.firstBrokenId} |`);
  lines.push("");
  lines.push(`## Agent activity (window)`);
  lines.push("");
  if (r.agents.length === 0) {
    lines.push(`_No tool calls recorded in the window._`);
  } else {
    lines.push(`| Agent | Calls | Failures | First seen | Last seen |`);
    lines.push(`|---|---|---|---|---|`);
    for (const a of r.agents) {
      lines.push(`| ${a.agent_id} | ${a.calls} | ${a.failures} | ${a.first_seen.slice(0, 16)} | ${a.last_seen.slice(0, 16)} |`);
    }
  }
  lines.push("");
  lines.push(`Sessions in window: **${r.sessions}**`);
  lines.push("");
  lines.push(`## Skill-admission security (global, window)`);
  lines.push("");
  lines.push(`- Admission events (HMAC-chained log): **${r.skillSecurity.admissionEvents}**`);
  lines.push(`- Quarantines: **${r.skillSecurity.quarantines}**`);
  lines.push("");
  lines.push(`## Memory writes & attribution (window)`);
  lines.push("");
  lines.push(`- Live facts: **${r.memory.liveFacts}** · written in window: **${r.memory.writtenInWindow}**`);
  const users = Object.entries(r.memory.byUser);
  if (users.length > 0) {
    lines.push(`- Attributed writers: ${users.map(([u, n]) => `**${u}** (${n})`).join(" · ")}`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(`_Verification method: per-row HMAC (HKDF per-agent subkey) + prev-hash linkage,`);
  lines.push(`walked in id order across the entire project chain. A "verified" row is`);
  lines.push(`byte-identical to what the recording process signed. See ARCHITECTURE.md._`);
  return lines.join("\n");
}
