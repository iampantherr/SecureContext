/**
 * Secret Scanner — Sprint 0 foundation
 * =====================================
 *
 * Detects API keys, tokens, private keys, and high-entropy strings in any
 * text BEFORE it leaves SecureContext via:
 *   - Anthropic API submissions (Sprint 2 mutation engine)
 *   - Tool call telemetry storage (Sprint 1)
 *   - Logs (any level)
 *   - Skill body indexing (Sprint 2)
 *   - Document content fed to summarizer / reranker
 *
 * USAGE:
 *   import { scanForSecrets, redactSecrets } from "./security/secret_scanner.js";
 *
 *   const scan = scanForSecrets(userText);
 *   if (scan.hasSecret) {
 *     auditLog({ event: "secret.scanner.match", ... details: { types: scan.types }});
 *     // Either reject the operation OR redact + continue:
 *     const redacted = redactSecrets(userText);
 *   }
 *
 * DESIGN PRINCIPLES:
 *   - **Detection before egress**: scan happens at the boundary, before any
 *     data leaves SC's process boundary (logs, API calls, telemetry, etc.)
 *   - **Conservative regex**: prefer false positives (over-block) to false
 *     negatives (leak). Operator can opt-out per-tool with explicit allowlist.
 *   - **Don't log the secret itself**: matches are reported by TYPE only
 *     (e.g. "anthropic_api_key"), never by content. Audit trail records that
 *     a match occurred without itself recording the secret.
 *   - **Performance**: must be <1ms for 10KB inputs. Tested in scanner perf tests.
 *
 * KNOWN LIMITATIONS:
 *   - Regex-based; sophisticated obfuscation (e.g. base64'd keys, split across
 *     lines) may evade. v1 catches the common cases; v2 may add entropy
 *     sliding-window scanning.
 *   - Generic high-entropy detection has tunable thresholds; default is
 *     conservative (length >= 32, entropy > 4.5 bits/char).
 *   - Does NOT detect passphrases, names, addresses, or other PII — that's
 *     a separate concern (PII redaction).
 */

// ─── Pattern catalog ─────────────────────────────────────────────────────────

/** Each pattern: type label + regex + optional context check. */
interface SecretPattern {
  type:        string;
  description: string;
  regex:       RegExp;
  /** Optional: only flag if also followed by additional context (reduce FP). */
  contextCheck?: (match: string, fullText: string) => boolean;
}

