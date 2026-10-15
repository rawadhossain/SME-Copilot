// Light sanity checks for the cash engine (not a test suite). Part A is pure and hand-checkable.
// Part B runs the seeded business through the loader and the sample order (needs the database).
import assert from "node:assert/strict";
import { commitmentEventSchema, type CommitmentEvent } from "../src/domain/commitment-event";
import { addMonths } from "../src/engine/dates";
import { attributeDrivers } from "../src/engine/drivers";
import { buildForecast, computeLateness } from "../src/engine/forecast";
import { forecastToJson } from "../src/engine/json";
import { sampleOrderEvents } from "../src/engine/samples/grocery-order";
import { runScenario } from "../src/engine/scenario";
import { applyTermChanges, type TermChanges } from "../src/engine/term-changes";
import type { EngineInput, Forecast } from "../src/engine/types";
import { overdueFromEnv } from "../src/engine/loader";

const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

/** Every number in a forecast must be a counter (index, count, days), never money. Money must be bigint. */
const COUNTER_KEYS = new Set(["index", "weekIndex", "horizonWeeks", "downsideDelayDays", "eventCount", "shareOfShortfallBps", "weeksBelowZero"]);
function assertNoFloatMoney(v: unknown, key = ""): void {
  if (typeof v === "number") {
    assert.ok(COUNTER_KEYS.has(key) || key === "", `unexpected number at "${key}"`);
    assert.ok(Number.isInteger(v), `non-integer number at "${key}"`);
  } else if (Array.isArray(v)) v.forEach((x) => assertNoFloatMoney(x, key));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertNoFloatMoney(x, k);
}

function assertIdentity(f: Forecast) {
  f.weeks.forEach((w, i) => {
    const net = f.items.filter((it) => it.weekIndex === w.index).reduce((a, it) => a + it.amount, 0n);
    assert.equal(w.opening + net, w.closing, `balance identity failed in week ${i + 1}`);
    assert.equal(w.inflow - w.outflow, net, `inflow/outflow mismatch in week ${i + 1}`);
    if (i > 0) assert.equal(w.opening, f.weeks[i - 1].closing, `opening != previous closing in week ${i + 1}`);
  });
  assert.equal(f.weeks[0].opening, f.openingBalance);
}

// ---------- Part A: hand-checkable ----------
const paid = (id: string, due: string, late: number) => ({
  id, number: id, counterpartyId: "C", counterpartyName: "Customer C", issuedOn: "2025-11-01", dueOn: due, amount: 100n,
  status: "paid" as const, paidOn: new Date(Date.parse(`${due}T00:00:00Z`) + late * 86_400_000).toISOString().slice(0, 10),
});
const tiny: EngineInput = {
  asOf: "2026-01-01", currency: "GBP", openingBalance: 100_000n, reserve: 50_000n,
  invoices: [
    paid("p1", "2025-11-30", 5), paid("p2", "2025-12-10", 7), paid("p3", "2025-12-20", 9),
    { id: "open1", number: "INV-1", counterpartyId: "C", counterpartyName: "Customer C", issuedOn: "2025-12-27", dueOn: "2026-01-10", amount: 200_000n, status: "open" },
  ],
  bills: [{ id: "b1", reference: "B-1", counterpartyId: "S", counterpartyName: "Supplier S", issuedOn: "2025-12-06", dueOn: "2026-01-05", amount: 30_000n, status: "open" }],
  commitments: [
    { id: "w", name: "Weekly cost", amount: -10_000n, frequency: "weekly", nextDueOn: "2026-01-02", kind: "confirmed" },
    { id: "m", name: "Monthly rent", amount: -20_000n, frequency: "monthly", nextDueOn: "2026-01-31", kind: "confirmed" },
  ],
};
const tinyBefore = stable(tiny);

assert.equal(computeLateness(tiny).get("C")?.shiftDays, 7); // median of 5, 7, 9
assert.deepEqual([addMonths("2026-01-31", 1), addMonths("2026-01-31", 2)], ["2026-02-28", "2026-03-31"]);

