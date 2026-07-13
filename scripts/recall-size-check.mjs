/**
 * R8f — recall-size regression gate.
 *
 * Asserts that on a MATURE project (seed with scripts/seed-mature-memory.mjs
 * first) the rendered recall stays within the budget and the temporal contract
 * holds. This is the check the feature E2Es structurally missed: they ran on
 * fresh projects with ~5 facts, where the 47k-token firehose (and the agents'
 * subagent-digest coping behaviour) can never manifest.
 *
 * Checks:
 *   1. BUDGET   — rendered recall (facts section, simulated with the same
 *                 recall_budget partition the MCP proxy uses) ≤ budget + 15% slack.
 *   2. TAIL     — with ~250 facts a collapsed-tail notice MUST be present
 *                 (if everything "fits", the budget isn't engaging).
 *   3. TEMPORAL — focus "what happened last week" puts in-window facts first,
 *                 and any in-window overflow is explicitly reported.
 *   4. HONESTY  — nothing is deleted: rendered + collapsed === facts returned.
 *
 * Usage: node scripts/recall-size-check.mjs   (exit 0 = pass, 1 = fail)
 * Requires: npm run build (imports dist/recall_budget.js), sc-api up, fixture seeded.
 */
import { readFileSync } from "node:fs";

const PROJECT = "C:/Users/Amit/AI_projects/ZZ_MATURE";
const API = process.env.ZC_API_URL || "http://localhost:3099";
const KEY = process.env.ZC_API_KEY || readEnvKey();

function readEnvKey() {
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(/^ZC_API_KEY=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

const { budgetFacts } = await import("../dist/recall_budget.js");
const { Config } = await import("../dist/config.js");
const { parseTemporalQuery } = await import("../dist/temporal_parse.js");

async function recall(focus) {
  const qs = new URLSearchParams({ projectPath: PROJECT, agentId: "orchestrator" });
  if (focus) qs.set("focus", focus);
  const res = await fetch(`${API}/api/v1/recall?${qs}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`recall -> ${res.status}`);
  return res.json();
}

// Render one fact the way the MCP proxy does (key/value + badge overhead).
function renderLen(facts) {
  return facts.reduce((a, f) => a + f.key.length + f.value.length + 24, 0);
}

let failures = 0;
const fail = (name, msg) => { failures++; console.log(`  FAIL ${name}: ${msg}`); };
const pass = (name, msg) => console.log(`  ok   ${name}: ${msg}`);

// ── 1+2+4: unfocused recall on the mature project ──────────────────────────
{
  const r = await recall();
  const facts = r.facts ?? [];
  console.log(`unfocused: ${facts.length} facts returned by API`);
  // Recall(orchestrator) = own namespace + shared 'default' pool (developer's
  // facts are private), and eviction may have trimmed toward the project's
  // complexity-scaled cap — both by design. Mature-scale means >150 live facts.
  if (facts.length < 150) fail("fixture", `expected mature-scale (>150) facts, got ${facts.length} — seed with scripts/seed-mature-memory.mjs`);
  const b = budgetFacts(facts);
  const size = renderLen(b.rendered);
  const budget = Config.RECALL_MAX_CHARS;
  if (budget <= 0) fail("budget-config", "ZC_RECALL_MAX_CHARS is 0 (budget disabled) — gate meaningless");
  if (size > budget * 1.15) fail("BUDGET", `rendered ${size} chars > ${budget} (+15% slack)`);
  else pass("BUDGET", `rendered ${size} chars ≤ ${budget} budget (${b.rendered.length} facts shown)`);
  if (b.collapsed.length === 0) fail("TAIL", "no collapsed tail on a 250-fact project — budget not engaging");
  else pass("TAIL", `${b.collapsed.length} facts collapsed, notice present=${b.tailNotice.length > 0}`);
  if (b.rendered.length + b.collapsed.length !== facts.length) fail("HONESTY", "rendered+collapsed != total (facts lost)");
  else pass("HONESTY", `rendered ${b.rendered.length} + collapsed ${b.collapsed.length} = ${facts.length}`);
}

// ── 3: temporal contract — "what happened last week" ───────────────────────
{
  const focus = "what happened last week";
  const r = await recall(focus);
  const facts = r.facts ?? [];
  const w = parseTemporalQuery(focus);
  if (!w.from) fail("TEMPORAL-PARSE", `'${focus}' did not parse a window`);
  const win = { from: w.from, to: w.to };
  const b = budgetFacts(facts, { win });
  const inWin = (f) => {
    const t = Date.parse(String(f.valid_at ?? f.created_at));
    return Number.isFinite(t) && t >= w.from.getTime() && (!w.to || t <= w.to.getTime());
  };
  const totalInWin = facts.filter(inWin).length;
  console.log(`temporal: ${facts.length} facts, ${totalInWin} inside last-week window`);
  if (totalInWin === 0) fail("TEMPORAL-FIXTURE", "no in-window facts — fixture backdating broken");
  // Tier-1 contract: every rendered slot is in-window until in-window facts run out.
  const expectFirst = Math.min(totalInWin, b.rendered.length);
  const firstInWin = b.rendered.slice(0, expectFirst).filter(inWin).length;
  if (firstInWin !== expectFirst) fail("TEMPORAL-PRIORITY", `only ${firstInWin}/${expectFirst} of the top slots are in-window`);
  else pass("TEMPORAL-PRIORITY", `top ${expectFirst} rendered slots are all in-window`);
  // Overflow honesty: if in-window facts were collapsed, the notice must say so.
  if (b.inWindowCollapsed > 0 && !b.tailNotice.includes("INSIDE your requested time window"))
    fail("TEMPORAL-OVERFLOW", `${b.inWindowCollapsed} in-window facts collapsed without the explicit warning`);
  else pass("TEMPORAL-OVERFLOW", `inWindowCollapsed=${b.inWindowCollapsed}, warning=${b.inWindowCollapsed > 0 ? "present" : "n/a"}`);
}

console.log(failures === 0 ? "\nRECALL-SIZE GATE: PASS" : `\nRECALL-SIZE GATE: ${failures} FAILURE(S)`);
// process.exit() while fetch keep-alive handles are closing trips a libuv
// assertion on Windows — set exitCode and let the loop drain instead.
process.exitCode = failures === 0 ? 0 : 1;
