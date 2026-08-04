/**
 * R5 (v0.42.0) — Multimodal file ingestion: PDF, DOCX, and images.
 *
 * Closes the verified LightRAG gap (their May-2026 RagAnything merge added
 * MinerU/Docling parsing) with a LOCAL-FIRST equivalent:
 *   - PDF   → text via pdfjs-dist (Mozilla, pure-JS, no native deps)
 *   - DOCX  → zero-dependency ZIP + XML extraction (a .docx IS a zip; we read the
 *             central directory ourselves and inflate word/document.xml with node:zlib)
 *   - image → described by a LOCAL Ollama vision model when one is installed
 *             (llava / qwen-vl / minicpm-v / moondream …); graceful skip otherwise
 *
 * Extracted text flows through the NORMAL indexing path (indexContent) — so
 * summaries, embeddings, retention tiers, graph edges, and the PG mirror all
 * apply to multimodal content exactly as to plain text.
 */

import { readFileSync } from "node:fs";
import { ollamaBase } from "../config.js";
import { inflateRawSync } from "node:zlib";
import { extname } from "node:path";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB ceiling — reject larger
const MAX_TEXT_CHARS = 50_000;                  // matches the KB content cap

// ── DOCX: minimal ZIP central-directory reader (zero-dep) ────────────────────

function readZipEntry(buf: Buffer, wantedName: string): Buffer | null {
  // End Of Central Directory: scan backwards for PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return null;
  const cdCount  = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null; // central dir header sig
    const compMethod   = buf.readUInt16LE(p + 10);
    const compSize     = buf.readUInt32LE(p + 20);
    const nameLen      = buf.readUInt16LE(p + 28);
    const extraLen     = buf.readUInt16LE(p + 30);
    const commentLen   = buf.readUInt16LE(p + 32);
    const localOffset  = buf.readUInt32LE(p + 42);
    // Normalize separators: spec says '/', but some zippers (PowerShell
    // Compress-Archive) write '\' — tolerate both.
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    if (name === wantedName) {
      // Local file header: sizes/name lengths may differ — re-read them there.
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen  = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (compMethod === 0) return Buffer.from(raw);          // stored
      if (compMethod === 8) return inflateRawSync(raw);        // deflate
      return null;                                             // unsupported method
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Extract readable text from a .docx (paragraphs → newlines, tags stripped). */
export function extractDocxText(path: string): string {
  const buf = readFileSync(path);
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  const xml = readZipEntry(buf, "word/document.xml");
  if (!xml) throw new Error("not a valid .docx (word/document.xml missing)");
  const text = xml.toString("utf8")
    .replace(/<w:p\b[^>]*>/g, "\n")     // paragraph boundaries
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")            // strip all remaining tags
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

// ── PDF: pdfjs-dist text extraction ──────────────────────────────────────────

export async function extractPdfText(path: string): Promise<string> {
  const buf = readFileSync(path);
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  // Legacy build works headless in Node (no DOM). Dynamic import keeps the
  // dependency off the hot path for text-only deployments.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const parts: string[] = [];
  const maxPages = Math.min(doc.numPages, 200);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    parts.push(tc.items.map((it) => ("str" in it ? (it as { str: string }).str : "")).join(" "));
    if (parts.join("\n").length > MAX_TEXT_CHARS) break;
  }
  await doc.destroy();
  return parts.join("\n").replace(/[ \t]{2,}/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

// ── Images: local Ollama vision model (optional) ─────────────────────────────

const VISION_HINTS = ["llava", "vision", "qwen2-vl", "qwen2.5vl", "qwen3-vl", "minicpm-v", "moondream", "bakllava", "gemma3"];


/** Find an installed local vision model, or null. */
export async function findVisionModel(): Promise<string | null> {
  const explicit = process.env["ZC_VISION_MODEL"];
  if (explicit) return explicit;
  try {
    const r = await fetch(`${ollamaBase()}/api/tags`);
    if (!r.ok) return null;
    const j = await r.json() as { models?: Array<{ name: string }> };
    for (const m of j.models ?? []) {
      const n = m.name.toLowerCase();
      if (VISION_HINTS.some((h) => n.includes(h))) return m.name;
    }
  } catch { /* Ollama down */ }
  return null;
}

/** Describe an image via the local vision model. Null when no model is installed. */
export async function describeImage(path: string): Promise<string | null> {
  const model = await findVisionModel();
  if (!model) return null;
  const buf = readFileSync(path);
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  try {
    const r = await fetch(`${ollamaBase()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "Describe this image thoroughly for a searchable knowledge base: content, any visible text (transcribe it), diagrams, UI elements, and their relationships. Plain text, no preamble.",
        images: [buf.toString("base64")],
        stream: false,
        options: { temperature: 0.2, num_predict: 700 },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { response?: string };
    const text = (j.response ?? "").trim();
    return text.length >= 20 ? text.slice(0, MAX_TEXT_CHARS) : null;
  } catch { return null; }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export type ExtractResult =
  | { kind: "pdf" | "docx"; text: string }
  | { kind: "image"; text: string; model: true }
  | { kind: "image"; text: null; model: false }
  | { kind: "unsupported" };

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** Extract indexable text from a multimodal file. */
export async function extractFile(path: string): Promise<ExtractResult> {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf")  return { kind: "pdf",  text: await extractPdfText(path) };
  if (ext === ".docx") return { kind: "docx", text: extractDocxText(path) };
  if (IMAGE_EXTS.has(ext)) {
    const desc = await describeImage(path);
    return desc ? { kind: "image", text: desc, model: true } : { kind: "image", text: null, model: false };
  }
  return { kind: "unsupported" };
}
