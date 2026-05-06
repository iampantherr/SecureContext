// Test the Ollama role classifier on a single skill
import { classifyRoles, classifyRolesKeyword, classifyRolesOllama } from "/app/dist/skills/role_classifier.js";

const skill = {
  skill_id: "anthropic-pdf@1@global",
  frontmatter: {
    name: "anthropic-pdf",
    version: "1",
    scope: "global",
    description: "Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable.",
  },
  body: "",
  body_hmac: "",
  source_path: null,
  promoted_from: null,
  created_at: new Date().toISOString(),
  archived_at: null,
  archive_reason: null,
};

console.log("=== keyword backend ===");
const kw = classifyRolesKeyword(skill);
console.log(JSON.stringify(kw, null, 2));

console.log("\n=== ollama backend ===");
const oll = await classifyRolesOllama(skill);
console.log(JSON.stringify(oll, null, 2));

console.log("\n=== default classifyRoles() ===");
const def = await classifyRoles(skill);
console.log(JSON.stringify({ ...def, intended_roles_count: def.intended_roles.length }, null, 2));
