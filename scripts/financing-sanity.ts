// Financing comparison check: one happy path against a hand calculation, one failure path. Pure engine, no database.
// All figures below are inline synthetic test literals, not app data.
import assert from "node:assert/strict";
import { buildForecast, checkContract, compareOffers, costOf, effectiveAnnualRateBps, equalInstalments, offerEvents, splitTotal, totalFromFactorRate, type EngineInput } from "../src/engine";
import { financingOfferSchema, financingOffersSchema, type FinancingOffer } from "../src/domain/financing-offer";

const input: EngineInput = {
  asOf: "2026-10-15", currency: "GBP", openingBalance: 1_000_000n, reserve: 0n, horizonWeeks: 13,
  invoices: [], bills: [],
  commitments: [{ id: "c1", name: "Wages (test)", amount: -200_000n, frequency: "weekly", nextDueOn: "2026-10-16", kind: "confirmed" }],
};

const loan: FinancingOffer = financingOfferSchema.parse({
  id: "Loan A", lender: "Test lender A", product: "term_loan", currency: "GBP", principalMinor: "2000000", upfrontFeesMinor: "100000", disbursementDate: "2026-10-20",
  repayments: equalInstalments("2026-10-27", 8, "weekly", 275_000n).map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() })),
});

async function main() {
  // ---- Happy path: hand calculation ----
  // Net received 2,000,000 - 100,000 = 1,900,000. Repaid 8 x 275,000 = 2,200,000. Cost 300,000 = 15.00% of the amount advanced.
  // Balance-days: net x (36 x 275,000 / 2,200,000) x 7 = 59,850,000. Annualised = 300,000 x 365 x 10,000 / 59,850,000 = 18,295.7 -> 18,296 bps.
  const c = costOf(loan);
  assert.equal(c.netReceivedMinor, 1_900_000n);
  assert.equal(c.totalRepaymentMinor, 2_200_000n);
  assert.equal(c.totalCostMinor, 300_000n);
  assert.equal(c.costOfAmountBps, 1500);
  assert.equal(c.annualisedCostBps, 18296);
  assert.equal(c.termDays, 56);

  const cmp = compareOffers(input, [], [loan], { horizonWeeks: 13, maxAnnualisedCostBps: 5000 });
  // Not borrowing: 1,000,000 - 13 x 200,000 = -1,600,000 at week 13, and the first negative week is week 6 (1,000,000 - 6 x 200,000 < 0 at the sixth Friday).
  const base = buildForecast(input, { events: [], horizonWeeks: 13 });
  assert.equal(cmp.doNotBorrow.minBalanceMinor, base.minimum.amount);
  assert.equal(cmp.doNotBorrow.minBalanceMinor, -1_600_000n);
  assert.equal(cmp.borrowingNeeded, true);

  // The offer's effect equals an independent forecast built from hand-written events.
  const hand = [{ date: "2026-10-20", amountMinor: 1_900_000n, currency: "GBP", label: "adv", kind: "financing" as const, source: "manual" as const, confidence: "medium" as const },
    ...Array.from({ length: 8 }, (_, i) => ({ date: `2026-${i < 1 ? "10-27" : ["11-03", "11-10", "11-17", "11-24", "12-01", "12-08", "12-15"][i - 1]}`, amountMinor: -275_000n, currency: "GBP", label: "rep", kind: "financing" as const, source: "manual" as const, confidence: "medium" as const }))];
  const f = buildForecast(input, { events: hand, horizonWeeks: 13 });
  assert.equal(cmp.offers[0].summary.minBalanceMinor, f.minimum.amount);
  assert.equal(cmp.offers[0].lowestBalanceImprovementMinor, f.minimum.amount - cmp.doNotBorrow.minBalanceMinor);
  assert.equal(offerEvents(loan).length, 9);
  assert.equal(cmp.offers[0].withinCostCap, false, "182.96% is above the 50% cap");
  assert.ok(cmp.offers[0].warnings.some((w) => w.includes("above your limit")));
  assert.equal(cmp.offers[0].stacking.peakWeeklyRepaymentMinor, 275_000n);
  console.log(`  happy: cost 3,000.00 (15.00% of the amount), estimated annualised ${c.annualisedCostBps / 100}%, lowest balance ${cmp.doNotBorrow.minBalanceMinor} -> ${cmp.offers[0].summary.minBalanceMinor} minor units, equal to an independent forecast`);

  // ---- Failure path ----
  const bad = financingOfferSchema.safeParse({ ...JSON.parse(JSON.stringify({ id: "Bad", lender: "X", product: "other", currency: "GBP", principalMinor: "100000", disbursementDate: "2026-10-20", repayments: [{ date: "2026-11-20", amountMinor: "99000" }] })) });
  assert.equal(bad.success, false, "repaying less than received is rejected");
  assert.equal(financingOfferSchema.safeParse({ id: "B2", lender: "X", product: "other", currency: "GBP", principalMinor: "100000", disbursementDate: "2026-10-20", repayments: [{ date: "2026-10-01", amountMinor: "120000" }] }).success, false, "repayment before the advance is rejected");
  assert.equal(financingOfferSchema.safeParse({ id: "B3", lender: "X", product: "other", currency: "GBP", principalMinor: "100000", upfrontFeesMinor: "100000", disbursementDate: "2026-10-20", repayments: [{ date: "2026-11-20", amountMinor: "120000" }] }).success, false, "fees equal to the advance are rejected");
  const dup = financingOffersSchema.safeParse([loan, loan].map((o) => ({ ...o, principalMinor: o.principalMinor.toString(), upfrontFeesMinor: o.upfrontFeesMinor.toString(), repayments: o.repayments.map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() })) })));
  assert.equal(dup.success, false, "duplicate ids are rejected");
  const usd = { ...loan, id: "Loan USD", currency: "USD" };
  assert.throws(() => compareOffers(input, [], [usd], { horizonWeeks: 13 }), /USD/);

  // Two offers: ranking by estimated annualised cost, and the stacking warning when both are taken.
  const cheap: FinancingOffer = financingOfferSchema.parse({ id: "Loan B", lender: "Test lender B", product: "term_loan", currency: "GBP", principalMinor: "2000000", disbursementDate: "2026-10-20",
    repayments: equalInstalments("2026-11-20", 4, "monthly", 520_000n).map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() })) });
  const two = compareOffers(input, [], [loan, cheap], { horizonWeeks: 13 });
  assert.deepEqual(two.cheapestFirst, ["Loan B", "Loan A"]);
  assert.ok(two.offers[0].lowestBalanceImprovementMinor < 0n, "Loan A is repaid inside the window, so it makes the lowest balance worse");
  assert.ok(two.offers[1].lowestBalanceImprovementMinor > 0n, "Loan B is mostly repaid after the window, so it improves the lowest balance");
  assert.ok(two.allTogether, "combined view exists for two offers");
  assert.ok(two.allTogether.stacking.peakWeeklyRepaymentMinor >= 275_000n);
  console.log(`  failure: bad offers rejected (under-repaying, repayment before the advance, fees >= advance, duplicate ids, wrong currency); ranking ${two.cheapestFirst.join(" < ")}`);
  // ---- Added in the research update ----
  // Effective annual rate: borrow 10,000.00 and repay 11,000.00 exactly 365 days later = 10.00% a year = 1000 bps (hand value).
  assert.equal(effectiveAnnualRateBps([{ date: "2026-01-01", amountMinor: 1_000_000n }, { date: "2027-01-01", amountMinor: -1_100_000n }]), 1000);
  // Two annual halves: borrow 1,000,000; repay 600,000 at 365 days and 600,000 at 730 days. NPV(r) = 0 at r = 20.0% (1.2 -> 500,000 + 416,667 = 916,667?) so verify by NPV instead.
  const irr = effectiveAnnualRateBps([{ date: "2026-01-01", amountMinor: 1_000_000n }, { date: "2027-01-01", amountMinor: -600_000n }, { date: "2028-01-01", amountMinor: -600_000n }]) as number;
  const r = irr / 10000;
  const npv = 1_000_000 - 600_000 / (1 + r) - 600_000 / Math.pow(1 + r, 730 / 365);
  assert.ok(Math.abs(npv) < 50, `rate ${irr} bps makes the present value of the repayments equal the advance (off by ${npv.toFixed(2)} minor units)`);
  assert.equal(effectiveAnnualRateBps([{ date: "2026-01-01", amountMinor: 100_000n }, { date: "2026-01-02", amountMinor: -300_000n }]), null, "a one-day term that triples compounds to a meaningless figure");
  // Loan A: the solved rate must make the present value of its repayments equal the money received (independent check), and compounding over a
  // 56-day term must exceed the simple average-balance figure.
  const rA = (c.effectiveAnnualRateBps as number) / 10000;
  const t0 = "2026-10-20";
  const pvA = loan.repayments.reduce((acc, x) => acc + Number(x.amountMinor) / Math.pow(1 + rA, (Date.parse(x.date) - Date.parse(t0)) / 86_400_000 / 365), 0);
  assert.ok(Math.abs(pvA - 1_900_000) < 100, `Loan A rate ${c.effectiveAnnualRateBps} bps: present value of repayments ${pvA.toFixed(2)} vs 1,900,000 received`);
  assert.ok((c.effectiveAnnualRateBps as number) > c.annualisedCostBps, "compounded rate is above the simple annualised figure for a short term");
  assert.ok(cmp.offers[0].warnings.every((w) => !w.includes("NaN")));

  // Factor rate and exact splitting: 1.35 x 10,000.00 = 13,500.00; 7 instalments sum exactly with the remainder on the last.
  assert.equal(totalFromFactorRate(1_000_000n, 1350), 1_350_000n);
  const parts = splitTotal("2026-11-02", 7, "weekly", 1_350_000n);
  assert.equal(parts.reduce((a, x) => a + x.amountMinor, 0n), 1_350_000n);
  assert.equal(parts[0].amountMinor, 192_857n);
  assert.equal(parts[6].amountMinor, 192_858n);
  assert.throws(() => totalFromFactorRate(1_000_000n, 900), /factor rate/);

  // Debt service coverage: receipts 3,000.00 a week against wages 2,000.00 give operating cash flow 13,000.00 over 13 weeks.
  // Loan B repays 2 x 5,200.00 inside the window = 10,400.00 -> 1.25 exactly (no warning). Loan A repays 8 x 2,750.00 = 22,000.00 -> 0.59 (warning).
  const withReceipts: EngineInput = { ...input, commitments: [...input.commitments, { id: "c2", name: "Receipts (test)", amount: 300_000n, frequency: "weekly", nextDueOn: "2026-10-16", kind: "confirmed" }] };
  const d = compareOffers(withReceipts, [], [loan, cheap], { horizonWeeks: 13 });
  const [a, b] = [d.offers.find((o) => o.offerId === "Loan A")!, d.offers.find((o) => o.offerId === "Loan B")!];
  assert.equal(a.dscr.operatingCashFlowMinor, 1_300_000n);
  assert.equal(a.dscr.debtServiceMinor, 2_200_000n);
  assert.equal(a.dscr.ratioX100, 59);
  assert.equal(a.dscr.warn, true);
  assert.equal(b.dscr.debtServiceMinor, 1_040_000n);
  assert.equal(b.dscr.ratioX100, 125);
  assert.equal(b.dscr.warn, false, "exactly the minimum is not a warning");
  assert.ok(b.repaymentsAfterWindowMinor === 1_040_000n, "Loan B has 2 of 4 repayments after the window");
  assert.ok(b.warnings.some((w) => w.includes("fall after")));
  assert.equal(d.allTogether!.dscr.debtServiceMinor, 3_240_000n);
  assert.ok(d.allTogether!.warnings.length === 1);
  // Financing already planned counts as debt service but is not operating cash flow.
  const planned = [{ date: "2026-11-03", amountMinor: -100_000n, currency: "GBP", label: "existing loan", kind: "financing" as const, source: "manual" as const, confidence: "high" as const }];
  const e = compareOffers(withReceipts, planned, [cheap], { horizonWeeks: 13 });
  assert.equal(e.offers[0].dscr.debtServiceMinor, 1_140_000n);
  assert.equal(e.offers[0].dscr.operatingCashFlowMinor, 1_300_000n);
  console.log("  research update: effective annual rate (10.00% exact case, present-value check), factor-rate and exact split helpers, debt service coverage (0.59 warns, 1.25 passes), repayments after the window flagged, planned financing counted");
  // Signed amount cap, and the contract-versus-offer check.
  const capped = compareOffers(input, [], [loan], { horizonWeeks: 13, maxAmountMinor: 1_500_000n });
  assert.equal(capped.offers[0].withinAmountCap, false, "20,000.00 is above a 15,000.00 limit");
  assert.ok(capped.offers[0].warnings.some((w) => w.includes("funding limit you signed")));
  assert.equal(compareOffers(input, [], [loan], { horizonWeeks: 13, maxAmountMinor: 2_000_000n }).offers[0].withinAmountCap, true, "exactly the limit is allowed");
  assert.equal(compareOffers(input, [], [loan], { horizonWeeks: 13 }).offers[0].withinAmountCap, null, "no limit signed");

  assert.equal(checkContract(loan, loan).matches, true, "an identical contract matches");
  const dearer = { ...loan, upfrontFeesMinor: 150_000n };
  const chk = checkContract(loan, dearer);
  const feeDiff = chk.differences.find((d) => d.field === "upfront_fees");
  assert.ok(feeDiff && feeDiff.worse === true, "a higher upfront fee costs more");
  assert.equal(chk.extraCostMinor, 50_000n, "500.00 more in fees = 500.00 more cost");
  assert.ok(chk.worseCount >= 1 && chk.needsAttention);
  const slipped = { ...loan, repayments: loan.repayments.map((r, i) => (i === 0 ? { ...r, date: "2026-10-26" } : r)) };
  const slip = checkContract(loan, slipped).differences[0];
  assert.deepEqual([slip.field, slip.paymentNumber, slip.offered, slip.contract, slip.worse], ["payment", 1, "2026-10-27", "2026-10-26", true], "an earlier first payment is worse for the owner");
  const shorter = { ...loan, repayments: loan.repayments.slice(0, 7) };
  assert.ok(checkContract(loan, shorter).differences.some((d) => d.field === "payment_count" && d.worse === null), "a different number of payments needs a look");
  assert.throws(() => checkContract(loan, { ...loan, currency: "USD" }), /USD/);
  console.log("  caps and contract: amount cap flags and allows exactly the limit; identical contract matches; higher fee, earlier payment and fewer payments are all caught");
  console.log("financing sanity: ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
