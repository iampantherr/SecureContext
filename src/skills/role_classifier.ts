/**
 * v0.24.2 — Role classifier for marketplace skills (and any skill missing
 * intended_roles).
 *
 * Why this exists: when a marketplace skill lands in skills_pg without
 * intended_roles, it's invisible to start-agents.ps1's role-based skill
 * injection — orphaned. v0.24.0/v0.24.1 had this bug: I set
 * `intended_roles: undefined` in the marketplace_pull mapping. All 17
 * Anthropic skills were imported but never auto-injected to any role.
 *
 * Two backends, mirroring polisher.ts:
 *   - keyword         — local, no API cost. Curated keyword → role mapping.
 *                       Good first pass; runs at every pull.
 *   - realtime-sonnet — calls Anthropic API for higher-fidelity classification.
 *                       Reserved for operator-triggered re-classify (cost concern).
 *
 * The keyword backend uses a hand-curated taxonomy:
 *   domain → role-set mapping (e.g. "design" → designer + ui-designer + ...)
 *   keyword → domain mapping (e.g. "ui" → "design", "api" → "code")
 * Skill text is tokenized; domains are scored by keyword hits; top domains'
 * roles are merged.
 *
 * Output is always validated against the canonical ROLE_NAMES set so we
 * never assign a role the dispatcher doesn't recognize.
 */

import type { Skill } from "./types.js";
import { ROLE_NAMES, ROLES_CATALOG } from "./roles_catalog.js";
import { Config } from "../config.js";
import { selectSummaryModel } from "../summarizer.js";

export interface RoleClassifyResult {
  intended_roles: string[];
  confidence:     "high" | "medium" | "low";
  backend:        "keyword" | "ollama" | "realtime-sonnet";
  reason:         string;
  duration_ms:    number;
}

/**
 * Domain-based taxonomy: maps a "skill domain" to the set of roles that
 * benefit from skills in that domain. Roles that span multiple domains
 * appear in multiple buckets (designer in design AND content, for example).
 *
 * Curated. Add new domains as the marketplace ecosystem grows.
 */
// v0.24.2: domain → core roles. Tightened from earlier iteration where
// "code" domain pulled in 7 roles (sre/devops/ml-engineer/platform-engineer
// for every skill mentioning "build" or "implement") — too broad. Now each
// domain ships with a CORE set of 2-4 highly-relevant roles. Operator
// refines via the dashboard's Edit frontmatter button — better to under-
// assign and have operator add than over-assign and have them remove.
const DOMAIN_TO_ROLES: Record<string, string[]> = {
  code: [
    "developer", "architect",
  ],
  design: [
    "designer", "ui-designer", "interaction-designer",
  ],
  branding: [
    "brand-designer", "brand-strategist", "creative-director",
  ],
  writing: [
    "writer", "technical-writer", "documentation-writer", "editor",
  ],
  marketing: [
    "marketer", "content-marketer", "growth-marketer",
  ],
  data: [
    "analyst", "data-analyst", "business-analyst",
  ],
  finance: [
    "accountant", "controller", "finance-manager", "financial-analyst",
  ],
  ops: [
    "ops-manager", "project-manager",
  ],
  legal: [
    "legal-counsel", "compliance-officer",
  ],
  research: [
    "researcher", "research-scientist", "user-researcher",
  ],
  qa: [
    "developer",  // QA isn't a separate role in this catalog
  ],
  comms: [
    "writer", "content-marketer", "social-media-manager",
  ],
};

/**
 * Keyword → domain. Substring match against tokenized skill text.
 * Lowercase. Order matters for ambiguity — earlier wins ties.
 */
