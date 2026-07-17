/**
 * S6 (v0.45.0) — SESSION REPLAY from the HMAC audit chain.
 *
 * Time-travel debugging with cryptographic provenance: scrub through every tool
 * call an agent made in a session, each step badged with its chain verdict.
 * AgentOps-style replay, but the timeline itself is tamper-evident — a modified
 * row (or an inserted/deleted one) breaks visibly at the exact step.
 *
 * KEY MODEL: rows are HMAC'd with a per-agent HKDF subkey derived from the
 * machine secret of the process that RECORDED them — usually the HOST's MCP
 * process, not the API container. The verifier therefore tries a set of
 * candidate root secrets: the container's own, plus (when mounted) the host's
 * via ZC_VERIFY_SECRET_PATH. A row verifies if ANY candidate key matches;
 * the response says which.
 *
 * Verification is CHAIN-WIDE per project (prev_hash links cross sessions), but
 * the replay view returns one session's steps with per-row verdicts.
 */
import { readFileSync } from "node:fs";
import { withClient } from "./pg_pool.js";
import { getMachineSecret } from "./security/machine_secret.js";
import { deriveAgentChainKeyFrom, canonicalize } from "./security/chained_table.js";
import { hmacRowHash, GENESIS } from "./security/hmac_chain.js";

export interface ChainRow {
  id: number;
  call_id: string;
  session_id: string;
  agent_id: string;
  tool_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | number;
  latency_ms: number;
  status: string;
  ts: Date;
  prev_hash: string;
  row_hash: string;
  task_id: string | null;
  skill_id: string | null;
  error_class: string | null;
}

export interface ReplayStep {
  id: number;
  call_id: string;
  agent_id: string;
  tool_name: string;
  status: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ts: string;
  task_id: string | null;
  skill_id: string | null;
  error_class: string | null;
  /** Chain verdict for THIS row: "verified" (hash+link ok), "hash-mismatch",
   *  "link-broken" (prev_hash doesn't match preceding row), or "unsigned"
   *  (pre-chain row with empty row_hash). */
  chain: "verified" | "hash-mismatch" | "link-broken" | "unsigned";
  /** Which candidate key verified it ("container" | "host" | null). */
  key: string | null;
}

/** Candidate root secrets for verification, labeled. */
function verifySecrets(): Array<{ label: string; secret: Buffer }> {
  const out: Array<{ label: string; secret: Buffer }> = [];
  try { out.push({ label: "container", secret: getMachineSecret() }); } catch { /* none */ }
  const extPath = process.env["ZC_VERIFY_SECRET_PATH"];
  if (extPath) {
    try {
      const raw = readFileSync(extPath);
      // .machine_secret is stored BASE64 (machine_secret.ts writes
      // buf.toString("base64")); also accept hex text or raw bytes so an
      // operator can point this at any secret file.
      const text = raw.toString("utf8").trim();
      let secret: Buffer;
      if (/^[0-9a-f]+$/i.test(text) && text.length >= 64 && text.length % 2 === 0) {
        secret = Buffer.from(text, "hex");
      } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && Buffer.from(text, "base64").length >= 32) {
        secret = Buffer.from(text, "base64");
      } else {
        secret = raw;
      }
      out.push({ label: "host", secret });
    } catch { /* mount absent — container-only verification */ }
  }
  return out;
}

function canonicalFor(row: ChainRow, projectHash: string): string {
  const cost = typeof row.cost_usd === "string" ? parseFloat(row.cost_usd) : row.cost_usd;
  return canonicalize([
    row.call_id,
    row.session_id,
    row.agent_id,
    projectHash,
    row.tool_name,
    row.model,
    row.input_tokens,
    row.output_tokens,
    (cost ?? 0).toFixed(8),
    row.latency_ms,
    row.status,
    row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
  ]);
}

/**
 * PURE chain-verdict walker over a project's rows (id-ascending) — exported for
 * unit tests. Each row gets {chain, key}: "verified" (some candidate secret's
 * per-agent subkey reproduces row_hash AND prev_hash links), "hash-mismatch",
 * "link-broken" (prev_hash ≠ preceding row_hash; the walker resyncs so a single
 * break doesn't cascade badges), or "unsigned" (pre-chain empty row_hash).
 */
