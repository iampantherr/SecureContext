// Run auto-import in verbose mode and dump per-file outcomes
import { autoImportSkills } from "/app/dist/skill_auto_import.js";

const result = await autoImportSkills({ verbose: false });
console.log("Summary:", {
  scanned: result.scanned,
  inserted: result.inserted,
  updated: result.updated,
  skipped_same: result.skipped_same,
  parse_errors: result.parse_errors,
  validation_errors: result.validation_errors,
});

const fails = result.details.filter((d) =>
  d.result === "parse_error" || d.result === "validation_error" || d.result === "db_error"
);
console.log(`\n${fails.length} failures:`);
for (const d of fails) {
  console.log(`  [${d.result}] ${d.file}: ${d.reason ?? "(no reason)"}`);
}
