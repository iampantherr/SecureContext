/**
 * 8-point security scanner for skill bodies (v0.23.0 Phase 1 #1)
 * ===============================================================
 *
 * Every skill body that lands in skills_pg passes through this gate.
 * Mirrors the Agensi marketplace's security scan but tuned to our threat
 * model + integrated into the storage_dual.upsertSkill chokepoint.
 *
 * The 8 checks (each is pass/fail; score = total passes):
 *
 *   1. Secret-pattern scan (existing src/secret_scanner.ts)
 *   2. Prompt-injection markers (jailbreak attempts, override directives)
 *   3. Tool-spawn directives (sub-agent escalation patterns)
 *   4. Filesystem-escape paths (../, ~/, /etc/, sensitive dirs)
 *   5. Network-exfil markers (untrusted curl/wget/fetch w/o allowlist)
 *   6. Sleep/timeout abuse (infinite loops, time-bombs)
 *   7. Body-length cap (≤16KB; bigger is operator-review-fatigue territory)
 *   8. Frontmatter integrity (required fields present + correctly typed)
 *
 * Gate behavior in storage_dual.upsertSkill:
 *   - score 8/8 → auto-allow promotion
 *   - score 7/8 → operator must approve via dashboard before promotion
 *   - score ≤6/8 → blocked outright + audit log entry, operator notified
 *
 * Audit log lives in skill_security_scans_pg (PG migration 20). Every scan
 * — pass or fail — produces a row so the operator can see the security-
 * gate history per skill over time.
 *
 * Marketplace pull (Phase 2) will use the same scanner. Anthropic-maintained
 * skills are NOT trusted blindly — they pass through the same gate.
 */

import type { Skill, SkillFrontmatter } from "./types.js";

export interface SecurityCheck {
  /** Stable name of the check for the audit log. */
  name: string;
  /** True iff this check passed; false means a problem was detected. */
  passed: boolean;
  /** Severity if failed: "block" never lets the skill in; "warn" requires operator review. */
  severity: "block" | "warn";
  /** Human-readable detail (matched pattern, line excerpt, etc.). Up to 512 chars. */
  detail?: string;
}

export interface ScanResult {
  /** True iff every check passed. */
  passed: boolean;
  /** Number of checks that passed (0..maxScore). */
  score: number;
  /** v0.37.0 — total number of checks run (11 as of v0.37.0; was hardcoded 8). */
  maxScore: number;
  /** Individual results per check. */
  checks: SecurityCheck[];
  /** SHA256 of the scanned body — for the audit log. */
  body_hash: string;
}

/**
 * Run all 8 security checks against a skill. Returns a ScanResult; the
 * caller (storage_dual.upsertSkill) decides what to do based on score.
 */
export async function scanSkillBody(skill: Skill): Promise<ScanResult> {
  const checks: SecurityCheck[] = [
    checkSecrets(skill.body),
    checkPromptInjection(skill.body),
    checkToolSpawn(skill.body),
    checkFilesystemEscape(skill.body),
    checkNetworkExfil(skill.body, skill.frontmatter),
    checkSleepAbuse(skill.body),
    checkBodyLength(skill.body),
    checkFrontmatterIntegrity(skill.frontmatter),
    // v0.37.0 — breadth additions (Tier-1 #6): threats invisible to the code-level checks.
    checkToxicToolFlow(skill.frontmatter),
    checkExfilImperative(skill.body),
    await checkTriggerShadowing(skill),
  ];

  const score = checks.filter((c) => c.passed).length;
  const { createHash } = await import("node:crypto");
  const body_hash = createHash("sha256").update(skill.body).digest("hex");

  return {
    passed: score === checks.length,
    score,
    maxScore: checks.length,
    checks,
    body_hash,
  };
}

// ─── v0.37.0 breadth checks ─────────────────────────────────────────────────

/**
 * Toxic tool-flow: individually-benign tool grants whose COMBINATION forms an
 * exfiltration path (read files/secrets + reach the network + write somewhere
 * observable). Warn severity — flags for operator review, never hard-blocks.
 */
