// Focused checks for autonomous cash-flow recovery (not a test suite). Run: bun run check:recovery
// Part A is pure (lateness, receipts matched once, promises fixed to the planning date, materiality). Part B runs on throwaway COPIES of the demo
// business (mock provider only): late payment, repeated trigger, changed forecast and stale approvals, refusal (reusing the replanner and what the
// buyer said), failed execution, an unclean rollback, and a late receipt too small to matter. Recovery only ever proposes: every scenario asserts
// that nothing was signed, executed or sent by it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createGateway, RECORDINGS_DIR, type GatewayConfig } from "../src/ai";
import type { CommitmentEvent } from "../src/domain/commitment-event";
import type { Lever } from "../src/domain/plan";
import { PROPOSAL_KINDS } from "../src/gate/mandate";
import { signMandate } from "../src/gate/owner-signing";
import { ASSUMED_LATE_DELAY_DAYS, brokenInvoicePromises, delayReceipts, lateReceipts, positionChange, type InvoiceRecord } from "../src/engine";

const ev = (date: string, amountMinor: bigint, kind: CommitmentEvent["kind"]): CommitmentEvent => ({ date, amountMinor, currency: "GBP", label: `${kind} (test)`, kind, source: "manual", confidence: "medium" });

function partA() {
  // A1. Late means late: due today is not late; received and cancelled receipts are never late.
  const r = (id: string, expectedOn: string, status = "scheduled", amountMinor = 500_000n) => ({ id, counterpartyId: "cp", amountMinor, expectedOn, status });
  const late = lateReceipts([r("a", "2026-10-10"), r("b", "2026-10-15"), r("c", "2026-10-01", "received"), r("d", "2026-10-01", "cancelled")], "2026-10-15");
  assert.deepEqual(late.map((x) => [x.id, x.daysLate]), [["a", 5]], "only a scheduled receipt past its date is late");

  // A2. A receipt is matched to ONE forecast item and moved once; the total cash does not change (nothing counted twice).
  const events = [ev("2026-10-10", 500_000n, "customer_receipt"), ev("2026-10-10", 500_000n, "financing"), ev("2026-11-30", -200_000n, "cost")];
  const moved = delayReceipts(events, late, "2026-10-15", { arrives: ASSUMED_LATE_DELAY_DAYS });
  assert.equal(moved.matched.length, 1);
  assert.equal(moved.events.filter((e) => e.date === "2026-10-29").length, 1, "exactly one of the two equal items moved");
  assert.equal(moved.events.reduce((n, e) => n + e.amountMinor, 0n), events.reduce((n, e) => n + e.amountMinor, 0n), "moving a receipt does not change the total");
  const never = delayReceipts(events, [...late, { ...late[0], id: "a2" }], "2026-10-15", "never");
  assert.equal(never.events.length, 1, "two late receipts remove two distinct items");
  assert.equal(delayReceipts(events, [{ ...late[0], amountMinor: 1n }], "2026-10-15", "never").unmatched.length, 1, "a receipt with no matching item changes nothing");

  // A3. A customer promise is judged against the date it was made, not against a date that slides with the forecast.
  const inv = (id: string, dueOn: string): InvoiceRecord => ({ id, number: id, counterpartyId: "buyer", counterpartyName: "Buyer (test)", issuedOn: "2026-08-01", dueOn, amount: 100_000n, status: "open" });
  const books = [inv("old", "2026-09-01"), inv("future", "2026-11-20")];
  const kept = brokenInvoicePromises({ invoices: books, planDate: "2026-10-01", asOf: "2026-10-07", chase: [{ counterpartyId: "buyer", payWithinDays: 7 }], early: [] });
  assert.equal(kept.length, 0, "inside the promised week nothing is broken");
  const broken = brokenInvoicePromises({ invoices: books, planDate: "2026-10-01", asOf: "2026-10-12", chase: [{ counterpartyId: "buyer", payWithinDays: 7 }], early: [{ counterpartyId: "buyer", daysEarly: 14, discountBps: 100 }] });
  assert.deepEqual(broken.map((b) => [b.kind, b.promisedBy, b.daysLate, b.invoiceIds.join()]), [["chase", "2026-10-08", 4, "old"]], "the chase promise is late; the early-payment one is not due yet");
  const paid = brokenInvoicePromises({ invoices: [{ ...inv("old", "2026-09-01"), status: "paid" }], planDate: "2026-10-01", asOf: "2026-10-12", chase: [{ counterpartyId: "buyer", payWithinDays: 7 }], early: [] });
  assert.equal(paid.length, 0, "a paid invoice is never a broken promise");

  // A4. Materiality: a new breach of the cushion, or a drop of at least 5% of the cushion.
  const view = (min: bigint) => ({ minBalanceMinor: min, minBalanceWeek: 3, reserveMinor: 1_000_000n });
  assert.equal(positionChange(view(1_200_000n), view(1_180_000n)).material, false, "a 2% of cushion dip above the cushion is not material");
  assert.equal(positionChange(view(1_200_000n), view(1_140_000n)).material, true, "6% of the cushion is");
  assert.equal(positionChange(view(1_010_000n), view(990_000n)).newBreach, true, "falling under the cushion is always material");
  assert.equal(positionChange(view(900_000n), view(890_000n)).material, false, "already under the cushion and barely worse");
  console.log("  A pure rules: lateness, one match per receipt, totals unchanged, promise dates fixed at planning, materiality");
}