export function walkChainVerdicts(
  rows: ChainRow[],
  projectHash: string,
  secrets: Array<{ label: string; secret: Buffer }>,
): Array<{ chain: ReplayStep["chain"]; key: string | null }> {
  const keyCache = new Map<string, Buffer>();
  const subkey = (label: string, secret: Buffer, agentId: string): Buffer => {
    const k = `${label}:${agentId}`;
    let v = keyCache.get(k);
    if (!v) { v = deriveAgentChainKeyFrom(secret, agentId); keyCache.set(k, v); }
    return v;
  };
  const out: Array<{ chain: ReplayStep["chain"]; key: string | null }> = [];
  let prevExpected = GENESIS;
  for (const row of rows) {
    if (!row.row_hash) {
      out.push({ chain: "unsigned", key: null }); // pre-chain row — linkage not advanced
      continue;
    }
    if (row.prev_hash !== prevExpected) {
      out.push({ chain: "link-broken", key: null });
      prevExpected = row.row_hash; // resync
      continue;
    }
    const canonical = canonicalFor(row, projectHash);
    let verdict: ReplayStep["chain"] = "hash-mismatch";
    let keyLabel: string | null = null;
    for (const { label, secret } of secrets) {
      const expected = hmacRowHash(subkey(label, secret, row.agent_id), row.prev_hash, canonical);
      if (expected === row.row_hash) { verdict = "verified"; keyLabel = label; break; }
    }
    prevExpected = row.row_hash;
    out.push({ chain: verdict, key: keyLabel });
  }
  return out;
}

/** Recent sessions for a project — the replay picker. */
export async function listReplaySessions(projectHash: string, limit = 30): Promise<Array<{
  session_id: string; agents: string[]; calls: number;
  first_ts: string; last_ts: string; cost_usd: number; failures: number;
}>> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT session_id,
              ARRAY_AGG(DISTINCT agent_id) AS agents,
              COUNT(*)::int AS calls,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COUNT(*) FILTER (WHERE status <> 'ok' AND status <> 'success')::int AS failures
         FROM tool_calls_pg
        WHERE project_hash = $1 AND session_id IS NOT NULL AND session_id <> ''
        GROUP BY session_id
        ORDER BY MAX(ts) DESC
        LIMIT $2`,
      [projectHash, limit],
    );
    return r.rows.map((row) => ({
      session_id: row.session_id,
      agents: row.agents ?? [],
      calls: row.calls,
      first_ts: new Date(row.first_ts).toISOString(),
      last_ts: new Date(row.last_ts).toISOString(),
      cost_usd: Number(row.cost_usd ?? 0),
      failures: row.failures ?? 0,
    }));
  });
}

/**
 * Replay one session with per-row chain verdicts. Verification walks the FULL
 * project chain in id order (linkage crosses sessions); the returned steps are
 * the requested session's rows only.
 */
export async function getSessionReplay(projectHash: string, sessionId: string): Promise<{
  session_id: string;
  steps: ReplayStep[];
  summary: {
    steps: number; verified: number; unsigned: number; broken: number;
    chainOk: boolean; keysTried: string[];
    projectRows: number;
  };
}> {
  const secrets = verifySecrets();
  return withClient(async (c) => {
    const r = await c.query<ChainRow>(
      `SELECT id, call_id, session_id, agent_id, tool_name, model,
              input_tokens, output_tokens, cost_usd, latency_ms, status, ts,
              prev_hash, row_hash, task_id, skill_id, error_class
         FROM tool_calls_pg
        WHERE project_hash = $1
        ORDER BY id ASC`,
      [projectHash],
    );
    const rows = r.rows;
    const verdicts = walkChainVerdicts(rows, projectHash, secrets);

    const steps: ReplayStep[] = [];
    let verified = 0, unsigned = 0, broken = 0;
    rows.forEach((row, i) => {
      if (row.session_id !== sessionId) return;
      const v = verdicts[i]!;
      if (v.chain === "verified") verified++;
      else if (v.chain === "unsigned") unsigned++;
      else broken++;
      steps.push({
        id: Number(row.id), call_id: row.call_id, agent_id: row.agent_id,
        tool_name: row.tool_name, status: row.status, latency_ms: row.latency_ms,
        input_tokens: row.input_tokens, output_tokens: row.output_tokens,
        cost_usd: Number(typeof row.cost_usd === "string" ? parseFloat(row.cost_usd) : row.cost_usd ?? 0),
        ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
        task_id: row.task_id, skill_id: row.skill_id, error_class: row.error_class,
        chain: v.chain, key: v.key,
      });
    });

    return {
      session_id: sessionId,
      steps,
      summary: {
        steps: steps.length, verified, unsigned, broken,
        chainOk: broken === 0,
        keysTried: secrets.map((s) => s.label),
        projectRows: rows.length,
      },
    };
  });
}
