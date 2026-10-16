// Phase K: sign a new mandate version with FUNDING limits, using the owner dev key (like mandate:v2). Announced: it inserts one mandate row,
// marks the previous version inactive and appends one record to the action log. Nothing is wiped or re-seeded.
//   bun run mandate:funding [businessId]
//   FUNDING_MAX_COST_BPS (default 6000 = 60% estimated yearly cost) and FUNDING_MAX_AMOUNT_MINOR (default 5000000 = 50,000.00) set the limits.
// The limits shape the funding comparison the owner sees; nothing executes a loan, so no gate decision depends on them yet.
import assert from "node:assert/strict";
import type { MandateWire } from "../src/gate/mandate";
import { signMandate } from "../src/gate/owner-signing";

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, desc, eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { appendActionRecord } = await import("../src/actionlog");
  const { ACTION_EVENTS } = await import("../src/actions/types");
  try {
    const id = process.argv[2] ?? (await getDefaultBusinessId());
    assert.ok(id, "no business; run bun run db:seed first");
    const costBps = Number(process.env.FUNDING_MAX_COST_BPS ?? "6000");
    const amountMinor = process.env.FUNDING_MAX_AMOUNT_MINOR ?? "5000000";
    assert.ok(Number.isInteger(costBps) && costBps >= 0 && costBps <= 100000, "FUNDING_MAX_COST_BPS must be an integer from 0 to 100000");
    assert.ok(/^\d+$/.test(amountMinor), "FUNDING_MAX_AMOUNT_MINOR must be a non-negative integer (minor units)");
    const [cur] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, id!), eq(S.mandates.active, true))).orderBy(desc(S.mandates.version)).limit(1);
    assert.ok(cur, "no active mandate for that business");
    const wire = JSON.parse(cur.canonical) as MandateWire;
    const next: MandateWire = { ...wire, version: cur.version + 1, limits: { ...wire.limits, maxFundingCostBps: costBps, maxFundingAmountMinor: amountMinor } };
    const signed = signMandate(next);
    await db.update(S.mandates).set({ active: false }).where(and(eq(S.mandates.businessId, id!), eq(S.mandates.active, true)));
    await db.insert(S.mandates).values({ businessId: id!, version: next.version, canonical: signed.canonical, signature: signed.signature, active: true });
    await appendActionRecord(db, { businessId: id!, event: ACTION_EVENTS.MANDATE_VERSION_SIGNED, actor: "owner", detail: { version: next.version, previousVersion: cur.version, maxFundingCostBps: costBps, maxFundingAmountMinor: amountMinor, signedBy: "owner dev key" } });
    console.log(`signed mandate v${next.version} for ${id}: funding cost limit ${costBps / 100}% a year, amount limit ${amountMinor} minor units (v${cur.version} is now inactive); logged`);
  } finally {
    await sql.end();
  }
}
await main();