const KEYWORD_TO_DOMAINS: Array<{ kw: string; domains: string[] }> = [
  // code domain
  { kw: "code",        domains: ["code"] },
  { kw: "api",         domains: ["code"] },
  { kw: "framework",   domains: ["code"] },
  { kw: "library",     domains: ["code"] },
  { kw: "function",    domains: ["code"] },
  { kw: "implement",   domains: ["code"] },
  { kw: "debug",       domains: ["code"] },
  { kw: "compile",     domains: ["code"] },
  { kw: "build",       domains: ["code"] },
  { kw: "package",     domains: ["code"] },
  { kw: "deploy",      domains: ["code", "ops"] },
  { kw: "git",         domains: ["code"] },
  { kw: "test",        domains: ["code", "qa"] },
  { kw: "integrat",    domains: ["code"] },
  { kw: "mcp",         domains: ["code"] },
  { kw: "claude-api",  domains: ["code"] },

  // design domain
  { kw: "design",      domains: ["design"] },
  { kw: "ui ",         domains: ["design"] },
  { kw: "ux ",         domains: ["design", "research"] },
  { kw: "visual",      domains: ["design"] },
  { kw: "layout",      domains: ["design"] },
  { kw: "color",       domains: ["design", "branding"] },
  { kw: "typograph",   domains: ["design", "branding"] },
  { kw: "aesthetic",   domains: ["design"] },
  { kw: "art",         domains: ["design"] },
  { kw: "canvas",      domains: ["design"] },
  { kw: "frontend",    domains: ["code", "design"] },
  { kw: "theme",       domains: ["design", "branding"] },
  { kw: "icon",        domains: ["design"] },

  // branding domain
  { kw: "brand",       domains: ["branding"] },
  { kw: "logo",        domains: ["branding", "design"] },
  { kw: "palette",     domains: ["branding", "design"] },
  { kw: "guideline",   domains: ["branding", "writing"] },
  { kw: "internal-comm", domains: ["comms"] },

  // writing domain
  { kw: "writ",        domains: ["writing"] },
  { kw: "draft",       domains: ["writing"] },
  { kw: "edit",        domains: ["writing"] },
  { kw: "article",     domains: ["writing"] },
  { kw: "essay",       domains: ["writing"] },
  { kw: "narrative",   domains: ["writing"] },
  { kw: "documentat",  domains: ["writing"] },
  { kw: "doc-",        domains: ["writing"] },
  { kw: "docx",        domains: ["writing"] },
  { kw: "markdown",    domains: ["writing"] },
  { kw: "report",      domains: ["writing", "data"] },
  { kw: "co-author",   domains: ["writing"] },
  { kw: "coauthor",    domains: ["writing"] },

  // marketing / comms
  { kw: "market",      domains: ["marketing"] },
  { kw: "campaign",    domains: ["marketing"] },
  { kw: "growth",      domains: ["marketing"] },
  { kw: "social",      domains: ["marketing", "comms"] },
  { kw: "seo",         domains: ["marketing"] },
  { kw: "slack",       domains: ["comms"] },
  { kw: "gif",         domains: ["comms", "design"] },

  // data / analysis
  { kw: "data",        domains: ["data"] },
  { kw: "analy",       domains: ["data"] },
  { kw: "spreadsheet", domains: ["data", "finance"] },
  { kw: "excel",       domains: ["data", "finance"] },
  { kw: "xlsx",        domains: ["data", "finance"] },
  { kw: "chart",       domains: ["data"] },
  { kw: "pivot",       domains: ["data"] },
  { kw: "dashboard",   domains: ["data"] },

  // finance
  { kw: "finance",     domains: ["finance"] },
  { kw: "accounting",  domains: ["finance"] },
  { kw: "budget",      domains: ["finance"] },
  { kw: "p&l",         domains: ["finance"] },
  { kw: "expense",     domains: ["finance"] },

  // documents / pdf / pptx
  { kw: "pdf",         domains: ["writing", "data"] },  // utility — both write reports + analysts read pdfs
  { kw: "pptx",        domains: ["writing", "marketing", "design"] },
  { kw: "presentation", domains: ["writing", "marketing"] },
  { kw: "slide",       domains: ["writing", "marketing"] },

  // research
  { kw: "research",    domains: ["research"] },
  { kw: "compet",      domains: ["research"] },

  // skill engineering / meta
  { kw: "skill",       domains: ["code"] },  // skill-creator → developer/architect

  // web
  { kw: "html",        domains: ["code", "design"] },
  { kw: "javascript",  domains: ["code"] },
  { kw: "webapp",      domains: ["code"] },
  { kw: "web-",        domains: ["code", "design"] },
  { kw: "artifact",    domains: ["code"] },
];

/**
 * Tokenize and lowercase, return as a single normalized string.
 * Used for keyword substring matching.
 */