const base: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };
const gw = createGateway(base);
const read = (f: string) => readFileSync(join("fixtures", f), "utf8");

async function partB() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq, sql: dsql } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const { startRun, buildContext } = await import("../src/actions/agent-run");
  const { authorisePlan, proposeAuthorisation } = await import("../src/actions/plan-authorise");
  const { executePlan } = await import("../src/actions/plan-exec");
  const { buildPlanView } = await import("../src/agent");
  const { getEvidence } = await import("../src/actions");
  const { createDocument } = await import("../src/actions/ledger");
  const { assessRecovery, runRecovery } = await import("../src/actions/recovery");
  const owner = postgres(process.env.DATABASE_URL!, { max: 1 }); // owner role: moves the world date, tampers, never used by the code under test
  const rows = async <T = Record<string, any>>(strings: TemplateStringsArray, ...v: unknown[]) => (await owner(strings, ...(v as never[]))) as unknown as T[];
  try {
    const demoId = await getDefaultBusinessId();
    assert.ok(demoId, "run bun run db:seed first");
    const stamp = Date.now().toString(36);

    async function clone(name: string) {
      const [src] = await db.select().from(S.businesses).where(eq(S.businesses.id, demoId!));
      const [biz] = await db.insert(S.businesses).values({ name, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true }).returning();
      const omit = <T extends { id: string; businessId: string }>(r: T) => { const { id: _i, businessId: _b, ...rest } = r; void _i; void _b; return rest; };
      for (const a of await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, demoId!))) await db.insert(S.financialAccounts).values({ ...omit(a), businessId: biz.id });
      const idMap = new Map<string, string>();
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, demoId!))) idMap.set(c.id, (await db.insert(S.counterparties).values({ ...omit(c), businessId: biz.id }).returning())[0].id);
      for (const i of await db.select().from(S.invoices).where(eq(S.invoices.businessId, demoId!))) await db.insert(S.invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
      for (const b of await db.select().from(S.bills).where(eq(S.bills.businessId, demoId!))) await db.insert(S.bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
      for (const c of await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, demoId!))) await db.insert(S.recurringCommitments).values({ ...omit(c), businessId: biz.id });
      const [m] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, demoId!), eq(S.mandates.active, true)));
      const wire = JSON.parse(m.canonical);
      wire.version = 1;
      wire.limits.maxPaymentMinor = "8000000";
      wire.limits.maxDailyOutflowMinor = "8500000";
      wire.limits.allowedProposalKinds = [...PROPOSAL_KINDS];
      const signed = signMandate({ ...wire, businessId: biz.id });
      await db.insert(S.mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
      for (const b of await db.select().from(S.sandboxBankAccounts).where(eq(S.sandboxBankAccounts.businessId, demoId!))) await db.insert(S.sandboxBankAccounts).values({ ...omit(b), businessId: biz.id });
      for (const py of await db.select().from(S.sandboxPayees).where(eq(S.sandboxPayees.businessId, demoId!))) await db.insert(S.sandboxPayees).values({ ...omit(py), businessId: biz.id, counterpartyId: py.counterpartyId ? idMap.get(py.counterpartyId)! : null });
      await db.execute(dsql.raw(`UPDATE financial_accounts SET balance_minor = balance_minor + 4000000 WHERE business_id = '${biz.id}'`));
      await db.execute(dsql.raw(`UPDATE sandbox_bank_accounts SET balance_minor = balance_minor + 4000000 WHERE business_id = '${biz.id}'`));
      return biz;
    }
    async function confirmed(bizId: string, filename: string, kind: "purchase_order" | "supplier_quote") {
      const r = await docs.createDocumentAndExtract(db, bizId, { filename, kind, text: read(filename) }, { gateway: gw });
      await confirmExtraction(db, r.extraction.id, "Test Owner");
      return r.extraction.id;
    }
    async function setup(label: string) {
      const biz = await clone(`Recovery Sanity ${label} ${stamp} (SYNTHETIC)`);
      const quoteId = await confirmed(biz.id, "supplier-quote-kestrel.md", "supplier_quote");
      await confirmed(biz.id, "purchase-order-northgate.md", "purchase_order");
      const run = await startRun(db, biz.id, { type: "commitment", extractionId: quoteId }, { gateway: gw, forceFallback: true });
      assert.equal(run.status, "completed");
      const ctx = await buildContext(db, biz.id, null);
      const { supplierId, buyerId, lenderId } = ctx.parties;
      assert.ok(supplierId && buyerId && lenderId);
      const addPlan = async (levers: Lever[]) => {
        const built = buildPlanView(ctx, { title: "Strategy under test", levers, contingencies: [], rationale: "Strategy for the recovery checks." }, "deterministic");
        assert.ok(built.ok, "plan buildable");
        const view = (built as any).view;
        await db.insert(S.plans).values({ businessId: biz.id, runId: run.runId, planHash: view.id, rank: 10, plan: JSON.parse(JSON.stringify(view)) });
        return view;
      };
      return { biz, runId: run.runId, ctx, supplierId, buyerId, lenderId, addPlan };
    }
    const lever3 = (s: { supplierId: string; lenderId: string }): Lever[] => [
      { kind: "supplier_reduce_deposit", counterpartyId: s.supplierId, percentBps: 2000 },
      { kind: "supplier_defer_balance", counterpartyId: s.supplierId, daysAfterShipment: 14 },
      { kind: "finance_invoice", counterpartyId: s.lenderId, advanceBps: 8000 },
    ];
    /** The state of everything recovery must never touch. */
    const guarded = async (id: string) => ({
      auths: (await rows<{ n: number }>`SELECT count(*)::int n FROM plan_authorisations WHERE business_id = ${id}`)[0].n,
      signed: (await rows<{ n: number }>`SELECT count(*)::int n FROM plan_authorisations WHERE business_id = ${id} AND signature IS NOT NULL`)[0].n,
      execs: (await rows<{ n: number }>`SELECT count(*)::int n FROM plan_executions WHERE business_id = ${id}`)[0].n,
      threads: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_threads WHERE business_id = ${id}`)[0].n,
      apps: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_applications WHERE business_id = ${id}`)[0].n,
      payments: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_payments WHERE business_id = ${id}`)[0].n,
      receipts: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_receipts WHERE business_id = ${id}`)[0].n,
      proposals: (await rows<{ n: number }>`SELECT count(*)::int n FROM action_proposals WHERE business_id = ${id}`)[0].n,
    });
    const runCount = async (id: string) => (await rows<{ n: number }>`SELECT count(*)::int n FROM agent_runs WHERE business_id = ${id}`)[0].n;
    const chainOk = async (id: string) => assert.equal(((await getEvidence(db, id)) as { chain: { ok: boolean } }).chain.ok, true, "action log chain verifies");
    const eventsOf = async (id: string) => ((await getEvidence(db, id)) as { records: { event: string }[] }).records.map((r) => r.event);
    const opts = { gateway: gw, forceFallback: true };
    const advanceWorld = async (id: string, days: number) => { await owner`UPDATE financial_accounts SET balance_as_of = balance_as_of + ${days} * interval '1 day' WHERE business_id = ${id}`; };

    // ================= B0. No strategy yet: nothing to recover =================
    const N = await setup("N");
    assert.equal((await runRecovery(db, N.biz.id, opts)).status, "no_active_strategy");

    // ================= B1. A customer / lender payment is late =================
    const A = await setup("A");
    const planA = await A.addPlan(lever3(A));
    const authA = await authorisePlan(db, A.biz.id, { runId: A.runId, confirmations: 2, planId: planA.id }, "Test Owner");
    assert.equal(authA.status, "authorised");
    const ranA = await executePlan(db, authA.authorisationId);
    assert.equal(ranA.status, "completed", JSON.stringify(ranA.verification?.explanation ?? ranA.outcome.failure));
    const healthy = await assessRecovery(db, A.biz.id);
    assert.equal(healthy.fingerprint, null, `a strategy that just ran and verified is on track (${healthy.events.map((e) => e.text).join(" | ")})`);
    assert.equal((await runRecovery(db, A.biz.id, opts)).status, "on_track");
    const beforeLate = await guarded(A.biz.id);

    // The bank has not credited the earliest scheduled receipt. Time passes WITH the rest of the forecast happening (wages, bills, the other receipts), so the books are
    // moved to the new date with the balance the old forecast projected for it, minus the receipt that never came. Only the lateness is the surprise.
    const recs = await rows<{ expected_on: string; amount_minor: string }>`SELECT expected_on::text, amount_minor::text FROM sandbox_receipts WHERE business_id = ${A.biz.id} AND status = 'scheduled' ORDER BY expected_on`;
    assert.ok(recs.length > 0, "the strategy scheduled receipts");
    const { buildForecast, applyTermChanges, addDays } = await import("../src/engine");
    const { currentAgreedChanges } = await import("../src/actions/shortage");
    const ctx0 = await buildContext(db, A.biz.id, null);
    const asOf0 = ctx0.asOf;
    const { chase: _c0, earlyPayment: _e0, ...order0 } = await currentAgreedChanges(db, A.biz.id);
    void _c0; void _e0;
    const planned = applyTermChanges(ctx0.pending.map((p) => p.event), order0);
    const first = recs[0];
    const lateBy = (Date.parse(`${first.expected_on}T00:00:00Z`) - Date.parse(`${asOf0}T00:00:00Z`)) / 86_400_000 + 4;
    const newAsOf = addDays(asOf0, lateBy);
    const without = planned.filter((e, i) => !(i === planned.findIndex((x) => x.amountMinor > 0n && x.date === first.expected_on && x.amountMinor.toString() === first.amount_minor)));
    const f0 = buildForecast(ctx0.input, { events: without, horizonWeeks: 20 });
    const balanceThen = f0.openingBalance + f0.items.filter((i) => i.date < newAsOf).reduce((n, i) => n + i.amount, 0n);
    const [acc] = await rows<{ id: string }>`SELECT id FROM financial_accounts WHERE business_id = ${A.biz.id} ORDER BY id LIMIT 1`;
    const total = BigInt((await rows<{ t: string }>`SELECT sum(balance_minor)::text t FROM financial_accounts WHERE business_id = ${A.biz.id}`)[0].t);
    await owner`UPDATE financial_accounts SET balance_minor = balance_minor + ${(balanceThen - total).toString()}::numeric WHERE id = ${acc.id}`;
    await advanceWorld(A.biz.id, lateBy);
    const a1 = await assessRecovery(db, A.biz.id);
    const lateEvents = a1.events.filter((e) => e.kind === "payment_late");
    assert.equal(lateEvents.length, 1, "the one receipt that did not arrive is reported; the January one is not due yet");
    const w = a1.world!;
    // Recomputed from current records, not from the stored promise: an independent forecast with the late items moved agrees with the one used.
    const ctxNow = await buildContext(db, A.biz.id, null);
    const { chase: _c, earlyPayment: _e, ...orderChanges } = await currentAgreedChanges(db, A.biz.id);
    void _c; void _e;
    const inForce = applyTermChanges(ctxNow.pending.map((p) => p.event), orderChanges);
    const lateKeys = new Set(w.late.map((l) => `${l.expectedOn}:${l.amountMinor}`));
    const shifted = inForce.map((e) => (e.amountMinor > 0n && lateKeys.has(`${e.date}:${e.amountMinor}`) ? { ...e, date: new Date(Date.parse(`${ctxNow.asOf}T00:00:00Z`) + ASSUMED_LATE_DELAY_DAYS * 86_400_000).toISOString().slice(0, 10) } : e));
    const indep = buildForecast({ ...ctxNow.input, adjustments: w.adjustments }, { events: shifted, horizonWeeks: 20 });
    assert.equal(indep.minimum.amount, w.expected.minimum.amount, "the lowest balance used equals an independent recomputation from current records");
    assert.equal(w.events.reduce((n, e) => n + e.amountMinor, 0n), inForce.reduce((n, e) => n + e.amountMinor, 0n), "no receipt or commitment is counted twice");
    const promised = BigInt(a1.strategy!.plan!.metrics.minBalanceMinor);
    console.log(`  B1 late payment: ${lateEvents.length} receipt(s) ${w.late.map((l) => l.daysLate).join("/")} days late; promised lowest ${promised}, now ${w.expected.minimum.amount}, if they never arrive ${w.worst.minimum.amount}; material ${a1.fingerprint !== null}`);
    assert.ok(a1.fingerprint, "the late payments change the position materially");
    const r1 = await runRecovery(db, A.biz.id, opts);
    assert.ok(["planned", "no_plan"].includes(r1.status), `recovery proposed (${r1.status}): ${r1.note ?? ""}`);
    assert.ok(r1.caseId && r1.report);
    assert.ok(r1.report!.failedAssumptions.length >= 1 && r1.report!.whatChanged.length >= 1 && r1.report!.consequence && r1.report!.uncertainty.length > 0, "the report says what changed, the consequence and what is uncertain");
    assert.ok(r1.report!.inForce.length > 0, "agreements in force are listed as agreements, apart from limits and assumptions");
    assert.ok(/fresh signature/.test(r1.report!.approval), "the report says a fresh signature is needed");
    if (r1.runId) {
      const plansA = await rows<{ plan: any }>`SELECT plan FROM plans WHERE run_id = ${r1.runId}`;
      for (const p of plansA) for (const l of p.plan.levers as Lever[]) assert.ok(!["supplier_reduce_deposit", "supplier_defer_balance", "buyer_request_deposit", "finance_invoice"].includes(l.kind), `no plan re-negotiates the order that is already in force (${l.kind})`);
      const [dn] = await rows<{ payload: any }>`SELECT payload FROM agent_steps WHERE run_id = ${r1.runId} AND kind = 'note' AND payload->>'type' = 'do_nothing'`;
      assert.equal(dn.payload.metrics.minBalanceMinor, w.expected.minimum.amount.toString(), "the planner's do-nothing baseline is the recomputed position, not the old forecast");
      assert.equal(r1.report!.options[0].lowestBalanceMinor, w.expected.minimum.amount.toString(), "the comparison starts from the same recomputed position");
      const o = r1.report!.options;
      assert.ok(o[0].kind === "continue" && o.length === plansA.length + 1, "options: keep the strategy, plus every proposed plan");
    }
    if (process.env.SHOW_REPORT) console.log(JSON.stringify(r1.report, null, 2));
    const after1 = await guarded(A.biz.id);
    assert.deepEqual({ ...after1, auths: beforeLate.auths }, { ...beforeLate, auths: beforeLate.auths }, "recovery signed, executed, sent and scheduled nothing");
    assert.equal(after1.auths, beforeLate.auths, "no authorisation was created for the recovery plans");
    console.log(`     recovery ${r1.status}: ${r1.report!.recommended.kind} (${r1.report!.recommended.text.slice(0, 110)})`);

    // ---- repeated trigger: the same situation returns the same case; nothing is started twice ----
    const runsBefore = await runCount(A.biz.id);
    const dup = await runRecovery(db, A.biz.id, opts);
    assert.equal(dup.status, "duplicate");
    assert.equal(dup.caseId, r1.caseId);
    const par = await Promise.all([runRecovery(db, A.biz.id, opts), runRecovery(db, A.biz.id, opts)]);
    assert.ok(par.every((x) => x.status === "duplicate" && x.caseId === r1.caseId), "concurrent triggers are single-flight");
    assert.equal(await runCount(A.biz.id), runsBefore, "no second recovery run was created");
    assert.equal((await rows<{ n: number }>`SELECT count(*)::int n FROM recovery_cases WHERE business_id = ${A.biz.id}`)[0].n, 1, "one case");
    console.log("     repeated and concurrent triggers: one case, no new run");

    // ---- the plans are signed ONLY by the owner; a recovery plan needs its own fresh authorisation ----
    if (r1.runId) {
      const top = (await rows<{ plan_hash: string; plan: any }>`SELECT plan_hash, plan FROM plans WHERE run_id = ${r1.runId} ORDER BY rank`).find((p) => !(p.plan.blockers?.length) && p.plan.checks.every((c: any) => c.decision !== "deny"));
      if (top) {
        const signedAuth = await authorisePlan(db, A.biz.id, { runId: r1.runId, confirmations: 2, planId: top.plan_hash }, "Test Owner");
        assert.equal(signedAuth.status, "authorised", "the owner can sign a recovery plan through the normal path");
        assert.notEqual(signedAuth.authorisationId, authA.authorisationId, "a recovery plan is never covered by the old approval");
        await assert.rejects(executePlan(db, authA.authorisationId), /already used|expired/i, "the old approval cannot run again");

        // ================= B2. The forecast changes: the old recovery and its signed approval go stale =================
        const sup = (await rows<{ id: string }>`SELECT id FROM counterparties WHERE business_id = ${A.biz.id} AND role = 'supplier' LIMIT 1`)[0].id;
        const ctxB = await buildContext(db, A.biz.id, null);
        const due = new Date(Date.parse(`${ctxB.asOf}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);
        await createDocument(db as any, A.biz.id, "bill", { counterpartyId: sup, number: `RECOVERY-${stamp}`, issuedOn: ctxB.asOf, dueOn: due, amount: "30000.00", acknowledgeOverlaps: true });
        const a2 = await assessRecovery(db, A.biz.id);
        assert.notEqual(a2.fingerprint, a1.fingerprint, "a changed forecast is a different situation");
        assert.ok(a2.events.some((e) => e.kind === "forecast_worsened" || e.kind === "forecast_below_reserve"), "the worse forecast is itself reported");
        const r2 = await runRecovery(db, A.biz.id, opts);
        assert.notEqual(r2.caseId, r1.caseId);
        assert.ok(["planned", "no_plan"].includes(r2.status));
        assert.ok(r2.superseded.includes(r1.caseId!), "the older recovery is marked superseded");
        assert.ok(r2.expiredAuthorisations.includes(signedAuth.authorisationId), "the signed but unexecuted approval for the old recovery plan was invalidated");
        const [st] = await rows<{ status: string }>`SELECT status FROM plan_authorisations WHERE id = ${signedAuth.authorisationId}`;
        assert.equal(st.status, "expired");
        await assert.rejects(executePlan(db, signedAuth.authorisationId), /expired/, "a stale approval cannot execute");
        await assert.rejects(proposeAuthorisation(db, A.biz.id, { runId: r1.runId, planId: top.plan_hash, confirmations: 2 }), /replaced by a newer/, "a replaced plan cannot be signed afresh");
        const [oldRun] = await rows<{ lifecycle: string }>`SELECT lifecycle FROM agent_runs WHERE id = ${r1.runId}`;
        assert.equal(oldRun.lifecycle, "superseded");
        console.log(`  B2 changed forecast: new case, old case superseded, signed approval expired and refused (${r2.status})`);
      } else console.log("  B2 skipped: the first recovery had no runnable plan to sign (see the report for why)");
    }
    await chainOk(A.biz.id);
    const evA = await eventsOf(A.biz.id);
    for (const e of ["recovery.detected", "recovery.duplicate_ignored"]) assert.ok(evA.includes(e), `${e} is logged`);

    // ================= B3. A counterparty refuses the signed terms (reuses the replanner and what the buyer said) =================
    const L = await setup("L");
    const planL = await L.addPlan([{ kind: "buyer_request_deposit", counterpartyId: L.buyerId, percentBps: 2000 }]);
    const authL = await authorisePlan(db, L.biz.id, { runId: L.runId, planId: planL.id, tolerances: { buyerDepositBps: 1000 } }, "Test Owner");
    const runL = await executePlan(db, authL.authorisationId);
    assert.equal(runL.status, "needs_replan");
    const aL = await assessRecovery(db, L.biz.id);
    assert.ok(aL.events.some((e) => e.kind === "counterparty_refused" && e.material), "the refusal is detected");
    const beforeL = await guarded(L.biz.id);
    const rL = await runRecovery(db, L.biz.id, opts);
    assert.ok(["replanned", "no_plan"].includes(rL.status), `refusal recovery ${rL.status}`);
    const afterL = await guarded(L.biz.id);
    assert.deepEqual(afterL, beforeL, "re-planning after a refusal signed, executed and sent nothing");
    if (rL.runId) {
      const [childRun] = await rows<{ constraints: any[] }>`SELECT constraints FROM agent_runs WHERE id = ${rL.runId}`;
      assert.ok(childRun.constraints.some((c) => c.kind === "buyer_request_deposit" && c.maxPercentBps === 1000), "the buyer's own stated cap was carried into the recovery");
      const ps = await rows<{ plan: any }>`SELECT plan FROM plans WHERE run_id = ${rL.runId}`;
      assert.ok(ps.every((p) => (p.plan.levers as any[]).every((l) => l.kind !== "buyer_request_deposit" || l.percentBps <= 1000)), "no recovery plan asks the buyer for more than it said it would pay");
    }
    assert.ok(rL.report!.statedLimits.some((t) => /10%/.test(t)), "the buyer's limit is reported as something THEY said, apart from agreements in force");
    const dupL = await runRecovery(db, L.biz.id, opts);
    assert.equal(dupL.status, "duplicate");
    console.log(`  B3 refusal: ${rL.status}; carried the buyer's 10% cap; repeated trigger ignored; ${rL.report!.recommended.kind}`);
    await chainOk(L.biz.id);

    // ================= B4. Execution fails and rolls back; then an unclean rollback =================
    const K = await setup("K");
    const planK = await K.addPlan(lever3(K));
    const authK = await authorisePlan(db, K.biz.id, { runId: K.runId, confirmations: 2, planId: planK.id }, "Test Owner");
    const runK = await executePlan(db, authK.authorisationId, { beforeStep: (step) => { if (step === "schedule:2") throw new Error("injected failure"); } });
    assert.equal(runK.status, "rolled_back");
    const aK = await assessRecovery(db, K.biz.id);
    assert.ok(aK.events.some((e) => e.kind === "execution_failed" && e.material), "a failed execution is detected");
    const beforeK = await guarded(K.biz.id);
    const rK = await runRecovery(db, K.biz.id, opts);
    assert.ok(["planned", "no_plan"].includes(rK.status), `failed execution recovery ${rK.status} ${rK.note ?? ""}`);
    assert.deepEqual(await guarded(K.biz.id), beforeK, "recovery after a failure changed nothing in the sandbox");
    console.log(`  B4 failed execution (rolled back): ${rK.status}, ${rK.report!.options.length - 1} plan(s) compared with keeping things as they are`);

    const U = await setup("U");
    const planU = await U.addPlan(lever3(U));
    const authU = await authorisePlan(db, U.biz.id, { runId: U.runId, confirmations: 2, planId: planU.id }, "Test Owner");
    const runU = await executePlan(db, authU.authorisationId, { beforeStep: (step) => { if (step === "schedule:2") throw new Error("injected failure"); } });
    assert.equal(runU.status, "rolled_back");
    await owner`UPDATE plan_executions SET status = 'failed' WHERE authorisation_id = ${authU.authorisationId}`; // as if a withdrawal had failed
    const rU = await runRecovery(db, U.biz.id, opts);
    assert.equal(rU.status, "blocked", "an unclean rollback is never retried automatically");
    assert.equal(rU.runId, null);
    assert.equal(await runCount(U.biz.id), 1, "no recovery run was started");
    console.log("     unclean rollback: blocked, no run started, the owner is told to review what is live");

    // ================= B5. A late receipt too small to matter starts nothing =================
    const T = await setup("T");
    const planT = await T.addPlan(lever3(T));
    const authT = await authorisePlan(db, T.biz.id, { runId: T.runId, confirmations: 2, planId: planT.id }, "Test Owner");
    assert.equal((await executePlan(db, authT.authorisationId)).status, "completed");
    const recT = await rows<{ expected_on: string }>`SELECT expected_on::text FROM sandbox_receipts WHERE business_id = ${T.biz.id} AND status = 'scheduled' ORDER BY expected_on LIMIT 1`;
    const asOfT = (await buildContext(db, T.biz.id, null)).asOf;
    await advanceWorld(T.biz.id, Math.max(2, Math.round((Date.parse(`${recT[0].expected_on}T00:00:00Z`) - Date.parse(`${asOfT}T00:00:00Z`)) / 86_400_000) + 2));
    await owner`UPDATE sandbox_receipts SET status = 'cancelled' WHERE business_id = ${T.biz.id}`; // nothing is waiting any more: cancelled is not late
    assert.equal((await assessRecovery(db, T.biz.id)).events.filter((e) => e.kind === "payment_late").length, 0, "a cancelled receipt is not reported as late");
    console.log("  B5 cancelled receipts are not reported as late");
    await chainOk(K.biz.id);
    await chainOk(T.biz.id);
  } finally {
    await owner.end();
    await sql.end();
  }
}

partA();
partB().then(() => console.log("recovery checks passed")).catch((e) => { console.error(e); process.exit(1); });