const f1 = buildForecast(tiny, { runRate: false });
assert.equal(stable(f1), stable(buildForecast(tiny, { runRate: false })), "determinism");
assert.equal(stable(tiny), tinyBefore, "input must not be mutated");
assertIdentity(f1);
assertNoFloatMoney(f1);
assertNoFloatMoney(forecastToJson(f1));
// Week 1: bill 300.00 + weekly 100.00 out of 1,000.00 -> 600.00. Week 2: weekly 100.00 -> 500.00 (not below reserve).
// Week 3: invoice due 10 Jan + 7 days late = 17 Jan (+2,000.00) and weekly 100.00 -> 2,400.00.
assert.deepEqual(f1.weeks.slice(0, 3).map((w) => w.closing), [60_000n, 50_000n, 240_000n]);
const inv = f1.items.find((i) => i.sourceId === "open1")!;
assert.equal(inv.date, "2026-01-17");
assert.equal(inv.kind, "estimate");
assert.equal(f1.items.filter((i) => i.sourceId === "w").length, 13);
assert.deepEqual(f1.items.filter((i) => i.sourceId === "m").map((i) => i.date), ["2026-01-31", "2026-02-28", "2026-03-31"]);
assert.equal(f1.items.find((i) => i.sourceId === "b1")!.kind, "confirmed");

// No history -> due date, confirmed.
const noHist = buildForecast({ ...tiny, invoices: tiny.invoices.filter((i) => i.status === "open") }, { runRate: false });
assert.deepEqual([noHist.items.find((i) => i.sourceId === "open1")!.date, noHist.items.find((i) => i.sourceId === "open1")!.kind], ["2026-01-10", "confirmed"]);

// Downside: estimated receipts delayed and relabelled as assumptions.
const down = buildForecast(tiny, { runRate: false, downsideDelayDays: 14 });
const dInv = down.items.find((i) => i.sourceId === "open1")!;
assert.deepEqual([dInv.date, dInv.kind, down.variant], ["2026-01-31", "assumption", "downside"]);
assertIdentity(down);

// Scenario: a 1,500.00 cost on 5 Jan is the single driver of the dip.
const parsed = commitmentEventSchema.parse({ date: "2026-01-05", amountMinor: "-150000", currency: "GBP", label: "Unplanned cost", kind: "cost", source: "manual", confidence: "high" });
const events: CommitmentEvent[] = [parsed];
const sc = runScenario(tiny, events);
assertIdentity(sc.scenario);
assert.equal(sc.scenario.weeks[0].closing, 60_000n - 150_000n);
assert.deepEqual(sc.scenario.firstBreach && [sc.scenario.firstBreach.weekIndex, sc.scenario.firstBreach.shortfall], [0, 50_000n - (60_000n - 150_000n)]);
assert.equal(sc.comparison.minimumDelta, -150_000n);
const drv = attributeDrivers(tiny, { events, runRate: false });
// Minimum is week 2 (-1,000.00). The cost is the main driver (1,500.00); the customer's 7-day lateness explains the rest:
// on time, the 2,000.00 would land in week 2, lifting the week-2 balance but leaving week 1 (-900.00) as the new minimum: +100.00.
assert.deepEqual(drv.drivers.map((d) => [d.kind, d.effectOnMinimum]), [["event", 150_000n], ["counterparty_delay", 10_000n]]);
assert.ok(!commitmentEventSchema.safeParse({ ...parsed, amountMinor: "-1.5" }).success, "decimal amount rejected cleanly (no exception)");
assert.ok(!commitmentEventSchema.safeParse({ ...parsed, amountMinor: "abc" }).success);
assert.ok(!commitmentEventSchema.safeParse({ ...parsed, amountMinor: "0" }).success);
assert.ok(!commitmentEventSchema.safeParse({ ...parsed, date: "2026-02-30" }).success);
assert.ok(!commitmentEventSchema.safeParse({ ...parsed, date: "2026-13-01" }).success, "impossible month rejected without throwing");
assert.throws(() => buildForecast(tiny, { events: [{ ...parsed, currency: "USD" }] }), /USD/);
// Horizon parameter: default 13, up to 26, nothing else about the method changes.
assert.equal(f1.weeks.length, 13);
const f26 = buildForecast(tiny, { runRate: false, horizonWeeks: 26 });
assert.equal(f26.weeks.length, 26);
assert.equal(f26.horizonWeeks, 26);
assertIdentity(f26);
assert.deepEqual(f26.weeks.slice(0, 13).map((w) => w.closing), f1.weeks.map((w) => w.closing), "first 13 weeks identical at 26 weeks");
assert.equal(drv.sequential.reduce((a, s) => a + s.effect, 0n), drv.totalEffect, "sequential steps add up to the total");
assert.ok(drv.totalEffect >= drv.drivers[0].effectOnMinimum, "total is at least the largest single effect here");
assert.throws(() => buildForecast(tiny, { horizonWeeks: 27 }), /horizonWeeks/);
assert.throws(() => buildForecast(tiny, { horizonWeeks: 0 }), /horizonWeeks/);

