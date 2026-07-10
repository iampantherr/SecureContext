/**
 * M0 — Memory-quality benchmark corpus + question set (LongMemEval-style).
 *
 * Deterministic by construction: fixed keys, fixed text, fixed day-offsets
 * (applied relative to seed time via direct DB timestamp rewrites), no RNG.
 *
 * The corpus is deliberately adversarial to the CURRENT architecture so the
 * benchmark can measure each planned improvement:
 *   - GOLD working-memory facts carry LOW importance (2-3) while 40 noise
 *     facts carry HIGH importance (4-5): importance-ordered recall buries
 *     golds → M1 (relevance-ranked recall) should surface them.
 *   - NEAR-DUPLICATE pairs pollute recall slots → M2 (consolidation) merges.
 *   - TEMPORAL decoys: same-topic facts weeks apart → M3 (temporal queries)
 *     must pick the one in the asked window.
 *   - KB DOC CHAINS A→B→C where the query only matches A's vocabulary →
 *     M4 (multi-hop) must surface C (1-hop only reaches B).
 *
 * Categories follow LongMemEval's five abilities (arXiv 2410.10813):
 *   IE  = information extraction (single-fact recall)
 *   MH  = multi-session/multi-hop reasoning (here: KB chain traversal)
 *   TR  = temporal reasoning
 *   KU  = knowledge updates (superseded chains — current fact must win)
 *   AB  = abstention (no answer exists — informational, excluded from headline)
 */

export const AGENT_ID = "developer";

// ── Working-memory facts ─────────────────────────────────────────────────────
// { key, value, importance, kind?, daysAgo }  → created_at = seedTime - daysAgo
// GOLD facts (used as answers) marked gold:true for readability.

