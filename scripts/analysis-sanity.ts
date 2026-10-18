// Focused checks for the business analysis (cash view; not a test suite). Run: bun run check:analysis
// Part A is pure: ageing boundaries, days to be paid, how customers pay, months, runway, "not enough data" states, determinism (hand-computed figures).
// Part B uses the seeded demo business: every headline figure equals an independent SQL / classifier recomputation, the Funding profile agrees,
// and the read changes no table. All figures are inline synthetic test literals.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { analyse, bucketOf, classifyTransaction, type AnalysisInput, type AnalysisTx, type InvoiceRecord, type BillRecord } from "../src/engine";

const AS_OF = "2026-10-15";
const inv = (id: string, cp: string, dueOn: string, amount: bigint, extra: Partial<InvoiceRecord> = {}): InvoiceRecord => ({ id, number: id, counterpartyId: cp, counterpartyName: `Customer ${cp} (test)`, issuedOn: "2026-01-01", dueOn, amount, status: "open", ...extra });
const bill = (id: string, issuedOn: string, dueOn: string, amount: bigint, extra: Partial<BillRecord> = {}): BillRecord => ({ id, reference: id, counterpartyId: "s1", counterpartyName: "Supplier (test)", issuedOn, dueOn, amount, status: "open", ...extra });
const base = (o: Partial<AnalysisInput> = {}): AnalysisInput => ({ asOf: AS_OF, currency: "GBP", invoices: [], bills: [], transactions: [], openingBalanceMinor: 1_000_000n, ...o });
const tx = (postedOn: string, amount: bigint, description: string, counterpartyRole: AnalysisTx["counterpartyRole"], counterpartyId: string | null = null): AnalysisTx => ({ postedOn, amount, description, counterpartyRole, counterpartyId, counterpartyName: counterpartyId ? `Customer ${counterpartyId} (test)` : null });
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const allFinite = (v: unknown): boolean => (typeof v === "number" ? Number.isFinite(v) : Array.isArray(v) ? v.every(allFinite) : v && typeof v === "object" ? Object.values(v).every(allFinite) : true);

