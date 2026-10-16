// Financing comparison (Phase K). Pure and deterministic: integer minor units, no database, no clock, no model.
// An offer is a disbursement plus dated repayments; its cash effect goes through the same forecast as everything else.
import type { CommitmentEvent } from "@/domain/commitment-event";
import type { FinancingOffer } from "@/domain/financing-offer";
import { addDays, addMonths, diffDays } from "../dates";
import { buildForecast } from "../forecast";
import type { EngineInput, Forecast } from "../types";

export const DEFAULT_STACKING_WARN_BPS = 2500; // informational: a week of repayments above 25% of average weekly inflow
export const DEFAULT_MIN_DSCR_X100 = 125; // lenders typically look for a debt service coverage ratio of about 1.25 or more
/** Compounded rates above this (100,000% a year) are reported as "not meaningful", which happens for very short terms. */
const MAX_MEANINGFUL_RATE = 1000;
const DAYS_PER_YEAR = 365n;

export interface Summary {
  minBalanceMinor: bigint;
  minBalanceWeek: number; // 1-based
  firstNegativeWeek: number | null; // 1-based
  weeksBelowReserve: number;
  weeksBelowZero: number;
  closingAtHorizonMinor: bigint;
  /** Closing balance of every forecast week (1-based index), for charts. */
  weekly: { index: number; start: string; closingMinor: bigint }[];
}

export interface Cost {
  netReceivedMinor: bigint;
  totalRepaymentMinor: bigint;
  totalCostMinor: bigint; // repayments minus money actually received
  costOfAmountBps: number; // total cost as a share of the amount advanced, basis points (rounded half-up)
  /**
   * Estimated annualised cost, basis points. Average-balance method (integers only): total cost x 365 / the sum of
   * outstanding balance x days, where the balance is the money received, paid down in proportion to repayments. It is an
   * estimate for comparing offers, not the lender's legal APR (which may use a different method).
   */
  annualisedCostBps: number;
  /**
   * Compounded effective annual rate from the actual dated cash flows (XIRR style: actual days, 365-day year), basis points.
   * Null when no rate exists or it is not meaningful (very short terms compound to absurd figures). An estimate, not the lender's legal APR.
   */
  effectiveAnnualRateBps: number | null;
  termDays: number;
  lastRepaymentDate: string;
}

/** Debt service coverage over the forecast window: operating cash flow before any financing, over all scheduled repayments. */
export interface Dscr {
  operatingCashFlowMinor: bigint;
  debtServiceMinor: bigint; // repayments inside the window, including financing already planned
  /** Ratio times 100 (125 = 1.25). Null when there is nothing to repay. May be zero or negative. */
  ratioX100: number | null;
  minRequiredX100: number;
  warn: boolean;
}

export interface Stacking {
  peakWeeklyRepaymentMinor: bigint;
  peakWeek: number | null; // 1-based
  averageWeeklyInflowMinor: bigint; // baseline (without this offer)
  burdenBps: number | null; // peak weekly repayments (this offer plus financing already planned) over average weekly inflow
  warn: boolean;
}

export interface OfferResult {
  offerId: string;
  lender: string;
  product: string;
  cost: Cost;
  summary: Summary;
  /** Change against not borrowing: positive = better. */
  lowestBalanceImprovementMinor: bigint;
  stacking: Stacking;
  dscr: Dscr;
  /** Repayments that fall after the forecast window; the comparison only sees the window, the cost covers the whole term. */
  repaymentsAfterWindowMinor: bigint;
  repaymentsByWeek: { week: number; amountMinor: bigint }[];
  withinCostCap: boolean | null; // null when no cap was given
  withinAmountCap: boolean | null; // null when no cap was given
  warnings: string[];
}

export interface FundingComparison {
  currency: string;
  horizonWeeks: number;
  /** "Don't borrow": the books and the pending commitments, nothing else. */
  doNotBorrow: Summary;
  /** True when not borrowing already keeps every week above the reserve. */
  borrowingNeeded: boolean;
  offers: OfferResult[];
  /** All offers taken together, to show stacking. Null when only one offer was given. */
  allTogether: { summary: Summary; stacking: Stacking; dscr: Dscr; warnings: string[] } | null;
  /** Offer ids from the lowest annualised cost up (ties: lower total cost, then input order). */
  cheapestFirst: string[];
}

