// Financing-option matching. Pure and deterministic: integer minor units, no database, no clock, no model, no randomness.
// A synthetic lender catalogue + a business profile + (optionally) a funding need -> per product: a verdict, every criterion with the figures,
// the most the business qualifies for, an indicative offer sized to the need (in the existing FinancingOffer type, costed by the existing engine),
// and a ranking. Everything is indicative: no acceptance probabilities, no approval claims, and the catalogue is not a quote.
import { CATALOGUE_VERSION, CRITERION_UNITS, SYNTHETIC_NOTICE, type CriterionId, type LenderProduct } from "@/domain/lender-catalogue";
import { financingOfferSchema, type FinancingOffer, type FinancingProduct } from "@/domain/financing-offer";
import { formatMoney, money } from "@/lib/money";
import { addDays, addMonths } from "../dates";
import { costOf, equalInstalments, splitTotal, totalFromFactorRate } from "./compare";
import type { BusinessProfile } from "./profile";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
/** A near miss: exactly one criterion failed, and by no more than this share of what was required (25%). */
export const NEAR_MISS_MAX_RELATIVE_BPS = 2500;
const ORDER_MIN_WAIT_DAYS = 30;
const SCALE = 10n ** 24n; // fixed point for the instalment formula (integers only)

export type MatchVerdict = "eligible" | "near_miss" | "not_eligible";
export type RowId = CriterionId | "min_amount" | "currency";
export type RowStatus = "met" | "not_met" | "not_applicable";

export interface CriterionRow {
  id: RowId;
  label: string;
  op: "min" | "max";
  unit: "months" | "count" | "bps" | "money";
  required: bigint;
  /** Null when not applicable (for example a share of receivables when there are none). */
  actual: bigint | null;
  status: RowStatus;
  /** Plain-language sentence when not met (for example "Needs 6 months of history; you have 4."). Empty when met. */
  reason: string;
  /** Where the figure comes from when that matters ("Declared by the owner, not verified."); null otherwise. */
  note: string | null;
}

export interface MatchResult {
  productId: string;
  lenderName: string;
  kind: LenderProduct["kind"];
  label: string;
  verdict: MatchVerdict;
  criteria: CriterionRow[];
  reason: string;
  /** The most the business qualifies for on this product (product maximum and its caps), regardless of the other criteria. */
  maxQualifyingMinor: bigint;
  /** Amount sized to the need (credit line: the limit). Null when no offer can be sized or the verdict is not_eligible. */
  sizedAmountMinor: bigint | null;
  /** True when the sized amount covers the need; false when capped below it; null when there is no need or no offer. */
  coversNeed: boolean | null;
  /** The indicative offer in the existing offer type (credit line: principal is the amount drawn). Null for not_eligible. */
  offer: FinancingOffer | null;
  netReceivedMinor: bigint | null;
  totalCostMinor: bigint | null;
  annualisedCostBps: number | null;
  disbursementDays: number;
  executable: boolean;
  rank: number;
  indicative: true;
  synthetic: true;
  notice: string;
}

export interface MatchOutput {
  catalogueVersion: string;
  asOf: string;
  currency: string;
  /** The funding need the offers were sized to; null = sized to each product's default amount. */
  needMinor: bigint | null;
  results: MatchResult[];
}

const cash = (v: bigint, cur: string) => formatMoney(money(v, cur), EXPONENTS[cur] ?? 2);
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

// ------------------------------------------------------------------------------------------------------------------ eligibility

const CRITERION_LABEL: Record<CriterionId, string> = {
  history_months: "Months of trading history", open_invoices: "Open invoices", top_customer_share: "Largest customer's share of open receivables",
  overdue_30_share: "Receivables more than 30 days overdue", annual_turnover: "Yearly customer receipts", confirmed_order: "Confirmed customer orders",
};

function actualOf(id: CriterionId, p: BusinessProfile): bigint | null {
  switch (id) {
    case "history_months": return BigInt(p.monthsOfHistory);
    case "open_invoices": return BigInt(p.openInvoiceCount);
    case "top_customer_share": return p.openInvoiceCount > 0 ? BigInt(p.topCustomerShareBps) : null;
    case "overdue_30_share": return p.openInvoiceCount > 0 ? BigInt(p.overdueOver30ShareBps) : null;
    case "annual_turnover": return p.annualisedTurnoverMinor;
    case "confirmed_order": return BigInt(p.confirmedOrder?.count ?? 0);
  }
}

