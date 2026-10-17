// A dedicated, SYNTHETIC business for demonstrating the flight simulator. It is a new throwaway copy of the demo company (the demo company itself and
// every other business are never touched): the two sample documents are confirmed (a supplier order and a customer order), a 50,000.00 supplier bill
// is added, and the clone's bank balance is raised (owner role, this clone only) until the lowest balance in the 20-week forecast is exactly the
// reserve plus 10,000.00. So: today the books are healthy and thin; the combined crisis is what creates the shortage.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { buildForecast } from "../src/engine";

export const MARGIN_MINOR = 1_000_000n;

export async function createFlightDemo(opts: { healthy?: boolean; keepDbOpen?: boolean } = {}): Promise<{ id: string; name: string; lowestMinor: bigint; reserveMinor: bigint }> {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { createDocument } = await import("../src/actions/ledger");
  const { buildContext } = await import("../src/actions/agent-run");
  const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const demo = await getDefaultBusinessId();
  if (!demo) throw new Error("run bun run db:seed first");
  const clone = await createDemoClone(db as any, demo);
  const gw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
  for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
    const r = await docs.createDocumentAndExtract(db as any, clone.id, { filename, kind, text: readFileSync(join("fixtures", filename), "utf8") }, { gateway: gw });
    await confirmExtraction(db as any, r.extraction.id, "Demo Owner");
  }
  const c0 = await buildContext(db as any, clone.id, null, []);
  const supplier = (await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, clone.id))).find((c) => c.role === "supplier")!;
  const due = new Date(Date.parse(`${c0.asOf}T00:00:00Z`) + 21 * 86_400_000).toISOString().slice(0, 10);
  await createDocument(db as any, clone.id, "bill", { counterpartyId: supplier.id, number: "DEMO-1", issuedOn: c0.asOf, dueOn: due, amount: "50000.00", acknowledgeOverlaps: true });
  const ctx = await buildContext(db as any, clone.id, null, []);
  const f = buildForecast(ctx.input, { events: ctx.pending.map((p) => p.event), horizonWeeks: ctx.horizonWeeks });
  if (opts.healthy !== false) {
    const topUp = ctx.input.reserve + MARGIN_MINOR - f.minimum.amount;
    const owner = postgres(process.env.DATABASE_URL!, { max: 1 }); // owner role: only for this throwaway clone's opening balance
    await owner`update financial_accounts set balance_minor = balance_minor + ${topUp.toString()} where business_id = ${clone.id}`;
    await owner.end();
  }
  const after = await buildContext(db as any, clone.id, null, []);
  const g = buildForecast(after.input, { events: after.pending.map((p) => p.event), horizonWeeks: after.horizonWeeks });
  if (!opts.keepDbOpen) await sql.end();
  return { id: clone.id, name: clone.name, lowestMinor: g.minimum.amount, reserveMinor: after.input.reserve };
}
