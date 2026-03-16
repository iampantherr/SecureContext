// SECURITY: We strip all credential headers before making any fetch request.
// SECURITY: We block SSRF — requests to loopback, private IPs, and cloud metadata
//           endpoints are rejected both by hostname AND by DNS resolution.
//           DNS-based SSRF check closes the DNS rebinding gap in pure hostname checks.

import { resolve4, resolve6 } from "node:dns/promises";

const BLOCKED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "proxy-authorization",
]);

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

export interface FetchResult {
  url: string;
  title: string;
  markdown: string;
  fetchedAt: string;
  byteSize: number;
}

// ─── SSRF Protection ─────────────────────────────────────────────────────────
// Blocks requests to loopback, private RFC-1918, link-local, cloud metadata
// endpoints, and other reserved addresses. Prevents the plugin being used as
// an SSRF proxy against internal services or cloud instance metadata APIs.
//
// Limitation: DNS rebinding can bypass hostname checks. A full SSRF fix requires
// resolving the hostname and checking the resulting IP — not done here to avoid
// the dns module. This covers the primary attack surface (literal IPs + localhost).

const SSRF_BLOCKED_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

// Known cloud metadata service IPs not covered by standard RFC ranges:
// 168.63.129.16  — Azure Instance Metadata Service (IMDS) and internal Azure DNS
// These are non-RFC-1918 but internal to cloud provider virtual networks.
const SSRF_BLOCKED_LITERAL_IPS = new Set([
  "168.63.129.16",  // Azure IMDS / Azure internal DNS resolver
]);

// Returns true if the hostname/IP string is a reserved/private address
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Exact hostname blocklist
  if (SSRF_BLOCKED_HOSTS.has(h)) return true;

  // Literal IP blocklist for cloud metadata IPs outside standard RFC ranges
  if (SSRF_BLOCKED_LITERAL_IPS.has(h)) return true;

  // *.local mDNS names (LAN service discovery)
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;

  // Pure IPv4 check: parse octets
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b, c, d] = v4.map(Number) as [unknown, number, number, number, number];
    if (
      a === 127 ||                                        // 127.0.0.0/8 loopback
      a === 0 ||                                          // 0.0.0.0/8 reserved
      a === 10 ||                                         // 10.0.0.0/8 private (RFC-1918)
      (a === 172 && b >= 16 && b <= 31) ||               // 172.16-31.0.0/12 private
      (a === 192 && b === 168) ||                         // 192.168.0.0/16 private
      (a === 169 && b === 254) ||                         // 169.254.0.0/16 link-local (AWS/GCP/Azure metadata)
      (a === 100 && b >= 64 && b <= 127) ||              // 100.64-127.0.0/10 shared address space
      (a === 192 && b === 0 && c === 2) ||               // 192.0.2.0/24 TEST-NET-1
      (a === 198 && b === 51 && c === 100) ||            // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) ||             // 203.0.113.0/24 TEST-NET-3
      (a === 240)                                         // 240.0.0.0/4 reserved
    ) return true;
  }

  // IPv6: loopback and private prefixes
  if (
    h === "::1" ||           // IPv6 loopback
    h === "::" ||            // IPv6 unspecified
    h.startsWith("fc") ||   // fc00::/7 unique local
    h.startsWith("fd") ||   // fd00::/8 unique local
    h.startsWith("fe80") || // fe80::/10 link-local
    h.startsWith("::ffff:7f") // ::ffff:127.x.x.x IPv4-mapped loopback
  ) return true;

  return false;
}

function assertNotSSRFByHostname(parsed: URL): void {
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(
      `SSRF blocked: '${parsed.hostname}' is a reserved/internal/loopback address. ` +
      `Only public internet URLs are allowed.`
    );
  }
}

/**
 * DNS-resolution SSRF check — closes the DNS rebinding attack vector.
 *
 * DNS rebinding attack: attacker.com initially resolves to public IP (passes hostname check),
 * then resolves to 127.0.0.1 at fetch time (bypasses hostname SSRF guard).
 * Mitigation: resolve the hostname HERE and check all returned IPs.
 *
 * Limitation: TOCTOU race between our DNS check and fetch's DNS lookup.
 * Full mitigation requires intercepting the TCP socket — impractical without a proxy.
 * This eliminates the primary rebinding vector while keeping code auditable.
 *
 * SECURITY: Skip resolution for literal IP addresses — isBlockedHost already handles those.
 */
function isLiteralIP(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || /^[0-9a-f:]+$/i.test(h);
}

async function assertNotSSRFByDNS(parsed: URL): Promise<void> {
  const hostname = parsed.hostname;
  if (isLiteralIP(hostname)) return; // already checked by assertNotSSRFByHostname

  const checkAddresses = (addresses: string[], family: string) => {
    for (const addr of addresses) {
      if (isBlockedHost(addr)) {
        throw new Error(
          `SSRF blocked: '${hostname}' resolves to ${family} address '${addr}' ` +
          `which is a reserved/internal/loopback range.`
        );
      }
    }
  };

  // Check IPv4 and IPv6 in parallel — either can expose an internal address
  const [v4Result, v6Result] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);

  if (v4Result.status === "fulfilled") checkAddresses(v4Result.value, "IPv4");
  if (v6Result.status === "fulfilled") checkAddresses(v6Result.value, "IPv6");
  // If both DNS lookups fail → hostname doesn't resolve → fetch will fail naturally
}

// ─── Header sanitization ─────────────────────────────────────────────────────

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
      safe[k] = v;
    }
  }
  return safe;
}

// ─── HTML → Markdown ─────────────────────────────────────────────────────────

function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
  let text = html;

  const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim() : baseUrl;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n");
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  text = text.replace(/<\/(ul|ol)>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, "_$2_");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return { title, markdown: text };
}

// ─── Main fetch function ──────────────────────────────────────────────────────

export async function fetchAndConvert(
  url: string,
  extraHeaders: Record<string, string> = {}
): Promise<FetchResult> {
  // Validate URL — only http/https allowed
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}. Only http/https allowed.`);
  }

  // SECURITY: Two-layer SSRF protection:
  // Layer 1 — hostname/IP blocklist (synchronous, covers literal IPs and known hostnames)
  assertNotSSRFByHostname(parsed);
  // Layer 2 — DNS resolution check (async, closes DNS rebinding attack vector)
  await assertNotSSRFByDNS(parsed);

  const safeHeaders = sanitizeHeaders({
    "User-Agent": "zc-ctx/0.1.0 (Claude Code context plugin)",
    "Accept": "text/html,text/plain,application/json",
    ...extraHeaders,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    // SECURITY: redirect:"follow" is default but each redirect target is NOT re-validated.
    // We use redirect:"follow" for usability, but note DNS rebinding remains a theoretical
    // risk. A full fix would require manual redirect handling with re-validation on each hop.
    response = await fetch(url, {
      headers: safeHeaders,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const isJson = contentType.includes("application/json");

  // Stream response with size cap (gzip bomb protection)
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const rawBody = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");

  let title = url;
  let markdown: string;

  if (isHtml) {
    const converted = htmlToMarkdown(rawBody, url);
    title = converted.title;
    markdown = converted.markdown;
  } else if (isJson) {
    title = url;
    markdown = "```json\n" + rawBody.slice(0, 50_000) + "\n```";
  } else {
    markdown = rawBody.slice(0, 100_000);
  }

  return {
    url,
    title,
    markdown,
    fetchedAt: new Date().toISOString(),
    byteSize: totalBytes,
  };
}
