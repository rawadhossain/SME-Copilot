// Focused checks for financing-option matching (not a test suite). Run: bun run check:matching
// Part A is pure: thresholds, near misses, hand-computed sizing and cost figures, ranking, determinism, the profile from raw inputs.
// Part B uses the seeded demo business (profile equals an independent SQL recomputation; the action equals the pure functions) and a throwaway clone
// (same need as assessFunding, nothing changes but one log record). All figures are inline synthetic test literals.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { costOf, deriveBusinessProfile, instalmentMinor, matchProducts, type BusinessProfile, type InvoiceRecord } from "../src/engine";
import { LENDER_CATALOGUE } from "../src/domain/lender-catalogue";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const P = (o: Partial<BusinessProfile> = {}): BusinessProfile => ({
  asOf: "2026-10-15", currency: "GBP", firstTransactionOn: "2025-10-01", tradingSince: null, monthsOfHistory: 12, historySource: "bank_statement", bankMonthsOfHistory: 12, declaredMonthsOfHistory: null, annualisedTurnoverMinor: 42_000_000n, turnoverAnnualisedFromShortHistory: false,
  averageMonthlyTurnoverMinor: 3_500_000n, customerReceiptsMinor: 42_000_000n, historyDays: 380, openReceivablesMinor: 5_000_000n, openInvoiceCount: 5,
  overdueOver30ShareBps: 1000, topCustomerShareBps: 4000, topCustomerName: "Acme (test)", confirmedOrder: null, ...o,
});
const one = (profile: BusinessProfile, id: string, need: bigint | null = null) => matchProducts(profile, LENDER_CATALOGUE, need).results.find((r) => r.productId === id)!;

