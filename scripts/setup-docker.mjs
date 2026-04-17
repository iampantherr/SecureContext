#!/usr/bin/env node
/**
 * SecureContext one-command Docker setup — v0.10.0+
 * ==================================================
 *
 * Interactive installer that brings a fresh machine from zero to "SC full mode"
 * in one command:
 *
 *   1. Verifies Docker + Docker Compose are installed.
 *   2. Detects GPU (NVIDIA / AMD / CPU-only) and picks the right compose overlay.
 *   3. Pulls the Docker stack images (postgres, api, ollama).
 *   4. Starts sc-postgres + sc-api + sc-ollama.
 *   5. Interactively asks which coder model to use for summarization, with
 *      VRAM-aware recommendations:
 *        - qwen2.5-coder:7b   (~4 GB VRAM, fast)
 *        - qwen2.5-coder:14b  (~8 GB VRAM, sweet spot — DEFAULT)
 *        - qwen2.5-coder:32b  (~20 GB VRAM, best quality, slow)
 *        - custom             (any HuggingFace/Ollama model name)
 *        - none               (truncation fallback, not recommended)
 *   6. Pulls nomic-embed-text (always) and the chosen coder model.
 *   7. Health-checks the stack and reports full vs degraded.
 *
 * Safe to re-run: idempotent on already-present containers + models.
 *
 * Usage:
 *   node scripts/setup-docker.mjs                              # interactive
 *   node scripts/setup-docker.mjs --model qwen2.5-coder:14b    # non-interactive
 *   node scripts/setup-docker.mjs --gpu cpu                    # force CPU overlay
 *   node scripts/setup-docker.mjs --no-start                   # only pull, don't start
 *   node scripts/setup-docker.mjs --health-only                # skip pulls, just verify
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ─── Setup ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DOCKER_DIR = resolve(REPO_ROOT, "docker");

const argv = process.argv.slice(2);
const arg = (name, def = undefined) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const MODEL_ARG     = arg("--model");
const GPU_OVERRIDE  = arg("--gpu");           // "nvidia" | "amd" | "cpu"
const NO_START      = arg("--no-start", false);
const HEALTH_ONLY   = arg("--health-only", false);
const NO_EMBED_PULL = arg("--no-embed-pull", false);
const HELP          = arg("--help", false) || arg("-h", false);

if (HELP) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n").filter(l => l.startsWith(" *")).map(l => l.slice(3)).join("\n"));
  process.exit(0);
}

const COLORS = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const c = (col, s) => `${COLORS[col]}${s}${COLORS.reset}`;
const step = (s) => console.log(c("cyan", `\n▶ ${s}`));
const ok   = (s) => console.log(`  ${c("green", "✓")} ${s}`);
const warn = (s) => console.log(`  ${c("yellow", "⚠")} ${s}`);
const fail = (s) => console.log(`  ${c("red", "✗")} ${s}`);
const dim  = (s) => console.log(c("gray", `    ${s}`));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: opts.inherit ? "inherit" : "pipe", encoding: "utf8", ...opts });
  return {
    code:   res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    ok:     res.status === 0,
  };
}

async function ask(rl, prompt, def = "") {
  const answer = await rl.question(c("cyan", prompt) + (def ? c("gray", ` [${def}]`) : "") + " ");
  return (answer ?? "").trim() || def;
}

function fmtBytes(n) {
  return n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(0) + " MB";
}

// ─── Step 1: verify docker + compose ────────────────────────────────────────

step("1/7  Verifying Docker + Compose");

{
  const r = run("docker", ["--version"]);
  if (!r.ok) {
    fail("docker not found. Install Docker Desktop from https://www.docker.com/products/docker-desktop");
    process.exit(1);
  }
  ok(r.stdout.trim());
}

{
  const r = run("docker", ["compose", "version"]);
  if (!r.ok) {
    fail("'docker compose' plugin not available. Update Docker Desktop or install the plugin.");
    process.exit(1);
  }
  ok(r.stdout.trim());
}

// ─── Step 2: GPU detection + overlay selection ──────────────────────────────

step("2/7  Detecting GPU");

let gpuKind = "cpu";
if (GPU_OVERRIDE) {
  gpuKind = GPU_OVERRIDE;
  warn(`GPU override via --gpu flag: ${gpuKind}`);
} else {
  // NVIDIA check
  const nv = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  if (nv.ok && nv.stdout.trim()) {
    gpuKind = "nvidia";
    const lines = nv.stdout.trim().split("\n");
    ok(`NVIDIA detected: ${lines.length} GPU(s)`);
    for (const line of lines) dim(line);
  } else {
    // AMD check (very rough — rocm-smi if present)
    const amd = run("rocm-smi", ["--showmeminfo", "vram"]);
    if (amd.ok) {
      gpuKind = "amd";
      ok("AMD GPU detected (rocm)");
    } else {
      warn("No GPU detected — will use CPU-only Ollama (14b will be slow; 7b recommended)");
      gpuKind = "cpu";
    }
  }
}

const overlayMap = {
  nvidia: "docker-compose.nvidia.yml",
  amd:    "docker-compose.amd.yml",
  cpu:    "docker-compose.cpu.yml",
};
const overlay = overlayMap[gpuKind];
if (!overlay || !existsSync(join(DOCKER_DIR, overlay))) {
  fail(`GPU overlay '${overlay}' not found in ${DOCKER_DIR}`);
  process.exit(1);
}
ok(`Using overlay: ${overlay}`);

const composeArgs = [
  "compose",
  "-f", join(DOCKER_DIR, "docker-compose.yml"),
  "-f", join(DOCKER_DIR, overlay),
];

// ─── Step 3: Pull Docker images ──────────────────────────────────────────────

if (HEALTH_ONLY) {
  step("3/7  Skipping image pull (--health-only)");
} else {
  step("3/7  Pulling Docker images (pgvector, Ollama, SC api)");
  const r = run("docker", [...composeArgs, "pull"], { inherit: true });
  if (!r.ok) { fail("docker compose pull failed"); process.exit(1); }
  ok("Images ready");
}

// ─── Step 4: Start stack ─────────────────────────────────────────────────────

if (NO_START) {
  step("4/7  Skipping start (--no-start)");
} else {
  step("4/7  Starting SC Docker stack");
  const r = run("docker", [...composeArgs, "up", "-d"], { inherit: true });
  if (!r.ok) { fail("docker compose up failed"); process.exit(1); }

  // Wait up to 30s for healthchecks to pass
  process.stdout.write("  waiting for healthchecks");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write(".");
    const ps = run("docker", ["ps", "--filter", "label=com.docker.compose.project=securecontext",
                              "--format", "{{.Names}}\t{{.Status}}"]);
    const lines = ps.stdout.trim().split("\n").filter(Boolean);
    const allHealthy = lines.length >= 3 && lines.every(l => l.includes("(healthy)") || l.includes("Up"));
    if (allHealthy) { ready = true; break; }
  }
  console.log();
  if (ready) { ok("stack healthy"); } else { warn("stack may still be starting; check 'docker compose ps'"); }
}

// ─── Step 5: Model selection ────────────────────────────────────────────────

step("5/7  Selecting summarization model");

const MODELS = [
  { name: "qwen2.5-coder:7b",  vram: "~4 GB",  speed: "fast",       note: "lighter; fine for 8 GB VRAM" },
  { name: "qwen2.5-coder:14b", vram: "~8 GB",  speed: "fast (GPU)", note: "DEFAULT — sweet spot for 16 GB+ VRAM" },
  { name: "qwen2.5-coder:32b", vram: "~20 GB", speed: "slow",       note: "highest quality; overnight indexing" },
  { name: "deepseek-coder:14b", vram: "~8 GB", speed: "fast",       note: "alternative coder model" },
  { name: "(custom)",          vram: "—",      speed: "—",           note: "any Ollama model you specify" },
  { name: "(none)",            vram: "0",      speed: "—",           note: "truncation fallback, NOT RECOMMENDED" },
];

let chosenModel = MODEL_ARG;

if (!chosenModel) {
  console.log();
  console.log(c("bold", "  Available models:"));
  MODELS.forEach((m, i) => {
    console.log(`    ${c("cyan", `${i + 1}`)}. ${m.name.padEnd(24)} ${m.vram.padEnd(10)} ${m.speed.padEnd(12)} ${c("gray", m.note)}`);
  });
  console.log();

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const pick = await ask(rl, "Choose by number or name:", "2");
    const idx = parseInt(pick, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= MODELS.length) {
      const sel = MODELS[idx - 1];
      if (sel.name === "(custom)") {
        chosenModel = await ask(rl, "Enter custom model name (e.g. starcoder2:7b):");
      } else if (sel.name === "(none)") {
        chosenModel = null;
      } else {
        chosenModel = sel.name;
      }
    } else {
      chosenModel = pick;
    }
  } finally {
    rl.close();
  }
}

if (chosenModel) {
  ok(`Summarizer model: ${chosenModel}`);
} else {
  warn("No summarizer model selected — L0/L1 will fall back to truncation");
}

// ─── Step 6: Pull Ollama models ──────────────────────────────────────────────

step("6/7  Pulling Ollama models");

async function pullModel(name) {
  process.stdout.write(`  pulling ${name}...`);
  // Use the Ollama HTTP API via docker exec (we don't know if ollama CLI is in host PATH)
  const r = run("docker", ["exec", "securecontext-ollama", "ollama", "pull", name], { inherit: true });
  return r.ok;
}

if (HEALTH_ONLY) {
  dim("skipped (--health-only)");
} else {
  if (!NO_EMBED_PULL) {
    const embedOk = await pullModel("nomic-embed-text");
    if (embedOk) ok("nomic-embed-text ready (embeddings)");
    else         fail("failed to pull nomic-embed-text — search will fall back to BM25-only");
  }
  if (chosenModel) {
    const chatOk = await pullModel(chosenModel);
    if (chatOk) ok(`${chosenModel} ready (summaries)`);
    else        fail(`failed to pull ${chosenModel} — summaries will fall back to truncation`);
  }
}

// ─── Step 7: Final health check ──────────────────────────────────────────────

step("7/7  Verifying health");

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Probe sc-api and sc-ollama externally (from host)
const apiHealth = await (async () => {
  try {
    const res = await fetch("http://localhost:3099/health", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
})();

const ollamaTags = await fetchJSON("http://localhost:11435/api/tags");
const models = ollamaTags?.models ?? [];
const modelNames = new Set(models.flatMap(m => [m.name, m.name.replace(/:latest$/, "")]));

const embedReady     = modelNames.has("nomic-embed-text") || modelNames.has("nomic-embed-text:latest");
const summarizerReady = !chosenModel || modelNames.has(chosenModel) || modelNames.has(`${chosenModel}:latest`);

console.log();
console.log(c("bold", "  Health summary:"));
(apiHealth     ? ok  : fail)(`sc-api        ${apiHealth     ? "healthy"   : "unreachable"}`);
(ollamaTags    ? ok  : fail)(`sc-ollama     ${ollamaTags    ? "healthy"   : "unreachable"}`);
(embedReady    ? ok  : warn)(`embeddings    ${embedReady    ? "ready"     : "missing nomic-embed-text"}`);
(summarizerReady ? ok : warn)(`summarizer    ${summarizerReady ? "ready" : `missing ${chosenModel}`}`);

const fullMode = apiHealth && ollamaTags && embedReady && summarizerReady;
console.log();
if (fullMode) {
  console.log(c("green", c("bold", "  ✓ SC running in FULL MODE")));
  console.log();
  console.log(c("gray", "  Next steps:"));
  console.log(c("gray", "    1. Make sure your ~/.claude/settings.json MCP env has:"));
  console.log(c("gray", '       "ZC_OLLAMA_URL": "http://127.0.0.1:11435/api/embeddings",'));
  if (chosenModel) {
    console.log(c("gray", `       "ZC_SUMMARY_MODEL": "${chosenModel}",`));
  }
  console.log(c("gray", '       "ZC_SUMMARY_KEEP_ALIVE": "30s"'));
  console.log(c("gray", "    2. For Claude Desktop: update %APPDATA%\\Claude\\claude_desktop_config.json similarly."));
  console.log(c("gray", "    3. Read AGENT_HARNESS.md for token-optimized workflow rules."));
} else {
  console.log(c("yellow", c("bold", "  ⚠ SC running in DEGRADED MODE — agents will spend ~3-4x more tokens")));
  console.log();
  console.log(c("gray", "  Re-run with --health-only to re-check after fixing any issues:"));
  console.log(c("gray", "    node scripts/setup-docker.mjs --health-only"));
  process.exit(1);
}

process.exit(0);
