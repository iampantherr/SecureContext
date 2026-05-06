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
import { ROLE_NAMES } from "./roles_catalog.js";

export interface RoleClassifyResult {
  intended_roles: string[];
  confidence:     "high" | "medium" | "low";
  backend:        "keyword" | "realtime-sonnet";
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

/**
 * Public entry point. Picks backend by env or arg. Default: keyword.
 */
export async function classifyRoles(skill: Skill, opts: { backend?: "keyword" | "realtime-sonnet" } = {}): Promise<RoleClassifyResult> {
  const backend = opts.backend ?? (process.env.ZC_ROLE_CLASSIFIER ?? "keyword") as "keyword" | "realtime-sonnet";
  if (backend === "realtime-sonnet") {
    // TODO v0.25: hook up Sonnet via the polisher's existing API plumbing.
    // For now, fall through to keyword and tag the result.
    const r = classifyRolesKeyword(skill);
    return { ...r, reason: `${r.reason} (sonnet backend stubbed; using keyword)` };
  }
  return classifyRolesKeyword(skill);
}
