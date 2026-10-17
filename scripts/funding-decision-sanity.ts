// Focused checks for the financing decision (not a test suite). Run: bun run check:funding-decision
// Part A is pure: the need (peak versus at a date), non-borrowing options, and affordability judged on the forecast rather than the headline cost.
// Part B uses a throwaway clone of the demo business: the decision agrees with the existing detector, applies for nothing, and is logged.
// All figures are inline synthetic test literals.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { buildForecast, compareOffers, decideFunding, equalInstalments, fromOffer, neededBy, summarise, type AlternativeInput, type EngineInput, type RawCandidate } from "../src/engine";
import type { CommitmentEvent } from "../src/domain/commitment-event";
import { financingOfferSchema, type FinancingOffer } from "../src/domain/financing-offer";

const input: EngineInput = {
  asOf: "2026-10-15", currency: "GBP", openingBalance: 1_000_000n, reserve: 300_000n, horizonWeeks: 13, invoices: [], bills: [],
  commitments: [{ id: "c1", name: "Wages (test)", amount: -200_000n, frequency: "weekly", nextDueOn: "2026-10-16", kind: "confirmed" }],
};
const ev = (date: string, amountMinor: bigint, label: string): CommitmentEvent => ({ date, amountMinor, currency: "GBP", label, kind: "customer_receipt", source: "manual", confidence: "medium" });
const receipt = ev("2026-12-15", 3_000_000n, "Big customer payment (test)");
const offer = (id: string, principal: string, disb: string, first: string, count: number, each: bigint, freq: "weekly" | "monthly"): FinancingOffer =>
  financingOfferSchema.parse({ id, lender: "Test lender", product: "term_loan", currency: "GBP", principalMinor: principal, upfrontFeesMinor: "0", disbursementDate: disb, repayments: equalInstalments(first, count, freq, each).map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() })) });

const alt = (id: string, extra: bigint, cost = 0n): AlternativeInput => ({
  id, actions: [`Ask a customer to pay ${extra} earlier (test)`], leverKinds: ["chase_overdue"], costMinor: cost, counterparties: 1,
  summary: summarise(buildForecast(input, { events: [receipt, ev("2026-10-22", extra, "Collected early (test)")], horizonWeeks: 13 })),
});

function candidates(offers: FinancingOffer[]): RawCandidate[] {
  const cmp = compareOffers(input, [receipt], offers, { horizonWeeks: 13 });
  return offers.map((o, i) => fromOffer(o, cmp.offers[i], [], { kind: "none", note: "n/a" }));
}