function checkToxicToolFlow(fm: SkillFrontmatter): SecurityCheck {
  const tools = (fm as { allowed_tools?: unknown }).allowed_tools;
  const list = (Array.isArray(tools) ? tools : typeof tools === "string" ? tools.split(",") : [])
    .map((t) => String(t).trim().toLowerCase());
  if (list.length === 0) return { name: "toxic_tool_flow", passed: true, severity: "warn" };
  const canRead     = list.some((t) => /read|bash|execute|grep|glob/.test(t));
  const canReachNet = list.some((t) => /fetch|web|curl|http|bash|execute/.test(t));
  const canWriteOut = list.some((t) => /broadcast|write|bash|execute|remember/.test(t));
  if (canRead && canReachNet && canWriteOut) {
    return {
      name: "toxic_tool_flow", passed: false, severity: "warn",
      detail: `allowed_tools grants read+network+write-out simultaneously (${list.slice(0, 8).join(", ")}) — an exfil-capable combination; operator review required`,
    };
  }
  return { name: "toxic_tool_flow", passed: true, severity: "warn" };
}

/**
 * Natural-language exfil imperatives: PROSE that instructs the agent to move
 * sensitive material somewhere observable ("cat ~/.aws/credentials into your
 * MERGE summary") — invisible to code-level AST scanning. Block severity.
 */
function checkExfilImperative(body: string): SecurityCheck {
  const SENSITIVE = /(credential|secret|token|api[-_ ]?key|password|private key|\.env\b|\.aws|\.ssh|id_rsa)/i;
  const MOVE_VERB = /\b(send|post|upload|paste|include|copy|insert|append|embed|put|cat|echo|forward|report|attach)\b/i;
  const SINK      = /\b(merge|summary|broadcast|message|response|output|comment|issue|gist|pastebin|webhook|url|endpoint|chat|reply)\b/i;
  for (const line of body.split(/\r?\n/)) {
    if (SENSITIVE.test(line) && MOVE_VERB.test(line) && SINK.test(line)) {
      return {
        name: "exfil_imperative", passed: false, severity: "block",
        detail: `prose instructs moving sensitive material to an observable sink: "${line.trim().slice(0, 160)}"`,
      };
    }
  }
  return { name: "exfil_imperative", passed: true, severity: "block" };
}

/**
 * Cross-skill trigger shadowing: a DIFFERENT active skill already claims a
 * near-identical trigger/description — competing for the same invocation is how a
 * malicious look-alike hijacks calls meant for a trusted skill. PG-backed; passes
 * cleanly (skip) on installs without PG. Warn severity → operator review, not a block.
 */
async function checkTriggerShadowing(skill: Skill): Promise<SecurityCheck> {
  const desc = String((skill.frontmatter as { description?: unknown }).description ?? "");
  if (!desc || (!process.env["ZC_POSTGRES_HOST"] && !process.env["ZC_POSTGRES_PASSWORD"])) {
    return { name: "trigger_shadowing", passed: true, severity: "warn" };
  }
  try {
    const { withClient } = await import("../pg_pool.js");
    const ownName = String((skill.frontmatter as { name?: unknown }).name ?? skill.skill_id.split("@")[0] ?? "");
    const rows = await withClient(async (c) => (await c.query<{ name: string; description: string }>(
      `SELECT name, COALESCE(frontmatter->>'description','') AS description
         FROM skills_pg WHERE archived_at IS NULL AND name <> $1 LIMIT 300`, [ownName])).rows);
    const tok = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const a = tok(desc);
    if (a.size === 0) return { name: "trigger_shadowing", passed: true, severity: "warn" };
    for (const r of rows) {
      const b = tok(r.description);
      if (b.size === 0) continue;
      let inter = 0; for (const t of a) if (b.has(t)) inter++;
      const jac = inter / (a.size + b.size - inter);
      if (jac >= 0.7) {
        return {
          name: "trigger_shadowing", passed: false, severity: "warn",
          detail: `trigger/description overlaps ${(jac * 100).toFixed(0)}% with active skill '${r.name}' — possible invocation hijack; operator review required`,
        };
      }
    }
  } catch { /* PG unreachable — skip cleanly */ }
  return { name: "trigger_shadowing", passed: true, severity: "warn" };
}