function reasonFor(id: CriterionId, required: bigint, actual: bigint, p: BusinessProfile): string {
  const cur = p.currency;
  switch (id) {
    case "history_months": return `Needs ${required} months of history; you have ${actual}${p.historySource === "declared" ? " (declared by you, not verified)" : ""}.`;
    case "open_invoices": return `Needs at least ${required} open invoices; you have ${actual}.`;
    case "top_customer_share": return `No single customer may be more than ${pct(required)} of your open receivables; your largest${p.topCustomerName ? ` (${p.topCustomerName})` : ""} is ${pct(actual)}.`;
    case "overdue_30_share": return `No more than ${pct(required)} of your open receivables may be over 30 days overdue; yours is ${pct(actual)}.`;
    case "annual_turnover": return `Needs yearly customer receipts of at least ${cash(required, cur)}; yours are about ${cash(actual, cur)}${p.turnoverAnnualisedFromShortHistory ? ` (estimated from ${p.bankMonthsOfHistory} months of bank data)` : ""}.`;
    case "confirmed_order": return `Needs a confirmed customer order; you have ${actual === 0n ? "none" : actual}.`;
  }
}

/** The most the business qualifies for on this product: its own maximum, the advance share of what it is advanced against, and any turnover cap. */
export function maxQualifying(p: LenderProduct, profile: BusinessProfile): bigint {
  let cap = p.amountMaxMinor;
  const pr = p.pricing;
  if (pr.kind === "invoice_fee") cap = min(cap, (profile.openReceivablesMinor * BigInt(pr.advanceBps)) / 10_000n);
  if (pr.kind === "order_fee") cap = min(cap, profile.confirmedOrder ? (profile.confirmedOrder.largestValueMinor * BigInt(pr.advanceBps)) / 10_000n : 0n);
  if (p.turnoverMonthsCap !== null) cap = min(cap, (profile.annualisedTurnoverMinor * BigInt(p.turnoverMonthsCap)) / 12n);
  return cap;
}
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

function noteFor(id: CriterionId, p: BusinessProfile): string | null {
  if (id === "history_months") return p.historySource === "declared" ? "Declared by the owner, not verified." : "From your bank statement.";
  if (id === "annual_turnover" && p.turnoverAnnualisedFromShortHistory) return `Estimated from ${p.bankMonthsOfHistory} months of bank data.`;
  return null;
}

function rowsFor(p: LenderProduct, profile: BusinessProfile, cap: bigint): CriterionRow[] {
  const rows: CriterionRow[] = p.criteria.map((c) => {
    const actual = actualOf(c.id, profile);
    const met = actual === null ? null : c.op === "min" ? actual >= c.value : actual <= c.value;
    const status: RowStatus = met === null ? "not_applicable" : met ? "met" : "not_met";
    return { id: c.id, label: CRITERION_LABEL[c.id], op: c.op, unit: CRITERION_UNITS[c.id], required: c.value, actual, status, reason: status === "not_met" ? reasonFor(c.id, c.value, actual as bigint, profile) : "", note: noteFor(c.id, profile) };
  });
  // The amount the business qualifies for must reach the product's minimum.
  const basis = p.pricing.kind === "invoice_fee" ? profile.openInvoiceCount > 0 : p.pricing.kind === "order_fee" ? profile.confirmedOrder !== null : true;
  const status: RowStatus = !basis ? "not_applicable" : cap >= p.amountMinMinor ? "met" : "not_met";
  rows.push({
    id: "min_amount", label: "Most you could borrow", op: "min", unit: "money", required: p.amountMinMinor, actual: basis ? cap : null, status,
    reason: status === "not_met" ? `The most you qualify for is ${cash(cap, profile.currency)}, below the product minimum of ${cash(p.amountMinMinor, profile.currency)}.` : "", note: null,
  });
  return rows;
}

/** Relative miss in basis points of the required value (rounded up); only meaningful for a not-met row. */
function relativeMissBps(r: CriterionRow): bigint {
  const diff = r.op === "min" ? r.required - (r.actual as bigint) : (r.actual as bigint) - r.required;
  return r.required === 0n ? 10_000n : ceilDiv(diff * 10_000n, r.required);
}