const PATTERNS: SecretPattern[] = [
  // ── Anthropic ──
  {
    type:        "anthropic_api_key",
    description: "Anthropic API key (sk-ant-...)",
    regex:       /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  },

  // ── OpenAI ──
  {
    type:        "openai_api_key",
    description: "OpenAI API key (sk-...)",
    // OpenAI keys: sk-proj-... or sk-... followed by 20+ chars; exclude sk-ant- (Anthropic)
    regex:       /sk-(?!ant-)(?:proj-)?[a-zA-Z0-9_-]{20,}/g,
  },

  // ── AWS ──
  {
    type:        "aws_access_key_id",
    description: "AWS Access Key ID (AKIA / AGPA / AIDA / ANPA / ANVA / ASIA prefix)",
    regex:       /\b(?:AKIA|AGPA|AIDA|ANPA|ANVA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    type:        "aws_secret_access_key",
    description: "AWS Secret Access Key (40 chars base64)",
    regex:       /\baws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]*([A-Za-z0-9/+=]{40})['"]*/gi,
  },

  // ── GitHub ──
  {
    type:        "github_pat",
    description: "GitHub PAT (ghp_, gho_, ghs_, ghu_, ghr_)",
    regex:       /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/g,
  },

  // ── Google / GCP ──
  {
    type:        "google_api_key",
    description: "Google API Key (AIza...)",
    regex:       /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },

  // ── Slack ──
  {
    type:        "slack_token",
    description: "Slack token (xoxb / xoxp / xoxa / xoxs)",
    regex:       /\bxox[baps]-[A-Za-z0-9-]{10,}\b/g,
  },

  // ── Stripe ──
  {
    type:        "stripe_live_key",
    description: "Stripe live key (sk_live_ / pk_live_)",
    regex:       /\b(?:sk|pk)_live_[A-Za-z0-9]{24,}\b/g,
  },

  // ── JWT ──
  {
    type:        "jwt",
    description: "JSON Web Token (header.payload.signature, base64url)",
    regex:       /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },

  // ── SSH private keys ──
  {
    type:        "ssh_private_key",
    description: "SSH private key (PEM-formatted)",
    regex:       /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },

  // ── Generic Bearer tokens (catch-all for Authorization headers leaked into logs) ──
  {
    type:        "bearer_token",
    description: "Bearer token in Authorization context",
    regex:       /\bAuthorization:\s*Bearer\s+([A-Za-z0-9_\-\.~+/=]{20,})/g,
  },

  // ── PEM certificates (less sensitive but still mark as private if labeled) ──
  // Optional — only match RSA/EC private; skip plain certs
];

// ─── Result types ────────────────────────────────────────────────────────────

export interface SecretMatch {
  type:        string;          // e.g. "anthropic_api_key"
  description: string;          // human readable
  /** Truncated, masked preview — first 4 + "***" + last 4 chars. NEVER the full secret. */
  masked:      string;
  /** Index in the source string where the match starts. */
  index:       number;
  /** Length of the matched string. */
  length:      number;
}

export interface ScanResult {
  hasSecret:        boolean;
  matches:          SecretMatch[];
  highEntropyCount: number;     // separate from regex matches; usually informational
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan a string for secrets. Returns matches by TYPE (never the full secret).
 * O(n * patternCount) but fast in practice.
 */
export function scanForSecrets(text: string, options: {
  /** Also detect generic high-entropy strings (length >= 32, entropy > 4.5). */
  detectHighEntropy?: boolean;
} = {}): ScanResult {
  if (!text || text.length === 0) {
    return { hasSecret: false, matches: [], highEntropyCount: 0 };
  }

  const matches: SecretMatch[] = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;  // reset for global regex reuse
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      const matched = m[0];
      if (pattern.contextCheck && !pattern.contextCheck(matched, text)) continue;
      matches.push({
        type:        pattern.type,
        description: pattern.description,
        masked:      maskSecret(matched),
        index:       m.index,
        length:      matched.length,
      });
    }
  }

  let highEntropyCount = 0;
  if (options.detectHighEntropy) {
    highEntropyCount = countHighEntropySubstrings(text, matches);
  }

  return {
    hasSecret:        matches.length > 0 || highEntropyCount > 0,
    matches,
    highEntropyCount,
  };
}

/**
 * Replace every detected secret in the text with a redaction marker.
 * Useful for safe logging: `console.log(redactSecrets(maybeUnsafe))`.
 *
 * Returns the redacted text (original is unmodified).
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  // Apply patterns in order; collect replacements so we don't shift indices
  type Replacement = { start: number; end: number; replacement: string };
  const replacements: Replacement[] = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      replacements.push({
        start:       m.index,
        end:         m.index + m[0].length,
        replacement: `[REDACTED:${pattern.type}]`,
      });
    }
  }
  // Sort descending by start so replacements don't shift earlier indices
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mask a secret to "first4***last4". Used in match reports and audit details. */
function maskSecret(s: string): string {
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

/**
 * Count substrings (length >= 32) in `text` that exceed a Shannon-entropy
 * threshold of 4.5 bits/char. Useful for catching unrecognized secret formats.
 *
 * Excludes substrings that overlap regex-confirmed matches (avoid double-count).
 */
function countHighEntropySubstrings(text: string, regexMatches: readonly SecretMatch[]): number {
  if (text.length < 32) return 0;

  // Build set of indices already inside regex matches
  const inRegex = new Set<number>();
  for (const m of regexMatches) {
    for (let i = m.index; i < m.index + m.length; i++) inRegex.add(i);
  }

  // Sliding window of length 40, hop 20, check Shannon entropy
  const WINDOW = 40;
  const HOP    = 20;
  let count = 0;
  for (let i = 0; i + WINDOW <= text.length; i += HOP) {
    if (inRegex.has(i)) continue;
    const slice = text.slice(i, i + WINDOW);
    if (!isCandidateChars(slice)) continue;
    if (shannonEntropy(slice) > 4.5) count++;
  }
  return count;
}

/** Quick filter: candidate must be mostly alphanumeric / base64-ish. */
function isCandidateChars(s: string): boolean {
  let alphaNum = 0;
  for (const c of s) {
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") ||
        c === "+" || c === "/" || c === "=" || c === "_" || c === "-") {
      alphaNum++;
    }
  }
  return alphaNum / s.length > 0.85;  // 85%+ alphanumeric/base64-like
}

/** Shannon entropy of a string in bits per character. */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  const len = s.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