// ---- Batch 9, section 1 (ADR-023): overdue invoices follow an explicit, configurable collection-delay assumption.
{
  const mk = (overdue?: EngineInput["overdue"]): EngineInput => ({
    asOf: "2026-10-15", currency: "GBP", openingBalance: 0n, reserve: 0n, horizonWeeks: 8, ...(overdue ? { overdue } : {}), bills: [], commitments: [],
    invoices: [
      { id: "i1", number: "INV-1", counterpartyId: "c1", counterpartyName: "Late Ltd", issuedOn: "2026-08-01", dueOn: "2026-09-04", amount: 1_000_000n, status: "open" }, // 41 days overdue
      { id: "i2", number: "INV-2", counterpartyId: "c1", counterpartyName: "Late Ltd", issuedOn: "2026-08-20", dueOn: "2026-09-30", amount: 500_000n, status: "open" }, // 15 days overdue
    ],
  });
  const f = buildForecast(mk(), { runRate: false });
  const dates = Object.fromEntries(f.items.filter((i) => i.sourceType === "invoice").map((i) => [i.label.split(" ")[1], i.date]));
  assert.equal(dates["INV-1"], "2026-11-14", "41 days overdue (> 30): collected 30 days after the forecast start");
  assert.equal(dates["INV-2"], "2026-10-29", "15 days overdue: collected 14 days after the forecast start");
  assert.match(f.items.find((i) => i.label.includes("INV-1"))!.note ?? "", /41 days overdue\. Assumption: collected 30 days after/);
  const f0 = buildForecast(mk({ delayDays: 0, longAfterDays: 30, longDelayDays: 0 }), { runRate: false });
  assert.ok(f0.items.filter((i) => i.sourceType === "invoice").every((i) => i.date === "2026-10-15"), "delay 0 reproduces the old optimistic behaviour on request");
  // failure path: nonsense configuration falls back to the documented defaults, never to a silent guess
  assert.deepEqual(overdueFromEnv({ OVERDUE_COLLECTION_DELAY_DAYS: "-3", OVERDUE_LONG_AFTER_DAYS: "abc", OVERDUE_LONG_DELAY_DAYS: "1.5" }), { delayDays: 14, longAfterDays: 30, longDelayDays: 30 });
  assert.deepEqual(overdueFromEnv({ OVERDUE_COLLECTION_DELAY_DAYS: "7" }).delayDays, 7);
  // chase never makes the expected date later; early payment moves a not-yet-due invoice and the discount is a cost
  const chased = buildForecast(mk(), { runRate: false, adjustments: { chase: [{ counterpartyId: "c1", payWithinDays: 7 }], early: [] } });
  assert.equal(chased.items.find((i) => i.label.includes("INV-1"))!.date, "2026-10-22");
  const notYet = { ...mk(), invoices: [{ id: "i3", number: "INV-3", counterpartyId: "c2", counterpartyName: "Fine Ltd", issuedOn: "2026-10-01", dueOn: "2026-11-10", amount: 1_000_000n, status: "open" as const }] };
  const early = buildForecast(notYet, { runRate: false, adjustments: { chase: [], early: [{ counterpartyId: "c2", daysEarly: 15, discountBps: 150 }] } });
  assert.equal(early.items[0].date, "2026-10-26");
  assert.equal(early.items[0].amount, 985_000n);
  assert.equal(early.adjustmentCostMinor, 15_000n);
  console.log("  overdue assumption (14/30 days, configurable), chase and early-payment adjustments: ok");
}
console.log("engine sanity part A (pure): ok");