// ------------------------------------------------------------------------------------------------------------------ sizing and offers

/** Smallest amount that covers the need, in the product's step, inside [min, cap]. */
function sizeAmount(p: LenderProduct, cap: bigint, need: bigint | null): { amount: bigint; covers: boolean | null } | null {
  if (cap < p.amountMinMinor) return null;
  if (need === null) return { amount: min(p.defaultAmountMinor, cap), covers: null };
  if (need > cap) return { amount: cap, covers: false };
  return { amount: min(cap, max(p.amountMinMinor, ceilDiv(need, p.stepMinor) * p.stepMinor)), covers: true };
}

/** Monthly instalment on a reducing balance, integers only. Interest accrues (and is added to the balance) during `holiday` months. */
export function instalmentMinor(principal: bigint, aprBps: number, count: number, holiday: number): bigint {
  const rM = (BigInt(aprBps) * SCALE) / 120_000n; // monthly rate, fixed point
  const grow = (k: number) => { let f = SCALE; for (let i = 0; i < k; i++) f = (f * (SCALE + rM)) / SCALE; return f; };
  const balance = (principal * grow(holiday)) / SCALE;
  if (rM === 0n) return ceilDiv(balance, BigInt(count));
  const f = grow(count);
  return halfUp(balance * rM * f, SCALE * (f - SCALE));
}

const PRODUCT_OF: Record<LenderProduct["kind"], FinancingProduct> = {
  invoice_finance: "invoice_finance", order_finance: "other", working_capital_loan: "term_loan", seasonal_loan: "term_loan", revolving_line: "overdraft", revenue_advance: "merchant_advance",
};

