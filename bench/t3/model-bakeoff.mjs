#!/usr/bin/env node
/**
 * T3 MODEL BAKEOFF — which local model should adjudicate fact-pair conflicts?
 *
 * The T3 invalidation loop's LLM step is a CONSTRAINED JUDGMENT task: given two
 * memory facts, classify {contradiction | update | compatible} and, for updates/
 * contradictions, which side is current. This harness measures candidate local
 * models on a 52-case gold set (real auto-resolved supersessions + hand-labeled
 * live pairs + synthetic contradictions/traps) across:
 *   - verdict accuracy (3-class)  — the number that decides the winner
 *   - current-side accuracy       — on update/contradiction cases
 *   - schema conformance WITHOUT constrained decoding (deploy-robustness signal)
 *   - latency (constrained mode)
 * Two runs per model: Ollama structured output (format: <schema>, production
 * mode) and free json_object prompting (conformance probe).
 *
 * Usage: node bench/t3/model-bakeoff.mjs [model ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
  "qwen2.5-coder:14b", "qwen2.5:14b", "qwen3:14b", "phi4:14b", "llama3.1:8b",
];
const GOLD = JSON.parse(readFileSync(join(DIR, "gold.json"), "utf8"));

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["contradiction", "update", "compatible"] },
    current: { type: "string", enum: ["a", "b", "none"] },
    reason: { type: "string" },
  },
  required: ["verdict", "current", "reason"],
};

const prompt = (c) => `You maintain an AI agent team's project memory. Two stored facts follow. Decide their relationship:
- "contradiction": they make incompatible claims about the SAME thing and the text gives no way to tell which is the current truth.
- "update": they concern the same thing and one clearly SUPERSEDES the other (newer decision, revised value, later state). Set "current" to the surviving side.
- "compatible": they can both be true (different topics, different scopes/environments, sequential progress reports, a status and a later status of DIFFERENT work).

Facts are work-journal entries from a software project; sequential progress on the same effort is compatible, not contradictory.

FACT A (key: ${c.key_a}):
${c.value_a}

FACT B (key: ${c.key_b}):
${c.value_b}

Answer with JSON only: {"verdict": "contradiction"|"update"|"compatible", "current": "a"|"b"|"none", "reason": "<one sentence>"}`;

async function call(model, c, constrained) {
  const body = {
    model,
    messages: [{ role: "user", content: prompt(c) }],
    stream: false,
    options: { temperature: 0, num_predict: 220 },
    ...(constrained ? { format: SCHEMA } : {}),
  };
  const t0 = Date.now();
  const resp = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) return { ok: false, ms, error: `http ${resp.status}` };
  const data = await resp.json();
  let text = (data.message?.content ?? "").trim();
  // qwen3 thinking tags / markdown fences in free mode
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:json)?|```$/gm, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, ms, error: "no-json", raw: text.slice(0, 120) };
  try {
    const j = JSON.parse(m[0]);
    if (!["contradiction", "update", "compatible"].includes(j.verdict)) return { ok: false, ms, error: "bad-verdict" };
    return { ok: true, ms, verdict: j.verdict, current: j.current ?? "none" };
  } catch { return { ok: false, ms, error: "parse-fail", raw: text.slice(0, 120) }; }
}

const results = {};
for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  const r = { constrained: { correct: 0, currentCorrect: 0, currentTotal: 0, fail: 0, msSum: 0 },
              free: { conform: 0 }, n: GOLD.length, perCase: [] };
  for (const c of GOLD) {
    const con = await call(model, c, true);
    if (!con.ok) { r.constrained.fail++; r.perCase.push({ id: c.id, error: con.error }); }
    else {
      r.constrained.msSum += con.ms;
      const vOk = con.verdict === c.gold;
      if (vOk) r.constrained.correct++;
      if (c.gold_current) {
        r.constrained.currentTotal++;
        if (con.current === c.gold_current) r.constrained.currentCorrect++;
      }
      r.perCase.push({ id: c.id, gold: c.gold, got: con.verdict, cur: con.current, ok: vOk, ms: con.ms });
    }
    // Conformance probe on a third of cases — enough signal, halves CPU time.
    if (GOLD.indexOf(c) % 3 === 0) {
      const free = await call(model, c, false);
      r.free.probed = (r.free.probed ?? 0) + 1;
      if (free.ok) r.free.conform++;
    }
    process.stdout.write(".");
  }
  const okN = GOLD.length - r.constrained.fail;
  console.log(`\n verdict acc: ${(100 * r.constrained.correct / GOLD.length).toFixed(1)}% | current-side acc: ${r.constrained.currentTotal ? (100 * r.constrained.currentCorrect / r.constrained.currentTotal).toFixed(1) : "-"}% | free-JSON conformance: ${r.free.probed ? (100 * r.free.conform / r.free.probed).toFixed(1) : "-"}% (n=${r.free.probed ?? 0}) | avg latency: ${okN ? Math.round(r.constrained.msSum / okN) : "-"}ms | hard failures: ${r.constrained.fail}`);
  results[model] = r;
  writeFileSync(join(DIR, "bakeoff-results.json"), JSON.stringify(results, null, 1));
}
console.log("\nSaved bench/t3/bakeoff-results.json");