// ---------- Part B: seeded business + sample order ----------
async function partB() {
  if (!process.env.APP_DATABASE_URL) {
    console.log("engine sanity part B: skipped (no APP_DATABASE_URL)");
    return;
  }
  const { db, sql } = await import("../src/db");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { loadEngineInput } = await import("../src/engine/loader");
  try {
    const id = await getDefaultBusinessId();
    if (!id) {
      console.log("engine sanity part B: skipped (no business; run bun run db:seed)");
      return;
    }
    const input = (await loadEngineInput(db, id))!;
    const base = buildForecast(input);
    assert.equal(stable(base), stable(buildForecast(input)), "determinism on seeded data");
    assertIdentity(base);
    assertNoFloatMoney(base);
    assert.equal(base.openingBalance, 4_200_000n);
    assert.equal(base.reserve, 2_800_000n, "reserve = one fortnightly payroll");

    const sample = sampleOrderEvents(input.asOf, input.currency);
    // Deposit + balance = quote total exactly; the receipt is the PO total.
    assert.equal(-(sample[0].amountMinor + sample[1].amountMinor), 9_600_000n);
    assert.equal(sample[0].amountMinor, -2_880_000n);
    assert.equal(sample[2].amountMinor, 18_000_000n);
    for (const e of sample) assert.ok(typeof e.amountMinor === "bigint");

    const r = runScenario(input, sample);
    assertIdentity(r.scenario);
    assertNoFloatMoney(r.scenario);
    assert.equal(r.comparison.weekly[0].delta, -2_880_000n, "deposit lands in week 1");
    assert.equal(r.comparison.weekly[3].delta, -2_880_000n, "only the deposit before week 5");
    assert.equal(r.comparison.weekly[4].delta, -9_600_000n, "deposit + balance from week 5");
    assert.equal(r.scenario.outsideHorizon.length, 1, "customer receipt (day 95) is after the 13 weeks");
    assert.ok(r.scenario.weeks[4].closing < 0n && r.baseline.weeks[4].closing > r.baseline.reserve, "week 5: baseline above reserve, scenario below zero");
    assert.ok(r.scenario.firstBreach !== null && r.scenario.maxShortfall > r.baseline.maxShortfall);

    const d = attributeDrivers(input, { events: sample });
    const eventDrivers = d.drivers.filter((x) => x.kind === "event");
    assert.equal(eventDrivers.reduce((a, x) => a + x.effectOnMinimum, 0n), 9_600_000n, "event effects add up to the 96,000.00 outflow");
    for (const x of eventDrivers) assert.ok(x.effectOnMinimum <= 9_600_000n);
    assert.ok(d.drivers.some((x) => x.kind === "counterparty_delay" && x.effectOnMinimum > 0n), "slow payer shows up as a driver");
    for (let i = 1; i < d.drivers.length; i++) assert.ok(d.drivers[i - 1].effectOnMinimum >= d.drivers[i].effectOnMinimum, "ranked");

    // ---- The demo story (reshaped seed, Batch 3B) ----
    const POUNDS = (n: number) => BigInt(n) * 100n;
    // 1. Healthy baseline: never below the reserve over 13 weeks; lowest week between 30k and 45k.
    assert.ok(base.minimum.amount >= base.reserve, "baseline never closes below the reserve");
    assert.ok(base.minimum.amount >= POUNDS(30_000) && base.minimum.amount <= POUNDS(45_000), "baseline lowest week 30k to 45k");
    // 2. Downside dips below the reserve but stays above -10,000.
    const down = buildForecast(input, { downsideDelayDays: 14 });
    assertIdentity(down);
    assert.ok(down.firstBreach !== null, "downside dips below the reserve");
    assert.ok(down.minimum.amount > -POUNDS(10_000), "downside stays above -10,000");
    console.log(`  downside lowest: ${down.minimum.amount} minor units (target range 10k to 25k; see docs)`);
    // 3. Order: minimum between -90k and -60k; first negative week 5 to 7.
    assert.ok(r.scenario.minimum.amount >= -POUNDS(90_000) && r.scenario.minimum.amount <= -POUNDS(60_000), "order minimum -90k to -60k");
    const firstNeg = r.scenario.weeksBelowZero[0] + 1;
    assert.ok(firstNeg >= 5 && firstNeg <= 7, `first negative week is ${firstNeg}`);
    // 4. At 20 weeks the receipt is inside the window and cash recovers above the reserve.
    const r20 = runScenario({ ...input, horizonWeeks: 20 }, sample);
    assert.equal(r20.scenario.weeks.length, 20);
    assert.equal(r20.scenario.outsideHorizon.length, 0, "receipt is inside the 20-week window");
    const receipt = r20.scenario.items.find((i) => i.sourceType === "event" && i.amount > 0n)!;
    const after = r20.scenario.weeks.slice(receipt.weekIndex);
    assert.ok(after.every((w) => w.closing >= r20.scenario.reserve), "closing balance after the receipt stays above the reserve");
    assert.deepEqual(r20.scenario.weeks.slice(0, 13).map((w) => w.closing), r.scenario.weeks.map((w) => w.closing), "20-week run equals 13-week run for the first 13 weeks");
    console.log(`  receipt lands in week ${receipt.weekIndex + 1}; that week closes at ${r20.scenario.weeks[receipt.weekIndex].closing} minor units`);
    // 5. Three overdue customer invoices, none from Northgate, totalling 30k to 35k, with different ages.
    const overdue = input.invoices.filter((i) => i.status === "open" && i.dueOn < input.asOf);
    assert.equal(overdue.length, 3, "three overdue invoices");
    assert.ok(overdue.every((i) => !i.counterpartyName.startsWith("Northgate")), "none from Northgate");
    const overdueTotal = overdue.reduce((a, i) => a + i.amount, 0n);
    assert.ok(overdueTotal >= POUNDS(30_000) && overdueTotal <= POUNDS(35_000), "overdue total 30k to 35k");
    const ages = overdue.map((i) => Math.round((Date.parse(`${input.asOf}T00:00:00Z`) - Date.parse(`${i.dueOn}T00:00:00Z`)) / 86_400_000)).sort((a, b) => a - b);
    assert.deepEqual(ages, [12, 25, 41]);
    // 6. Northgate pays about 10 to 12 days late; the others a few days.
    const late = computeLateness(input);
    for (const l of late.values()) {
      if (l.counterpartyName.startsWith("Northgate")) assert.ok(l.shiftDays >= 10 && l.shiftDays <= 12, "Northgate 10 to 12 days late");
      else assert.ok(l.shiftDays >= 0 && l.shiftDays <= 5, "others a few days late");
    }
    // ---- Sequential attribution on the real scenario ----
    const dseq = attributeDrivers(input, { events: sample });
    assert.equal(dseq.sequential.reduce((a, x) => a + x.effect, 0n), dseq.totalEffect, "sequential steps add up to the total");
    assert.equal(dseq.minimum + dseq.totalEffect, dseq.minimumWithoutDrivers);
    assert.deepEqual(dseq.sequential.map((x) => x.label), dseq.drivers.map((x) => x.label).filter((l) => dseq.sequential.some((x) => x.label === l)), "same rank order");

    // ---- Lever results (applyTermChanges), reported next to the earlier hand arithmetic. Nothing is tuned to match. ----
    const levers: [string, TermChanges | null][] = [
      ["sample order, no change", null],
      ["supplier deposit 15%", { supplierDepositBps: 1500 }],
      ["supplier balance deferred 30 days", { supplierBalanceDeferralDays: 30 }],
      ["buyer deposit 20%", { buyerDepositBps: 2000 }],
      ["buyer deposit 20% + balance deferred 30 days", { buyerDepositBps: 2000, supplierBalanceDeferralDays: 30 }],
      ["invoice finance 80% advance, 2% fee", { invoiceFinance: { advanceBps: 8000, feeBps: 200 } }],
    ];
    const gbp = (n: bigint) => (n < 0n ? "-" : "") + "GBP " + ((n < 0n ? -n : n) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + ((n < 0n ? -n : n) % 100n).toString().padStart(2, "0");
    const baseTotal = sample.reduce((a, e) => a + e.amountMinor, 0n);
    console.log("  lever                                         13-week min (week)      first negative wk   20-week min (week)");
    for (const [name, ch] of levers) {
      const ev = ch ? applyTermChanges(sample, ch) : sample;
      const r13 = runScenario(input, ev);
      const r20 = runScenario({ ...input, horizonWeeks: 20 }, ev);
      assertIdentity(r13.scenario);
      assertIdentity(r20.scenario);
      const neg = r13.scenario.weeksBelowZero[0];
      const total = ev.reduce((a, e) => a + e.amountMinor, 0n);
      if (name.startsWith("invoice finance")) assert.equal(total, baseTotal - 360_000n, "finance costs exactly the 2% fee on 180,000.00");
      else assert.equal(total, baseTotal, "renegotiation moves cash in time, it does not change the total");
      console.log(`  ${name.padEnd(46)}${(gbp(r13.scenario.minimum.amount) + " (" + (r13.scenario.minimum.weekIndex + 1) + ")").padEnd(24)}${(neg === undefined ? "none" : String(neg + 1)).padEnd(20)}${gbp(r20.scenario.minimum.amount)} (${r20.scenario.minimum.weekIndex + 1})`);
    }
    console.log("  earlier hand arithmetic (Batch 3B): order -61,227.14; 20% buyer deposit about -25.2k; 80% advance about +79k at week 10");
    console.log("engine sanity part B (seeded business + sample order): ok");
  } finally {
    await sql.end();
  }
}
await partB();