// ─── Individual checks ─────────────────────────────────────────────────────

function checkSecrets(body: string): SecurityCheck {
  // Same patterns as lint.ts rule 7, but run as a separate first-class
  // check here for the security-scan audit log.
  const patterns = [
    [/sk-(live|test|proj)-[a-zA-Z0-9]{20,}/, "OpenAI-style key"],
    [/sk-ant-[a-zA-Z0-9-]{40,}/, "Anthropic key"],
    [/AKIA[A-Z0-9]{16}/, "AWS access key id"],
    [/ghp_[a-zA-Z0-9]{36}/, "GitHub PAT (classic)"],
    [/github_pat_[a-zA-Z0-9_]{80,}/, "GitHub PAT (fine-grained)"],
    [/xoxb-\d+-\d+-[a-zA-Z0-9]+/, "Slack bot token"],
    [/-----BEGIN [A-Z ]+ PRIVATE KEY-----/, "Private key block"],
  ] as const;
  for (const [re, label] of patterns) {
    if (re.test(body)) {
      return { name: "secret_scan", passed: false, severity: "block", detail: `matches ${label}` };
    }
  }
  return { name: "secret_scan", passed: true, severity: "block" };
}

function checkPromptInjection(body: string): SecurityCheck {
  // Patterns commonly seen in jailbreak / prompt-injection attempts. The
  // skill body shouldn't contain language that tries to override the
  // agent's system prompt.
  const markers = [
    /ignore (the |all )?(previous|prior|above|earlier) instructions?/i,
    /disregard (the |all )?previous/i,
    /you are now (a |an )?different/i,
    /system\s*:\s*you are/i,
    /<\|im_start\|>/,
    /<\|im_end\|>/,
    /\[INST\]\s*system/i,
    /role\s*:\s*system\s*[\r\n]/i,    // hand-rolled message-shape injection
    /forget (everything|all)/i,
  ];
  for (const re of markers) {
    if (re.test(body)) {
      return {
        name: "prompt_injection",
        passed: false,
        severity: "block",
        detail: `body contains ${re.source.slice(0, 60)} pattern`,
      };
    }
  }
  return { name: "prompt_injection", passed: true, severity: "block" };
}

function checkToolSpawn(body: string): SecurityCheck {
  // Skills should NOT instruct the agent to spawn sub-agents — that's the
  // orchestrator's job. Detecting these instructions catches malicious
  // skills attempting to escalate via Task-tool abuse.
  const markers = [
    /spawn[_\s-]?subagent/i,
    /launch[_\s-]?subagent/i,
    /use the Task tool to (spawn|create|launch)/i,
    /Agent tool to (spawn|delegate)/i,
    /generate-purpose tool to (spawn|launch)/i,    // refer to the general-purpose Agent
  ];
  for (const re of markers) {
    if (re.test(body)) {
      return {
        name: "tool_spawn",
        passed: false,
        severity: "block",
        detail: `body instructs subagent spawn — pattern ${re.source.slice(0, 50)}`,
      };
    }
  }
  return { name: "tool_spawn", passed: true, severity: "block" };
}