function partA() {
  // The catalogue is synthetic, fictional and labelled.
  assert.equal(LENDER_CATALOGUE.length, 6);
  for (const p of LENDER_CATALOGUE) assert.ok(p.synthetic && p.notice === "Indicative terms from a synthetic catalogue, not a quote." && p.lenderName.includes("(SYNTHETIC)"));

  // A1. Thresholds: exactly at passes; one under fails with the right figures; near miss versus not eligible.
  assert.equal(one(P({ monthsOfHistory: 6 }), "ifin-clearwater").verdict, "eligible", "exactly 6 months passes");
  const five = one(P({ monthsOfHistory: 5 }), "ifin-clearwater");
  assert.equal(five.verdict, "near_miss");
  assert.ok(five.reason.includes("needs 6 months of history; you have 5."), five.reason);
  const four = one(P({ monthsOfHistory: 4 }), "ifin-clearwater");
  assert.equal(four.verdict, "not_eligible", "4 of 6 months is a 33% miss");
  assert.ok(four.reason.includes("Needs 6 months of history; you have 4."));
  assert.equal(four.offer, null, "no offer for a product the business is not eligible for");
  assert.equal(one(P({ overdueOver30ShareBps: 3500 }), "ifin-clearwater").verdict, "eligible", "35.00% overdue is exactly the limit");
  const over = one(P({ overdueOver30ShareBps: 3501 }), "ifin-clearwater");
  assert.equal(over.verdict, "near_miss");
  assert.ok(over.reason.includes("yours is 35.01%"), over.reason);
  assert.equal(one(P({ overdueOver30ShareBps: 4375 }), "ifin-clearwater").verdict, "near_miss", "exactly 25% over the limit is still a near miss");
  assert.equal(one(P({ overdueOver30ShareBps: 4376 }), "ifin-clearwater").verdict, "not_eligible", "one basis point more is not");
  assert.equal(one(P({ monthsOfHistory: 5, openInvoiceCount: 2 }), "ifin-clearwater").verdict, "not_eligible", "two failed criteria is never a near miss");
  assert.equal(one(P({ openInvoiceCount: 0, openReceivablesMinor: 0n, topCustomerShareBps: 0, overdueOver30ShareBps: 0 }), "ifin-clearwater").criteria.find((c) => c.id === "top_customer_share")!.status, "not_applicable");

  // A2. Hand figure, invoice finance: GBP 50,000.00 open x 80% = GBP 40,000.00 qualifying. A need of 12,345.00 is rounded up to the GBP 100 step: 12,400.00.
  // Invoices behind it = 12,400.00 / 0.8 = 15,500.00; fee 2% of that = 310.00, taken from the advance; the cost is exactly that fee.
  const ifin = one(P(), "ifin-clearwater", 1_234_500n);
  assert.equal(ifin.maxQualifyingMinor, 4_000_000n);
  assert.equal(ifin.sizedAmountMinor, 1_240_000n);
  assert.equal(ifin.coversNeed, true);
  assert.equal(ifin.offer!.upfrontFeesMinor, 31_000n);
  assert.equal(ifin.netReceivedMinor, 1_209_000n);
  assert.equal(ifin.totalCostMinor, 31_000n);
  assert.equal(ifin.totalCostMinor, costOf(ifin.offer!).totalCostMinor, "cost comes from the existing engine");
  assert.equal(ifin.executable, true);
  const big = one(P(), "ifin-clearwater", 6_000_000n);
  assert.equal(big.sizedAmountMinor, 4_000_000n, "a need above what the business qualifies for is sized to the maximum");
  assert.equal(big.coversNeed, false);

  // A3. Hand figures: turnover cap = 2 months of GBP 420,000.00 a year = 70,000.00; a factor-rate advance of 10,000.00 x 1.25 costs exactly 2,500.00;
  // 12,000.00 at 12% a year over 12 months is 1,066.19 a month (standard annuity figure).
  assert.equal(one(P(), "wcl-fenwick").maxQualifyingMinor, 7_000_000n);
  assert.equal(one(P(), "rcf-marlowe").maxQualifyingMinor, 10_500_000n, "3 months of turnover");
  assert.equal(instalmentMinor(1_200_000n, 1200, 12, 0), 106_619n);
  const rev = one(P(), "rev-quickfern");
  assert.equal(rev.sizedAmountMinor, 1_000_000n, "no need: the product's default amount");
  assert.equal(rev.coversNeed, null);
  assert.equal(rev.totalCostMinor, 250_000n);
  const seas = one(P({ monthsOfHistory: 24 }), "seas-quarterbright", 4_000_000n);
  assert.equal(seas.verdict, "eligible");
  assert.equal(seas.offer!.repayments.length, 9, "12 months with a 3-month holiday: 9 instalments");
  assert.equal(seas.offer!.repayments[0].date, "2027-02-21", "first repayment after the holiday (disbursed 2026-10-21)");
  const line = one(P(), "rcf-marlowe", 3_000_000n);
  assert.equal(line.offer!.principalMinor, 3_000_000n, "the line is drawn only for the need");
  assert.equal(line.offer!.upfrontFeesMinor, 15_000n, "0.5% arrangement fee on the 30,000.00 limit");

  // A4. Ranking on a mix of verdicts, with a near miss; deterministic.
  const mix = P({ monthsOfHistory: 12 });
  const a = matchProducts(mix, LENDER_CATALOGUE, 3_000_000n);
  assert.equal(json(a), json(matchProducts(mix, LENDER_CATALOGUE, 3_000_000n)), "same inputs, identical result");
  const tier = { eligible: 0, near_miss: 1, not_eligible: 2 } as const;
  assert.deepEqual(a.results.map((r) => r.rank), a.results.map((_, i) => i + 1));
  for (let i = 1; i < a.results.length; i++) assert.ok(tier[a.results[i - 1].verdict] <= tier[a.results[i].verdict], "eligible, then near miss, then not eligible");
  const elig = a.results.filter((r) => r.verdict === "eligible");
  assert.ok(elig.length >= 3 && a.results.some((r) => r.verdict === "not_eligible"), "the profile gives a mix");
  for (let i = 1; i < elig.length; i++) assert.ok(elig[i - 1].totalCostMinor! <= elig[i].totalCostMinor!, "among those that cover the need, cheaper first");
  assert.equal(a.results.find((r) => r.productId === "ordfin-tallowrow")!.verdict, "not_eligible", "no confirmed order");
  const nm = matchProducts(P({ monthsOfHistory: 5 }), LENDER_CATALOGUE, 3_000_000n).results;
  const nmIdx = nm.findIndex((r) => r.productId === "ifin-clearwater");
  assert.equal(nm[nmIdx].verdict, "near_miss");
  assert.ok(nm.slice(0, nmIdx).every((r) => r.verdict === "eligible") && nm.slice(nmIdx + 1).every((r) => r.verdict !== "eligible"), "the near miss ranks after every eligible product");
  const wide = matchProducts(mix, LENDER_CATALOGUE, 9_000_000n).results.filter((r) => r.verdict === "eligible");
  assert.equal(wide[0].productId, "rcf-marlowe", "the only product that can cover 90,000.00 ranks first");
  assert.ok(wide.slice(1).every((r) => r.coversNeed === false));
  assert.ok(matchProducts(P({ currency: "USD" }), LENDER_CATALOGUE, null).results.every((r) => r.verdict === "not_eligible"), "a catalogue in GBP does not match USD books");
  for (const r of a.results) assert.ok(r.indicative && r.synthetic && r.notice.includes("not a quote"));

  // A5. The profile from raw inputs: months, trailing receipts (transfers, lender money and later dates left out), open receivables, concentration.
  const tx = (postedOn: string, amount: bigint, description: string, counterpartyRole: any) => ({ postedOn, amount, description, counterpartyRole });
  const txs = [
    tx("2026-04-15", -10_000n, "Rent", null), tx("2026-05-01", 1_000_000n, "Payment from customer", "customer"), tx("2026-09-01", 2_000_000n, "Payment from customer", "customer"),
    tx("2026-06-01", 500_000n, "Transfer from savings", null), tx("2026-07-01", 700_000n, "Loan advance", "lender"), tx("2026-11-01", 9_900n, "Payment from customer", "customer"),
  ];
  const inv = (id: string, cp: string, amount: bigint, dueOn: string, extra: Partial<InvoiceRecord> = {}): InvoiceRecord => ({ id, number: id, counterpartyId: cp, counterpartyName: `Customer ${cp} (test)`, issuedOn: "2026-08-01", dueOn, amount, status: "open", ...extra });
  const invs = [
    inv("A", "c1", 600_000n, "2026-09-01"), inv("B", "c1", 500_000n, "2026-10-20", { outstanding: 200_000n }), inv("C", "c2", 200_000n, "2026-10-10"),
    inv("D", "c2", 900_000n, "2026-08-01", { status: "paid" }), inv("E", "c2", 900_000n, "2026-10-01", { countedIn: "order:x" }),
  ];
  const orders = [{ valueMinor: 4_000_000n, receiptDate: "2026-12-01", customerName: "Northgate (test)" }, { valueMinor: 9_000_000n, receiptDate: "2026-12-15", customerName: "Northgate (test)" }];
  const prof = deriveBusinessProfile({ asOf: "2026-10-15", currency: "GBP", transactions: txs, invoices: invs, orders });
  assert.equal(prof.monthsOfHistory, 6, "2026-04-15 to 2026-10-15 is exactly 6 whole months");
  assert.equal(deriveBusinessProfile({ asOf: "2026-10-15", currency: "GBP", transactions: [tx("2026-04-16", 1n, "x", null)], invoices: [], orders: [] }).monthsOfHistory, 5, "one day short of 6 months");
  assert.equal(prof.customerReceiptsMinor, 3_000_000n);
  assert.equal(prof.historyDays, 184);
  assert.equal(prof.annualisedTurnoverMinor, 5_951_086n, "3,000,000 x 365 / 184, rounded down");
  assert.ok(prof.turnoverAnnualisedFromShortHistory);
  assert.equal(prof.openReceivablesMinor, 1_000_000n, "600,000 + 200,000 outstanding + 200,000; paid and counted-elsewhere left out");
  assert.equal(prof.openInvoiceCount, 3);
  assert.equal(prof.overdueOver30ShareBps, 6000);
  assert.equal(prof.topCustomerShareBps, 8000);
  assert.deepEqual(prof.confirmedOrder, { count: 2, largestValueMinor: 9_000_000n, customerName: "Northgate (test)", receiptDate: "2026-12-15" });
  // A6. Declared trading start: the earlier of declared and bank wins; turnover and receivables never use it; the history row says so.
  const declaredIn = (d: string | null) => deriveBusinessProfile({ asOf: "2026-10-15", currency: "GBP", transactions: txs, invoices: invs, orders, tradingSince: d });
  const dec = declaredIn("2021-03-01");
  assert.equal(dec.historySource, "declared");
  assert.equal(dec.monthsOfHistory, 67, "2021-03-01 to 2026-10-15 is 67 whole months");
  assert.equal(dec.declaredMonthsOfHistory, 67);
  assert.equal(dec.bankMonthsOfHistory, 6, "the bank window alone is still reported");
  assert.equal(dec.annualisedTurnoverMinor, prof.annualisedTurnoverMinor, "declared history never changes turnover");
  assert.equal(dec.openReceivablesMinor, prof.openReceivablesMinor);
  assert.ok(dec.turnoverAnnualisedFromShortHistory, "still flagged: turnover is estimated from 6 months of bank data");
  const later = declaredIn("2026-06-01");
  assert.equal(later.historySource, "bank_statement", "a declared date later than the first bank transaction does not shorten history");
  assert.equal(later.monthsOfHistory, 6);
  assert.equal(declaredIn("2027-01-01").historySource, "bank_statement", "a declared date after as-of is ignored by the pure function");
  const hist = one(dec, "ifin-clearwater").criteria.find((c) => c.id === "history_months")!;
  assert.equal(hist.note, "Declared by the owner, not verified.");
  assert.equal(one(P({ historySource: "declared", monthsOfHistory: 4 }), "ifin-clearwater").criteria.find((c) => c.id === "history_months")!.reason, "Needs 6 months of history; you have 4 (declared by you, not verified).");
  console.log("  A pure: thresholds and near misses, hand-computed sizing/cost/instalment figures, ranking, determinism, profile from raw inputs");
}

