// Sanity checks for Batch 8a: plan authorisation, single-round negotiation, execution, verification, rollback.
// Not a test suite. Run: bun run check:plan
// Mock provider only (no live model). Every scenario runs on a COPY of the demo business flagged is_test; the demo is only read.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createGateway, RECORDINGS_DIR, type GatewayConfig } from "../src/ai";
import { planId, type Lever } from "../src/domain/plan";
import { PROPOSAL_KINDS } from "../src/gate/mandate";
import { signMandate } from "../src/gate/owner-signing";
import { formatMoney, money } from "../src/lib/money";

const base: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };
const mockGw = createGateway(base);
const read = (f: string) => readFileSync(join("fixtures", f), "utf8");
const gbp = (m: string | bigint) => formatMoney(money(BigInt(m), "GBP"), 2);

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq, sql: dsql } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const { startRun, buildContext } = await import("../src/actions/agent-run");
  const { approveAuthorisation, authorisePlan } = await import("../src/actions/plan-authorise");
  const { executePlan, releaseHeld } = await import("../src/actions/plan-exec");
  const { verifyPlanExecution } = await import("../src/actions/plan-verify");
  const { getPlanAuthorisation } = await import("../src/actions/plan-read");
  const { replanFromExecution } = await import("../src/actions/replan");
  const { proposeAction } = await import("../src/actions");
  const { checkShortage } = await import("../src/actions/shortage");
  const { getScoreboard } = await import("../src/actions/scoreboard");
  const { permits } = await import("../src/actions/plan-terms");
  const { leverBounds } = await import("../src/agent");
  const { getEvidence } = await import("../src/actions");
  const { buildPlanView } = await import("../src/agent");
  const owner = postgres(process.env.DATABASE_URL!, { max: 1 }); // owner role: used only to tamper and to set up personalities
  const probe = join("src", "agent", "_layering_probe.ts");
  try {
    const demoId = await getDefaultBusinessId();
    assert.ok(demoId, "run bun run db:seed first");
    const stamp = Date.now().toString(36);

    // ---------- helpers ----------
    async function clone(name: string) {
      const [src] = await db.select().from(S.businesses).where(eq(S.businesses.id, demoId!));
      const [biz] = await db.insert(S.businesses).values({ name, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true }).returning();
      const omit = <T extends { id: string; businessId: string }>(r: T) => { const { id: _i, businessId: _b, ...rest } = r; void _i; void _b; return rest; };
      for (const a of await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, demoId!))) await db.insert(S.financialAccounts).values({ ...omit(a), businessId: biz.id });
      const idMap = new Map<string, string>();
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, demoId!))) {
        const [n] = await db.insert(S.counterparties).values({ ...omit(c), businessId: biz.id }).returning();
        idMap.set(c.id, n.id);
      }
      for (const i of await db.select().from(S.invoices).where(eq(S.invoices.businessId, demoId!))) await db.insert(S.invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
      for (const b of await db.select().from(S.bills).where(eq(S.bills.businessId, demoId!))) await db.insert(S.bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
      for (const c of await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, demoId!))) await db.insert(S.recurringCommitments).values({ ...omit(c), businessId: biz.id });
      const [m] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, demoId!), eq(S.mandates.active, true)));
      // Demo limits as in the seed after Batch 8b (ADR-019): GBP 80,000 per payment, GBP 85,000 per day.
      const wire = JSON.parse(m.canonical);
      wire.version = 1; // the clone has its own mandate history
      wire.limits.maxPaymentMinor = "8000000";
      wire.limits.maxDailyOutflowMinor = "8500000";
      wire.limits.allowedProposalKinds = [...PROPOSAL_KINDS];
      const signed = signMandate({ ...wire, businessId: biz.id });
      await db.insert(S.mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
      for (const b of await db.select().from(S.sandboxBankAccounts).where(eq(S.sandboxBankAccounts.businessId, demoId!))) await db.insert(S.sandboxBankAccounts).values({ ...omit(b), businessId: biz.id });
      for (const py of await db.select().from(S.sandboxPayees).where(eq(S.sandboxPayees.businessId, demoId!))) await db.insert(S.sandboxPayees).values({ ...omit(py), businessId: biz.id, counterpartyId: py.counterpartyId ? idMap.get(py.counterpartyId)! : null });
      // Test headroom: with the conservative overdue assumption (ADR-023) the demo cash is too tight for the mechanics checks to pay a deposit
      // before payroll. Add GBP 40,000 to the books and to the sandbox bank of this CLONE (the demo itself is not touched).
      await db.execute(dsql.raw(`UPDATE financial_accounts SET balance_minor = balance_minor + 4000000 WHERE business_id = '${biz.id}'`));
      await db.execute(dsql.raw(`UPDATE sandbox_bank_accounts SET balance_minor = balance_minor + 4000000 WHERE business_id = '${biz.id}'`));
      return biz;
    }
    async function addConfirmed(bizId: string, filename: string, kind: "purchase_order" | "supplier_quote", text: string) {
      const r = await docs.createDocumentAndExtract(db, bizId, { filename, kind, text }, { gateway: mockGw });
      await confirmExtraction(db, r.extraction.id, "Test Owner");
      return r.extraction.id;
    }
    /** A fresh clone with a completed planning run, its context, and a helper to store a crafted plan. */
    async function setup(label: string) {
      const biz = await clone(`Plan Sanity ${label} ${stamp} (SYNTHETIC)`);
      const quoteId = await addConfirmed(biz.id, "supplier-quote-kestrel.md", "supplier_quote", read("supplier-quote-kestrel.md"));
      await addConfirmed(biz.id, "purchase-order-northgate.md", "purchase_order", read("purchase-order-northgate.md"));
      const run = await startRun(db, biz.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, forceFallback: true });
      assert.equal(run.status, "completed");
      const ctx = await buildContext(db, biz.id, null);
      const { supplierId, buyerId, lenderId } = ctx.parties;
      assert.ok(supplierId && buyerId && lenderId);
      let rank = 10;
      const addPlan = async (levers: Lever[], raw = false) => {
        const built = buildPlanView(ctx, { title: "Sanity plan", levers, contingencies: [], rationale: "Sanity plan for the checks." }, "deterministic");
        let view;
        if (built.ok) view = built.view;
        else if (raw) view = { id: planId(levers), title: "Beyond the mandate", levers, contingencies: [], rationale: "x", source: "deterministic", metrics: { minBalanceMinor: "0", minBalanceWeek: 1, firstNegativeWeek: null, weeksBelowReserve: 0, closingAtHorizonMinor: "0", totalCostMinor: "0", counterpartiesNeeded: 1, horizonWeeks: 20 }, checks: [], assumptions: [], proseFlagged: false, removedSentences: [] };
        else assert.fail(`plan not buildable: ${built.reasons.join("; ")}`);
        await db.insert(S.plans).values({ businessId: biz.id, runId: run.runId, planHash: view.id, rank: ++rank, plan: JSON.parse(JSON.stringify(view)) });
        return view;
      };
      return { biz, runId: run.runId, ctx, supplierId, buyerId, lenderId, addPlan };
    }
    const lever3 = (s: { supplierId: string; lenderId: string }): Lever[] => [
      { kind: "supplier_reduce_deposit", counterpartyId: s.supplierId, percentBps: 2000 },
      { kind: "supplier_defer_balance", counterpartyId: s.supplierId, daysAfterShipment: 14 },
      { kind: "finance_invoice", counterpartyId: s.lenderId, advanceBps: 8000 },
    ];
    const rows = async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...v: unknown[]) => (await owner(strings, ...(v as never[]))) as unknown as T[];
    const sandboxCounts = async (id: string) => ({
      threads: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_threads WHERE business_id = ${id}`)[0].n,
      messages: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_messages WHERE business_id = ${id}`)[0].n,
      apps: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_applications WHERE business_id = ${id}`)[0].n,
      payments: (await rows<{ n: number }>`SELECT count(*)::int n FROM sandbox_payments WHERE business_id = ${id}`)[0].n,
      proposals: (await rows<{ n: number }>`SELECT count(*)::int n FROM action_proposals WHERE business_id = ${id}`)[0].n,
    });
    const chainOk = async (id: string) => assert.equal(((await getEvidence(db, id)) as { chain: { ok: boolean } }).chain.ok, true, "action log chain verifies");

    // ================= 1. Happy path + idempotency/replay =================
    const A = await setup("A");
    const planA = await A.addPlan(lever3(A));
    const auth = await authorisePlan(db, A.biz.id, { runId: A.runId, confirmations: 2, planId: planA.id }, "Test Owner");
    assert.equal(auth.status, "authorised");
    const before = await sandboxCounts(A.biz.id);
    assert.equal(before.threads + before.apps + before.payments, 0, "authorising sends nothing");
    const run1 = await executePlan(db, auth.authorisationId);
    assert.equal(run1.status, "completed", JSON.stringify(run1.verification?.explanation ?? run1.outcome));
    assert.ok(run1.verification?.ok);
    assert.deepEqual(run1.outcome.branches.map((b) => b.status), ["committed", "committed", "committed"]);
    // Section 1 (happy): payments AND receipts are scheduled through the gate, and the forecast-aware gate allowed the GBP 76,800 balance payment.
    assert.deepEqual(run1.outcome.scheduled.map((x) => x.kind).sort(), ["payment", "payment", "receipt", "receipt"]);
    assert.ok(run1.outcome.scheduled.some((x) => x.kind === "payment" && x.amountMinor === "7680000"), "the GBP 76,800 balance payment was scheduled");
    const view = (await getPlanAuthorisation(db, auth.authorisationId)) as { authorisation: { status: string; integrity: string }; actions: { kind: string; status: string }[]; trail: { event: string }[] };
    assert.equal(view.authorisation.status, "used");
    assert.equal(view.authorisation.integrity, "ok");
    assert.equal(view.actions.length, 8, "3 sends/applications + 1 accept_offer + 2 receipts + 2 payments");
    assert.ok(view.actions.every((a) => a.status === "verified"), "every action went through the pipeline and was verified");
    const ev = view.trail.map((t) => t.event);
    for (const needed of ["plan.authorised", "plan.execution_started", "gate.decision", "action.approved", "action.executed", "action.verified", "plan.branch_result", "plan.execution_completed", "plan.verified"]) assert.ok(ev.includes(needed), `trail has ${needed}`);
    const mv = run1.verification!.metrics;
    assert.ok(mv.every((m) => m.ok), "recomputed metrics equal the expectation from the agreed terms");
    assert.equal(run1.verification!.promiseVsAgreed.direction, "same");
    const [lowest] = mv;
    const balA = await rows<{ balance_minor: string }>`SELECT balance_minor::text FROM sandbox_bank_accounts WHERE business_id = ${A.biz.id}`;
    assert.equal(balA[0].balance_minor, "8200000", "scheduled items do not move the bank until the bank job runs");
    console.log(`  1 happy path: authorised, 8 actions (3 negotiation, 1 take-up, 2 receipts, 2 payments; all verified), plan verified; lowest balance expected ${gbp(lowest.promised!)} = recomputed ${gbp(lowest.actual!)}; ${run1.verification!.promiseVsAgreed.label}`);
    // Replay / idempotency: running it again is refused and applies nothing twice.
    const after1 = await sandboxCounts(A.biz.id);
    await assert.rejects(executePlan(db, auth.authorisationId), /already used/);
    assert.deepEqual(await sandboxCounts(A.biz.id), after1, "second run changed nothing");
    const [tsApp] = await rows<{ status: string }>`SELECT status FROM sandbox_applications WHERE business_id = ${A.biz.id}`;
    assert.equal(tsApp.status, "accepted");
    console.log(`  9 idempotency: second execution refused (already used); sandbox counts unchanged (${JSON.stringify(after1)})`);

    // ================= 7. Verification failure is loud =================
    await owner`UPDATE sandbox_threads SET agreed_terms = jsonb_set(agreed_terms, '{percentBps}', '2500') WHERE business_id = ${A.biz.id} AND topic = 'supplier.reduce_deposit'`;
    const bad = await verifyPlanExecution(db, auth.authorisationId);
    assert.equal(bad.ok, false);
    assert.ok(bad.explanation.length > 0 && bad.explanation.some((x) => /sandbox now shows/.test(x)), bad.explanation.join(" | "));
    const [exA] = await rows<{ status: string }>`SELECT status FROM plan_executions WHERE authorisation_id = ${auth.authorisationId}`;
    assert.equal(exA.status, "verification_failed");
    const evA = ((await getEvidence(db, A.biz.id)) as { records: { event: string; verification: string }[] }).records;
    assert.ok(evA.some((r) => r.event === "plan.verification_failed" && r.verification === "failed"), "failure is in the log");
    // Section 4 (failed verification): the run says so on the status API, the evidence stays, and nothing is retried or fixed.
    const stView = (await getPlanAuthorisation(db, auth.authorisationId)) as { run: { lifecycle: string }; execution: { status: string; verification: { ok: boolean } } };
    assert.equal(stView.run.lifecycle, "verification_failed");
    assert.equal(stView.execution.status, "verification_failed");
    assert.equal(stView.execution.verification.ok, false);
    console.log(`  7 forced mismatch (also section 2 failure, section 4): verification FAILED, run lifecycle verification_failed, logged; ${bad.explanation[0].slice(0, 110)}`);
    await chainOk(A.biz.id);

    // ================= 2. Mandate gate =================
    const B = await setup("B");
    const beyond = await B.addPlan([{ kind: "finance_invoice", counterpartyId: B.lenderId, advanceBps: 9500 }], true);
    const denied = await authorisePlan(db, B.biz.id, { runId: B.runId, confirmations: 2, planId: beyond.id }, "Test Owner");
    assert.equal(denied.status, "denied");
    assert.ok(denied.problems.length > 0 || denied.gates.some((g) => g.decision === "deny"));
    await assert.rejects(approveAuthorisation(db, denied.authorisationId, "Test Owner"), /only a proposed/);
    assert.equal((await sandboxCounts(B.biz.id)).threads, 0);
    console.log(`  2a plan beyond the mandate (95% advance): denied at signing (${(denied.gates.find((g) => g.decision === "deny")?.reasons[0] ?? denied.problems[0]).slice(0, 90)})`);

    const C = await setup("C");
    const planC = await C.addPlan(lever3(C));
    const authC = await authorisePlan(db, C.biz.id, { runId: C.runId, confirmations: 2, planId: planC.id }, "Test Owner");
    const [m1] = await rows<{ canonical: string }>`SELECT canonical FROM mandates WHERE business_id = ${C.biz.id} AND active`;
    const v2 = signMandate({ ...JSON.parse(m1.canonical), version: 2 });
    await owner`UPDATE mandates SET active = false WHERE business_id = ${C.biz.id}`;
    await owner`INSERT INTO mandates (business_id, version, canonical, signature, active) VALUES (${C.biz.id}, 2, ${v2.canonical}, ${v2.signature}, true)`;
    await assert.rejects(executePlan(db, authC.authorisationId), /mandate changed after signing/);
    assert.equal((await sandboxCounts(C.biz.id)).threads, 0, "nothing was sent");
    console.log("  2b mandate replaced (version 2) after signing: execution refused, nothing sent");

    const D = await setup("D");
    const planD = await D.addPlan(lever3(D));
    const authD = await authorisePlan(db, D.biz.id, { runId: D.runId, confirmations: 2, planId: planD.id }, "Test Owner");
    await owner`UPDATE mandates SET canonical = replace(canonical, '"maxFinanceAdvanceBps":8000', '"maxFinanceAdvanceBps":9999') WHERE business_id = ${D.biz.id} AND active`;
    await assert.rejects(executePlan(db, authD.authorisationId), /Mandate signature is invalid|mandate/i);
    assert.equal((await sandboxCounts(D.biz.id)).threads, 0);
    console.log("  2c mandate text tampered after signing: execution refused, nothing sent");

    // ================= 3. Tamper, replay, expiry =================
    const E = await setup("E");
    const planE = await E.addPlan(lever3(E));
    const authE = await authorisePlan(db, E.biz.id, { runId: E.runId, confirmations: 2, planId: planE.id }, "Test Owner");
    await owner`UPDATE plans SET plan = jsonb_set(plan, '{levers,0,percentBps}', '1500') WHERE business_id = ${E.biz.id} AND plan_hash = ${planE.id}`;
    await assert.rejects(executePlan(db, authE.authorisationId), /edited after it was signed/);
    assert.equal((await sandboxCounts(E.biz.id)).threads, 0);
    console.log("  3a plan edited after signing: execution refused");

    const F = await setup("F");
    const planF = await F.addPlan(lever3(F));
    const authF = await authorisePlan(db, F.biz.id, { runId: F.runId, confirmations: 2, planId: planF.id }, "Test Owner");
    await owner`UPDATE plan_authorisations SET terms = jsonb_set(terms, '{entries,0,request,proposal,percentBps}', '500') WHERE id = ${authF.authorisationId}`;
    await assert.rejects(executePlan(db, authF.authorisationId), /no longer match the signed hash/);
    await owner`UPDATE plan_authorisations SET expires_at = expires_at + interval '1 day' WHERE id = ${authF.authorisationId}`;
    await assert.rejects(executePlan(db, authF.authorisationId), /signature is invalid/);
    console.log("  3b edited terms and edited expiry: both refused (hash and signature)");

    const G = await setup("G");
    const planG = await G.addPlan(lever3(G));
    const authG = await authorisePlan(db, G.biz.id, { runId: G.runId, confirmations: 2, planId: planG.id, ttlHours: 24 }, "Test Owner");
    await owner`UPDATE financial_accounts SET balance_as_of = balance_as_of + interval '2 days' WHERE business_id = ${G.biz.id}`;
    await assert.rejects(executePlan(db, authG.authorisationId), /expired/);
    const [stG] = await rows<{ status: string }>`SELECT status FROM plan_authorisations WHERE id = ${authG.authorisationId}`;
    assert.equal(stG.status, "expired");
    assert.equal((await sandboxCounts(G.biz.id)).threads, 0);
    console.log("  3c expired authorisation (world date moved on): refused, marked expired, nothing sent");

    // ================= 4. Rejected counterparty =================
    const H = await setup("H");
    await owner`UPDATE counterparties SET profile = profile || '{"maxSupplierDepositReductionBps":0}'::jsonb WHERE id = ${H.supplierId}`;
    const planH = await H.addPlan([{ kind: "supplier_reduce_deposit", counterpartyId: H.supplierId, percentBps: 2000 }, { kind: "finance_invoice", counterpartyId: H.lenderId, advanceBps: 8000 }]);
    const authH = await authorisePlan(db, H.biz.id, { runId: H.runId, confirmations: 2, planId: planH.id }, "Test Owner");
    const runH = await executePlan(db, authH.authorisationId);
    assert.equal(runH.status, "needs_replan");
    assert.deepEqual(runH.outcome.branches.map((b) => b.status), ["needs_replan", "offered"]);
    const sc = await rows<{ topic: string; status: string }>`SELECT topic, status FROM sandbox_threads WHERE business_id = ${H.biz.id}`;
    assert.deepEqual(sc.map((t) => t.status), ["rejected"], "the thread stays rejected; nothing agreed");
    const appsH = await rows<{ status: string }>`SELECT status FROM sandbox_applications WHERE business_id = ${H.biz.id}`;
    assert.deepEqual(appsH.map((a) => a.status), ["offered"], "the finance offer is kept on hold for the owner (not taken up)");
    assert.equal((await releaseHeld(db, authH.authorisationId)).released, 1, "releasing the hold withdraws it");
    const appsH2 = await rows<{ status: string }>`SELECT status FROM sandbox_applications WHERE business_id = ${H.biz.id}`;
    assert.deepEqual(appsH2.map((a) => a.status), ["withdrawn"], "the finance offer was withdrawn on release");
    const kindsH = await rows<{ kind: string }>`SELECT kind FROM action_proposals WHERE business_id = ${H.biz.id}`;
    assert.ok(!kindsH.some((k) => k.kind === "sandbox.accept_offer"), "no accept action exists");
    assert.equal((await sandboxCounts(H.biz.id)).payments, 0);
    console.log(`  4 supplier rejects: status needs_replan; branches ${runH.outcome.branches.map((b) => b.status).join("/")}; no acceptance; finance offer held, then withdrawn on release`);
    await chainOk(H.biz.id);

    // ================= 5. Counters =================
    const I = await setup("I");
    await owner`UPDATE counterparties SET profile = profile || '{"maxSupplierDepositReductionBps":1000}'::jsonb WHERE id = ${I.supplierId}`; // floor 20%
    const planI = await I.addPlan([{ kind: "supplier_reduce_deposit", counterpartyId: I.supplierId, percentBps: 1500 }]);
    const authI = await authorisePlan(db, I.biz.id, { runId: I.runId, confirmations: 2, planId: planI.id }, "Test Owner");
    const runI = await executePlan(db, authI.authorisationId);
    assert.equal(runI.status, "needs_replan");
    assert.match(runI.outcome.branches[0].reason ?? "", /above the authorised/);
    const thI = await rows<{ status: string }>`SELECT status FROM sandbox_threads WHERE business_id = ${I.biz.id}`;
    assert.deepEqual(thI.map((t) => t.status), ["countered"], "the counter was NOT accepted");
    assert.equal((await sandboxCounts(I.biz.id)).proposals, 1, "only the one authorised proposal was sent");
    console.log(`  5a out-of-terms counter (asked 15%, counter 20%, zero tolerance): not accepted; ${runI.outcome.branches[0].reason}`);

    const J = await setup("J");
    await owner`UPDATE counterparties SET profile = profile || '{"maxSupplierDepositReductionBps":1000}'::jsonb WHERE id = ${J.supplierId}`;
    const planJ = await J.addPlan([{ kind: "supplier_reduce_deposit", counterpartyId: J.supplierId, percentBps: 1500 }, { kind: "supplier_defer_balance", counterpartyId: J.supplierId, daysAfterShipment: 14 }, { kind: "finance_invoice", counterpartyId: J.lenderId, advanceBps: 8000 }]); // defer + finance keep the projected balance above the floor
    const authJ = await authorisePlan(db, J.biz.id, { runId: J.runId, confirmations: 2, planId: planJ.id, tolerances: { supplierDepositBps: 500 } }, "Test Owner");
    const runJ = await executePlan(db, authJ.authorisationId);
    assert.deepEqual(runJ.outcome.branches[0].agreedTerms, { percentBps: 2000 });
    assert.equal(runJ.outcome.branches[0].status, "committed");
    // A deposit change only moves cash between two payments before the lowest point, so the promised metrics still hold; the term difference is noted.
    assert.equal(runJ.status, "completed", JSON.stringify(runJ.outcome.failure));
    assert.ok(runJ.verification!.explanation.some((x) => /was agreed as 2000; the plan asked for 1500/.test(x)), "the term difference is recorded");
    console.log("  5b in-bound counter (signed tolerance 5 points): accepted by re-proposal at 20%; metrics still hold and the term difference is noted in the verification");

    // ================= 6. Failure mid-execution =================
    const K = await setup("K");
    const planK = await K.addPlan(lever3(K));
    const authK = await authorisePlan(db, K.biz.id, { runId: K.runId, confirmations: 2, planId: planK.id }, "Test Owner");
    const runK = await executePlan(db, authK.authorisationId, { beforeStep: (step) => { if (step === "schedule:2") throw new Error("injected failure after the finance take-up and two receipts"); } });
    assert.equal(runK.status, "rolled_back");
    const thK = await rows<{ status: string }>`SELECT status FROM sandbox_threads WHERE business_id = ${K.biz.id}`;
    const apK = await rows<{ status: string }>`SELECT status FROM sandbox_applications WHERE business_id = ${K.biz.id}`;
    assert.ok(thK.length === 2 && thK.every((t) => t.status === "withdrawn"), "every agreement withdrawn");
    assert.deepEqual(apK.map((a) => a.status), ["withdrawn"]);
    assert.ok(runK.outcome.compensated.length === 5 && runK.outcome.compensated.every((c) => c.ok), "2 receipts, 1 application, 2 threads withdrawn");
    const rcK = await rows<{ status: string }>`SELECT status FROM sandbox_receipts WHERE business_id = ${K.biz.id}`;
    assert.ok(rcK.length === 2 && rcK.every((r) => r.status === "cancelled"), "scheduled receipts cancelled");
    assert.equal((await sandboxCounts(K.biz.id)).payments, 0);
    assert.equal(runK.outcome.committed, false);
    const evK = ((await getEvidence(db, K.biz.id)) as { records: { event: string }[] }).records.map((r) => r.event);
    assert.ok(evK.includes("plan.compensated") && evK.includes("plan.execution_failed"));
    console.log(`  6 failure after the take-up and two scheduled receipts: rolled back; ${runK.outcome.compensated.length} withdrawals (receipts, application, threads), nothing agreed, accepted or scheduled remains`);
    await chainOk(K.biz.id);

    // ================= Section 1 failure: the gate is not weakened =================
    const P = await setup("P");
    const kesPayee = (await rows<{ id: string }>`SELECT id FROM sandbox_payees WHERE business_id = ${P.biz.id} AND counterparty_id = ${P.supplierId}`)[0].id;
    const over = await proposeAction(db, P.biz.id, { kind: "sandbox.schedule_payment", payeeId: kesPayee, amountMinor: "7900000", currency: "GBP", scheduledFor: P.ctx.asOf, purpose: "supplier" }, `over-${stamp}`, "owner");
    assert.equal(over.gate.decision, "deny");
    assert.ok(over.gate.limitsChecked.some((l) => l.limit === "projectedBalanceFloor" && !l.ok), "denied by the projected balance, not by a limit alone");
    console.log(`  1b payment of GBP 79,000 with nothing backing it: denied (${over.gate.reasons[0].slice(0, 100)})`);

    // ================= Section 2 happy: a counter inside the tolerance is verified against the AGREED terms =================
    const L = await setup("L");
    const planL = await L.addPlan([{ kind: "buyer_request_deposit", counterpartyId: L.buyerId, percentBps: 2000 }]);
    const authL = await authorisePlan(db, L.biz.id, { runId: L.runId, planId: planL.id, tolerances: { buyerDepositBps: 1000 } }, "Test Owner");
    const runL = await executePlan(db, authL.authorisationId);
    assert.equal(runL.status, "completed", runL.verification?.explanation.join(" | "));
    assert.deepEqual(runL.outcome.branches[0].agreedTerms, { percentBps: 1000 });
    assert.equal(runL.verification!.promiseVsAgreed.direction, "worse");
    assert.match(runL.verification!.promiseVsAgreed.label, /worse than planned/);
    console.log(`  2 buyer counter inside the signed tolerance: accepted, verified against the agreed terms; owner sees: ${runL.verification!.promiseVsAgreed.label.slice(0, 150)}`);

    // ================= Section 3 happy: reject/counter -> constraint -> re-plan -> new authorisation -> executes and verifies =================
    const M = await setup("M");
    const planM = await M.addPlan([{ kind: "buyer_request_deposit", counterpartyId: M.buyerId, percentBps: 2000 }, { kind: "finance_invoice", counterpartyId: M.lenderId, advanceBps: 8000 }]);
    const authM = await authorisePlan(db, M.biz.id, { runId: M.runId, planId: planM.id }, "Test Owner");
    const runM = await executePlan(db, authM.authorisationId);
    assert.equal(runM.status, "needs_replan");
    assert.deepEqual(runM.outcome.constraints.map((c) => ({ kind: c.kind, maxPercentBps: c.maxPercentBps })), [{ kind: "buyer_request_deposit", maxPercentBps: 1000 }]);
    assert.ok(Object.keys(runM.outcome.constraints[0]).every((k) => ["kind", "counterpartyId", "excluded", "maxPercentBps", "source", "round"].includes(k)), "the constraint holds structured fields only");
    const parentView = (await getPlanAuthorisation(db, authM.authorisationId)) as { run: { lifecycle: string } };
    assert.equal(parentView.run.lifecycle, "needs_replan");
    const rp = await replanFromExecution(db, authM.authorisationId, { forceFallback: true });
    assert.equal(rp.status, "replanned");
    assert.ok(rp.plans.length > 0 && rp.plans.every((p) => p.levers.every((l) => l.kind !== "buyer_request_deposit" || l.percentBps <= 1000)), "every new plan respects the learned cap");
    assert.equal((await executePlanGuard(M.biz.id)), 0, "re-planning executed nothing");
    const chosen = rp.plans.find((p) => p.levers.some((l) => l.kind === "buyer_request_deposit")) ?? rp.plans[0];
    const authM2 = await authorisePlan(db, M.biz.id, { runId: rp.newRunId!, planId: chosen.id, confirmations: 2 }, "Test Owner");
    assert.equal(authM2.status, "authorised", "the new plan needs and gets a NEW authorisation");
    assert.notEqual(authM2.authorisationId, authM.authorisationId);
    const runM2 = await executePlan(db, authM2.authorisationId);
    assert.equal(runM2.status, "completed", JSON.stringify(runM2.verification?.explanation ?? runM2.outcome));
    const stM = (await getPlanAuthorisation(db, authM.authorisationId)) as { run: { lifecycle: string; successorRunId: string } };
    assert.equal(stM.run.lifecycle, "replanned");
    assert.equal(stM.run.successorRunId, rp.newRunId);
    console.log(`  3 re-plan: buyer capped at 10% -> constraint stored -> new run (round ${rp.round}, ${rp.plans.length} plans) -> new authorisation -> executed and verified; first run lifecycle ${stM.run.lifecycle}`);
    await chainOk(M.biz.id);

    // ================= Section 3 failure: the re-plan limit =================
    const N = await setup("N");
    await owner`UPDATE counterparties SET profile = profile || '{"maxBuyerDepositBps":0}'::jsonb WHERE id = ${N.buyerId}`;
    const planN = await N.addPlan([{ kind: "buyer_request_deposit", counterpartyId: N.buyerId, percentBps: 1000 }]);
    const authN = await authorisePlan(db, N.biz.id, { runId: N.runId, planId: planN.id }, "Test Owner");
    const runN = await executePlan(db, authN.authorisationId);
    assert.equal(runN.status, "needs_replan");
    assert.equal(runN.outcome.constraints[0].excluded, true);
    await owner`UPDATE agent_runs SET round = 2 WHERE id = ${N.runId}`; // this run is already the second re-plan round
    const ex = await replanFromExecution(db, authN.authorisationId, { forceFallback: true });
    assert.equal(ex.status, "exhausted");
    assert.match(ex.message!, /No feasible plan inside the owner's constraints/);
    assert.ok(ex.bestOption);
    const [lcN] = await rows<{ lifecycle: string }>`SELECT lifecycle FROM agent_runs WHERE id = ${N.runId}`;
    assert.equal(lcN.lifecycle, "exhausted");
    console.log("  3b after 2 re-plan rounds: exhausted with 'No feasible plan inside the owner's constraints' and a best documented option; no new run");

    async function executePlanGuard(bizId: string) {
      return (await rows<{ n: number }>`SELECT count(*)::int n FROM plan_executions WHERE business_id = ${bizId}`)[0].n - 1;
    }

    // ================= Section 0 (ADR-025): a buyer counter inside the tolerance now carries a finance application =================
    const T = await setup("T");
    const planT = await T.addPlan([{ kind: "buyer_request_deposit", counterpartyId: T.buyerId, percentBps: 2000 }, { kind: "finance_invoice", counterpartyId: T.lenderId, advanceBps: 8000 }]);
    const authT = await authorisePlan(db, T.biz.id, { runId: T.runId, planId: planT.id, tolerances: { buyerDepositBps: 1000 } }, "Test Owner");
    const runT = await executePlan(db, authT.authorisationId);
    assert.equal(runT.status, "completed", JSON.stringify(runT.verification?.explanation ?? runT.outcome.failure));
    assert.deepEqual(runT.outcome.branches[0].agreedTerms, { percentBps: 1000 });
    const [appT] = await rows<{ requested_amount_minor: string }>`SELECT requested_amount_minor::text FROM sandbox_applications WHERE business_id = ${T.biz.id}`;
    assert.equal(appT.requested_amount_minor, "16200000", "the application was re-submitted for the invoice left after the AGREED 10% deposit (GBP 162,000)");
    // failure: an amount above the signed maximum is not covered
    const termsT = ((await owner`SELECT terms FROM plan_authorisations WHERE id = ${authT.authorisationId}`)[0] as { terms: never }).terms;
    const finReq = (termsT as { entries: { request: { kind: string; lenderId: string; invoiceAmountMinor: string; advanceBps: number } }[] }).entries[1].request;
    const { requestSchema } = await import("../src/gate");
    assert.equal(permits(termsT, requestSchema.parse({ ...finReq, invoiceAmountMinor: "16200001" })), false, "above the signed maximum: not covered");
    assert.equal(permits(termsT, requestSchema.parse({ ...finReq, invoiceAmountMinor: "16200000" })), true);
    console.log("  0 buyer counter + finance: application re-submitted for GBP 162,000 inside the signed maximum, executed and verified; above the maximum is not covered");

    // ================= Section 2: chase and early-payment levers =================
    const Q = await setup("Q");
    const bq = leverBounds(Q.ctx);
    const nameOf = async (id: string) => (await rows<{ name: string }>`SELECT name FROM counterparties WHERE id = ${id}`)[0].name;
    const named = async (ids: string[], part: string) => { for (const id of ids) if ((await nameOf(id)).includes(part)) return id; return ids[0]; };
    const chaseCp = await named(bq.chase_overdue.candidates, "Harbour");
    const earlyCp = await named(bq.early_payment_discount.candidates, "Pennine");
    const planQ = await Q.addPlan([{ kind: "chase_overdue", counterpartyId: chaseCp, payWithinDays: 14 }, { kind: "early_payment_discount", counterpartyId: earlyCp, daysEarly: 15, discountBps: 100 }]);
    assert.ok(planQ.metrics.totalCostMinor !== "0", "the discount is a cost computed by the engine");
    const authQ = await authorisePlan(db, Q.biz.id, { runId: Q.runId, planId: planQ.id }, "Test Owner");
    const runQ = await executePlan(db, authQ.authorisationId);
    assert.equal(runQ.status, "completed", JSON.stringify(runQ.verification?.explanation ?? runQ.outcome.failure));
    assert.deepEqual(runQ.outcome.branches.map((b) => b.agreedTerms), [{ payWithinDays: 14 }, { daysEarly: 15, discountBps: 100 }]);
    const beyondQ = await Q.addPlan([{ kind: "early_payment_discount", counterpartyId: earlyCp, daysEarly: 30, discountBps: 9000 }], true);
    const deniedQ = await authorisePlan(db, Q.biz.id, { runId: Q.runId, planId: beyondQ.id }, "Test Owner");
    assert.equal(deniedQ.status, "denied");
    console.log(`  2 chase (14 days) + early payment (15 days, 1%): agreed by the buyers, cost GBP ${(Number(planQ.metrics.totalCostMinor) / 100).toFixed(2)} from the engine, executed and verified; a 90% discount is denied at signing (${(deniedQ.gates.find((g) => g.decision === "deny")?.reasons[0] ?? deniedQ.problems[0]).slice(0, 80)})`);

    // ================= Section 2b: two-person control (second approver) =================
    {
      const { randomUUID } = await import("node:crypto");
      const { requestSecondApproval, confirmSecond } = await import("../src/actions/plan-authorise");
      const U = await setup("U");
      const bu = leverBounds(U.ctx);
      const planU = await U.addPlan([{ kind: "chase_overdue", counterpartyId: bu.chase_overdue.candidates[0], payWithinDays: 14 }]);
      const owner = { id: randomUUID(), name: "Alex Owner" };
      const waiting = await requestSecondApproval(db, U.biz.id, { runId: U.runId, planId: planU.id, confirmations: 2 }, owner);
      assert.equal(waiting.status, "awaiting_second");
      const row0 = (await rows<{ status: string; signature: string | null; first_confirmed_name: string }>`SELECT status, signature, first_confirmed_name FROM plan_authorisations WHERE id = ${waiting.authorisationId}`)[0];
      assert.deepEqual([row0.status, row0.signature, row0.first_confirmed_name], ["awaiting_second", null, "Alex Owner"], "after the owner's confirmation the plan waits and the system has NOT signed it");
      await assert.rejects(executePlan(db, waiting.authorisationId), /never signed/, "nothing runs before the second approval");
      const sam = { id: randomUUID(), name: "Sam Approver", role: "approver" };
      await assert.rejects(confirmSecond(db, U.biz.id, waiting.authorisationId, { ...sam, id: owner.id }, "approve"), /different person/, "the same person cannot give both confirmations");
      await assert.rejects(confirmSecond(db, U.biz.id, waiting.authorisationId, { ...sam, role: "owner" }, "approve"), /approver account/, "only an approver account can give the second approval");
      await assert.rejects(confirmSecond(db, Q.biz.id, waiting.authorisationId, sam, "approve"), /Unknown plan authorisation/, "another business cannot confirm it");
      const done = await confirmSecond(db, U.biz.id, waiting.authorisationId, sam, "approve");
      assert.equal(done.status, "authorised");
      const row1 = (await rows<{ status: string; signature: string | null; approved_by: string }>`SELECT status, signature, approved_by FROM plan_authorisations WHERE id = ${waiting.authorisationId}`)[0];
      assert.ok(row1.status === "authorised" && row1.signature && row1.approved_by === "Alex Owner + Sam Approver", "approving makes the system sign, and both names are recorded");
      await assert.rejects(confirmSecond(db, U.biz.id, waiting.authorisationId, sam, "approve"), /not waiting/, "it can only be confirmed once");
      const ranU = await executePlan(db, waiting.authorisationId);
      assert.equal(ranU.status, "completed", JSON.stringify(ranU.verification?.explanation ?? ranU.outcome.failure));
      // Declining ends it: nothing is signed and it can never run.
      const V = await setup("V");
      const bv = leverBounds(V.ctx);
      const planV = await V.addPlan([{ kind: "chase_overdue", counterpartyId: bv.chase_overdue.candidates[0], payWithinDays: 14 }]);
      const wv = await requestSecondApproval(db, V.biz.id, { runId: V.runId, planId: planV.id, confirmations: 2 }, owner);
      assert.equal((await confirmSecond(db, V.biz.id, wv.authorisationId, sam, "decline")).status, "declined");
      await assert.rejects(confirmSecond(db, V.biz.id, wv.authorisationId, sam, "approve"), /not waiting/, "a declined plan cannot be approved later");
      const rowV = (await rows<{ status: string; signature: string | null }>`SELECT status, signature FROM plan_authorisations WHERE id = ${wv.authorisationId}`)[0];
      assert.deepEqual([rowV.status, rowV.signature], ["declined", null]);
      console.log("  2b second approver: the owner's confirmation parks the plan unsigned; the same person, a non-approver and another business are refused; a different approver's own confirmation signs it (both names recorded) and it runs and verifies; declining ends it");
    }

    // ================= Section 3: the shortage trigger =================
    const R = await setup("R");
    const opts = { gateway: mockGw, forceFallback: true };
    const s1 = await checkShortage(db, R.biz.id, {}, opts);
    assert.equal(s1.status, "planned");
    assert.ok(s1.run!.plans.length > 0 && s1.detection.reason!.kind === "below_zero");
    assert.equal((await rows<{ n: number }>`SELECT count(*)::int n FROM plan_authorisations WHERE business_id = ${R.biz.id}`)[0].n, 0, "detecting and planning executed and authorised nothing");
    const s2 = await checkShortage(db, R.biz.id, {}, opts);
    assert.equal(s2.status, "existing_run");
    assert.equal(s2.runId, s1.runId, "the same shortage does not create a second run");
    await owner`UPDATE financial_accounts SET balance_minor = balance_minor + 100000 WHERE business_id = ${R.biz.id}`; // a changed forecast
    const s3 = await checkShortage(db, R.biz.id, {}, opts);
    assert.equal(s3.status, "planned");
    assert.deepEqual(s3.superseded, [s1.runId]);
    const [oldRun] = await rows<{ lifecycle: string }>`SELECT lifecycle FROM agent_runs WHERE id = ${s1.runId}`;
    assert.equal(oldRun.lifecycle, "superseded");
    await owner`UPDATE financial_accounts SET balance_minor = balance_minor + 50000000 WHERE business_id = ${R.biz.id}`; // healthy now
    const s4 = await checkShortage(db, R.biz.id, {}, opts);
    assert.equal(s4.status, "no_shortage");
    assert.equal(s4.runId, null);
    console.log(`  3 shortage trigger: below_zero detected (lowest ${gbp(s1.detection.reason!.minBalanceMinor)}, week ${s1.detection.reason!.minBalanceWeek}), ${s1.run!.plans.length} plans, same shortage -> same run, changed forecast -> new run + old superseded, healthy forecast -> no run`);

    // ================= Section 4: the scoreboard =================
    const sb = (await getScoreboard(db, M.biz.id)) as { summary: { executed: number; verified: number; ownerApprovals: number; deniedOrBlocked: number }; entries: { status: string; rounds: number; doNothing: { minBalanceMinor: string } | null; executedPlan: { verification: string; minBalanceMinor: string } | null; lowestBalanceImprovementMinor: string | null; ownerApprovals: number; label: string }[] };
    assert.equal(sb.entries.length, 1);
    const e0 = sb.entries[0];
    assert.equal(e0.executedPlan?.verification, "verified");
    assert.equal(e0.rounds, 1);
    assert.equal(e0.ownerApprovals, 2, "two signed authorisations: the refused attempt and the re-plan");
    assert.ok(BigInt(e0.lowestBalanceImprovementMinor!) > 0n, "executed plan beats doing nothing on the lowest balance");
    const sbN = (await getScoreboard(db, N.biz.id)) as { entries: { status: string; executedPlan: unknown; deniedOrBlocked: number; label: string }[] };
    assert.equal(sbN.entries[0].status, "exhausted");
    assert.equal(sbN.entries[0].executedPlan, null);
    console.log(`  4 scoreboard: re-planned commitment: do nothing lowest ${gbp(e0.doNothing!.minBalanceMinor)} -> executed ${gbp(e0.executedPlan!.minBalanceMinor)} (verified, ${e0.ownerApprovals} owner approvals); exhausted commitment: "${sbN.entries[0].label}"`);

    // ================= 9. Owner plan edit (Batch 13, no model) =================
    {
    const { editPlan } = await import("../src/actions/plan-edit");
    const E = await setup("E");
    const planE = await E.addPlan(lever3(E));
    const plansBefore = (await rows<{ n: number }>`SELECT count(*)::int n FROM plans WHERE run_id = ${E.runId}`)[0].n;
    const edited = lever3(E).map((l) => (l.kind === "supplier_reduce_deposit" ? { ...l, percentBps: 1700 } : l));
    const prev = await editPlan(db, E.biz.id, { runId: E.runId, basePlanId: planE.id, levers: edited });
    assert.ok(prev.ok && !prev.committed && !prev.unchanged, "preview recomputes the plan");
    assert.equal((await rows<{ n: number }>`SELECT count(*)::int n FROM plans WHERE run_id = ${E.runId} AND plan_hash = ${planId(edited)}`)[0].n, 0, "preview writes nothing");
    assert.notEqual(prev.ok && prev.plan.metrics.minBalanceMinor, planE.metrics.minBalanceMinor, "the edit changed the engine numbers");
    const done = await editPlan(db, E.biz.id, { runId: E.runId, basePlanId: planE.id, levers: edited, notes: { [E.supplierId]: "Please confirm by Friday" }, commit: true });
    assert.ok(done.ok && done.committed && done.plan.source === "owner" && done.plan.editedFrom === planE.id && done.plan.ownerNotes?.[E.supplierId] === "Please confirm by Friday", "owner plan keeps the owner note");
    const authE = await authorisePlan(db, E.biz.id, { runId: E.runId, confirmations: 2, planId: planId(edited) }, "Test Owner");
    assert.equal(authE.status, "authorised", "an edited plan can be signed like any other");
    {
      // An owner note written while adjusting the terms now goes into that counterparty's letter (Batch 14).
      const { previewAuthorisation } = await import("../src/actions/plan-authorise");
      const pv = (await previewAuthorisation(db, E.biz.id, { runId: E.runId, planId: planId(edited), confirmations: 2 }, { name: "Alex Mercer" })) as unknown as { letters: Record<string, { paragraphs: string[] }> };
      assert.ok(pv.letters[E.supplierId].paragraphs.some((x) => x === "Please confirm by Friday"), "the owner's note is a paragraph of the supplier letter");
    }
    const bad = await editPlan(db, E.biz.id, { runId: E.runId, basePlanId: planE.id, levers: lever3(E).map((l) => (l.kind === "supplier_reduce_deposit" ? { ...l, percentBps: 9900 } : l)), commit: true });
    assert.ok(!bad.ok && bad.reasons.length > 0, "an edit outside the bounds is refused with reasons");
    assert.equal((await rows<{ n: number }>`SELECT count(*)::int n FROM plans WHERE run_id = ${E.runId}`)[0].n, plansBefore + 1, "only the valid edit was stored");
    const tooBig = await editPlan(db, E.biz.id, { runId: E.runId, basePlanId: planE.id, levers: lever3(E).map((l) => (l.kind === "supplier_reduce_deposit" ? { ...l, percentBps: 1500 } : l)) });
    assert.ok(!tooBig.ok && tooBig.reasons.some((r) => /per-payment limit/.test(r)), "a deposit that makes the balance payment exceed the per-payment limit is refused while choosing, not at run time");
    await chainOk(E.biz.id);
    console.log(`  9 owner plan edit: preview wrote nothing; commit stored an owner plan (deposit 20% -> 17%, lowest ${gbp(prev.ok ? prev.plan.metrics.minBalanceMinor : "0")}), signed; out-of-bounds edit refused with reasons`);
    }

    // ================= 10. Owner revision after a counterparty pushes back (Batch 13, no model) =================
    {
      const { reviseFromExecution } = await import("../src/actions/revise");
      const R2 = await setup("R2");
      const planR2 = await R2.addPlan([{ kind: "buyer_request_deposit", counterpartyId: R2.buyerId, percentBps: 2000 }, { kind: "finance_invoice", counterpartyId: R2.lenderId, advanceBps: 8000 }]);
      const authR2 = await authorisePlan(db, R2.biz.id, { runId: R2.runId, planId: planR2.id }, "Test Owner");
      const runR2 = await executePlan(db, authR2.authorisationId);
      assert.equal(runR2.status, "needs_replan");
      const stillAsk = await reviseFromExecution(db, authR2.authorisationId, { levers: planR2.levers });
      assert.ok(!stillAsk.ok && stillAsk.reasons.some((r) => /10%/.test(r)), "asking the buyer for 20% again is refused: it said 10% at most");
      const agreed: Lever[] = planR2.levers.map((l) => (l.kind === "buyer_request_deposit" ? { ...l, percentBps: 1000 } : l));
      const check = await reviseFromExecution(db, authR2.authorisationId, { levers: agreed });
      assert.ok(check.ok && !check.committed && check.newRunId === null, "checking the revision writes nothing");
      const runsBefore = (await rows<{ n: number }>`SELECT count(*)::int n FROM agent_runs WHERE business_id = ${R2.biz.id}`)[0].n;
      const opened = await reviseFromExecution(db, authR2.authorisationId, { levers: agreed, commit: true });
      assert.ok(opened.ok && opened.committed && opened.newRunId);
      assert.equal((await rows<{ n: number }>`SELECT count(*)::int n FROM agent_runs WHERE business_id = ${R2.biz.id}`)[0].n, runsBefore + 1);
      const [pr] = await rows<{ lifecycle: string; successor_run_id: string }>`SELECT lifecycle, successor_run_id FROM agent_runs WHERE id = ${R2.runId}`;
      assert.equal(pr.lifecycle, "replanned");
      assert.equal(pr.successor_run_id, opened.newRunId);
      const authR3 = await authorisePlan(db, R2.biz.id, { runId: opened.newRunId!, planId: opened.plan.id, confirmations: 2 }, "Test Owner");
      assert.equal(authR3.status, "authorised", "the revised plan needs and gets a new signature");
      const runR3 = await executePlan(db, authR3.authorisationId);
      assert.equal(runR3.status, "completed", JSON.stringify(runR3.verification?.explanation ?? runR3.outcome));
      await chainOk(R2.biz.id);
      console.log("  10 owner revision: buyer capped at 10% -> owner revises (re-asking 20% refused, 10% accepted, check wrote nothing) -> new round signed -> executed and verified");
    }

    // ================= 11. Partial revision: the vendor that agreed is kept, only the one that pushed back is asked again =================
    {
      const { reviseFromExecution } = await import("../src/actions/revise");
      const T = await setup("T");
      // Headroom (clone only): this deal has no finance lever, so the balance payment must be backed by cash on hand.
      await owner`UPDATE financial_accounts SET balance_minor = balance_minor + 10000000 WHERE business_id = ${T.biz.id}`;
      await owner`UPDATE sandbox_bank_accounts SET balance_minor = balance_minor + 10000000 WHERE business_id = ${T.biz.id}`;
      await owner`UPDATE counterparties SET profile = profile || '{"maxSupplierDepositReductionBps":1000}'::jsonb WHERE id = ${T.supplierId}`; // supplier floor 20%
      const planT = await T.addPlan([{ kind: "supplier_reduce_deposit", counterpartyId: T.supplierId, percentBps: 1500 }, { kind: "buyer_request_deposit", counterpartyId: T.buyerId, percentBps: 1000 }]);
      const authT = await authorisePlan(db, T.biz.id, { runId: T.runId, confirmations: 2, planId: planT.id }, "Test Owner");
      const runT = await executePlan(db, authT.authorisationId);
      assert.equal(runT.status, "needs_replan");
      assert.deepEqual(runT.outcome.branches.map((b) => b.status).sort(), ["agreed", "needs_replan"], "the buyer agreed; the supplier pushed back");
      assert.equal(runT.outcome.held, true, "the buyer's agreement is kept on hold");
      const buyerThreads = () => rows<{ status: string }>`SELECT status FROM sandbox_threads WHERE business_id = ${T.biz.id} AND counterparty_id = ${T.buyerId}`;
      assert.deepEqual((await buyerThreads()).map((t) => t.status), ["agreed"], "the buyer thread is still agreed after the pause");
      const revised: Lever[] = planT.levers.map((l) => (l.kind === "supplier_reduce_deposit" ? { ...l, percentBps: 2000 } : l));
      const prevT = await reviseFromExecution(db, authT.authorisationId, { levers: revised });
      assert.ok(prevT.ok && prevT.kept.length === 1 && prevT.kept[0].kind === "buyer_request_deposit" && prevT.askedAgain.length === 1 && prevT.askedAgain[0].kind === "supplier_reduce_deposit", "the preview says what stays and what is asked again");
      const openedT = await reviseFromExecution(db, authT.authorisationId, { levers: revised, commit: true });
      assert.ok(openedT.ok && openedT.committed);
      assert.deepEqual((await buyerThreads()).map((t) => t.status), ["agreed"], "the buyer thread was not touched by the revision");
      const authT2 = await authorisePlan(db, T.biz.id, { runId: openedT.newRunId!, confirmations: 2, planId: openedT.plan.id }, "Test Owner");
      const runT2 = await executePlan(db, authT2.authorisationId);
      assert.equal(runT2.status, "completed", JSON.stringify(runT2.outcome.failure ?? runT2.verification?.explanation));
      assert.ok(runT2.outcome.branches.some((b) => b.kind === "buyer_request_deposit" && b.carriedFrom === authT.authorisationId), "the buyer agreement was taken over, not asked again");
      const sentTo = async (cp: string) => (await rows<{ n: number }>`SELECT count(*)::int n FROM action_proposals WHERE business_id = ${T.biz.id} AND kind = 'sandbox.send_proposal' AND payload->>'counterpartyId' = ${cp}`)[0].n;
      assert.equal(await sentTo(T.buyerId), 1, "the buyer got exactly one proposal in the whole deal");
      assert.equal(await sentTo(T.supplierId), 2, "the supplier was asked twice (its first answer was a counter beyond the signed terms)");
      await chainOk(T.biz.id);
      // Changing the buyer's own term withdraws its old agreement; nothing is left behind. (Failure path: a deal that then fails rolls back the carried agreement too.)
      const U = await setup("U");
      await owner`UPDATE counterparties SET profile = profile || '{"maxSupplierDepositReductionBps":1000}'::jsonb WHERE id = ${U.supplierId}`;
      const planU = await U.addPlan([{ kind: "supplier_reduce_deposit", counterpartyId: U.supplierId, percentBps: 1500 }, { kind: "buyer_request_deposit", counterpartyId: U.buyerId, percentBps: 1000 }]);
      const authU = await authorisePlan(db, U.biz.id, { runId: U.runId, confirmations: 2, planId: planU.id }, "Test Owner");
      await executePlan(db, authU.authorisationId);
      const changed: Lever[] = planU.levers.map((l) => (l.kind === "supplier_reduce_deposit" ? { ...l, percentBps: 2000 } : { ...l, percentBps: 500 }));
      const openedU = await reviseFromExecution(db, authU.authorisationId, { levers: changed, commit: true });
      assert.ok(openedU.ok && openedU.committed && openedU.kept.length === 0 && openedU.askedAgain.length === 2);
      const oldBuyer = await rows<{ status: string }>`SELECT status FROM sandbox_threads WHERE business_id = ${U.biz.id} AND counterparty_id = ${U.buyerId} ORDER BY created_at`;
      assert.deepEqual(oldBuyer.map((t) => t.status), ["withdrawn"], "the buyer's old agreement was withdrawn because its term changed");
      console.log("  11 partial revision: one vendor agreed and was kept (asked once in the whole deal), the vendor that pushed back was asked again; the new round executed and verified; changing the agreed vendor's own term withdraws its old agreement");
    }

    // ================= 12. Assistant-assisted edit (Batch 13): one structured call, code applies it, the same engine check decides =================
    {
      const { assistEdit } = await import("../src/actions/plan-assist");
      const { editPlan } = await import("../src/actions/plan-edit");
      const V = await setup("V");
      const planV = await V.addPlan(lever3(V));
      const before = (await rows<{ n: number }>`SELECT count(*)::int n FROM plans WHERE run_id = ${V.runId}`)[0].n;
      process.env.PLAN_EDIT_ASSIST_MAX = "3";
      const a1 = await assistEdit(db, V.biz.id, { runId: V.runId, instruction: "Make the deposit 17%, defer the balance 20 days and drop the finance", levers: planV.levers }, { gateway: mockGw });
      assert.ok(a1.ok && a1.source === "model", "answered through the gateway (mock script)");
      const get = (k: string) => (a1.ok ? a1.levers.find((l) => l.kind === k) : undefined) as Record<string, number> | undefined;
      assert.equal(get("supplier_reduce_deposit")?.percentBps, 1700);
      assert.equal(get("supplier_defer_balance")?.daysAfterShipment, 20);
      assert.equal(get("finance_invoice"), undefined, "the finance term was dropped");
      assert.equal((await rows<{ n: number }>`SELECT count(*)::int n FROM plans WHERE run_id = ${V.runId}`)[0].n, before, "the assistant saved nothing");
      const prevV = await editPlan(db, V.biz.id, { runId: V.runId, basePlanId: planV.id, levers: a1.ok ? a1.levers : [] });
      assert.ok(prevV.ok && !prevV.committed, "the suggested terms go through the same engine check and mandate check");
      const a2 = await assistEdit(db, V.biz.id, { runId: V.runId, instruction: "Set the deposit to 150%", levers: planV.levers }, { gateway: mockGw });
      assert.ok(a2.ok && a2.changes.length === 0 && a2.ignored.length > 0, "an out-of-range number is ignored and reported, never clamped or guessed");
      const a3 = await assistEdit(db, V.biz.id, { runId: V.runId, instruction: "make it a bit better", levers: planV.levers }, { gateway: mockGw });
      assert.ok(a3.ok && a3.changes.length === 0 && !!a3.unclear, "a vague instruction gives no edits and says why");
      const a4 = await assistEdit(db, V.biz.id, { runId: V.runId, instruction: "deposit 10%", levers: planV.levers }, { gateway: mockGw });
      assert.ok(!a4.ok && a4.remaining === 0, "the per-case cap stops a fourth call");
      delete process.env.PLAN_EDIT_ASSIST_MAX;
      await chainOk(V.biz.id);
      console.log("  12 assistant edit: 'deposit 17%, defer 20 days, drop finance' -> three structured edits applied by code, nothing saved, the engine check accepts the result; 150% ignored; vague gives no edits; cap of 3 enforced");
    }

    // ================= 13. Proposal letters and the drawn signature (Batch 14) =================
    {
      const { previewAuthorisation } = await import("../src/actions/plan-authorise");
      const { makeSignaturePng, makeBlankPng } = await import("./png-fixture");
      type L = Record<string, { subject: string; paragraphs: string[] }>;
      const W = await setup("W");
      const planW = await W.addPlan(lever3(W));
      const prevW = (await previewAuthorisation(db, W.biz.id, { runId: W.runId, planId: planW.id, confirmations: 2 }, { name: "Alex Mercer" })) as unknown as { letters: L; termLines: Record<string, string[]> };
      assert.deepEqual(Object.keys(prevW.letters).sort(), [W.supplierId, W.lenderId].sort(), "one drafted letter per counterparty in the plan");
      assert.ok(Object.values(prevW.letters).every((l) => /^Dear /.test(l.paragraphs[0]) && l.paragraphs.some((p) => /^Kind regards/.test(p)) && l.subject.length > 5), "professional drafts: greeting, subject, sign-off");
      assert.ok(prevW.termLines[W.supplierId].some((t) => /^Deposit: 20% of the order value/.test(t)) && prevW.termLines[W.lenderId].some((t) => /^Invoice-finance advance: 80%/.test(t)), "the locked terms lines come from the signed terms");
      const edited: L = JSON.parse(JSON.stringify(prevW.letters));
      edited[W.supplierId].paragraphs[1] = "EDITED LINE: thank you for the quotation; we would like to adjust the terms.";
      const base = { runId: W.runId, planId: planW.id, confirmations: 2 as const };
      await assert.rejects(() => authorisePlan(db, W.biz.id, { ...base, letters: edited, signatureImage: makeBlankPng() }, "Alex Mercer"), /Please draw your signature/);
      await assert.rejects(() => authorisePlan(db, W.biz.id, { ...base, letters: { [W.supplierId]: edited[W.supplierId] }, signatureImage: makeSignaturePng() }, "Alex Mercer"), /exactly one letter for each counterparty/);
      const authW = await authorisePlan(db, W.biz.id, { ...base, letters: edited, signatureImage: makeSignaturePng() }, "Alex Mercer");
      assert.equal(authW.status, "authorised");
      assert.ok(authW.authorisation.lettersHash && authW.authorisation.signatureHash, "both fingerprints are stored and signed");
      const runW = await executePlan(db, authW.authorisationId);
      assert.equal(runW.status, "completed", JSON.stringify(runW.outcome.failure ?? runW.verification?.explanation));
      const bodies = await rows<{ body: string; counterparty_id: string }>`SELECT body, counterparty_id FROM sandbox_messages WHERE business_id = ${W.biz.id} AND direction = 'outbound'`;
      const sup = bodies.find((b) => b.counterparty_id === W.supplierId)!.body;
      assert.ok(sup.includes("EDITED LINE") && sup.includes("Proposed terms") && sup.includes("Deposit: 20% of the order value") && /fingerprint [0-9a-f]{12}/.test(sup), "the supplier received the owner's edited wording, the locked terms and the signature reference");
      const [appW] = await rows<{ offer: { coverText?: string } }>`SELECT offer FROM sandbox_applications WHERE business_id = ${W.biz.id}`;
      assert.ok(appW.offer.coverText?.includes("Invoice-finance advance: 80%"), "the lender's application carries its letter");
      await chainOk(W.biz.id);
      // Failure path: editing the letters after signing is caught before anything is sent.
      const X = await setup("X");
      const planX = await X.addPlan(lever3(X));
      const prevX = (await previewAuthorisation(db, X.biz.id, { runId: X.runId, planId: planX.id, confirmations: 2 }, { name: "Alex Mercer" })) as unknown as { letters: L };
      const authX = await authorisePlan(db, X.biz.id, { runId: X.runId, planId: planX.id, confirmations: 2, letters: prevX.letters, signatureImage: makeSignaturePng() }, "Alex Mercer");
      await owner`UPDATE plan_authorisations SET letters = '{}'::jsonb WHERE id = ${authX.authorisationId}`;
      await assert.rejects(() => executePlan(db, authX.authorisationId), /letters were edited after they were signed/);
      assert.equal((await sandboxCounts(X.biz.id)).threads, 0, "nothing was sent");
      console.log("  13 letters and signature: drafted per counterparty, edited line and locked terms reached the supplier and lender, blank drawing and missing letter refused, letters edited after signing refused before sending");
    }

    // ================= 14. Plans that cannot run rank last (Batch 14) =================
    {
      const { demoteBlocked } = await import("../src/agent");
      const mk = (id: string, blockers?: string[]) => ({ id, title: "Recommended: x", levers: [], contingencies: [], rationale: "", source: "ai", metrics: planA.metrics, checks: [], assumptions: [], proseFlagged: false, removedSentences: [], ...(blockers ? { blockers } : {}) }) as unknown as Parameters<typeof demoteBlocked>[0][number];
      const ranked = demoteBlocked([mk("blocked", ["limit"]), mk("ok1"), mk("ok2")]);
      assert.deepEqual(ranked.map((p) => p.id), ["ok1", "ok2", "blocked"], "a plan that cannot run goes after the ones that can");
      assert.ok((ranked[2].warnings ?? []).length > 0 && !/^recommended/i.test(ranked[2].title), "and it is flagged and no longer called the recommendation");
      assert.deepEqual(demoteBlocked([mk("a", ["limit"]), mk("b", ["limit"])]).map((p) => p.id), ["a", "b"], "if every plan is blocked the order is unchanged");
      console.log("  14 blocked plans: demoted behind plans that can run, flagged, no longer recommended");
    }

    // ================= 8. Layering =====
    writeFileSync(probe, [
      'import { authorisePlan } from "@/actions/plan-authorise";',
      'import { executePlan } from "@/actions/plan-exec";',
      'import { verifyPlanExecution } from "@/actions/plan-verify";',
      'import { signPlanAuthorisation } from "@/gate/owner-signing";',
      "export const probe = [authorisePlan, executePlan, verifyPlanExecution, signPlanAuthorisation];",
      "",
    ].join("\n"));
    let lintOut = "";
    try {
      execSync("bun run lint src/agent/_layering_probe.ts", { encoding: "utf8", stdio: "pipe" });
      assert.fail("lint should have failed on the probe");
    } catch (e) {
      lintOut = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
    } finally {
      if (existsSync(probe)) unlinkSync(probe);
    }
    const hits = (lintOut.match(/no-restricted-imports/g) ?? []).length;
    assert.ok(hits >= 4, `expected 4 restricted-import errors, got ${hits}\n${lintOut.slice(0, 600)}`);
    assert.ok(!existsSync(probe));
    console.log(`  8 layering: src/agent importing plan-authorise, plan-exec, plan-verify and owner-signing fails lint (${hits} errors); probe deleted`);

    console.log("plan sanity: ok");
  } finally {
    if (existsSync(probe)) unlinkSync(probe);
    await owner.end();
    await sql.end();
  }
}
await main();
