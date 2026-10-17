// Focused checks for coordinated rescue strategies (not a test suite). Run: bun run check:strategy
// Part A is pure and uses inline synthetic data: combined plans come from the existing engine, prefer not borrowing, size financing, never
// double count, respect `allow` and learned refusals. Part B uses a throwaway clone of the demo business: the planning run carries the
// strategy, it passes the gate dry-run, a refusal changes the choice, and nothing is signed or executed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { adjustmentsOf, applyTermChanges, buildForecast, type EngineInput } from "../src/engine";
import { coordinate, leversToChanges, searchPlans, simulateLevers, type CoordinateOptions } from "../src/engine/plans";
import type { CommitmentEvent } from "../src/domain/commitment-event";
import type { Constraint } from "../src/domain/constraints";
import { LEVER_KINDS } from "../src/domain/plan";

const ev = (date: string, amountMinor: bigint, kind: CommitmentEvent["kind"], label: string): CommitmentEvent => ({ date, amountMinor, currency: "GBP", label, kind, source: "manual", confidence: "medium" });
const events = [
  ev("2026-10-22", -900_000n, "supplier_deposit", "Kestrel deposit (test)"),
  ev("2026-11-25", -2_100_000n, "supplier_balance", "Kestrel balance (test)"),
  ev("2026-12-20", 4_500_000n, "customer_receipt", "Northgate order paid (test)"),
];
const mkInput = (wages: bigint, overdue: bigint): EngineInput => ({
  asOf: "2026-10-15", currency: "GBP", openingBalance: 1_000_000n, reserve: 300_000n, horizonWeeks: 13,
  invoices: [
    { id: "i1", number: "INV-1", counterpartyId: "buy2", counterpartyName: "Acme (test)", issuedOn: "2026-08-20", dueOn: "2026-09-20", amount: overdue, status: "open" },
    { id: "i2", number: "INV-2", counterpartyId: "buy3", counterpartyName: "Birch (test)", issuedOn: "2026-10-01", dueOn: "2026-11-20", amount: 800_000n, status: "open" },
  ],
  bills: [],
  commitments: [{ id: "c1", name: "Wages (test)", amount: -wages, frequency: "weekly", nextDueOn: "2026-10-16", kind: "confirmed" }],
});
const parties = { supplierId: "sup1", buyerId: "buy1", lenderId: "len1" };
const opts = (o: Partial<CoordinateOptions> = {}): CoordinateOptions => ({
  horizonWeeks: 13, allowedKinds: [...LEVER_KINDS], financeCapBps: 8000, financeFeeBps: 200, earlyDiscountCapBps: 200, allow: () => true, ...o,
});
const kinds = (ls: { kind: string }[]) => ls.map((l) => l.kind).sort().join("+");

