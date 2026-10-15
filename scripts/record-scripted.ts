// Creates SCRIPTED recordings (not real model output) for the fixture documents, so the demo works offline in replay mode.
//   bun run llm:record-scripted
// Recordings are keyed by the exact request. If the fixtures are regenerated with other dates, run this again.
import { readFileSync } from "node:fs";
import { createGateway, RECORDINGS_DIR } from "../src/ai";
import { extractDocument } from "../src/ingest/documents";

const gw = createGateway({ provider: "mock", mode: "record", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
const docs: [string, "purchase_order" | "supplier_quote"][] = [
  ["fixtures/purchase-order-northgate.md", "purchase_order"],
  ["fixtures/supplier-quote-kestrel.md", "supplier_quote"],
  ["fixtures/injected-purchase-order.md", "purchase_order"],
];
for (const [file, kind] of docs) {
  const text = readFileSync(file, "utf8");
  const run = await extractDocument(text, kind, { asOf: "2026-10-15", gateway: gw });
  console.log(`${file}: ${run.outcome.status}, ${run.outcome.flags.flags.length} flag(s), ${run.outcome.flags.suspicious.length} suspicious`);
}
console.log(`Scripted recordings written to ${RECORDINGS_DIR}`);