function normalizeText(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .join(" ")
    .replace(/[^a-z0-9\s\-_]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Keyword-based classification. Returns roles for the highest-scoring
 * domains. Always validates against ROLE_NAMES so we never assign a
 * role unknown to the dispatcher.
 */
export function classifyRolesKeyword(skill: Skill): RoleClassifyResult {
  const start = Date.now();
  // v0.24.2: match against NAME + DESCRIPTION only — NOT the body.
  // First impl matched the body's first 2k chars too, which dragged in
  // false positives: e.g. algorithmic-art body mentions ".js files
  // (generative algorithms)" → triggered "javascript" + "function" code
  // keywords → assigned developer/devops/sre/ml-engineer alongside the
  // designer roles. Body-text adds noise. Name + description capture
  // intent more reliably.
  const text = normalizeText(
    skill.frontmatter.name ?? "",
    skill.frontmatter.description ?? "",
  );

  // Score each domain by keyword hits
  const domainScores = new Map<string, number>();
  for (const { kw, domains } of KEYWORD_TO_DOMAINS) {
    if (text.includes(kw)) {
      for (const d of domains) {
        domainScores.set(d, (domainScores.get(d) ?? 0) + 1);
      }
    }
  }

  if (domainScores.size === 0) {
    return {
      intended_roles: [],
      confidence:     "low",
      backend:        "keyword",
      reason:         "no domain keywords matched skill name/description — operator should manually assign",
      duration_ms:    Date.now() - start,
    };
  }

  // v0.24.2: top 2 domains only (was 3) so we don't over-assign roles
  // when keywords from a tertiary domain happen to match weakly.
  const sorted = [...domainScores.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 2);
  const topScore = top[0][1];

  const allRoles = new Set<string>();
  for (const [domain] of top) {
    for (const role of DOMAIN_TO_ROLES[domain] ?? []) {
      if (ROLE_NAMES.has(role)) {
        allRoles.add(role);
      }
    }
  }

  const intended = [...allRoles].sort();

  // Confidence heuristic: more keyword hits = higher confidence
  const confidence: "high" | "medium" | "low" =
    topScore >= 3 ? "high" : topScore >= 2 ? "medium" : "low";

  return {
    intended_roles: intended,
    confidence,
    backend:        "keyword",
    reason:         `top domain(s): ${top.map(([d, s]) => `${d}=${s}`).join(", ")}; ${intended.length} roles assigned`,
    duration_ms:    Date.now() - start,
  };
}

// ─── v0.24.3: Ollama (qwen2.5-coder:14b) backend ───────────────────────────
//
// Reuse the same Ollama instance + coder model that summarizer.ts uses for
// L0/L1 file summaries. Already running in the docker-compose stack
// (sc-ollama), already kept warm by the v0.23.3 30m keep_alive bump, no
// API costs. Higher fidelity than keyword matching for ambiguous skills
// (e.g. "build" no longer fires both code AND design domains by accident
// — the model reasons about INTENT instead of substring presence).

function getOllamaBaseForClassifier(): string {
  return Config.OLLAMA_URL.replace(/\/api\/[^/]*\/?$/, "");
}

function buildClassifierPrompt(skill: Skill, roleHints: string): string {
  const name        = skill.frontmatter.name ?? "(unknown)";
  const description = skill.frontmatter.description ?? "(no description)";
  return `You are classifying a skill (a procedural agent capability) by which job roles
should have access to it. Return a JSON array of role names — only roles
that would genuinely benefit. Pick from the role list below, exact spelling.

Skill name: ${name}
Skill description: ${description}

Available roles (name — short description):
${roleHints}

Rules:
- Return 2-7 roles. Don't over-assign — if only developers benefit, return ["developer"].
- Roles that only TANGENTIALLY relate (e.g. "anyone who reads PDFs") DON'T qualify;
  the skill must be a legitimate part of that role's working procedure.
- Use exact role names from the list. Don't invent new ones.
- Output JSON only, no prose, no markdown fences:

["role-1", "role-2", ...]`;
}

/**
 * Build a compact role-list hint for the prompt. Cap at ~80 roles
 * to fit comfortably in the model's context.
 */
function buildRoleHints(): string {
  return ROLES_CATALOG
    .slice(0, 80)
    .map((r) => `- ${r.name} — ${r.desc.slice(0, 110)}`)
    .join("\n");
}

/**
 * Parse the model's JSON output. Tolerant: strips markdown fences if
 * the model adds them despite the prompt instructions.
 */
function parseOllamaResponse(text: string): string[] | null {
  let s = text.trim();
  // Strip ```json ... ``` fences if present
  if (s.startsWith("```")) {
    const end = s.lastIndexOf("```");
    s = s.slice(s.indexOf("\n") + 1, end).trim();
  }
  // Find the first [ ... ] in the response
  const start = s.indexOf("[");
  const close = s.lastIndexOf("]");
  if (start === -1 || close === -1 || close <= start) return null;
  s = s.slice(start, close + 1);
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x) => typeof x === "string");
  } catch {
    return null;
  }
}