function partA() {
  // ---- A1. The best combination is the engine's full forecast; it borrows nothing when that is enough ----
  const inA = mkInput(150_000n, 700_000n);
  const A = coordinate(inA, events, parties, opts());
  assert.ok(A.baseline.minBalance < inA.reserve, "there is a gap");
  console.log(`  A1 verdict ${A.verdict}; ${A.selected ? kinds(A.selected.levers) : "nothing"}; do nothing ${A.baseline.minBalance}; ${A.evaluated} combinations evaluated`);
  if (A.verdict === "closes_without_borrowing") {
    const s = A.selected!;
    assert.ok(!s.borrows && s.closesGap);
    // The same number by a different route (term changes then forecast), not through simulateLevers.
    const ch = leversToChanges(s.levers, 200);
    const f = buildForecast(inA, { events: applyTermChanges(events, ch), horizonWeeks: 13, adjustments: adjustmentsOf(ch) });
    assert.equal(f.minimum.amount, s.minBalanceMinor, "the combined lowest balance is the engine's full forecast");
    const all = searchPlans(inA, events, parties, { horizonWeeks: 13, financeCapBps: null, allowedKinds: LEVER_KINDS.filter((k) => k !== "finance_invoice"), topN: 100000, earlyDiscountCapBps: 200, financeFeeBps: 200 }).ranked;
    assert.ok(all.filter((p) => p.minBalance >= inA.reserve).every((p) => p.cost >= s.costMinor), "no cheaper adequate combination exists");
    assert.ok(A.contributions.every((c) => c.needed), "each action is needed: without it the cushion fails");
    if (s.levers.length > 1) {
      const i = A.interaction!;
      assert.equal(i.combinedGainMinor, s.minBalanceMinor - A.baseline.minBalance);
      assert.ok(all.filter((p) => p.levers.length === 1 && p.minBalance >= inA.reserve).length === 0, "no single action closes the gap, so combining was necessary");
      console.log(`     separate gains add to ${i.sumOfOwnGainsMinor}; the combined forecast gives ${i.combinedGainMinor}`);
    }
  }
  assert.ok(A.audit.ok && A.audit.duplicateSources.length === 0, "nothing counted twice");

  // ---- A2. Finance only when nothing else closes the gap, and sized as small as possible ----
  // The signed limits here allow only collecting from customers and invoice finance (no supplier or buyer-deposit asks), and the supplier balance is large.
  const events2 = [events[0], ev("2026-11-25", -3_500_000n, "supplier_balance", "Kestrel balance (test)"), ev("2026-12-20", 7_000_000n, "customer_receipt", "Northgate order paid (test)")];
  const inB = mkInput(100_000n, 700_000n);
  const narrow = ["chase_overdue", "early_payment_discount", "finance_invoice"] as const;
  const B = coordinate(inB, events2, parties, opts({ allowedKinds: [...narrow] }));
  const nb = coordinate(inB, events2, parties, opts({ allowedKinds: ["chase_overdue", "early_payment_discount"], financeCapBps: null }));
  assert.equal(B.verdict, "closes_with_financing", "chasing and early payment are not enough, so a sized advance is used");
  assert.notEqual(nb.verdict, "closes_without_borrowing");
  console.log(`  A2 verdict ${B.verdict}; without finance: ${nb.verdict}`);
  {
    const fin = B.financing!;
    assert.ok(B.selected!.closesGap && B.selected!.borrows);
    const rest = B.selected!.levers.filter((l) => l.kind !== "finance_invoice");
    if (fin.advanceBps > 500) {
      const lower = simulateLevers(inB, events2, [...rest, { kind: "finance_invoice", counterpartyId: "len1", advanceBps: fin.advanceBps - 500 }], { horizonWeeks: 13, financeFeeBps: 200 });
      assert.ok(lower.minBalance < inB.reserve, "one grid step less borrowing would not have closed the gap with these actions");
    }
    assert.ok(fin.advanceBps <= 8000, "never above the signed cap");
    assert.notEqual(B.audit.orderCashConserved, false, "the order's cash adds up with finance");
    console.log(`     ${kinds(B.selected!.levers)} advance ${fin.advanceBps / 100}% (${fin.advanceMinor}); finance alone needs ${fin.aloneAdvanceBps === null ? "more than the cap" : fin.aloneAdvanceBps / 100 + "%"}`);
  }

  // ---- A3. Honest when nothing closes it; silent when there is no gap ----
  const C = coordinate(mkInput(900_000n, 700_000n), events, parties, opts());
  assert.ok(["partial", "no_help"].includes(C.verdict), "a huge gap is not claimed to be closed");
  if (C.selected) assert.ok(!C.selected.closesGap);
  const D = coordinate({ ...inA, openingBalance: 50_000_000n }, events, parties, opts());
  assert.equal(D.verdict, "no_shortage");
  assert.equal(D.selected, null);
  console.log(`  A3 huge gap: "${C.verdict}"${C.selected ? ` best lowest ${C.selected.minBalanceMinor}` : ""}; no gap: "${D.verdict}"`);

  // ---- A4. Authorization and learned refusals shape the result ----
  const noFinance = coordinate(inB, events2, parties, opts({ allowedKinds: [...narrow], allow: (ls) => !ls.some((l) => l.kind === "finance_invoice") }));
  assert.ok(!noFinance.selected?.borrows, "a lever the gate or the limits refuse is never proposed");
  const refusal: Constraint[] = [{ kind: "chase_overdue", counterpartyId: "buy2", excluded: true } as Constraint];
  const R = coordinate(inA, events, parties, opts({ constraints: refusal }));
  assert.ok(!R.selected || !R.selected.levers.some((l) => l.kind === "chase_overdue"), "after a refusal the chase is not proposed again");
  console.log(`  A4 finance denied: ${noFinance.verdict}; after a chase refusal: ${R.verdict} (${R.selected ? kinds(R.selected.levers) : "nothing"})`);

  // ---- A5. What counterparties already said shapes the proposal; what nobody said creates no certainty ----
  const inC = mkInput(150_000n, 1_500_000n);
  const none = coordinate(inC, events, parties, opts());
  const knownBuyer = coordinate(inC, events, parties, opts({ known: (l) => l.kind === "buyer_request_deposit" }));
  const knownAll = coordinate(inC, events, parties, opts({ known: () => true }));
  const knownNone = coordinate(inC, events, parties, opts({ known: () => false }));
  assert.equal(none.verdict, "closes_without_borrowing");
  assert.ok(knownBuyer.selected!.levers.some((l) => l.kind === "buyer_request_deposit"), "between equally cheap options, the one that rests on something a counterparty said is chosen");
  assert.equal(knownBuyer.selected!.costMinor, none.selected!.costMinor, "knowing something never costs more: it only breaks ties");
  for (const k of [knownAll, knownNone]) {
    assert.equal(k.verdict, none.verdict, "claiming everything or nothing is known does not change what is feasible");
    assert.equal(k.selected!.costMinor, none.selected!.costMinor);
    assert.ok(k.selected!.closesGap);
  }
  // A stated limit changes the proposal; the ask is at their limit, not above it, and the result is recomputed (no fabricated headroom).
  const capped = coordinate(inC, events, parties, opts({ known: (l) => l.kind === "buyer_request_deposit", constraints: [{ kind: "buyer_request_deposit", counterpartyId: "buy1", excluded: false, maxPercentBps: 1000, source: "counter", round: 1 } as Constraint] }));
  assert.ok(capped.selected!.levers.every((l) => l.kind !== "buyer_request_deposit" || l.percentBps <= 1000), "a stated cap is respected");
  const floor = coordinate(inC, events, parties, opts({ constraints: [{ kind: "supplier_defer_balance", counterpartyId: "sup1", excluded: false, maxDays: 14, source: "counter", round: 1 } as Constraint] }));
  assert.ok(floor.selected!.levers.every((l) => l.kind !== "supplier_defer_balance" || l.daysAfterShipment <= 14), "a stated longest deferral is respected");
  // Concession room and the cost of a refusal are worked out by the engine, not guessed.
  for (const r of none.room) {
    if (!r.gentlest) continue;
    const others = none.selected!.levers.filter((l) => l.kind !== r.lever.kind);
    assert.ok(simulateLevers(inC, events, [...others, r.gentlest], { horizonWeeks: 13, financeFeeBps: 200 }).minBalance >= inC.reserve, "the gentlest counter named still keeps the cushion");
  }
  assert.ok(none.room.some((r) => r.gentlest && JSON.stringify(r.gentlest) !== JSON.stringify(r.lever)) || none.room.every((r) => !r.gentlest || JSON.stringify(r.gentlest) === JSON.stringify(r.lever)));
  assert.equal(none.fallbacks.length, none.selected!.levers.length, "a fallback exists for every action");
  for (const f of none.fallbacks) {
    assert.ok(!f.levers.some((l) => l.kind === f.lever.kind && l.counterpartyId === f.lever.counterpartyId), "the fallback does not contain the refused action");
    if (f.levers.length > 0) assert.equal(simulateLevers(inC, events, f.levers, { horizonWeeks: 13, financeFeeBps: 200 }).minBalance, f.minBalanceMinor, "the fallback figure is the engine's");
  }
  console.log(`  A5 equal-cost tie follows what was said (${kinds(none.selected!.levers)} -> ${kinds(knownBuyer.selected!.levers)}); claiming all/none known changes nothing feasible; caps respected; room ${none.room.map((r) => (r.gentlest ? "yes" : "n/a")).join("/")}; fallbacks ${none.fallbacks.map((f) => f.verdict).join("/")}`);
}