export interface CompareOptions {
  horizonWeeks: number;
  stackingWarnBps?: number;
  /** Minimum debt service coverage ratio times 100 (default 125). */
  minDscrX100?: number;
  /** Owner's signed ceiling on the estimated annualised cost, basis points. */
  maxAnnualisedCostBps?: number | null;
  /** Owner's signed ceiling on the amount advanced by one offer, minor units. */
  maxAmountMinor?: bigint | null;
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Cost of one offer. */
export function costOf(o: FinancingOffer): Cost {
  const net = o.principalMinor - o.upfrontFeesMinor;
  const total = sum(o.repayments.map((r) => r.amountMinor));
  const cost = total - net;
  const sorted = [...o.repayments].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const termDays = Math.max(1, diffDays(o.disbursementDate, sorted[sorted.length - 1].date));

  // Outstanding balance after each repayment = net x (total - repaid so far) / total. Integrate over days, divide once.
  let weightedNumerator = 0n; // sum of net x (total - repaid) x days; divide by total at the end
  let repaid = 0n;
  let prevDate = o.disbursementDate;
  for (const r of sorted) {
    const days = BigInt(diffDays(prevDate, r.date));
    weightedNumerator += net * (total - repaid) * days;
    repaid += r.amountMinor;
    prevDate = r.date;
  }
  const balanceDays = weightedNumerator / total; // money x days
  const annualised = balanceDays > 0n ? halfUp(cost * DAYS_PER_YEAR * 10000n, balanceDays) : 0n;
  return {
    netReceivedMinor: net,
    totalRepaymentMinor: total,
    totalCostMinor: cost,
    costOfAmountBps: Number(halfUp(cost * 10000n, o.principalMinor)),
    annualisedCostBps: Number(annualised),
    effectiveAnnualRateBps: effectiveAnnualRateBps([{ date: o.disbursementDate, amountMinor: net }, ...sorted.map((r) => ({ date: r.date, amountMinor: -r.amountMinor }))]),
    termDays,
    lastRepaymentDate: sorted[sorted.length - 1].date,
  };
}

/**
 * Compounded effective annual rate (XIRR style) as basis points, or null. This is the ONE place that uses floating point, and only to
 * search for a rate, which is a ratio and not money: the cash flows stay integers and the integer average-balance figure is the cross-check.
 * Flows are from the borrower's side: money received is positive, repayments negative.
 */
export function effectiveAnnualRateBps(flows: { date: string; amountMinor: bigint }[]): number | null {
  if (flows.length < 2) return null;
  const t0 = flows[0].date;
  const pts = flows.map((f) => ({ t: diffDays(t0, f.date) / 365, a: Number(f.amountMinor) }));
  const npv = (r: number) => pts.reduce((acc, p) => acc + p.a / Math.pow(1 + r, p.t), 0);
  let lo = 0;
  let hi = MAX_MEANINGFUL_RATE;
  if (npv(lo) >= 0) return null; // repaying no more than received: no positive cost rate
  if (npv(hi) < 0) return null; // not meaningful
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) < 0) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10000);
}

function halfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (d * 2n);
}

/** The offer as dated cash movements: the money received (net of upfront fees), then every repayment. */
export function offerEvents(o: FinancingOffer): CommitmentEvent[] {
  const net = o.principalMinor - o.upfrontFeesMinor;
  const label = `${o.lender}: ${o.id}`;
  const events: CommitmentEvent[] = [
    { date: o.disbursementDate, amountMinor: net, currency: o.currency, label: `${label} advance (net of fees)`, kind: "financing", source: "manual", confidence: "medium" },
  ];
  o.repayments.forEach((r, i) => events.push({ date: r.date, amountMinor: -r.amountMinor, currency: o.currency, label: `${label} repayment ${i + 1}`, kind: "financing", source: "manual", confidence: "medium" }));
  return events;
}

/** Equal instalments helper for the owner form: N payments of the same amount, from a first date. */
export function equalInstalments(firstDate: string, count: number, frequency: "weekly" | "fortnightly" | "monthly", amountMinor: bigint): { date: string; amountMinor: bigint }[] {
  if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error("count must be a whole number from 1 to 120");
  if (amountMinor <= 0n) throw new Error("amount must be positive");
  return Array.from({ length: count }, (_, i) => ({
    date: frequency === "monthly" ? addMonths(firstDate, i) : addDays(firstDate, i * (frequency === "weekly" ? 7 : 14)),
    amountMinor,
  }));
}

/** Factor-rate quote: principal times a factor given in thousandths (1.35 = 1350) is the total to be repaid, rounded half-up. */
export function totalFromFactorRate(principalMinor: bigint, factorThousandths: number): bigint {
  if (!Number.isInteger(factorThousandths) || factorThousandths <= 1000 || factorThousandths > 3000) throw new Error("factor rate must be above 1.000 and at most 3.000");
  if (principalMinor <= 0n) throw new Error("principal must be positive");
  return halfUp(principalMinor * BigInt(factorThousandths), 1000n);
}

