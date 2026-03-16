// SECURITY: We strip all credential headers before making any fetch request.
// This prevents leaking API keys or session tokens to arbitrary URLs.

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

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
      safe[k] = v;
    }
  }
  return safe;
}

function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
  // Minimal HTML → Markdown conversion (no external deps)
  let text = html;

  // Extract title
  const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim() : baseUrl;

  // Remove script/style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n");

  // Code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Links — keep text only (avoid leaking hrefs to noise)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  text = text.replace(/<\/(ul|ol)>/gi, "\n");

  // Paragraphs and breaks
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Bold/italic
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, "_$2_");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return { title, markdown: text };
}

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

  const safeHeaders = sanitizeHeaders({
    "User-Agent": "zc-ctx/0.1.0 (Claude Code context plugin)",
    "Accept": "text/html,text/plain,application/json",
    ...extraHeaders,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { headers: safeHeaders, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const isJson = contentType.includes("application/json");

  // Stream response with size cap
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