function checkFilesystemEscape(body: string): SecurityCheck {
  // The skill body may LEGITIMATELY mention paths in code blocks for
  // documentation. We're looking for IMPERATIVE instructions to access
  // sensitive paths. Mostly heuristic — false positives possible, but
  // an operator-review (severity=warn) catches real risks.
  const markers = [
    /\.\.\/\.\.\//,                              // ../../ traversal (real)
    /Read\s*\(\s*["'].*\/etc\/passwd/i,           // explicit /etc/passwd read
    /Read\s*\(\s*["'].*C:\\Windows\\System32/i,
    /Read\s*\(\s*["'].*\/\.ssh\//i,
    /Read\s*\(\s*["'].*\/\.aws\//i,
    /\\\\[a-zA-Z0-9._-]+\\(c|d|admin)\$/i,        // Windows admin shares
  ];
  for (const re of markers) {
    if (re.test(body)) {
      return {
        name: "filesystem_escape",
        passed: false,
        severity: "warn",
        detail: `body references sensitive path — ${re.source.slice(0, 50)}`,
      };
    }
  }
  return { name: "filesystem_escape", passed: true, severity: "warn" };
}

function checkNetworkExfil(body: string, frontmatter: SkillFrontmatter): SecurityCheck {
  // If the skill body contains a curl/wget/fetch call to a URL NOT in
  // network_allowlist, that's a potential exfil channel. Skills that
  // genuinely need network access must declare `requires_network: true`
  // and an allowlist (enforced separately by lint rule 9).
  const curlMatch = body.match(/(?:curl|wget)\s+(?:--?[a-zA-Z]+\s+)*['"]?(https?:\/\/[^\s'"`]+)/i);
  const fetchMatch = body.match(/fetch\s*\(\s*['"]?(https?:\/\/[^\s'"`]+)/i);
  const url = curlMatch?.[1] ?? fetchMatch?.[1];

  if (!url) return { name: "network_exfil", passed: true, severity: "warn" };

  // If the skill declared an allowlist, the URL must match a prefix.
  const allowlist = frontmatter.network_allowlist ?? [];
  if (allowlist.some((prefix) => url.startsWith(prefix))) {
    return { name: "network_exfil", passed: true, severity: "warn" };
  }

  return {
    name: "network_exfil",
    passed: false,
    severity: "warn",
    detail: `body references URL not in network_allowlist: ${url.slice(0, 80)}`,
  };
}

function checkSleepAbuse(body: string): SecurityCheck {
  // Skills that instruct unbounded sleeps / time-bombs — likely either
  // accidental DoS or deliberate stalling.
  const markers = [
    /sleep\s+\d{4,}/,                          // sleep > 1000s
    /Start-Sleep\s+-(?:Seconds|s)\s+\d{4,}/i,
    /setTimeout\s*\(\s*[^,]+,\s*\d{8,}\s*\)/,  // setTimeout with > 1e8 ms
    /while\s*\(\s*true\s*\)/,                  // while(true) loop
    /while\s*\(\s*1\s*\)/,
    /timeout\s*[=:]\s*Infinity/i,
  ];
  for (const re of markers) {
    if (re.test(body)) {
      return {
        name: "sleep_abuse",
        passed: false,
        severity: "warn",
        detail: `body contains potential time-bomb — ${re.source.slice(0, 50)}`,
      };
    }
  }
  return { name: "sleep_abuse", passed: true, severity: "warn" };
}

function checkBodyLength(body: string): SecurityCheck {
  // v0.24.1: aligned with the relaxed lint rule (which I had originally set
  // at 16k as a guess, not Anthropic spec). Hard cap at 100k chars; below
  // that, the lint rule's 25k WARN catches the "consider progressive
  // disclosure" case. The security check is for "is this body of a size
  // that's even tractable to review at all" — anything past 100k is
  // unmanageable in any context window we'd ship to.
  const len = body.length;
  if (len > 100_000) {
    return {
      name: "body_length",
      passed: false,
      severity: "block",
      detail: `body is ${len} chars; max 100000 — at ~25k tokens this is unmanageable in any agent context`,
    };
  }
  return { name: "body_length", passed: true, severity: "block" };
}

function checkFrontmatterIntegrity(fm: SkillFrontmatter): SecurityCheck {
  const required: Array<keyof SkillFrontmatter> = ["name", "version", "scope", "description"];
  const missing = required.filter((k) => fm[k] === undefined || fm[k] === null || fm[k] === "");
  if (missing.length > 0) {
    return {
      name: "frontmatter_integrity",
      passed: false,
      severity: "block",
      detail: `missing required fields: ${missing.join(", ")}`,
    };
  }
  if (typeof fm.name !== "string" || typeof fm.version !== "string" || typeof fm.scope !== "string") {
    return {
      name: "frontmatter_integrity",
      passed: false,
      severity: "block",
      detail: "name/version/scope must be strings",
    };
  }
  return { name: "frontmatter_integrity", passed: true, severity: "block" };
}