async function main() {
  const base = compareOffers(input, [receipt], [], { horizonWeeks: 13 }).doNotBorrow;
  const run = (alternatives: AlternativeInput[], offers: FinancingOffer[]) => decideFunding({ asOf: input.asOf, currency: "GBP", horizonWeeks: 13, reserveMinor: input.reserve, baseline: base, alternatives, candidates: candidates(offers) });

  // ---- A1. The need: peak versus the amount needed at a date ----
  const d0 = run([], []);
  const need = d0.need;
  assert.equal(need.peakShortfallMinor, input.reserve - base.minBalanceMinor, "peak = reserve minus the lowest balance");
  assert.ok(need.firstShortfallMinor < need.peakShortfallMinor, "what is missing in the first short week is less than the deepest gap");
  assert.equal(neededBy(need, input.asOf, need.firstShortStart!), need.peakShortfallMinor, "funding must be in by the first short week to cover the peak");
  const lastWeek = need.weeks[need.weeks.length - 1];
  assert.equal(neededBy(need, input.asOf, lastWeek.start), lastWeek.shortfallMinor, "late in the gap only what is still missing then is needed");
  assert.equal(need.zeroShortfallMinor, base.minBalanceMinor < 0n ? -base.minBalanceMinor : 0n);
  assert.equal(d0.recommendation.kind, "no_suitable_offer", "a gap, nothing to borrow and no alternative: say so");
  assert.ok(d0.recommendation.reasons.some((r) => r.includes("No funding offers")));

  // ---- A2. Affordability is the forecast, not the headline: the cheaper offer is the unaffordable one ----
  const safe = offer("Safe loan", "1200000", "2026-10-20", "2026-12-22", 2, 660_000n, "monthly"); // cost 120,000
  const cheap = offer("Cheap but heavy", "1500000", "2026-10-20", "2026-10-27", 6, 255_000n, "weekly"); // cost 30,000, repaid before the customer pays
  const d1 = run([], [safe, cheap]);
  const cs = Object.fromEntries(d1.candidates.map((c) => [c.id, c]));
  assert.ok(cs["Cheap but heavy"].totalCostMinor < cs["Safe loan"].totalCostMinor, "the heavy offer has the lower total cost");
  assert.equal(cs["Cheap but heavy"].affordability, "not_affordable");
  assert.ok(cs["Safe loan"].affordability === "affordable" || cs["Safe loan"].affordability === "affordable_with_caution");
  assert.equal(d1.candidates[0].id, "Safe loan", "ranked above the cheaper but unaffordable one");
  assert.equal(d1.recommendation.kind, "borrow");
  assert.equal(d1.recommendation.candidateId, "Safe loan");
  assert.equal(cs["Safe loan"].lowestBalanceMinor, compareOffers(input, [receipt], [safe], { horizonWeeks: 13 }).offers[0].summary.minBalanceMinor, "same figures as the existing comparison");
  // an offer that arrives after the gap starts covers only part
  const late = offer("Late money", "1200000", "2026-12-01", "2026-12-22", 2, 660_000n, "monthly");
  assert.equal(run([], [late]).candidates[0].affordability, "partly_covers");

  // ---- A3. A non-borrowing option that solves it beats borrowing; one that only helps lowers the need ----
  const solves = run([alt("collect-all", 1_000_000n)], [safe]);
  assert.equal(solves.recommendation.kind, "avoid_borrowing");
  assert.equal(solves.alternatives[0].outcome, "removes_need");
  const helps = run([alt("collect-some", 400_000n)], [safe]);
  assert.equal(helps.alternatives[0].outcome, "reduces_need");
  assert.equal(helps.recommendation.kind, "borrow");
  assert.equal(helps.recommendation.remainingNeedMinor, helps.alternatives[0].remainingShortfallMinor);
  assert.ok(helps.alternatives[0].remainingShortfallMinor < need.peakShortfallMinor);

  // ---- A4. No gap: no borrowing ----
  const fine = decideFunding({ asOf: input.asOf, currency: "GBP", horizonWeeks: 13, reserveMinor: -5_000_000n, baseline: base, alternatives: [], candidates: candidates([safe]) });
  assert.equal(fine.recommendation.kind, "no_funding_needed");
  console.log(`  A pure: peak ${need.peakShortfallMinor} vs first-week ${need.firstShortfallMinor}; cheaper heavy offer judged not affordable; avoid-borrowing, borrow, partial and no-gap outcomes`);

  // ---- B. database ----
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq, and, sql: dsql } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { assessFunding } = await import("../src/actions/funding-decision");
  const { saveFundingOffers } = await import("../src/actions/funding-store");
  const { detectShortage } = await import("../src/actions/shortage");
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");
    const { id } = await createDemoClone(db as any, demo!);
    const counts = async () => {
      const n = async (t: any) => Number((await db.select({ c: dsql<number>`count(*)` }).from(t).where(eq(t.businessId, id)))[0].c);
      return [await n(S.plans), await n(S.agentRuns), await n(S.sandboxApplications), await n(S.sandboxThreads)];
    };
    // The demo business has no gap, so add a large bill to the clone to create one.
    const { createDocument } = await import("../src/actions/ledger");
    const supplier = (await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, id))).find((c) => c.role === "supplier")!;
    const asOfNow = (await assessFunding(db as any, id)).decision.asOf;
    const inDays = (n: number) => new Date(Date.parse(`${asOfNow}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "FUND-DECISION-1", issuedOn: asOfNow, dueOn: inDays(21), amount: "900000.00", acknowledgeOverlaps: true });
    const before = await counts();
    const a1 = await assessFunding(db as any, id);
    assert.ok(a1.decision.need.needed, "the large bill creates a gap");
    const det = await detectShortage(db as any, id);
    const dn = a1.decision.need;
    assert.equal(dn.needed, det.shortage, "same verdict as the shortage detector");
    if (det.reason) assert.equal(dn.peakShortfallMinor.toString(), det.reason.shortfallMinor, "same peak shortfall as the shortage detector");
    // two saved offers dated from the balance date, one far too small to close the gap and one sized to it
    const peak = dn.peakShortfallMinor > 0n ? dn.peakShortfallMinor : 500_000n;
    const dec = (n: bigint) => `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
    const at = (n: number) => new Date(Date.parse(`${a1.decision.asOf}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await saveFundingOffers(db as any, id, { offers: [
      { id: "Small", lender: "Test lender", product: "term_loan", principal: dec(peak / 10n + 100n), upfrontFees: "0", disbursementDate: at(2), schedule: { kind: "equal", firstDate: at(60), count: 2, frequency: "monthly", amount: dec(peak / 19n + 100n) } },
      { id: "Sized", lender: "Test lender", product: "term_loan", principal: dec(peak + 100_000n), upfrontFees: "0", disbursementDate: at(2), schedule: { kind: "equal", firstDate: at(60), count: 2, frequency: "monthly", amount: dec((peak + 100_000n) / 2n + 10_000n) } },
    ] });
    const a2 = await assessFunding(db as any, id);
    const typed = a2.decision.candidates.filter((c) => c.source === "owner_entered_offer");
    assert.equal(typed.length, 2);
    for (const c of typed) assert.equal(c.route.kind, "none", "a typed offer cannot be applied for from here");
    const rec = a2.decision.recommendation;
    if (rec.candidateId) assert.ok(["affordable", "affordable_with_caution", "partly_covers"].includes(a2.decision.candidates.find((c) => c.id === rec.candidateId)!.affordability), "only an affordable or partly covering candidate is recommended");
    if (rec.kind === "avoid_borrowing") assert.equal(a2.decision.alternatives.find((a) => a.id === rec.alternativeId)!.outcome, "removes_need");
    for (const c of a2.decision.candidates) assert.ok(c.rank >= 1 && c.reasons.length > 0, "every candidate carries its reasons");
    assert.deepEqual(await counts(), before, "assessing created no plans, runs, applications or threads");
    const logs = await db.select().from(S.actionRecords).where(and(eq(S.actionRecords.businessId, id), eq(S.actionRecords.event, "funding.decision_made")));
    assert.equal(logs.length, 3, "each assessment is one log record");
    assert.ok(!JSON.stringify(logs.map((l) => l.detail)).includes("Test lender"), "lender names are not copied into the log");
    console.log([`    ${rec.headline}`, ...rec.reasons.map((r) => `      - ${r}`), `    candidates: ${a2.decision.candidates.map((c) => `${c.id}=${c.affordability}`).join(", ")}`, ...a2.decision.unavailable.map((u) => `    unavailable ${u.label}: ${u.reason}`)].join(String.fromCharCode(10)));
    console.log(`  B database: ${dn.needed ? `gap ${dn.peakShortfallMinor}` : "no gap"}; recommendation "${rec.kind}"; ${a2.decision.alternatives.length} non-borrowing option(s); ${a2.decision.candidates.length} candidate(s); nothing created, 3 log records`);

    // ---- C. with a confirmed order, the sandbox lender's invoice finance is a candidate that goes through the rescue plans ----
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
    const docs = await import("../src/ingest/documents");
    const { confirmExtraction } = await import("../src/ingest/documents/confirm");
    const gw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
    const c2 = await createDemoClone(db as any, demo!);
    for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
      const r = await docs.createDocumentAndExtract(db as any, c2.id, { filename, kind, text: readFileSync(join("fixtures", filename), "utf8") }, { gateway: gw });
      await confirmExtraction(db as any, r.extraction.id, "Test Owner");
    }
    const appsBefore = Number((await db.select({ c: dsql<number>`count(*)` }).from(S.sandboxApplications).where(eq(S.sandboxApplications.businessId, c2.id)))[0].c);
    const a3 = await assessFunding(db as any, c2.id);
    const fin = a3.decision.candidates.find((c) => c.source === "sandbox_invoice_finance");
    if (fin) {
      assert.equal(fin.termsAssumed, true, "the fee is labelled an assumption");
      assert.equal(fin.route.kind, "rescue_plan", "it proceeds through the rescue plans, not directly");
      assert.ok(fin.totalCostMinor > 0n && fin.netReceivedMinor > 0n);
    } else assert.ok(a3.decision.unavailable.some((u) => u.label === "Invoice finance"), "if invoice finance is not offered, the reason is stated");
    const appsAfter = Number((await db.select({ c: dsql<number>`count(*)` }).from(S.sandboxApplications).where(eq(S.sandboxApplications.businessId, c2.id)))[0].c);
    assert.equal(appsAfter, appsBefore, "assessing applied for nothing");
    console.log(`  C order present: ${fin ? `invoice finance is a candidate (${fin.affordability}, cost ${fin.totalCostMinor}, route ${fin.route.kind})` : "invoice finance not offered: " + a3.decision.unavailable.map((u) => u.reason).join(" ")}; recommendation "${a3.decision.recommendation.kind}"`);

    // ---- D. catalogue products become candidates: eligible, not executable, sized to the need, judged like any other; invoice finance is not duplicated ----
    const plain = (d: any) => JSON.stringify(d, (k, v) => (k === "catalogue" ? undefined : typeof v === "bigint" ? `${v}n` : v));
    // A clone with the order but NO bank history and no declared start: nothing in the catalogue is eligible, so the decision must be unchanged.
    const c3 = await createDemoClone(db as any, demo!);
    await db.delete(S.transactions).where(eq(S.transactions.businessId, c3.id));
    await db.update(S.businesses).set({ tradingSince: null }).where(eq(S.businesses.id, c3.id));
    for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
      const r = await docs.createDocumentAndExtract(db as any, c3.id, { filename, kind, text: readFileSync(join("fixtures", filename), "utf8") }, { gateway: gw });
      await confirmExtraction(db as any, r.extraction.id, "Test Owner");
    }
    const none1 = await assessFunding(db as any, c3.id);
    const none0 = await assessFunding(db as any, c3.id, { catalogue: false });
    assert.ok(none1.decision.need.needed, "there is a real gap");
    assert.equal(plain(none1.decision), plain(none0.decision), "nothing eligible in the catalogue (no bank history): the decision is unchanged");
    assert.ok(none1.decision.candidates.every((c) => c.source !== "catalogue"));
    const withCat = (await assessFunding(db as any, c2.id)).decision;
    const without = (await assessFunding(db as any, c2.id, { catalogue: false })).decision;
    const cat = withCat.candidates.filter((c) => c.source === "catalogue");
    assert.ok(cat.length >= 1, "an eligible catalogue loan appears as a candidate");
    for (const c of cat) {
      assert.ok(c.indicative === true && c.catalogue!.verdict === "eligible" && c.route.kind === "none" && c.termsAssumed);
      assert.ok(c.reasons.length > 0 && c.rank >= 1 && ["affordable", "affordable_with_caution", "partly_covers", "not_affordable"].includes(c.affordability), "judged week by week like the others");
      assert.ok(c.catalogue!.productId !== "ifin-clearwater" && c.product !== "invoice_finance", "invoice finance is not added a second time");
    }
    const sandboxFin = withCat.candidates.find((c) => c.source === "sandbox_invoice_finance");
    assert.ok(sandboxFin && sandboxFin.catalogue && sandboxFin.catalogue.productId === "ifin-clearwater", "the catalogue verdict is attached to the existing invoice-finance option");
    assert.equal(withCat.candidates.filter((c) => /invoice/i.test(c.product)).length, 1, "exactly one invoice-finance option");
    const order = (d: any) => d.candidates.filter((c: any) => c.source !== "catalogue").map((c: any) => c.id).join(",");
    assert.equal(order(withCat), order(without), "the existing candidates keep their relative order");
    assert.equal(plain(withCat.alternatives), plain(without.alternatives), "non-borrowing options are unchanged");
    console.log(`  D catalogue: ${cat.length} eligible product(s) judged beside ${withCat.candidates.length - cat.length} existing candidate(s); ranking: ${withCat.candidates.map((c) => `#${c.rank} ${c.label} (${c.source}, ${c.affordability})`).join("; ")}; recommendation "${withCat.recommendation.kind}"`);
  } finally {
    await sql.end();
  }
  console.log("funding decision checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