export const WM_FACTS = [
  // — Cluster: authentication (gold: auth_token_rotation) —
  { key: "auth_token_rotation", value: "Refresh tokens rotate every 14 days and the rotation job runs in auth-worker, not the API gateway.", importance: 2, daysAgo: 12, gold: true },
  { key: "auth_provider_choice", value: "We use Keycloak as the identity provider for all internal services.", importance: 3, daysAgo: 20 },
  { key: "auth_mfa_note", value: "MFA enrollment is mandatory for admin roles only.", importance: 3, daysAgo: 18 },

  // — Cluster: database (gold: db_conn_pool_size) —
  { key: "db_conn_pool_size", value: "The Postgres connection pool must stay at 12 per service because RDS proxy hard-caps us at 200 total connections.", importance: 2, daysAgo: 9, gold: true },
  { key: "db_engine_choice", value: "Postgres 16 is the standard database engine for new services.", importance: 4, daysAgo: 30 },
  { key: "db_migration_tool", value: "Schema migrations run through sqitch, not raw SQL scripts.", importance: 3, daysAgo: 25 },

  // — Cluster: deployments (gold: deploy_freeze_window) —
  { key: "deploy_freeze_window", value: "Production deploys are frozen every quarter-close week; the calendar lives in ops/freeze.md.", importance: 2, daysAgo: 7, gold: true },
  { key: "deploy_tool", value: "ArgoCD drives all Kubernetes deployments.", importance: 4, daysAgo: 28 },
  { key: "deploy_rollback_note", value: "Rollbacks must use argo rollback, never kubectl apply of old manifests.", importance: 3, daysAgo: 22 },

  // — Cluster: frontend (gold: fe_bundle_budget) —
  { key: "fe_bundle_budget", value: "The landing page JavaScript bundle budget is 180KB gzipped; CI fails the build above that.", importance: 2, daysAgo: 11, gold: true },
  { key: "fe_framework", value: "Next.js 15 with app router is the frontend standard.", importance: 4, daysAgo: 29 },
  { key: "fe_styling", value: "Tailwind v4 only; no CSS modules in new code.", importance: 3, daysAgo: 26 },

  // — Cluster: billing (gold: billing_proration_rule) —
  { key: "billing_proration_rule", value: "Mid-cycle plan upgrades prorate daily but downgrades only apply at the next cycle boundary.", importance: 2, daysAgo: 8, gold: true },
  { key: "billing_provider", value: "Stripe is the payments provider; invoices generate on the 1st.", importance: 4, daysAgo: 27 },
  { key: "billing_tax_note", value: "EU VAT is handled by Stripe Tax, not our code.", importance: 3, daysAgo: 24 },

  // — Cluster: observability (gold: obs_trace_sampling) —
  { key: "obs_trace_sampling", value: "Trace sampling is 10% in production but ERROR spans are always kept via tail sampling in the collector.", importance: 2, daysAgo: 10, gold: true },
  { key: "obs_stack", value: "Grafana + Tempo + Loki is the observability stack.", importance: 4, daysAgo: 30 },
  { key: "obs_dashboard_note", value: "Team dashboards live under grafana folder 'squad-dashboards'.", importance: 3, daysAgo: 23 },

  // — Cluster: incident process (gold: inc_sev1_paging) —
  { key: "inc_sev1_paging", value: "SEV1 incidents page the on-call AND the engineering manager simultaneously; SEV2 pages on-call only.", importance: 2, daysAgo: 13, gold: true },
  { key: "inc_tool", value: "Incidents are tracked in incident.io.", importance: 4, daysAgo: 21 },

  // — Cluster: API design (gold: api_pagination_style) —
  { key: "api_pagination_style", value: "Public APIs use cursor pagination with opaque base64 cursors; offset pagination is banned.", importance: 2, daysAgo: 6, gold: true },
  { key: "api_versioning", value: "API versioning is header-based (X-API-Version), not URL-based.", importance: 4, daysAgo: 19 },

  // — Cluster: security reviews (gold: sec_dep_scan_gate) —
  { key: "sec_dep_scan_gate", value: "Dependency CVE scans block merge only for HIGH and CRITICAL findings with a fix version available.", importance: 2, daysAgo: 5, gold: true },
  { key: "sec_review_cadence", value: "Quarterly security reviews are led by the platform team.", importance: 4, daysAgo: 17 },

  // — Cluster: testing (gold: test_flaky_quarantine) —
  { key: "test_flaky_quarantine", value: "A test that flakes 3 times in 7 days is auto-quarantined into the nightly-only suite by the flake bot.", importance: 2, daysAgo: 4, gold: true },
  { key: "test_framework", value: "Vitest for unit tests, Playwright for E2E.", importance: 4, daysAgo: 16 },

  // — TEMPORAL cluster: cache TTL (gold recent vs decoy old — same topic!) —
  { key: "cache_ttl_decision_old", value: "Cache TTL decision: product cache entries expire after 15 minutes.", importance: 3, kind: "decision", daysAgo: 25 },
  { key: "cache_ttl_decision_new", value: "Cache TTL decision: product cache entries now expire after 60 minutes to cut origin load.", importance: 2, kind: "decision", daysAgo: 4, gold: true },

  // — TEMPORAL cluster: rate limiting (gold old vs decoy recent) —
  { key: "ratelimit_decision_march", value: "Rate limiting decision: public API limited to 100 requests per minute per key.", importance: 2, kind: "decision", daysAgo: 45, gold: true },
  { key: "ratelimit_note_recent", value: "Rate limiting note: internal services bypass the public rate limiter entirely.", importance: 3, daysAgo: 3 },

  // — KNOWLEDGE-UPDATE chains (old retired via superseded_by, new live) —
  { key: "queue_backend_old", value: "Job queue decision: we use Redis lists via BullMQ for background jobs.", importance: 3, kind: "decision", daysAgo: 40, retire: { by: "queue_backend_new" } },
  { key: "queue_backend_new", value: "Job queue decision: background jobs migrated from BullMQ to pg-boss so Postgres is the only stateful dependency.", importance: 2, kind: "decision", daysAgo: 6, gold: true },
  { key: "storage_provider_old", value: "File uploads are stored in S3 us-east-1.", importance: 3, daysAgo: 38, retire: { by: "storage_provider_new" } },
  { key: "storage_provider_new", value: "File uploads now go to Cloudflare R2; S3 is read-only legacy until Q3 migration completes.", importance: 2, daysAgo: 5, gold: true },
  { key: "notify_channel_old", value: "Alerts are sent to the #ops Slack channel.", importance: 3, daysAgo: 35, retire: { by: "notify_channel_new" } },
  { key: "notify_channel_new", value: "Alerts moved from #ops to the #incidents Slack channel with severity-based routing.", importance: 2, daysAgo: 3, gold: true },

  // — NEAR-DUPLICATE pairs (M2 consolidation targets; both live) —
  { key: "dup_lint_a", value: "ESLint with the shared config @acme/eslint-config is mandatory on every package.", importance: 3, daysAgo: 15 },
  { key: "dup_lint_b", value: "Every package must use ESLint and extend the shared @acme/eslint-config preset.", importance: 3, daysAgo: 9 },
  { key: "dup_tz_a", value: "All backend timestamps are stored in UTC; conversion happens only at the UI layer.", importance: 3, daysAgo: 14 },
  { key: "dup_tz_b", value: "Backend stores timestamps exclusively in UTC and the frontend converts for display.", importance: 3, daysAgo: 8 },
  { key: "dup_pr_a", value: "Pull requests need one approval from a code owner before merge.", importance: 3, daysAgo: 13 },
  { key: "dup_pr_b", value: "Merging a PR requires a single code-owner approval.", importance: 3, daysAgo: 7 },
  { key: "dup_env_a", value: "Secrets are injected via Doppler; .env files are forbidden in repos.", importance: 3, daysAgo: 12 },
  { key: "dup_env_b", value: "No .env files in git — all secrets come from Doppler at runtime.", importance: 3, daysAgo: 6 },
];

