// Re-verifies an evidence export from the file alone (no database, no server, no network):
//   node scripts/verify-export.mjs evidence-xxxx.json        (or the .html export: the bundle is read from it)
// Checks the owner's signatures on the mandate and on every plan authorisation, the hashes they bind, and the log's hash chain.
// Exit code 0 only if every check passes.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { verifyBundle } from "../src/export/verify-core.js";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/verify-export.mjs <evidence.json|evidence.html>"); process.exit(2); }
let text = readFileSync(file, "utf8");
if (file.endsWith(".html")) {
  const m = text.match(/<script type="application\/json" id="bundle">([\s\S]*?)<\/script>/);
  if (!m) { console.error("no embedded bundle found"); process.exit(2); }
  text = m[1];
}
const checks = await verifyBundle(JSON.parse(text), webcrypto.subtle);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} of ${checks.length} checks FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
