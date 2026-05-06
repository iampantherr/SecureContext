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
  /** True iff score >= 8 (all checks passed). */
  passed: boolean;
  /** Score 0-8 = number of checks that passed. */
  score: number;
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
  ];

  const score = checks.filter((c) => c.passed).length;
  const { createHash } = await import("node:crypto");
  const body_hash = createHash("sha256").update(skill.body).digest("hex");

  return {
    passed: score === 8,
    score,
    checks,
    body_hash,
  };
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