async function partB() {
  const { db, sql } = await import("../src/db");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { createDocument } = await import("../src/actions/ledger");
  const { assessFunding } = await import("../src/actions/funding-decision");
  const { computeFundingMatch, matchFunding } = await import("../src/actions/funding-match");
  const S = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");

    // B1. The demo's derived profile equals an independent recomputation straight from SQL.
    const m = await computeFundingMatch(db as any, demo!);
    const asOf = m.profile.asOf;
    const [h] = await sql`select min(posted_on)::text as first, (extract(year from age(${asOf}::date, min(posted_on))) * 12 + extract(month from age(${asOf}::date, min(posted_on))))::int as months, (select trading_since::text from businesses where id = ${demo}) as declared from transactions where business_id = ${demo}`;
    const [r] = await sql`select coalesce(sum(t.amount_minor), 0)::text as s from transactions t join counterparties c on c.id = t.counterparty_id where t.business_id = ${demo} and c.role = 'customer' and t.amount_minor > 0 and t.posted_on <= ${asOf}::date and t.description !~* '\\m(transfer|own account|internal|sweep)\\M'`;
    const open = await sql`select i.customer_id, sum(i.amount_minor - coalesce(p.s, 0))::text as owed, sum(case when ${asOf}::date - i.due_on > 30 then i.amount_minor - coalesce(p.s, 0) else 0 end)::text as late, count(*)::int as n
      from invoices i left join (select invoice_id, sum(amount_minor) s from document_payments where voided_at is null and paid_on <= ${asOf}::date group by invoice_id) p on p.invoice_id = i.id
      where i.business_id = ${demo} and i.status not in ('paid', 'void', 'draft') and i.counted_in is null and i.amount_minor - coalesce(p.s, 0) > 0 group by i.customer_id`;
    const total = open.reduce((a: bigint, x: any) => a + BigInt(x.owed), 0n);
    const late = open.reduce((a: bigint, x: any) => a + BigInt(x.late), 0n);
    const top = open.reduce((a: bigint, x: any) => (BigInt(x.owed) > a ? BigInt(x.owed) : a), 0n);
    const days = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${h.first}T00:00:00Z`)) / 86_400_000) + 1;
    const pr = m.profile;
    assert.equal(pr.firstTransactionOn, h.first);
    const [dm] = h.declared ? await sql`select (extract(year from age(${asOf}::date, ${h.declared}::date)) * 12 + extract(month from age(${asOf}::date, ${h.declared}::date)))::int as months` : [{ months: h.months }];
    assert.equal(pr.bankMonthsOfHistory, h.months, "months covered by the bank statement");
    assert.equal(pr.monthsOfHistory, Math.max(h.months, dm.months), "months of history: the earlier of declared and bank");
    assert.equal(pr.historySource, h.declared && h.declared < h.first ? "declared" : "bank_statement");
    assert.equal(pr.customerReceiptsMinor.toString(), r.s, "customer receipts over the history");
    assert.equal(pr.annualisedTurnoverMinor, (BigInt(r.s) * 365n) / BigInt(days), "annualised turnover");
    assert.equal(pr.openReceivablesMinor, total, "open receivables");
    assert.equal(pr.openInvoiceCount, open.reduce((a: number, x: any) => a + x.n, 0));
    assert.equal(pr.overdueOver30ShareBps, Number((late * 10_000n) / total), "share more than 30 days overdue");
    assert.equal(pr.topCustomerShareBps, Number((top * 10_000n) / total), "largest customer's share");

    // B2. The action's result equals the pure functions on that profile and the same need.
    assert.equal(json(m.match), json(matchProducts(m.profile, LENDER_CATALOGUE, m.need.needed ? m.need.amountMinor : null)), "the action adds nothing to the pure matcher");
    console.log(`  B1/B2 demo as of ${asOf}: ${pr.monthsOfHistory} months of history, yearly receipts ${pr.annualisedTurnoverMinor}${pr.turnoverAnnualisedFromShortHistory ? " (scaled up)" : ""}, open receivables ${pr.openReceivablesMinor} in ${pr.openInvoiceCount} invoices, ${pr.overdueOver30ShareBps / 100}% over 30 days, largest customer ${pr.topCustomerShareBps / 100}%; need ${m.need.needed ? m.need.amountMinor : "none"}`);
    for (const x of m.match.results) console.log(`    #${x.rank} ${x.productId} ${x.verdict}${x.sizedAmountMinor !== null ? ` | sized ${x.sizedAmountMinor}${x.coversNeed === false ? " (below need)" : ""}, cost ${x.totalCostMinor}` : ""} | ${x.reason}`);

    // B3. On a clone with a real gap: the same need as assessFunding; the match changes no table but adds exactly one log record.
    const { id } = await createDemoClone(db as any, demo!);
    await createDocument(db as any, id, "bill", { counterpartyId: (await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, id))).find((c) => c.role === "supplier")!.id, number: "MATCH-1", issuedOn: asOf, dueOn: new Date(Date.parse(`${asOf}T00:00:00Z`) + 21 * 86_400_000).toISOString().slice(0, 10), amount: "60000.00", acknowledgeOverlaps: true });
    const decision = (await assessFunding(db as any, id)).decision;
    assert.ok(decision.need.needed);
    const tables = (await sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'business_id' and table_name <> 'action_records' order by table_name`).map((x: any) => x.table_name as string);
    const fingerprint = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) { const [x] = await sql`select count(*)::int as n, coalesce(md5(string_agg(x::text, ',' order by x::text)), '') as h from ${sql(t)} x where business_id = ${id}`; out[t] = `${x.n}:${x.h}`; }
      return out;
    };
    const logs = async () => Number((await sql`select count(*)::int as n from action_records where business_id = ${id}`)[0].n);
    const before = await fingerprint();
    const logBefore = await logs();
    const res = await matchFunding(db as any, id);
    assert.equal(res.need.amountMinor, decision.need.peakShortfallMinor, "the same need as assessFunding");
    assert.equal(res.match.needMinor, decision.need.peakShortfallMinor);
    for (const x of res.match.results) if (x.sizedAmountMinor !== null) assert.equal(x.coversNeed, x.sizedAmountMinor >= res.need.amountMinor, "coversNeed says whether the sized amount reaches the need");
    assert.deepEqual(await fingerprint(), before, "no table of the business changed");
    assert.equal((await logs()) - logBefore, 1, "exactly one log record");
    const [last] = await sql`select event, detail from action_records where business_id = ${id} order by chain_seq desc limit 1`;
    assert.equal(last.event, "funding.matched");
    assert.ok(!JSON.stringify(last.detail).includes("SYNTHETIC") && last.detail.matchHash.length === 64, "ids, verdicts and a hash only; no lender or free text");

    // B3b. Declaring the trading start: validated, logged, and it flows into history months (earlier of declared and bank).
    const { declareTradingSince } = await import("../src/actions/funding-match");
    await assert.rejects(() => declareTradingSince(db as any, id, { tradingSince: "2099-01-01" }), (e: any) => e.code === "invalid" && /after/.test(e.message), "a future date is refused");
    await assert.rejects(() => declareTradingSince(db as any, id, { tradingSince: "1949-12-31" }), (e: any) => e.code === "invalid" && /1950/.test(e.message), "before 1950 is refused");
    await assert.rejects(() => declareTradingSince(db as any, id, { tradingSince: "2021-02-30" }), (e: any) => e.code === "invalid", "not a real date");
    await declareTradingSince(db as any, id, { tradingSince: "2024-10-15" });
    const withDecl = await computeFundingMatch(db as any, id);
    assert.equal(withDecl.profile.monthsOfHistory, 24, "2024-10-15 to 2026-10-15");
    assert.equal(withDecl.profile.historySource, "declared");
    await declareTradingSince(db as any, id, { tradingSince: null });
    const cleared = await computeFundingMatch(db as any, id);
    assert.equal(cleared.profile.historySource, "bank_statement");
    assert.equal(cleared.profile.monthsOfHistory, cleared.profile.bankMonthsOfHistory);
    const [declLog] = await sql`select detail from action_records where business_id = ${id} and event = 'funding.profile_declared' order by chain_seq desc limit 1`;
    assert.deepEqual(Object.keys(declLog.detail).sort(), ["declaredBy", "tradingSince", "verified"]);
    await declareTradingSince(db as any, id, { tradingSince: "2021-03-01" }); // restore for the rest of the clone's life

    // B4. Failure path: an unknown business is refused.
    await assert.rejects(() => matchFunding(db as any, "00000000-0000-4000-8000-000000000000"), (e: any) => e.code === "not_found");
    console.log(`  B3/B4 clone (need ${res.need.amountMinor}, ${res.match.results.filter((x) => x.coversNeed).length} product(s) cover it): same need as assessFunding, tables unchanged, one funding.matched record; unknown business refused`);
  } finally {
    await sql.end();
  }
}

partA();
partB().then(() => console.log("matching checks passed")).catch((e) => { console.error(e); process.exit(1); });