function buildOffer(p: LenderProduct, profile: BusinessProfile, amount: bigint, need: bigint | null): FinancingOffer | null {
  const pr = p.pricing;
  const disbursement = addDays(profile.asOf, p.disbursementDays);
  let principal = amount;
  let upfront = 0n;
  let repayments: { date: string; amountMinor: bigint }[];
  if (pr.kind === "invoice_fee") {
    const face = ceilDiv(amount * 10_000n, BigInt(pr.advanceBps)); // invoices the advance is taken against
    upfront = halfUp(face * BigInt(pr.feeBpsOfFaceValue), 10_000n); // fee on the face value, taken from the advance (as the sandbox lender does)
    repayments = [{ date: addDays(disbursement, pr.collectionDays), amountMinor: amount }];
  } else if (pr.kind === "order_fee") {
    if (!profile.confirmedOrder) return null;
    upfront = halfUp(amount * BigInt(pr.feeBpsOfAdvance), 10_000n);
    const due = profile.confirmedOrder.receiptDate > addDays(disbursement, ORDER_MIN_WAIT_DAYS) ? profile.confirmedOrder.receiptDate : addDays(disbursement, ORDER_MIN_WAIT_DAYS);
    repayments = [{ date: due, amountMinor: amount }]; // repaid when the customer pays
  } else if (pr.kind === "amortising") {
    const count = pr.termMonths - pr.holidayMonths;
    repayments = equalInstalments(addMonths(disbursement, pr.holidayMonths + 1), count, "monthly", instalmentMinor(amount, pr.aprBps, count, pr.holidayMonths));
  } else if (pr.kind === "revolving") {
    principal = need !== null && need > 0n ? min(amount, need) : amount; // the limit is `amount`; interest runs on what is drawn
    upfront = halfUp(amount * BigInt(pr.arrangementBpsOfLimit), 10_000n);
    const interest = max(1n, halfUp(principal * BigInt(pr.aprBps), 120_000n));
    repayments = Array.from({ length: pr.termMonths }, (_, i) => ({ date: addMonths(disbursement, i + 1), amountMinor: i === pr.termMonths - 1 ? interest + principal : interest }));
  } else {
    repayments = splitTotal(addMonths(disbursement, 1), pr.instalments, "monthly", totalFromFactorRate(amount, pr.factorThousandths));
  }
  const parsed = financingOfferSchema.safeParse({
    id: p.id, lender: p.lenderName, product: PRODUCT_OF[p.kind], currency: profile.currency, principalMinor: principal.toString(), upfrontFeesMinor: upfront.toString(),
    disbursementDate: disbursement, repayments: repayments.map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() })),
  });
  if (!parsed.success) throw new Error(`Catalogue product ${p.id} produced an invalid offer: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

// ------------------------------------------------------------------------------------------------------------------ matching and ranking

function matchOne(p: LenderProduct, profile: BusinessProfile, need: bigint | null): Omit<MatchResult, "rank"> {
  const common = { productId: p.id, lenderName: p.lenderName, kind: p.kind, label: p.label, disbursementDays: p.disbursementDays, executable: p.executable, indicative: true as const, synthetic: true as const, notice: SYNTHETIC_NOTICE };
  const none = { sizedAmountMinor: null, coversNeed: null, offer: null, netReceivedMinor: null, totalCostMinor: null, annualisedCostBps: null };
  if (profile.currency !== p.currency) {
    const reason = `The catalogue is in ${p.currency}; your books are in ${profile.currency}.`;
    return { ...common, ...none, verdict: "not_eligible", maxQualifyingMinor: 0n, reason, criteria: [{ id: "currency", label: "Currency", op: "min", unit: "count", required: 0n, actual: null, status: "not_met", reason, note: null }] };
  }
  const cap = maxQualifying(p, profile);
  const criteria = rowsFor(p, profile, cap);
  const failed = criteria.filter((r) => r.status === "not_met");
  const verdict: MatchVerdict = failed.length === 0 ? "eligible" : failed.length === 1 && relativeMissBps(failed[0]) <= BigInt(NEAR_MISS_MAX_RELATIVE_BPS) ? "near_miss" : "not_eligible";
  const reason = verdict === "eligible"
    ? `You meet all ${criteria.filter((r) => r.status !== "not_applicable").length} requirements. The most you qualify for is ${cash(cap, profile.currency)}.`
    : verdict === "near_miss" ? `Close: ${failed[0].reason.charAt(0).toLowerCase()}${failed[0].reason.slice(1)}`
    : `Not eligible: ${failed.map((r) => r.reason).join(" ")}`;
  if (verdict === "not_eligible") return { ...common, ...none, verdict, maxQualifyingMinor: cap, criteria, reason };
  const sized = sizeAmount(p, cap, need !== null && need > 0n ? need : null);
  if (!sized) return { ...common, ...none, verdict, maxQualifyingMinor: cap, criteria, reason };
  const offer = buildOffer(p, profile, sized.amount, need);
  if (!offer) return { ...common, ...none, verdict, maxQualifyingMinor: cap, criteria, reason };
  const cost = costOf(offer);
  return { ...common, verdict, maxQualifyingMinor: cap, criteria, reason, sizedAmountMinor: sized.amount, coversNeed: sized.covers, offer, netReceivedMinor: cost.netReceivedMinor, totalCostMinor: cost.totalCostMinor, annualisedCostBps: cost.annualisedCostBps };
}

const TIER: Record<MatchVerdict, number> = { eligible: 0, near_miss: 1, not_eligible: 2 };
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function matchProducts(profile: BusinessProfile, catalogue: readonly LenderProduct[], need: bigint | null): MatchOutput {
  const raw = catalogue.map((p) => matchOne(p, profile, need));
  const ordered = [...raw].sort((a, b) =>
    TIER[a.verdict] - TIER[b.verdict]
    || (a.coversNeed === b.coversNeed ? 0 : a.coversNeed === false ? 1 : b.coversNeed === false ? -1 : 0) // covering the need first (no need given: no effect)
    || (a.verdict === "not_eligible" ? 0 : (need === null || need <= 0n ? (a.annualisedCostBps ?? 0) - (b.annualisedCostBps ?? 0) : cmpBig(a.totalCostMinor ?? 0n, b.totalCostMinor ?? 0n)) || a.disbursementDays - b.disbursementDays)
    || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
  );
  return {
    catalogueVersion: CATALOGUE_VERSION, asOf: profile.asOf, currency: profile.currency, needMinor: need !== null && need > 0n ? need : null,
    results: ordered.map((r, i) => ({ ...r, rank: i + 1 })),
  };
}