/**
 * Ollama-based classifier. Uses qwen2.5-coder:14b (or whatever
 * selectSummaryModel returns). Falls back to keyword on any failure
 * — never throws back to the caller.
 */
export async function classifyRolesOllama(skill: Skill): Promise<RoleClassifyResult> {
  const start = Date.now();

  // Pick a model the same way summarizer does
  const model = await selectSummaryModel();
  if (!model) {
    const fallback = classifyRolesKeyword(skill);
    return { ...fallback, reason: `${fallback.reason} (ollama: no model available; fell back to keyword)` };
  }

  const prompt = buildClassifierPrompt(skill, buildRoleHints());

  try {
    const ctrl  = new AbortController();
    // Reuse the summarizer's timeout — covers cold load + inference.
    const timer = setTimeout(() => ctrl.abort(), Config.SUMMARY_TIMEOUT_MS);
    const res   = await fetch(`${getOllamaBaseForClassifier()}/api/generate`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({
        model,
        prompt,
        stream:     false,
        keep_alive: Config.SUMMARY_KEEP_ALIVE,
        options: {
          temperature: 0.1,   // near-deterministic
          num_predict: 200,   // role lists are short — JSON arr of names
        },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);

    const j = await res.json() as { response?: string };
    const raw = (j.response ?? "").trim();

    const candidates = parseOllamaResponse(raw);
    if (!candidates || candidates.length === 0) {
      // Couldn't parse → fall back
      const fb = classifyRolesKeyword(skill);
      return { ...fb, reason: `${fb.reason} (ollama parse failed: ${raw.slice(0, 80).replace(/\s+/g, " ")}; fell back to keyword)` };
    }

    // Filter against canonical role set — drop hallucinated names
    const valid = candidates.filter((r) => ROLE_NAMES.has(r));
    const dropped = candidates.length - valid.length;

    if (valid.length === 0) {
      const fb = classifyRolesKeyword(skill);
      return { ...fb, reason: `${fb.reason} (ollama returned ${candidates.length} roles, all unknown — fell back)` };
    }

    return {
      intended_roles: valid.sort(),
      confidence:     valid.length >= 3 ? "high" : "medium",
      backend:        "ollama",
      reason:         `model=${model}; returned ${candidates.length} roles${dropped > 0 ? ` (${dropped} dropped as unknown to dispatcher)` : ""}`,
      duration_ms:    Date.now() - start,
    };
  } catch (e) {
    // Timeout / network / parse error → graceful fallback
    const fb = classifyRolesKeyword(skill);
    return { ...fb, reason: `${fb.reason} (ollama error: ${(e as Error).message}; fell back to keyword)` };
  }
}

/**
 * Public entry point. Default backend: ollama (via env override or arg).
 *
 * Backend selection priority:
 *   1. opts.backend (explicit)
 *   2. ZC_ROLE_CLASSIFIER env var
 *   3. "ollama" (default — local, no API cost, qwen2.5-coder:14b)
 *
 * Ollama backend gracefully falls back to keyword on any failure
 * (model unavailable, timeout, malformed JSON, network), so callers
 * don't need to handle classifier errors.
 */
export async function classifyRoles(
  skill: Skill,
  opts: { backend?: "keyword" | "ollama" | "realtime-sonnet" } = {},
): Promise<RoleClassifyResult> {
  const backend = opts.backend
    ?? (process.env.ZC_ROLE_CLASSIFIER as "keyword" | "ollama" | "realtime-sonnet" | undefined)
    ?? "ollama";

  if (backend === "ollama") {
    return classifyRolesOllama(skill);
  }
  if (backend === "realtime-sonnet") {
    // TODO v0.25: hook up Sonnet via the polisher's existing API plumbing.
    const r = classifyRolesKeyword(skill);
    return { ...r, reason: `${r.reason} (sonnet backend stubbed; using keyword)` };
  }
  return classifyRolesKeyword(skill);
}
