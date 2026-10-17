// Light checks for Financial Intelligence & Early Warning (not a test suite). Run: bun run check:insights
// Part A is pure (constructed records). Part B reads the seeded businesses: it must write nothing but the one ask log record.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { classifyTransaction, computeInsights, type InsightTx, type InsightsInput } from "../src/engine/insights";
import { classifyQuestion, ruleAnswer, type AskFacts } from "../src/agent";

const AS_OF = "2026-10-15";
const day = (n: number) => { const d = new Date(Date.parse(`${AS_OF}T00:00:00Z`) + n * 86_400_000); return d.toISOString().slice(0, 10); };
const tx = (id: string, offset: number, amount: bigint, description: string, role: InsightTx["counterpartyRole"] = null): InsightTx => ({ id, postedOn: day(offset), amount, description, counterpartyRole: role });
const inv = (n: string, cp: string, issued: number, due: number, amt: bigint, paid?: number) => ({ id: n, number: n, counterpartyId: cp, counterpartyName: `Customer ${cp}`, issuedOn: day(issued), dueOn: day(due), amount: amt, status: (paid === undefined ? "open" : "paid") as "open" | "paid", ...(paid === undefined ? {} : { paidOn: day(paid) }) });
const bill = (n: string, due: number, amt: bigint) => ({ id: n, reference: n, counterpartyId: "s", counterpartyName: "Supplier", issuedOn: day(due - 30), dueOn: day(due), amount: amt, status: "open" as const });
const noShortage = { shortage: false, belowZero: false, minBalanceMinor: "5000000", minBalanceWeek: 3, minWeekStart: null, firstNegativeWeek: null, reserveMinor: "1000000" };
const base = (over: Partial<InsightsInput>): InsightsInput => ({
  engine: { asOf: AS_OF, currency: "GBP", openingBalance: 5_000_000n, reserve: 1_000_000n, invoices: [], bills: [], overdue: undefined },
  transactions: [], forecast: noShortage, ...over,
});