// 40 high-importance noise facts (work-log style) that dominate importance
// ordering. Generated deterministically by index.
export function noiseFacts() {
  const topics = [
    "sprint planning notes", "release checklist status", "standup summary",
    "roadmap review outcome", "quarterly OKR check-in", "retro action items",
    "capacity planning update", "hiring pipeline status", "vendor contract note",
    "team offsite logistics",
  ];
  const out = [];
  for (let i = 0; i < 40; i++) {
    const t = topics[i % topics.length];
    out.push({
      key: `worklog_${String(i).padStart(2, "0")}`,
      value: `Work log ${i}: ${t} recorded for iteration ${Math.floor(i / 10) + 40}; owners confirmed and follow-ups filed in the tracker.`,
      importance: i % 2 === 0 ? 5 : 4,
      daysAgo: (i % 28) + 1,
    });
  }
  return out;
}

// ── KB documents (via /api/v1/index) ────────────────────────────────────────
// Multi-hop chains: query vocabulary appears ONLY in the head doc; the answer
// lives 2 hops away. Docs reference each other by basename so the co-reference
// graph builder links them.
export const KB_DOCS = [
  // Chain 1: checkout-overview → ledger-service → reconciliation-rules (gold)
  { source: "file:docs/checkout-overview.md", content: "Checkout overview: the customer payment journey starts at the cart, proceeds through payment capture, and hands settlement to the accounting layer described in ledger-service.md. Nothing about matching rules lives here." },
  { source: "file:docs/ledger-service.md", content: "Ledger service: double-entry postings for every captured payment. Settlement batches are matched nightly according to reconciliation-rules.md. This service owns the postings table only." },
  { source: "file:docs/reconciliation-rules.md", content: "Reconciliation rules: unmatched settlement entries older than 48 hours escalate to the finance queue, and tolerance for amount mismatch is 0.5 percent before manual review is required." },

  // Chain 2: onboarding-flow → provisioning-service → quota-defaults (gold)
  { source: "file:docs/onboarding-flow.md", content: "Onboarding flow: new workspace signup collects the company profile and triggers tenant creation via provisioning-service.md. Quota details are not defined here." },
  { source: "file:docs/provisioning-service.md", content: "Provisioning service: creates the tenant schema, seeds default roles, and applies the limits defined in quota-defaults.md before activating the workspace." },
  { source: "file:docs/quota-defaults.md", content: "Quota defaults: every new workspace starts with 5 seats, 10 GB storage, and 100k API calls per month; enterprise plans lift the API ceiling to 2 million." },

  // Chain 3: search-architecture → indexer-pipeline → stemming-config (gold)
  { source: "file:docs/search-architecture.md", content: "Search architecture: user queries hit the query service which fans out to shards; document ingestion is handled by the indexer-pipeline.md. Language handling is downstream." },
  { source: "file:docs/indexer-pipeline.md", content: "Indexer pipeline: normalizes documents, applies analyzers per language, and loads the token filters from stemming-config.md before writing segments." },
  { source: "file:docs/stemming-config.md", content: "Stemming configuration: English uses the Porter2 stemmer, German uses the light variant, and Turkish stemming is disabled entirely because of over-stemming defects." },

  // Standalone docs (IE-from-KB + abstention distractors)
  { source: "file:docs/webhook-retries.md", content: "Webhook retries: failed deliveries retry with exponential backoff at 1, 5, 25, and 125 minutes, then park in the dead-letter table for manual replay." },
  { source: "file:docs/feature-flags.md", content: "Feature flags: flags are evaluated in the edge middleware with a 30-second config refresh; kill switches propagate globally in under a minute." },
  { source: "file:docs/data-retention.md", content: "Data retention: audit events are kept for 400 days, application logs for 30 days, and raw request bodies are never persisted." },
  { source: "file:docs/email-templates.md", content: "Email templates: transactional emails render from MJML sources at build time; marketing emails are managed in the ESP, not in this repo." },
  { source: "file:docs/mobile-release.md", content: "Mobile release: iOS and Android ship on a two-week train; hotfixes require VP approval and skip the train." },
  { source: "file:docs/i18n-process.md", content: "Internationalization: strings are extracted weekly to the TMS, and machine-translated drafts must be human-reviewed for German and Japanese before release." },
];

