// Batch 9, section 0: bring the DEMO business to the current synthetic mandate by signing mandate version 2 with the owner dev key.
//   bun run mandate:v2        (needs the dev keys in .env; reads them through bun --env-file, never prints them)
// What it does (announced): inserts mandate v2 for the default demo business (limits GBP 80,000 per payment and GBP 85,000 per day,
// allowed proposal kinds = all current kinds including buyer.chase_payment), marks v1 inactive, and appends ONE record to the action log.
// Nothing is wiped or re-seeded. Then it runs a DRY-RUN of the demo plan's GBP 76,800 supplier payment against the gate (writes nothing).
import assert from "node:assert/strict";
import { PROPOSAL_KINDS, type MandateWire } from "../src/gate/mandate";
import { signMandate } from "../src/gate/owner-signing";

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, desc, eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { appendActionRecord } = await import("../src/actionlog");
  const { ACTION_EVENTS } = await import("../src/actions/types");
  const { loadGateState, loadSignedMandate } = await import("../src/actions/state");
  const { evaluate, requestSchema } = await import("../src/gate");
  try {
    const id = await getDefaultBusinessId();
    assert.ok(id, "no demo business; run bun run db:seed first");
    const [cur] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, id!), eq(S.mandates.active, true))).orderBy(desc(S.mandates.version)).limit(1);
    assert.ok(cur, "no active mandate");
    const wire = JSON.parse(cur.canonical) as MandateWire;
    if (cur.version >= 2) {
      console.log(`mandate v${cur.version} is already active; nothing to sign`);
    } else {
      const v2: MandateWire = {
        ...wire,
        version: cur.version + 1,
        limits: { ...wire.limits, maxPaymentMinor: "8000000", maxDailyOutflowMinor: "8500000", allowedProposalKinds: [...PROPOSAL_KINDS] },
      };
      const signed = signMandate(v2);
      await db.update(S.mandates).set({ active: false }).where(and(eq(S.mandates.businessId, id!), eq(S.mandates.active, true)));
      await db.insert(S.mandates).values({ businessId: id!, version: v2.version, canonical: signed.canonical, signature: signed.signature, active: true });
      await appendActionRecord(db, { businessId: id!, event: ACTION_EVENTS.MANDATE_VERSION_SIGNED, actor: "owner", detail: { version: v2.version, previousVersion: cur.version, maxPaymentMinor: v2.limits.maxPaymentMinor, maxDailyOutflowMinor: v2.limits.maxDailyOutflowMinor, allowedProposalKinds: v2.limits.allowedProposalKinds, signedBy: "owner dev key" } });
      console.log(`signed mandate v${v2.version} for the demo business (v${cur.version} is now inactive); logged to the action log`);
    }

    // Dry-run: the demo plan "defer 14 days + 20% supplier deposit + 80% finance" pays Kestrel GBP 76,800 on asOf + 42 days.
    const state = await loadGateState(db, id!, { projection: true });
    const mandate = await loadSignedMandate(db, id!);
    const [payee] = await db.select().from(S.sandboxPayees).where(and(eq(S.sandboxPayees.businessId, id!), eq(S.sandboxPayees.approved, true)));
    const kes = (await db.select().from(S.sandboxPayees).where(eq(S.sandboxPayees.businessId, id!))).find((p) => p.name.toLowerCase().includes("kestrel")) ?? payee;
    const day = (n: number) => new Date(new Date(`${state.asOf}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const req = requestSchema.parse({ kind: "sandbox.schedule_payment", payeeId: kes.id, amountMinor: "7680000", currency: state.currency, scheduledFor: day(42), purpose: "supplier" });
    const bare = evaluate(mandate, state, req);
    // As it would stand mid-plan: the 80% finance advance (GBP 144,000.00, asOf + 35) and the deposit payment (GBP 19,200.00, asOf) already scheduled.
    const mid = { ...state, projection: { ...state.projection!, receipts: [...state.projection!.receipts, { date: day(35), amountMinor: 14_400_000n }], payments: [...state.projection!.payments, { date: day(0), amountMinor: 1_920_000n }] } };
    const planned = evaluate(mandate, mid, req);
    const limit = (r: typeof bare, name: string) => r.limitsChecked.find((l) => l.limit === name);
    console.log(`dry-run, GBP 76,800.00 to ${kes.name} on ${day(42)} (nothing written):`);
    console.log(`  per-payment limit ok=${limit(planned, "maxPaymentMinor")?.ok}, daily limit ok=${limit(planned, "maxDailyOutflowMinor")?.ok}`);
    console.log(`  with no receipts scheduled (as the demo is today): ${bare.decision}${bare.decision === "deny" ? ` - ${bare.reasons[0]}` : ""}`);
    console.log(`  mid-plan (finance advance and deposit scheduled): ${planned.decision}${planned.decision === "deny" ? ` - ${planned.reasons[0]}` : ""}`);
    assert.equal(limit(planned, "maxPaymentMinor")?.ok, true);
    assert.notEqual(planned.decision, "deny", "the demo plan's payment must pass the gate mid-plan");
  } finally {
    await sql.end();
  }
}
await main();