async function partB() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq, sql: dsql } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { createDocument } = await import("../src/actions/ledger");
  const { buildContext, startRun } = await import("../src/actions/agent-run");
  const { dryRun, coordinateForContext } = await import("../src/agent");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");
    const { id } = await createDemoClone(db as any, demo!);
    const gw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
    for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
      const r = await docs.createDocumentAndExtract(db as any, id, { filename, kind, text: readFileSync(join("fixtures", filename), "utf8") }, { gateway: gw });
      await confirmExtraction(db as any, r.extraction.id, "Test Owner");
    }
    const ctx0 = await buildContext(db as any, id, null, []);
    const supplier = (await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, id))).find((c) => c.role === "supplier")!;
    const inDays = (n: number) => new Date(Date.parse(`${ctx0.asOf}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "STRATEGY-1", issuedOn: ctx0.asOf, dueOn: inDays(21), amount: "50000.00", acknowledgeOverlaps: true });
    const ctx = await buildContext(db as any, id, null, []);
    const counts = async () => {
      const n = async (t: any) => Number((await db.select({ c: dsql<number>`count(*)` }).from(t).where(eq(t.businessId, id)))[0].c);
      return [await n(S.planAuthorisations), await n(S.planExecutions), await n(S.sandboxApplications), await n(S.sandboxThreads)];
    };
    const before = await counts();
    const c1 = coordinateForContext(ctx);
    assert.ok(c1, "signed limits are valid in the demo");
    console.log(`  B demo clone: verdict ${c1.verdict}; do nothing lowest ${c1.baseline.minBalance} vs cushion ${c1.reserveMinor}`);
    if (c1.selected) {
      assert.ok(dryRun(ctx, c1.selected.levers).every((c) => c.decision !== "deny"), "every action passes the permission gate dry-run");
      const run = await startRun(db as any, id, { type: "shortage", variant: "baseline" }, { gateway: gw, forceFallback: true });
      assert.equal(run.status, "completed");
      const withStrategy = run.plans.filter((p) => p.strategy);
      assert.ok(withStrategy.length >= 1, "the planning run carries the coordinated strategy");
      assert.ok(run.plans.every((p) => p.checks.every((c) => c.decision !== "deny")), "no plan with a denied action is proposed");
      const top = withStrategy[0];
      assert.equal(top.metrics.minBalanceMinor, c1.selected.minBalanceMinor.toString(), "the stored plan shows the same figures as the coordinator");
      console.log(`     plan: ${top.title}`);
      console.log(`     ${top.strategy!.headline}`);
      // Replan: a counterparty refusal removes that action and the strategy is found again from what remains.
      const first = c1.selected.levers[0];
      const refusal: Constraint[] = [{ kind: first.kind, counterpartyId: first.counterpartyId, excluded: true } as Constraint];
      const c2 = coordinateForContext(await buildContext(db as any, id, null, refusal))!;
      assert.ok(!c2.selected || !c2.selected.levers.some((l) => l.kind === first.kind && l.counterpartyId === first.counterpartyId), "a refused action is not proposed again");
      console.log(`     after ${first.kind} refused: ${c2.verdict}${c2.selected ? ` (${kinds(c2.selected.levers)}, lowest ${c2.selected.minBalanceMinor})` : ""}`);
    }

    // ---- B2. Known answers carry over to a FRESH run; no history means no invented certainty; old answers expire ----
    {
      const { loadKnownConstraints } = await import("../src/actions/negotiation-memory");
      const { eq: eq2 } = await import("drizzle-orm");
      const fresh = await createDemoClone(db as any, demo!);
      for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
        const r = await docs.createDocumentAndExtract(db as any, fresh.id, { filename, kind, text: readFileSync(join("fixtures", filename), "utf8") }, { gateway: gw });
        await confirmExtraction(db as any, r.extraction.id, "Test Owner");
      }
      await createDocument(db as any, fresh.id, "bill", { counterpartyId: (await db.select().from(S.counterparties).where(eq2(S.counterparties.businessId, fresh.id))).find((c) => c.role === "supplier")!.id, number: "STRATEGY-2", issuedOn: ctx0.asOf, dueOn: inDays(21), amount: "50000.00", acknowledgeOverlaps: true });
      assert.deepEqual(await loadKnownConstraints(db as any, fresh.id), [], "no history: nothing is known");
      const r0 = await startRun(db as any, fresh.id, { type: "shortage", variant: "baseline" }, { gateway: gw, forceFallback: true });
      const p0 = r0.plans.find((p) => p.strategy)!;
      const buyerAsk0 = p0.levers.find((l) => l.kind === "buyer_request_deposit");
      assert.ok(p0.strategy!.untested!.length === p0.levers.length && (p0.strategy!.known ?? []).length === 0, "with no history every ask is labelled an assumption");
      assert.ok(!/blikelyb|probab|chance|expected to accept|odds/i.test(JSON.stringify(p0.strategy)), "no acceptance odds are claimed");
      // The buyer capped deposits at 10% in an earlier round (stored exactly as the executor stores it: a structured constraint on a run).
      const ctxF = await buildContext(db as any, fresh.id, null, []);
      const buyer = ctxF.parties.buyerId!;
      const cap: Constraint = { kind: "buyer_request_deposit", counterpartyId: buyer, excluded: false, maxPercentBps: 1000, source: "counter", round: 1 };
      await startRun(db as any, fresh.id, { type: "shortage", variant: "downside" }, { gateway: gw, forceFallback: true, replan: { parentRunId: r0.runId, round: 1, constraints: [cap] } });
      const known = await loadKnownConstraints(db as any, fresh.id);
      assert.ok(known.some((c) => c.kind === "buyer_request_deposit" && c.maxPercentBps === 1000), "the cap is remembered");
      const r1 = await startRun(db as any, fresh.id, { type: "shortage", variant: "baseline" }, { gateway: gw, forceFallback: true });
      const stored = (await db.select().from(S.agentRuns).where(eq2(S.agentRuns.id, r1.runId)))[0];
      assert.ok((stored.constraints as Constraint[]).some((c) => c.maxPercentBps === 1000), "the fresh run started from what the buyer said");
      assert.ok(r1.plans.every((p) => p.levers.every((l) => l.kind !== "buyer_request_deposit" || l.percentBps <= 1000)), "no plan repeats the deposit the buyer already capped");
      const p1 = r1.plans.find((p) => p.strategy);
      if (p1) assert.equal(p1.strategy!.verdict === "partial", BigInt(p1.metrics.minBalanceMinor) < ctxF.input.reserve, "the verdict still states whether the gap closes");
      if (p1 && p1.levers.some((l) => l.kind === "buyer_request_deposit")) assert.ok(p1.strategy!.known!.some((t) => /10%/.test(t)), "the explanation says the ask rests on what the buyer said");
      else if (p1) assert.ok(p1.strategy!.known!.some((t) => /10%/.test(t)), "the explanation names the limit that was avoided");
      assert.deepEqual(await loadKnownConstraints(db as any, fresh.id, Date.now() + 90 * 86_400_000), [], "answers older than the window expire");
      console.log(`     B2 no history: ${buyerAsk0 ? "asked the buyer for " + (buyerAsk0 as { percentBps: number }).percentBps / 100 + "%" : "no buyer deposit"}, every ask an assumption; after the buyer's 10% cap a fresh run asks at most 10%${p1 ? ` (${p1.strategy!.verdict})` : ""}; answers older than ${30} days expire`);
    }
    assert.deepEqual(await counts(), before, "nothing was signed, executed, applied for or sent");
  } finally {
    await sql.end();
  }
}

partA();
partB().then(() => console.log("strategy checks passed")).catch((e) => { console.error(e); process.exit(1); });