/** A known total split into N dated instalments; the last one takes the rounding remainder so the total is exact. */
export function splitTotal(firstDate: string, count: number, frequency: "weekly" | "fortnightly" | "monthly", totalMinor: bigint): { date: string; amountMinor: bigint }[] {
  const base = equalInstalments(firstDate, count, frequency, 1n);
  const each = totalMinor / BigInt(count);
  if (each <= 0n) throw new Error("total is too small for that many instalments");
  const rem = totalMinor - each * BigInt(count);
  return base.map((r, i) => ({ date: r.date, amountMinor: i === count - 1 ? each + rem : each }));
}

export function summarise(f: Forecast): Summary {
  return {
    minBalanceMinor: f.minimum.amount,
    minBalanceWeek: f.minimum.weekIndex + 1,
    firstNegativeWeek: f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null,
    weeksBelowReserve: f.weeks.filter((w) => w.belowReserve).length,
    weeksBelowZero: f.weeksBelowZero.length,
    closingAtHorizonMinor: f.weeks[f.weeks.length - 1].closing,
    weekly: f.weeks.map((w) => ({ index: w.index + 1, start: w.start, closingMinor: w.closing })),
  };
}

/** Repayments (positive amounts) per forecast week, from the financing events in a list, inside the horizon. */
function repaymentsByWeek(asOf: string, horizon: number, events: CommitmentEvent[]): Map<number, bigint> {
  const m = new Map<number, bigint>();
  for (const e of events) {
    if (e.kind !== "financing" || e.amountMinor >= 0n) continue;
    const w = Math.floor(diffDays(asOf, e.date) / 7);
    if (w < 0 || w >= horizon) continue;
    m.set(w + 1, (m.get(w + 1) ?? 0n) - e.amountMinor);
  }
  return m;
}

function stackingOf(byWeek: Map<number, bigint>, avgInflow: bigint, warnBps: number): Stacking {
  let peak = 0n;
  let peakWeek: number | null = null;
  for (const [w, amt] of [...byWeek].sort((a, b) => a[0] - b[0])) if (amt > peak) { peak = amt; peakWeek = w; }
  const burden = avgInflow > 0n ? Number(halfUp(peak * 10000n, avgInflow)) : null;
  return { peakWeeklyRepaymentMinor: peak, peakWeek, averageWeeklyInflowMinor: avgInflow, burdenBps: burden, warn: burden === null ? peak > 0n : burden > warnBps };
}

function dscrOf(operating: bigint, debtService: bigint, minX100: number): Dscr {
  if (debtService <= 0n) return { operatingCashFlowMinor: operating, debtServiceMinor: debtService, ratioX100: null, minRequiredX100: minX100, warn: false };
  const ratio = Number(halfUp(operating * 100n, debtService));
  return { operatingCashFlowMinor: operating, debtServiceMinor: debtService, ratioX100: ratio, minRequiredX100: minX100, warn: ratio < minX100 };
}
const x100 = (n: number) => (n / 100).toFixed(2);

/**
 * Compare offers against not borrowing. `baseEvents` are the pending commitments already confirmed (for example an order),
 * including any financing repayments already planned: those count towards stacking.
 */