// ── Questions ────────────────────────────────────────────────────────────────
// { id, category, question, gold: {type:'wm', key} | {type:'kb', source} | null,
//   decoy? (key/source that must NOT outrank gold), window? (for TR reference) }
export const QUESTIONS = [
  // IE — single-fact recall from working memory (golds are low-importance)
  { id: "ie-01", category: "IE", question: "How often do refresh tokens rotate and which service runs the rotation job?", gold: { type: "wm", key: "auth_token_rotation" } },
  { id: "ie-02", category: "IE", question: "What is our Postgres connection pool size per service and why that number?", gold: { type: "wm", key: "db_conn_pool_size" } },
  { id: "ie-03", category: "IE", question: "When are production deployments frozen?", gold: { type: "wm", key: "deploy_freeze_window" } },
  { id: "ie-04", category: "IE", question: "What is the JavaScript bundle size budget for the landing page?", gold: { type: "wm", key: "fe_bundle_budget" } },
  { id: "ie-05", category: "IE", question: "How does proration work when a customer upgrades mid-cycle?", gold: { type: "wm", key: "billing_proration_rule" } },
  { id: "ie-06", category: "IE", question: "What is the trace sampling rate in production and how are error spans handled?", gold: { type: "wm", key: "obs_trace_sampling" } },
  { id: "ie-07", category: "IE", question: "Who gets paged for a SEV1 incident?", gold: { type: "wm", key: "inc_sev1_paging" } },
  { id: "ie-08", category: "IE", question: "What pagination style do our public APIs use?", gold: { type: "wm", key: "api_pagination_style" } },
  { id: "ie-09", category: "IE", question: "Which dependency scan findings block a merge?", gold: { type: "wm", key: "sec_dep_scan_gate" } },
  { id: "ie-10", category: "IE", question: "What happens to a test that keeps flaking?", gold: { type: "wm", key: "test_flaky_quarantine" } },
  { id: "ie-11", category: "IE", question: "What is the retry schedule for failed webhook deliveries?", gold: { type: "kb", source: "file:docs/webhook-retries.md" } },
  { id: "ie-12", category: "IE", question: "How long are audit events retained?", gold: { type: "kb", source: "file:docs/data-retention.md" } },

  // MH — multi-hop KB chains (query vocabulary only matches the head doc)
  { id: "mh-01", category: "MH", question: "In the customer payment journey from cart to settlement, what tolerance is allowed for amount mismatches before manual review?", gold: { type: "kb", source: "file:docs/reconciliation-rules.md" }, head: "file:docs/checkout-overview.md" },
  { id: "mh-02", category: "MH", question: "During the customer payment journey, when do unmatched settlement entries escalate to finance?", gold: { type: "kb", source: "file:docs/reconciliation-rules.md" }, head: "file:docs/checkout-overview.md" },
  { id: "mh-03", category: "MH", question: "When a new workspace signup completes, how many seats and API calls does the workspace start with?", gold: { type: "kb", source: "file:docs/quota-defaults.md" }, head: "file:docs/onboarding-flow.md" },
  { id: "mh-04", category: "MH", question: "After a workspace signup collects the company profile, what storage limit is applied?", gold: { type: "kb", source: "file:docs/quota-defaults.md" }, head: "file:docs/onboarding-flow.md" },
  { id: "mh-05", category: "MH", question: "For user queries hitting the query service, which stemmer is used for English content?", gold: { type: "kb", source: "file:docs/stemming-config.md" }, head: "file:docs/search-architecture.md" },
  { id: "mh-06", category: "MH", question: "In our search stack that fans out to shards, why is Turkish stemming turned off?", gold: { type: "kb", source: "file:docs/stemming-config.md" }, head: "file:docs/search-architecture.md" },

  // TR — temporal reasoning (window relative to seed time)
  { id: "tr-01", category: "TR", question: "What did we decide about cache TTL last week?", gold: { type: "wm", key: "cache_ttl_decision_new" }, decoy: { type: "wm", key: "cache_ttl_decision_old" } },
  { id: "tr-02", category: "TR", question: "What was our cache TTL decision about three weeks ago, before the recent change?", gold: { type: "wm", key: "cache_ttl_decision_old" }, decoy: { type: "wm", key: "cache_ttl_decision_new" } },
  { id: "tr-03", category: "TR", question: "What rate limiting decision did we make about six weeks ago?", gold: { type: "wm", key: "ratelimit_decision_march" }, decoy: { type: "wm", key: "ratelimit_note_recent" } },
  { id: "tr-04", category: "TR", question: "What decisions were made in the last 7 days about caching?", gold: { type: "wm", key: "cache_ttl_decision_new" }, decoy: { type: "wm", key: "cache_ttl_decision_old" } },
  { id: "tr-05", category: "TR", question: "What did we change about alert notification channels in the last week?", gold: { type: "wm", key: "notify_channel_new" } },
  { id: "tr-06", category: "TR", question: "As of one month ago, where were file uploads stored?", gold: { type: "wm", key: "storage_provider_old" }, asOfDaysAgo: 30 },
  { id: "tr-07", category: "TR", question: "What job queue decision was in effect five weeks ago?", gold: { type: "wm", key: "queue_backend_old" }, asOfDaysAgo: 35 },
  { id: "tr-08", category: "TR", question: "What changed about the job queue in the last two weeks?", gold: { type: "wm", key: "queue_backend_new" }, decoy: { type: "wm", key: "queue_backend_old" } },

  // KU — knowledge updates: the CURRENT fact must be returned (old is retired)
  { id: "ku-01", category: "KU", question: "What do we use for background job queues?", gold: { type: "wm", key: "queue_backend_new" }, retired: "queue_backend_old" },
  { id: "ku-02", category: "KU", question: "Where do file uploads go?", gold: { type: "wm", key: "storage_provider_new" }, retired: "storage_provider_old" },
  { id: "ku-03", category: "KU", question: "Which Slack channel receives alerts?", gold: { type: "wm", key: "notify_channel_new" }, retired: "notify_channel_old" },
  { id: "ku-04", category: "KU", question: "What is the current product cache TTL?", gold: { type: "wm", key: "cache_ttl_decision_new" }, decoy: { type: "wm", key: "cache_ttl_decision_old" } },
  { id: "ku-05", category: "KU", question: "Is BullMQ still in use for jobs?", gold: { type: "wm", key: "queue_backend_new" }, retired: "queue_backend_old" },
  { id: "ku-06", category: "KU", question: "Is S3 still the primary upload target?", gold: { type: "wm", key: "storage_provider_new" }, retired: "storage_provider_old" },

  // AB — abstention (no relevant memory exists; informational only)
  { id: "ab-01", category: "AB", question: "What is our policy on GPU cluster reservations?", gold: null },
  { id: "ab-02", category: "AB", question: "Which CDN do we use for video streaming?", gold: null },
  { id: "ab-03", category: "AB", question: "What did we decide about the Rust rewrite of the billing engine?", gold: null },
  { id: "ab-04", category: "AB", question: "What is the on-call compensation policy?", gold: null },
];
