// Usage: bun run import:csv -- <file> --business <id>
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { importBankStatement } from "../src/ingest/import";
import { formatMoney } from "../src/lib/money";

async function main() {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--business");
  const businessId = bi >= 0 ? args[bi + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && i !== bi + 1);
  if (!file || !businessId) {
    console.error("Usage: bun run import:csv -- <file> --business <id>");
    process.exit(2);
  }
  const { db, sql } = await import("../src/db");
  try {
    const s = await importBankStatement(db, businessId, readFileSync(file, "utf8"), basename(file));
    const r = s.reconciliation;
    console.log(`File:            ${file}`);
    console.log(`Rows read:       ${s.rowsRead}`);
    console.log(`Imported:        ${s.imported}`);
    console.log(`Duplicates:      ${s.duplicates}`);
    console.log(`Errors:          ${s.errors.length}`);
    for (const e of s.errors.slice(0, 20)) console.log(`  row ${e.row}, ${e.field}: ${e.reason}`);
    if (s.errors.length > 20) console.log(`  ... and ${s.errors.length - 20} more`);
    if (r.statementClosing && r.computedClosing && r.difference) {
      console.log(
        `Reconciliation:  ${r.ok ? "OK" : "MISMATCH"} (statement closing ${formatMoney(r.statementClosing, s.exponent)}, ` +
          `computed ${formatMoney(r.computedClosing, s.exponent)}, difference ${formatMoney(r.difference, s.exponent)}, ` +
          `${r.balanceBreaks.length} balance break(s))`,
      );
    } else console.log("Reconciliation:  n/a (no valid rows)");
    if (s.errors.length > 0 || !r.ok) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