export function compareOffers(input: EngineInput, baseEvents: CommitmentEvent[], offers: FinancingOffer[], opts: CompareOptions): FundingComparison {
  const horizon = opts.horizonWeeks;
  const warnBps = opts.stackingWarnBps ?? DEFAULT_STACKING_WARN_BPS;
  const cap = opts.maxAnnualisedCostBps ?? null;
  const amountCap = opts.maxAmountMinor ?? null;
  for (const o of offers) if (o.currency !== input.currency) throw new Error(`Offer "${o.id}" is in ${o.currency} but the business reports in ${input.currency}`);

  const run = (events: CommitmentEvent[]) => buildForecast(input, { events, horizonWeeks: horizon });
  const baseFc = run(baseEvents);
  const doNotBorrow = summarise(baseFc);
  const weeklyInflow = sum(baseFc.weeks.map((w) => w.inflow)) / BigInt(horizon);
  const existing = repaymentsByWeek(input.asOf, horizon, baseEvents);
  const minDscr = opts.minDscrX100 ?? DEFAULT_MIN_DSCR_X100;
  // Operating cash flow = everything the forecast shows, with financing already planned taken back out (repayments added back, advances removed).
  const inWindow = (date: string) => { const w = Math.floor(diffDays(input.asOf, date) / 7); return w >= 0 && w < horizon; };
  const plannedFin = baseEvents.filter((e) => e.kind === "financing" && inWindow(e.date));
  const existingRepay = sum(plannedFin.filter((e) => e.amountMinor < 0n).map((e) => -e.amountMinor));
  const existingAdvance = sum(plannedFin.filter((e) => e.amountMinor > 0n).map((e) => e.amountMinor));
  const operating = sum(baseFc.weeks.map((w) => w.inflow - w.outflow)) + existingRepay - existingAdvance;

  const results: OfferResult[] = offers.map((o) => {
    const ev = offerEvents(o);
    const fc = run([...baseEvents, ...ev]);
    const summary = summarise(fc);
    const cost = costOf(o);
    const own = repaymentsByWeek(input.asOf, horizon, ev);
    const combined = new Map(existing);
    for (const [w, a] of own) combined.set(w, (combined.get(w) ?? 0n) + a);
    const stacking = stackingOf(combined, weeklyInflow, warnBps);
    const ownInWindow = sum(ev.filter((e) => e.amountMinor < 0n && inWindow(e.date)).map((e) => -e.amountMinor));
    const dscr = dscrOf(operating, existingRepay + ownInWindow, minDscr);
    const afterWindow = sum(o.repayments.filter((r) => !inWindow(r.date)).map((r) => r.amountMinor));
    const withinCostCap = cap === null ? null : cost.annualisedCostBps <= cap;
    const withinAmountCap = amountCap === null ? null : o.principalMinor <= amountCap;
    const warnings: string[] = [];
    if (dscr.warn) warnings.push(dscr.ratioX100 !== null && dscr.ratioX100 <= 0 ? "Operating cash flow in the window is not positive, so it cannot cover these repayments." : `Debt service coverage is ${x100(dscr.ratioX100 as number)} (lenders typically want ${x100(minDscr)} or more).`);
    if (withinAmountCap === false) warnings.push(`The amount advanced is above the funding limit you signed.`);
    if (afterWindow > 0n) warnings.push(`Part of the repayments fall after the ${horizon}-week window (last one ${cost.lastRepaymentDate}); the cost shown covers the whole term, the cash view only the window.`);
    if (withinCostCap === false) warnings.push(`Estimated annualised cost ${(cost.annualisedCostBps / 100).toFixed(1)}% is above your limit of ${((cap as number) / 100).toFixed(1)}%.`);
    if (summary.firstNegativeWeek !== null) warnings.push(`Cash still goes below zero in week ${summary.firstNegativeWeek} with this offer.`);
    if (diffDays(input.asOf, o.disbursementDate) < 0) warnings.push("The advance is dated before today.");
    return {
      offerId: o.id, lender: o.lender, product: o.product, cost, summary,
      lowestBalanceImprovementMinor: summary.minBalanceMinor - doNotBorrow.minBalanceMinor,
      stacking, dscr, repaymentsAfterWindowMinor: afterWindow, repaymentsByWeek: [...own].sort((a, b) => a[0] - b[0]).map(([week, amountMinor]) => ({ week, amountMinor })), withinCostCap, withinAmountCap, warnings,
    };
  });

  let allTogether: FundingComparison["allTogether"] = null;
  if (offers.length > 1) {
    const ev = offers.flatMap(offerEvents);
    const summary = summarise(run([...baseEvents, ...ev]));
    const combined = new Map(existing);
    for (const [w, a] of repaymentsByWeek(input.asOf, horizon, ev)) combined.set(w, (combined.get(w) ?? 0n) + a);
    const stacking = stackingOf(combined, weeklyInflow, warnBps);
    const dscr = dscrOf(operating, existingRepay + sum(ev.filter((e) => e.amountMinor < 0n && inWindow(e.date)).map((e) => -e.amountMinor)), minDscr);
    const warnings = dscr.warn ? [`Taking all ${offers.length} offers: debt service coverage ${dscr.ratioX100 !== null && dscr.ratioX100 > 0 ? x100(dscr.ratioX100) : "is not positive"} against the ${x100(minDscr)} lenders typically want; the heaviest repayment week is week ${stacking.peakWeek}.`] : [];
    allTogether = { summary, stacking, dscr, warnings };
  }

  const order = results.map((r, i) => ({ r, i })).sort((a, b) => a.r.cost.annualisedCostBps - b.r.cost.annualisedCostBps || (a.r.cost.totalCostMinor < b.r.cost.totalCostMinor ? -1 : a.r.cost.totalCostMinor > b.r.cost.totalCostMinor ? 1 : 0) || a.i - b.i);
  return {
    currency: input.currency, horizonWeeks: horizon, doNotBorrow,
    borrowingNeeded: doNotBorrow.weeksBelowReserve > 0 || doNotBorrow.firstNegativeWeek !== null,
    offers: results, allTogether, cheapestFirst: order.map((x) => x.r.offerId),
  };
}