async function main() {
  // ---------- A. pure ----------
  // classification: a transfer is neither income nor an expense; a receipt needs a customer link; unknowns stay "other", never revenue
  assert.equal(classifyTransaction({ amount: 500000n, description: "Transfer from savings", counterpartyRole: null }), "transfer");
  assert.equal(classifyTransaction({ amount: 500000n, description: "BACS CR ACME", counterpartyRole: "customer" }), "customer_receipt");
  assert.equal(classifyTransaction({ amount: 500000n, description: "Mystery credit", counterpartyRole: null }), "other_in");
  assert.equal(classifyTransaction({ amount: -4500n, description: "STO Dockside Estates rent", counterpartyRole: null }), "rent");

  // A1. happy path: money in falls, spending and overdue rise, one customer dominates, bills rise, one payment is unusually large
  const txs: InsightTx[] = [];
  let n = 0;
  for (const off of [-50, -45, -40, -35, -32]) txs.push(tx(`p${n++}`, off, 4_000_000n, "BACS CR customer", "customer")); // 5 receipts in the earlier window: 200,000.00
  txs.push(tx("r1", -10, 1_500_000n, "BACS CR customer", "customer"), tx("r2", -3, 1_000_000n, "BACS CR customer", "customer")); // 25,000.00 now
  for (const off of [-52, -38]) txs.push(tx(`s${n++}`, off, -3_000_000n, "BACS DR Kestrel supplier", "supplier"));
  for (const off of [-24, -20, -12, -6]) txs.push(tx(`s${n++}`, off, -6_000_000n, "BACS DR Kestrel supplier", "supplier"));
  txs.push(tx("big", -2, -30_000_000n, "BACS DR Kestrel supplier", "supplier"));
  for (const off of [-300, -270, -240, -210, -180, -150]) txs.push(tx(`h${n++}`, off, -3_000_000n, "BACS DR Kestrel supplier", "supplier")); // history for "usual size"
  txs.push(tx("x", -20, 9_999_999n, "Transfer between own accounts"));
  const a = computeInsights(base({
    transactions: txs,
    engine: {
      asOf: AS_OF, currency: "GBP", openingBalance: 5_000_000n, reserve: 1_000_000n, overdue: undefined,
      invoices: [inv("A1", "big", -80, -50, 20_000_000n), inv("A2", "big", -40, -2, 30_000_000n), inv("B1", "small", -20, 10, 5_000_000n), inv("P1", "small", -90, -60, 1_000_000n, -55)],
      bills: [bill("L1", -10, 1_000_000n), bill("N1", 5, 2_000_000n), bill("N2", 12, 1_500_000n)],
    },
  }));
  assert.equal(a.periods.comparable, true);
  const kinds = new Set(a.findings.map((f) => f.kind));
  for (const k of ["receipts_decline", "overdue_receivables", "receipts_concentration", "bills_rising", "bills_overdue", "spending_change", "large_payment", "cash_deterioration"]) assert.ok(kinds.has(k as any), `expected finding ${k}`);
  assert.equal(a.metrics.current.inMinor, "2500000", "the transfer is not counted as money in");
  const decline = a.findings.find((f) => f.kind === "receipts_decline")!;
  assert.match(decline.why, /down 87\.5%/);
  assert.equal(decline.comparison?.prior.from, day(-55));
  const overdue = a.findings.find((f) => f.kind === "overdue_receivables")!;
  assert.equal(overdue.figures[0].kind === "money" && overdue.figures[0].amountMinor, "50000000", "overdue total is exactly the open invoices past due");
  assert.ok(overdue.uncertainty.length > 0 && a.findings.every((f) => f.uncertainty.length > 0), "every finding states what is uncertain");
  // order: severity first
  const rank = { high: 0, medium: 1, low: 2 } as const;
  assert.ok(a.findings.every((f, i, all) => i === 0 || rank[all[i - 1].severity] <= rank[f.severity]), "findings are most severe first");
  assert.equal(a.status, "needs_attention");
  // never claims profit, margin or revenue anywhere in wording
  const allText = JSON.stringify(a);
  assert.ok(!/\b(profit|margin|revenue|benchmark)\b/i.test(allText.replace(/Profit and margins are not calculated[^"]*/, "").replace(/not profit/g, "").replace(/Net cash movement is not profit\./g, "")), "no invented profit, margin, revenue or benchmark");
  // no plan-search action unless the forecast shows a shortage; with one, the planner levers are named
  assert.ok(a.findings.every((f) => f.actions.every((x) => x.kind !== "plan_search")));
  const withShortage = computeInsights({ ...base({ transactions: txs, engine: { asOf: AS_OF, currency: "GBP", openingBalance: 5_000_000n, reserve: 1_000_000n, overdue: undefined, invoices: [inv("A2", "big", -40, -2, 30_000_000n), inv("B1", "small", -20, 10, 5_000_000n)], bills: [] } }), forecast: { ...noShortage, shortage: true, belowZero: true, minBalanceMinor: "-250000", firstNegativeWeek: 4 } });
  assert.equal(withShortage.findings[0].kind, "forecast_shortfall", "a forecast shortage leads");
  assert.ok(withShortage.findings.find((f) => f.kind === "overdue_receivables")!.actions.some((x) => x.kind === "plan_search" && /pay/.test(x.note ?? "")), "overdue links to the planner lever");

  // A2. failure path: too little history -> no comparison, no invented trend, said so
  const short = computeInsights(base({ transactions: [tx("a", -20, 100000n, "BACS CR customer", "customer"), tx("b", -5, -50000n, "DD something")] }));
  assert.equal(short.periods.comparable, false);
  assert.ok(short.periods.reason);
  assert.ok(!short.findings.some((f) => f.comparison !== null && f.kind !== "overdue_receivables"), "no period comparison without history");
  assert.equal(short.metrics.prior, null);
  assert.equal(short.status, "not_enough_history");
  // stale bank data is not compared either
  const stale = computeInsights(base({ transactions: [-80, -70, -60, -50, -40].map((o, i) => tx(`t${i}`, o, 100000n, "BACS CR customer", "customer")) }));
  assert.equal(stale.periods.comparable, false);
  // a paid invoice with no paid date: no overdue trend is claimed
  const noDate = computeInsights(base({ engine: { asOf: AS_OF, currency: "GBP", openingBalance: 0n, reserve: 0n, overdue: undefined, invoices: [{ ...inv("Z", "c", -90, -50, 100000n, -10), paidOn: undefined } as any, inv("Y", "c", -60, -45, 700000n)], bills: [] } }));
  assert.ok(noDate.findings.find((f) => f.kind === "overdue_receivables")!.figures.every((f) => !/ago/.test(f.label)), "no earlier overdue figure without paid dates");
  console.log("  A pure rules: classification, all finding kinds, comparison gating, ordering, shortage link, no profit/margin claims");

  // assistant routing and answer from facts only
  assert.equal(classifyQuestion("What are my biggest financial warnings?").intent, "insights");
  assert.equal(classifyQuestion("Are my overdue invoices getting worse?").topic, "overdue");
  assert.equal(classifyQuestion("What happens if my customer pays two weeks late?").intent, "late", "existing routing unchanged");
  assert.equal(classifyQuestion("sign it for me").intent, "action");
  const facts = { currency: "GBP", reserveMinor: "0", forecast: { shortage: false, minBalanceMinor: "1", minBalanceWeek: 1, firstNegativeWeek: null, shortfallMinor: null }, causes: [], downside: null, doNothing: null, plans: [], maxReplanRounds: 2, evidence: [], insights: { asOf: a.asOf, status: a.status, headline: a.headline, comparable: true, comparableReason: null, windowDays: 28, topic: null, findings: a.findings.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, title: f.title, why: f.why, figures: f.figures, comparison: f.comparison?.label ?? null, uncertainty: f.uncertainty, actions: [] })), limits: a.limits } } as AskFacts;
  const ans = ruleAnswer("insights", facts);
  assert.ok(ans.answer.length <= 900 && ans.answer.includes(a.findings[0].title));
  assert.match(ruleAnswer("insights", { ...facts, insights: { ...facts.insights!, topic: "concentration", findings: [] } }).answer, /no warning about customer concentration/i);
  console.log("  A assistant: questions route to findings; the answer is built from the findings' own wording");

  // ---------- B. database ----------
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { sql: dsql } = await import("drizzle-orm");
  const { getInsights } = await import("../src/actions/insights");
  const { askAboutCash } = await import("../src/actions/cash-ask");
  const { ActionError } = await import("../src/actions/types");
  try {
    const before = await db.select({ n: dsql<number>`count(*)::int` }).from(S.actionRecords);
    const tables = { transactions: S.transactions, invoices: S.invoices, bills: S.bills, proposals: S.actionProposals, approvals: S.approvals, runs: S.agentRuns, payments: S.sandboxPayments };
    const counts = async () => Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([k, t]) => [k, (await db.select({ n: dsql<number>`count(*)::int` }).from(t))[0].n])));
    const c0 = await counts();
    let compared = 0, total = 0;
    for (const b of await db.select({ id: S.businesses.id, isTest: S.businesses.isTest }).from(S.businesses)) {
      let r;
      try { r = await getInsights(db, b.id); } catch (e) { if (b.isTest) continue; throw e; } // a throwaway test business with no accounts has no as-of date
      total += 1;
      if (r.periods.comparable) compared += 1;
      assert.ok(r.findings.every((f) => f.uncertainty.length > 0 && f.why.length > 0));
      const ins = BigInt(r.metrics.current.inMinor), out = BigInt(r.metrics.current.outMinor);
      assert.equal(BigInt(r.metrics.current.netMinor), ins - out, "net = in - out");
    }
    assert.ok(total > 0, "run bun run db:seed first");
    await assert.rejects(() => getInsights(db, "00000000-0000-4000-8000-000000000000"), (e: unknown) => e instanceof ActionError && e.code === "not_found", "an unknown business is refused");
    const biz = (await db.select({ id: S.businesses.id }).from(S.businesses).where(dsql`${S.businesses.isTest} = false`).limit(1))[0].id;
    const asked = await askAboutCash(db, biz, { question: "What are my biggest financial warnings?" });
    assert.ok(asked.ok && asked.intent === "insights" && asked.answer.length > 0, "the assistant answers a financial-health question");
    if (asked.ok) assert.ok(asked.details.length > 0 && asked.evidence.some((e) => e.href === "/room#financial-health"));
    const c1 = await counts();
    assert.deepEqual(c1, c0, "reading insights and asking changed no books, plans or sandbox rows");
    const after = await db.select({ n: dsql<number>`count(*)::int` }).from(S.actionRecords);
    console.log(`  B ${total} businesses read (${compared} comparable); unknown business refused; assistant answered from findings; log records +${after[0].n - before[0].n} (the ask only); nothing else written`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