function partA() {
  // A1. Bucket boundaries: due today is not yet due; 1 and 30 days overdue are 1_30; 31 and 60 are 31_60; 61 is 61_90; 91 is over_90.
  assert.deepEqual(["2026-10-15", "2026-10-16", "2026-10-14", "2026-09-15", "2026-09-14", "2026-08-16", "2026-08-15", "2026-07-17", "2026-07-16"].map((d) => bucketOf(d, AS_OF)),
    ["not_yet_due", "not_yet_due", "1_30", "1_30", "31_60", "31_60", "61_90", "61_90", "over_90"], "due today = not yet due; 1 and 30 = 1_30; 31 and 60 = 31_60; 61 and 90 = 61_90; 91 = over_90");
  const open = [
    inv("today", "c1", "2026-10-15", 100_000n), inv("d1", "c1", "2026-10-14", 200_000n), inv("d30", "c2", "2026-09-15", 300_000n), inv("d31", "c2", "2026-09-14", 400_000n),
    inv("d60", "c1", "2026-08-16", 700_000n), inv("d61", "c3", "2026-08-15", 600_000n), inv("d91", "c3", "2026-07-16", 500_000n),
    inv("part", "c1", "2026-10-01", 1_000_000n, { outstanding: 250_000n }),
    inv("paid", "c1", "2026-09-01", 9_000_000n, { status: "paid", paidOn: "2026-09-03" }), inv("counted", "c2", "2026-09-01", 8_000_000n, { countedIn: "order:x" }),
  ];
  const r = analyse(base({ invoices: open })).receivables;
  assert.deepEqual(r.buckets.map((b) => [b.bucket, b.amountMinor, b.count]), [["not_yet_due", 100_000n, 1], ["1_30", 750_000n, 3], ["31_60", 1_100_000n, 2], ["61_90", 600_000n, 1], ["over_90", 500_000n, 1]], "a partly paid invoice buckets on its 250,000 outstanding; paid and counted-elsewhere are left out");
  assert.equal(r.totalMinor, 3_050_000n);
  assert.equal(r.overdueMinor, 2_950_000n);
  assert.equal(r.overdueShareBps, 9672, "2,950,000 of 3,050,000");
  assert.equal(r.over30Minor, 2_200_000n);
  assert.equal(r.over30ShareBps, 7213, "more than 30 days: 2,200,000 of 3,050,000");

  // A2. Days sales / payable outstanding: open 2,000,000 over 4,000,000 invoiced in 90 days x 90 = 45 days; bills: 1,000,000 over 3,000,000 = 30 days.
  const issued = "2026-09-01";
  const dsoInv = [inv("o1", "c1", "2026-10-30", 1_000_000n, { issuedOn: issued }), inv("o2", "c1", "2026-10-30", 1_000_000n, { issuedOn: issued }), inv("p1", "c1", "2026-09-30", 1_000_000n, { issuedOn: issued, status: "paid", paidOn: "2026-10-01" }), inv("p2", "c1", "2026-09-30", 1_000_000n, { issuedOn: issued, status: "paid", paidOn: "2026-10-02" })];
  const dsoBills = [bill("b1", issued, "2026-10-30", 1_000_000n), bill("b2", issued, "2026-09-30", 1_000_000n, { status: "paid", paidOn: "2026-09-29" }), bill("b3", issued, "2026-09-30", 1_000_000n, { status: "paid", paidOn: "2026-09-29" })];
  const a2 = analyse(base({ invoices: dsoInv, bills: dsoBills }));
  assert.deepEqual([a2.dso.days, a2.dso.documents, a2.dso.documentedMinor, a2.dpo.days], [45, 4, 4_000_000n, 30]);
  assert.ok(a2.dso.formula.includes("× 90") && a2.dso.window.from === "2026-07-18" && a2.dso.window.to === AS_OF, "the formula and window are stated");
  const few = analyse(base({ invoices: dsoInv.slice(0, 2) }));
  assert.equal(few.dso.days, null);
  assert.ok(/Not enough invoices/.test(few.dso.reason!), few.dso.reason!);

  // A3. How customers pay: six invoices settled in 180 days. Late days +10, +4, -2 in the last 90 days (average 4) and +20, +10, +6 before (average 12): overall 8, trend -8.
  const paid = (id: string, cp: string, due: string, paidOn: string) => inv(id, cp, due, 100_000n, { status: "paid", paidOn });
  const settled = [paid("r1", "c1", "2026-09-01", "2026-09-11"), paid("r2", "c1", "2026-09-10", "2026-09-14"), paid("r3", "c2", "2026-09-20", "2026-09-18"), paid("q1", "c1", "2026-06-01", "2026-06-21"), paid("q2", "c2", "2026-06-10", "2026-06-20"), paid("q3", "c2", "2026-06-15", "2026-06-21"), paid("old", "c1", "2026-01-01", "2026-03-01")];
  const pb = analyse(base({ invoices: settled })).paymentBehaviour;
  assert.deepEqual([pb.settledCount, pb.averageDaysLate], [6, 8], "the invoice settled in March is outside the 180 days");
  assert.deepEqual([pb.trend!.recentAverage, pb.trend!.priorAverage, pb.trend!.changeDays, pb.trend!.recentCount, pb.trend!.priorCount], [4, 12, -8, 3, 3]);
  assert.deepEqual(pb.customers.map((c) => [c.customerId, c.averageDaysLate, c.settledCount]).sort(), [["c1", 11, 3], ["c2", 5, 3]], "c1: (10+4+20)/3 = 11.33 -> 11; c2: (-2+10+6)/3 = 4.67 -> 5");
  const thin = analyse(base({ invoices: settled.slice(0, 5) })).paymentBehaviour;
  assert.equal(thin.trend, null);
  assert.ok(/at least 3/.test(thin.trendReason!), "a window with fewer than 3 settled invoices gives no trend");
  assert.equal(analyse(base({ invoices: settled.slice(0, 2) })).paymentBehaviour.averageDaysLate, null, "fewer than 3 settled: no average");

  // A4. Months and runway. Complete months only; transfers and loan money are left out of both sides.
  const months = (sepIn: bigint): AnalysisTx[] => [
    tx("2026-07-02", 1_000_000n, "Payment from customer", "customer", "c1"), tx("2026-07-10", -1_300_000n, "Supplier payment", "supplier"),
    tx("2026-08-02", 1_000_000n, "Payment from customer", "customer", "c1"), tx("2026-08-10", -1_200_000n, "Supplier payment", "supplier"), tx("2026-08-12", -5_000_000n, "Transfer to savings", null), tx("2026-08-20", 4_000_000n, "Loan advance", "lender"),
    tx("2026-09-02", sepIn, "Payment from customer", "customer", "c2"), tx("2026-09-10", -1_300_000n, "Supplier payment", "supplier"),
    tx("2026-10-05", 300_000n, "Payment from customer", "customer", "c1"),
  ];
  const withFirst = (txs: AnalysisTx[]) => [tx("2026-07-01", 1n, "Opening", null), ...txs];
  const mc = analyse(base({ transactions: withFirst(months(900_000n)) }));
  assert.deepEqual(mc.monthlyCash.months.map((m) => [m.month, m.inMinor, m.outMinor, m.netMinor]), [["2026-07", 1_000_000n, 1_300_000n, -300_000n], ["2026-08", 1_000_000n, 1_200_000n, -200_000n], ["2026-09", 900_000n, 1_300_000n, -400_000n]], "transfer and loan money excluded; the October row is partial");
  assert.equal(mc.monthlyCash.partialMonth!.month, "2026-10");
  assert.deepEqual(mc.runway, { burning: true, months: 3, monthlyBurnMinor: 300_000n, balanceMinor: 1_000_000n, monthsUsed: 3 }, "1,000,000 balance / 300,000 a month = 3 months, rounded down");
  const ok = analyse(base({ transactions: withFirst(months(2_500_000n)) }));
  assert.deepEqual(ok.runway, { burning: false, monthsUsed: 3, averageNetMinor: 233_333n }, "net +700,000 over 3 months: not burning");
  assert.ok(ok.observations.some((o) => /more money came in from customers than went out/.test(o)));
  const lateStart = analyse(base({ transactions: [tx("2026-07-15", 1n, "Opening", null), ...months(900_000n).slice(2)] }));
  assert.deepEqual(lateStart.monthlyCash.months.map((m) => m.month), ["2026-08", "2026-09"], "July is not fully inside the history (first transaction 15 July)");
  const one = analyse(base({ transactions: [tx("2026-09-01", 1n, "Opening", null), tx("2026-09-10", 500_000n, "Payment from customer", "customer", "c1")] }));
  assert.deepEqual(one.runway.burning, null);
  assert.ok(/Fewer than 2 complete months/.test((one.runway as any).reason));
  const conc = mc.concentration;
  assert.equal(conc.top[0].customerId, "c1");
  assert.equal(conc.top[0].shareOfReceiptsBps, 6896, "c1 received 2,000,000 of 2,900,000 in complete months");
  assert.equal(conc.topShareOfReceiptsBps, null, "two customers are too few for a concentration figure");
  assert.ok(/Too few customers/.test(conc.receiptsReason!) && !mc.observations.some((o) => /top d+ customers?/.test(o)), "and no concentration sentence is written");
  const four = analyse(base({ transactions: [tx("2026-07-01", 1n, "Opening", null), ...["c1", "c2", "c3", "c4"].map((c, i) => tx(`2026-08-0${i + 1}`, BigInt((i + 1) * 100_000), "Payment from customer", "customer", c)), tx("2026-09-02", -50_000n, "Supplier payment", "supplier")] }));
  assert.equal(four.concentration.topShareOfReceiptsBps, 9000, "4 customers: the top 3 (400,000 + 300,000 + 200,000) are 900,000 of 1,000,000");
  assert.ok(four.observations.some((o) => /top 3 customers made up 90%/.test(o)));

  // A5. No data at all: every state says what is missing, nothing is NaN or infinite, and the same input gives the same output.
  const empty = analyse(base({ openingBalanceMinor: 0n }));
  assert.equal(empty.dso.days, null);
  assert.equal(empty.dpo.days, null);
  assert.equal(empty.paymentBehaviour.averageDaysLate, null);
  assert.equal(empty.monthlyCash.availableMonths, 0);
  assert.equal(empty.runway.burning, null);
  assert.deepEqual([empty.receivables.totalMinor, empty.receivables.overdueShareBps, empty.observations.length], [0n, 0, 0]);
  assert.ok(allFinite(empty) && allFinite(mc) && !/NaN|Infinity/.test(json(mc)));
  assert.equal(json(analyse(base({ invoices: open, transactions: withFirst(months(900_000n)) }))), json(analyse(base({ invoices: open, transactions: withFirst(months(900_000n)) }))), "deterministic");
  assert.ok(analyse(base()).limits.some((l) => /not profit or margin/.test(l)), "the limits say it is cash, not profit");
  console.log("  A pure: bucket boundaries, outstanding-only ageing, DSO/DPO hand figures, payment days late and trend, months and runway, not-enough-data states, determinism");
}

