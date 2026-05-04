import { backfillSecurityScans } from "/app/dist/skill_auto_import.js";
const r = await backfillSecurityScans();
console.log("Result:", r);