async function partB() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { getAnalysis } = await import("../src/actions/analysis");
  const { computeFundingMatch } = await import("../src/actions/funding-match");
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");
    const a = await getAnalysis(db as any, demo!);
    const asOf = a.asOf;

    // B1. Ageing and the Funding profile agree, and both equal an independent SQL recomputation from the tables.
    const profile = (await computeFundingMatch(db as any, demo!)).profile;
    assert.equal(a.receivables.totalMinor, profile.openReceivablesMinor, "open receivables equal the Funding profile's");
    assert.equal(a.receivables.count, profile.openInvoiceCount);
    assert.equal(a.receivables.over30ShareBps, profile.overdueOver30ShareBps, "the 30+ days share equals the profile's overdueOver30ShareBps");
    const bucketSql = async (doc: "invoices" | "bills", payCol: "invoice_id" | "bill_id") => sql`
      select case when d <= 0 then 'not_yet_due' when d <= 30 then '1_30' when d <= 60 then '31_60' when d <= 90 then '61_90' else 'over_90' end as b, sum(o)::text as s, count(*)::int as n
      from (select (${asOf}::date - x.due_on) as d, x.amount_minor - coalesce((select sum(p.amount_minor) from document_payments p where p.${sql(payCol)} = x.id and p.voided_at is null and p.paid_on <= ${asOf}::date), 0) as o
            from ${sql(doc)} x where x.business_id = ${demo} and x.status not in ('paid', 'void', 'draft') and x.counted_in is null) t where o > 0 group by 1`;
    for (const [doc, col, got] of [["invoices", "invoice_id", a.receivables], ["bills", "bill_id", a.payables]] as const) {
      const rows = await bucketSql(doc, col);
      for (const b of got.buckets) {
        const r = rows.find((x: any) => x.b === b.bucket);
        assert.equal(b.amountMinor.toString(), r ? r.s : "0", `${doc} ${b.bucket} amount`);
        assert.equal(b.count, r ? r.n : 0, `${doc} ${b.bucket} count`);
      }
    }

    // B2. Days to be paid, from SQL.
    const win = new Date(Date.parse(`${asOf}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
    const [iss] = await sql`select coalesce(sum(amount_minor), 0)::text s, count(*)::int n from invoices where business_id = ${demo} and status not in ('void', 'draft') and issued_on >= ${win}::date and issued_on <= ${asOf}::date`;
    const dsoExp = (BigInt(a.receivables.totalMinor) * 90n * 2n + BigInt(iss.s)) / (BigInt(iss.s) * 2n);
    assert.equal(BigInt(a.dso.days!), dsoExp, "days sales outstanding");
    assert.equal(a.dso.documents, iss.n);

    // B3. How customers pay: average days from due date to settlement of invoices paid in the last 180 days.
    const wFrom = new Date(Date.parse(`${asOf}T00:00:00Z`) - 179 * 86_400_000).toISOString().slice(0, 10);
    const lateRows = await sql`select (paid_on - due_on)::int as late from invoices where business_id = ${demo} and status = 'paid' and paid_on >= ${wFrom}::date and paid_on <= ${asOf}::date`;
    const late = lateRows.map((r: any) => r.late as number);
    assert.equal(a.paymentBehaviour.settledCount, late.length);
    assert.equal(a.paymentBehaviour.averageDaysLate, Math.floor((2 * late.reduce((x, y) => x + y, 0) + late.length) / (2 * late.length)), "average days late");

    // B4. Money in and out by month equals the insights' own classifier applied to the raw bank rows (and a plain SQL version of the same rule).
    const raw = await sql`select t.posted_on::text as d, t.amount_minor::text as amt, t.description, c.role from transactions t left join counterparties c on c.id = t.counterparty_id where t.business_id = ${demo} and t.posted_on <= ${asOf}::date`;
    const perMonth = new Map<string, { in: bigint; out: bigint }>();
    for (const r of raw) {
      const cat = classifyTransaction({ amount: BigInt(r.amt), description: r.description, counterpartyRole: r.role });
      if (cat === "transfer") continue;
      const m = r.d.slice(0, 7);
      const cur = perMonth.get(m) ?? { in: 0n, out: 0n };
      if (cat === "customer_receipt") cur.in += BigInt(r.amt);
      if (BigInt(r.amt) < 0n) cur.out += -BigInt(r.amt);
      perMonth.set(m, cur);
    }
    assert.ok(a.monthlyCash.months.length >= 3, "the demo covers at least three complete months");
    for (const m of a.monthlyCash.months) {
      const e = perMonth.get(m.month)!;
      assert.equal(m.inMinor, e.in, `${m.month} money in`);
      assert.equal(m.outMinor, e.out, `${m.month} money out`);
      assert.equal(m.netMinor, e.in - e.out);
      const [s] = (await sql`select coalesce(sum(case when t.amount_minor > 0 and c.role = 'customer' then t.amount_minor else 0 end), 0)::text i, coalesce(sum(case when t.amount_minor < 0 then -t.amount_minor else 0 end), 0)::text o
        from transactions t left join counterparties c on c.id = t.counterparty_id where t.business_id = ${demo} and to_char(t.posted_on, 'YYYY-MM') = ${m.month} and t.description !~* '\\m(transfer|own account|internal|sweep)\\M'`) as any[];
      assert.deepEqual([s.i, s.o], [m.inMinor.toString(), m.outMinor.toString()], `${m.month}: plain SQL version of the same rule`);
    }
    // B5. Runway from the independent monthly figures and the account balance.
    const last3 = a.monthlyCash.months.slice(-3).map((m) => perMonth.get(m.month)!);
    const avg = last3.reduce((x, y) => x + (y.in - y.out), 0n) / BigInt(last3.length);
    const [bal] = await sql`select coalesce(sum(balance_minor), 0)::text s from financial_accounts where business_id = ${demo}`;
    if (avg < 0n) assert.deepEqual([a.runway.burning, (a.runway as any).months], [true, Number(BigInt(bal.s) / -avg)], "runway months");
    else assert.equal(a.runway.burning, false);
    assert.equal(a.workingCapital.netMinor, BigInt(bal.s) + a.receivables.totalMinor - a.payables.totalMinor);

    // B6. Failure path: unknown business refused; the read changes no table; a business with nothing in it gets "not enough data" states.
    await assert.rejects(() => getAnalysis(db as any, "00000000-0000-4000-8000-000000000000"), (e: any) => e.code === "not_found");
    const tables = (await sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'business_id' order by table_name`).map((r: any) => r.table_name as string);
    const fingerprint = async () => { const out: Record<string, string> = {}; for (const t of tables) { const [x] = await sql`select count(*)::int as n, coalesce(md5(string_agg(x::text, ',' order by x::text)), '') as h from ${sql(t)} x where business_id = ${demo}`; out[t] = `${x.n}:${x.h}`; } return out; };
    const before = await fingerprint();
    await getAnalysis(db as any, demo!);
    assert.deepEqual(await fingerprint(), before, "reading the analysis changed no table (the log included)");
    const [biz] = await db.insert(S.businesses).values({ name: `Analysis Sanity Empty ${Date.now().toString(36)} (SYNTHETIC)`, baseCurrency: "GBP", reserveMinor: 0n, reserveCurrency: "GBP", isSynthetic: true, isTest: true }).returning();
    await db.insert(S.financialAccounts).values({ businessId: biz.id, name: "Empty (SYNTHETIC)", currency: "GBP", balanceMinor: 0n, balanceAsOf: new Date(`${asOf}T00:00:00Z`) });
    const e = await getAnalysis(db as any, biz.id);
    assert.deepEqual([e.dso.days, e.dpo.days, e.paymentBehaviour.averageDaysLate, e.monthlyCash.availableMonths, e.runway.burning, e.observations.length], [null, null, null, 0, null, 0]);
    assert.ok(e.dso.reason && e.monthlyCash.reason && (e.runway as any).reason, "each missing piece says why");
    assert.ok(allFinite(e));

    console.log(`  B demo as of ${asOf}: receivables ${a.receivables.totalMinor} in ${a.receivables.count} invoices (${a.receivables.overdueShareBps / 100}% overdue, ${a.receivables.over30ShareBps / 100}% over 30 days); payables ${a.payables.totalMinor}; days sales outstanding ${a.dso.days}, days payable ${a.dpo.days}; invoices paid on average ${a.paymentBehaviour.averageDaysLate} days late (${a.paymentBehaviour.settledCount} settled); ${a.monthlyCash.months.length} complete months in/out ${a.monthlyCash.months.map((m) => `${m.month} ${m.inMinor}/${m.outMinor}`).join(", ")}; runway ${a.runway.burning ? `${(a.runway as any).months} months` : "not burning"}`);
    console.log("  B6 failure paths: unknown business refused; no table changed by the read; a business with no data returns 'not enough data' with reasons");
  } finally {
    await sql.end();
  }
}

partA();
partB().then(() => console.log("analysis checks passed")).catch((e) => { console.error(e); process.exit(1); });
