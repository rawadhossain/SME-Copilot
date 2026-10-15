// Plan terms: what the owner's signature covers besides the plan itself (ADR-016). PURE: no database, no clock.
// For every lever: the exact request that will be sent and the worst counter or offer the owner accepts in advance
// (the bound). With zero tolerance the bound equals the lever, so only an exact acceptance continues. Everything here
// is structured data; counterparty free text never enters.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Constraint } from "@/domain/constraints";
import { sortLevers, type Lever } from "@/domain/plan";
import type { CommitmentEvent } from "@/domain/commitment-event";
import { FINANCE_FEE_BPS_ASSUMPTION, financedInvoiceMinor, leverToRequest } from "@/engine/plans";
import { canonicalize } from "@/gate/canonical";
import { requestSchema, type GateRequest, type GateRequestJson } from "@/gate/request";

export const sha256Hex = (x: unknown): string => createHash("sha256").update(canonicalize(x), "utf8").digest("hex");

/** Hash of the plan's levers (sorted, so order does not matter). */
export const leversHashOf = (levers: Lever[]): string => sha256Hex(sortLevers(levers));

/** How far from the lever's own terms the owner lets the agent accept a counter or offer. All zero by default. */
export const tolerancesSchema = z
  .object({
    supplierDepositBps: z.number().int().min(0).max(10000).default(0),
    deferralDays: z.number().int().min(0).max(180).default(0),
    buyerDepositBps: z.number().int().min(0).max(10000).default(0),
    financeFeeBps: z.number().int().min(0).max(10000).default(0),
    chaseDays: z.number().int().min(0).max(30).default(0),
    discountBps: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export type Tolerances = z.output<typeof tolerancesSchema>;

export type Bound =
  | { kind: "supplier_reduce_deposit"; maxPercentBps: number } // a counter deposit at or below this is acceptable
  | { kind: "supplier_defer_balance"; minDays: number } // a counter deferral at or above this is acceptable
  | { kind: "buyer_request_deposit"; minPercentBps: number } // a counter deposit at or above this is acceptable
  | { kind: "finance_invoice"; maxFeeBps: number; /** The largest invoice the application may be for (minor units, string): the receipt less the smallest buyer deposit the signed bounds allow (ADR-025). Absent: the request amount. */ maxInvoiceMinor?: string } // an offer with a fee at or below this is acceptable
  | { kind: "chase_overdue"; maxDays: number } // a counter of "pay within N days" with N at or below this is acceptable
  | { kind: "early_payment_discount"; maxDiscountBps: number }; // a counter discount at or below this is acceptable

export interface TermsEntry {
  index: number;
  lever: Lever;
  /** The exact request (wire form: money as strings). */
  request: GateRequestJson;
  bound: Bound;
}

export interface PlanTerms {
  version: 1;
  entries: TermsEntry[];
  /** How many confirmations the owner gave. Payments above the mandate threshold need 2 (ADR-019). */
  confirmations: 1 | 2;
}

export const termsHashOf = (terms: PlanTerms): string => sha256Hex(terms);

export function buildTerms(levers: Lever[], baseEvents: CommitmentEvent[], tolerances: Tolerances, mandateFeeCapBps: number, baseFeeBps: number = FINANCE_FEE_BPS_ASSUMPTION, confirmations: 1 | 2 = 1): PlanTerms {
  const sorted = sortLevers(levers);
  const entries = sorted.map((lever, index): TermsEntry => {
    const request = leverToRequest(lever, baseEvents, sorted);
    if (!request) throw new Error(`The ${lever.kind} lever cannot be turned into a request (the order data it needs is missing)`);
    let bound: Bound;
    switch (lever.kind) {
      case "supplier_reduce_deposit": bound = { kind: lever.kind, maxPercentBps: Math.min(10000, lever.percentBps + tolerances.supplierDepositBps) }; break;
      case "supplier_defer_balance": bound = { kind: lever.kind, minDays: Math.max(1, lever.daysAfterShipment - tolerances.deferralDays) }; break;
      case "buyer_request_deposit": bound = { kind: lever.kind, minPercentBps: Math.max(1, lever.percentBps - tolerances.buyerDepositBps) }; break;
      case "finance_invoice": {
        // ADR-025: if the plan also asks a buyer for a deposit, the application may be re-submitted for the recomputed invoice,
        // up to the invoice that the smallest deposit the signed bounds allow would leave.
        const buyer = sorted.find((l) => l.kind === "buyer_request_deposit");
        const worst = buyer && buyer.kind === "buyer_request_deposit" ? [{ ...buyer, percentBps: Math.max(1, buyer.percentBps - tolerances.buyerDepositBps) }] : sorted;
        const maxInv = financedInvoiceMinor(baseEvents, worst);
        bound = { kind: lever.kind, maxFeeBps: Math.min(mandateFeeCapBps, baseFeeBps + tolerances.financeFeeBps), ...(maxInv ? { maxInvoiceMinor: maxInv.amountMinor.toString() } : {}) };
        break;
      }
      case "chase_overdue": bound = { kind: lever.kind, maxDays: Math.min(30, lever.payWithinDays + tolerances.chaseDays) }; break;
      case "early_payment_discount": bound = { kind: lever.kind, maxDiscountBps: Math.min(10000, lever.discountBps + tolerances.discountBps) }; break;
    }
    return { index, lever, request, bound };
  });
  return { version: 1, entries, confirmations };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export type BranchVerdict =
  | { verdict: "agreed" }
  | { verdict: "counter_in_terms"; counterRequest: GateRequestJson; counterTerms: Record<string, number> }
  | { verdict: "offer_in_terms" }
  | { verdict: "out_of_terms"; reason: string; /** Structured numbers the counterparty put in its reply, for re-planning. */ observed?: Record<string, number> }
  | { verdict: "rejected"; reason: string };

/** Classifies a counterparty's structured reply to a send_proposal. Free text is never read. */
export function classifyProposalReply(entry: TermsEntry, reply: { outcome: string; terms: Record<string, unknown> | null }): BranchVerdict {
  const req = requestSchema.parse(entry.request);
  if (req.kind !== "sandbox.send_proposal") return { verdict: "out_of_terms", reason: "not a proposal lever" };
  const asked = req.proposal;
  const t = reply.terms ?? {};
  if (reply.outcome === "reject" || reply.outcome === "decline") return { verdict: "rejected", reason: `the counterparty ${reply.outcome}ed the proposal` };
  if (reply.outcome !== "accept" && reply.outcome !== "counter") return { verdict: "out_of_terms", reason: `unexpected outcome "${reply.outcome}"` };

  const b = entry.bound;
  const counterValue = (field: string) => num(t[field]);
  if (asked.kind === "supplier.reduce_deposit" && b.kind === "supplier_reduce_deposit") {
    const v = counterValue("percentBps");
    if (reply.outcome === "accept") return v === asked.percentBps ? { verdict: "agreed" } : { verdict: "out_of_terms", reason: "the accepted terms differ from the proposal" };
    if (v === null) return { verdict: "out_of_terms", reason: "the counter has no usable terms" };
    return v <= b.maxPercentBps && v >= asked.percentBps
      ? { verdict: "counter_in_terms", counterTerms: { percentBps: v }, counterRequest: { kind: "sandbox.send_proposal", counterpartyId: req.counterpartyId, proposal: { kind: "supplier.reduce_deposit", percentBps: v } } }
      : { verdict: "out_of_terms", reason: `counter deposit ${v / 100}% is above the authorised ${b.maxPercentBps / 100}%`, observed: { percentBps: v } };
  }
  if (asked.kind === "supplier.defer_balance" && b.kind === "supplier_defer_balance") {
    const v = counterValue("daysAfterShipment");
    if (reply.outcome === "accept") return v === asked.daysAfterShipment ? { verdict: "agreed" } : { verdict: "out_of_terms", reason: "the accepted terms differ from the proposal" };
    if (v === null) return { verdict: "out_of_terms", reason: "the counter has no usable terms" };
    return v >= b.minDays && v <= asked.daysAfterShipment
      ? { verdict: "counter_in_terms", counterTerms: { daysAfterShipment: v }, counterRequest: { kind: "sandbox.send_proposal", counterpartyId: req.counterpartyId, proposal: { kind: "supplier.defer_balance", daysAfterShipment: v } } }
      : { verdict: "out_of_terms", reason: `counter deferral of ${v} days is below the authorised ${b.minDays} days`, observed: { daysAfterShipment: v } };
  }
  if (asked.kind === "buyer.request_deposit" && b.kind === "buyer_request_deposit") {
    const v = counterValue("percentBps");
    if (reply.outcome === "accept") return v === asked.percentBps ? { verdict: "agreed" } : { verdict: "out_of_terms", reason: "the accepted terms differ from the proposal" };
    if (v === null) return { verdict: "out_of_terms", reason: "the counter has no usable terms" };
    return v >= b.minPercentBps && v <= asked.percentBps
      ? { verdict: "counter_in_terms", counterTerms: { percentBps: v }, counterRequest: { kind: "sandbox.send_proposal", counterpartyId: req.counterpartyId, proposal: { kind: "buyer.request_deposit", percentBps: v } } }
      : { verdict: "out_of_terms", reason: `counter deposit ${v / 100}% is below the authorised ${b.minPercentBps / 100}%`, observed: { percentBps: v } };
  }
  if (asked.kind === "buyer.chase_payment" && b.kind === "chase_overdue") {
    const v = counterValue("payWithinDays");
    if (reply.outcome === "accept") return v === asked.payWithinDays ? { verdict: "agreed" } : { verdict: "out_of_terms", reason: "the accepted terms differ from the proposal" };
    if (v === null) return { verdict: "out_of_terms", reason: "the counter has no usable terms" };
    return v >= asked.payWithinDays && v <= b.maxDays
      ? { verdict: "counter_in_terms", counterTerms: { payWithinDays: v }, counterRequest: { kind: "sandbox.send_proposal", counterpartyId: req.counterpartyId, proposal: { kind: "buyer.chase_payment", payWithinDays: v } } }
      : { verdict: "out_of_terms", reason: `the buyer will only pay within ${v} days; the authorised limit is ${b.maxDays} days`, observed: { payWithinDays: v } };
  }
  if (asked.kind === "buyer.request_early_payment" && b.kind === "early_payment_discount") {
    const d = counterValue("discountBps");
    const days = counterValue("daysEarly");
    if (reply.outcome === "accept") return d === asked.discountBps && days === asked.daysEarly ? { verdict: "agreed" } : { verdict: "out_of_terms", reason: "the accepted terms differ from the proposal" };
    if (d === null || days !== asked.daysEarly) return { verdict: "out_of_terms", reason: "the counter has no usable terms" };
    return d >= asked.discountBps && d <= b.maxDiscountBps
      ? { verdict: "counter_in_terms", counterTerms: { daysEarly: days, discountBps: d }, counterRequest: { kind: "sandbox.send_proposal", counterpartyId: req.counterpartyId, proposal: { kind: "buyer.request_early_payment", daysEarly: days, discountBps: d } } }
      : { verdict: "out_of_terms", reason: `the buyer wants a ${d / 100}% discount; the authorised limit is ${b.maxDiscountBps / 100}%`, observed: { discountBps: d } };
  }
  return { verdict: "out_of_terms", reason: "the reply does not fit the lever" };
}

/** Classifies the lender's answer to the application (the offer's real advance and fee come from the lender, not the plan). */
export function classifyOffer(entry: TermsEntry, app: { status: string; advanceBps: number | null; feeBps: number | null }): BranchVerdict {
  if (entry.bound.kind !== "finance_invoice" || entry.lever.kind !== "finance_invoice") return { verdict: "out_of_terms", reason: "not a finance lever" };
  if (app.status === "declined") return { verdict: "rejected", reason: "the lender declined the application" };
  if (app.status !== "offered" || app.advanceBps === null || app.feeBps === null) return { verdict: "out_of_terms", reason: `the application is ${app.status}` };
  if (app.advanceBps !== entry.lever.advanceBps) return { verdict: "out_of_terms", reason: `offered advance ${app.advanceBps / 100}% differs from the authorised ${entry.lever.advanceBps / 100}%`, observed: { advanceBps: app.advanceBps, feeBps: app.feeBps } };
  if (app.feeBps > entry.bound.maxFeeBps) return { verdict: "out_of_terms", reason: `fee ${app.feeBps / 100}% is above the authorised ${entry.bound.maxFeeBps / 100}%`, observed: { advanceBps: app.advanceBps, feeBps: app.feeBps } };
  return { verdict: "offer_in_terms" };
}

/** Is this exact request covered by the signed terms? (An exact lever request, or an in-bound counter of a proposal lever.) */
export function permits(terms: PlanTerms, request: GateRequest): boolean {
  return terms.entries.some((e) => {
    const authorised = requestSchema.parse(e.request);
    if (request.kind === "sandbox.submit_application" && authorised.kind === "sandbox.submit_application") {
      // ADR-025: the amount may be recomputed after a buyer counter, but never above the maximum the owner signed.
      const maxInv = e.bound.kind === "finance_invoice" && e.bound.maxInvoiceMinor ? BigInt(e.bound.maxInvoiceMinor) : authorised.invoiceAmountMinor;
      return request.lenderId === authorised.lenderId && request.invoiceAmountMinor >= authorised.invoiceAmountMinor && request.invoiceAmountMinor <= maxInv && request.advanceBps === authorised.advanceBps;
    }
    if (request.kind !== "sandbox.send_proposal" || authorised.kind !== "sandbox.send_proposal") return false;
    if (request.counterpartyId !== authorised.counterpartyId || request.proposal.kind !== authorised.proposal.kind) return false;
    if (canonicalize(request.proposal) === canonicalize(authorised.proposal)) return true;
    const p = request.proposal;
    const b = e.bound;
    switch (p.kind) {
      case "supplier.reduce_deposit": return b.kind === "supplier_reduce_deposit" && authorised.proposal.kind === p.kind && p.percentBps >= authorised.proposal.percentBps && p.percentBps <= b.maxPercentBps;
      case "supplier.defer_balance": return b.kind === "supplier_defer_balance" && authorised.proposal.kind === p.kind && p.daysAfterShipment <= authorised.proposal.daysAfterShipment && p.daysAfterShipment >= b.minDays;
      case "buyer.request_deposit": return b.kind === "buyer_request_deposit" && authorised.proposal.kind === p.kind && p.percentBps <= authorised.proposal.percentBps && p.percentBps >= b.minPercentBps;
      case "buyer.chase_payment": return b.kind === "chase_overdue" && authorised.proposal.kind === p.kind && p.payWithinDays >= authorised.proposal.payWithinDays && p.payWithinDays <= b.maxDays;
      case "buyer.request_early_payment": return b.kind === "early_payment_discount" && authorised.proposal.kind === p.kind && p.daysEarly === authorised.proposal.daysEarly && p.discountBps >= authorised.proposal.discountBps && p.discountBps <= b.maxDiscountBps;
      default: return false;
    }
  });
}

/** May the finance offer of this application be taken up (or, afterwards, was it legitimately taken up)? Lender, amount, advance and fee must all fit the signed terms. */
export function permitsAcceptOffer(terms: PlanTerms, app: { lenderId: string; requestedAmountMinor: bigint; status: string; advanceBps: number | null; feeBps: number | null }): boolean {
  return terms.entries.some((e) => {
    const authorised = requestSchema.parse(e.request);
    return authorised.kind === "sandbox.submit_application" && authorised.lenderId === app.lenderId && app.requestedAmountMinor >= authorised.invoiceAmountMinor && app.requestedAmountMinor <= (e.bound.kind === "finance_invoice" && e.bound.maxInvoiceMinor ? BigInt(e.bound.maxInvoiceMinor) : authorised.invoiceAmountMinor) && classifyOffer(e, { ...app, status: app.status === "accepted" ? "offered" : app.status }).verdict === "offer_in_terms";
  });
}

/** Withdrawal is compensation: it may only undo something with a counterparty named in the signed terms. */
export function permitsWithdrawFor(terms: PlanTerms, counterpartyId: string): boolean {
  return terms.entries.some((e) => {
    const r = requestSchema.parse(e.request);
    return (r.kind === "sandbox.send_proposal" && r.counterpartyId === counterpartyId) || (r.kind === "sandbox.submit_application" && r.lenderId === counterpartyId);
  });
}

/**
 * The structured constraint a refused or out-of-terms branch teaches (ADR-021). Built ONLY from the lever, the verdict and the
 * numbers the counterparty put in its structured reply; reason strings are written by this code and are not parsed.
 */
export function constraintFrom(entry: TermsEntry, verdict: BranchVerdict, round: number): Constraint | null {
  if (verdict.verdict !== "rejected" && verdict.verdict !== "out_of_terms") return null;
  const r = requestSchema.parse(entry.request);
  const counterpartyId = r.kind === "sandbox.send_proposal" ? r.counterpartyId : r.kind === "sandbox.submit_application" ? r.lenderId : null;
  if (!counterpartyId) return null;
  const base = { kind: entry.lever.kind, counterpartyId, excluded: false, round } as const;
  if (verdict.verdict === "rejected") return { ...base, excluded: true, source: entry.lever.kind === "finance_invoice" ? "decline" : "reject" };
  const o = verdict.observed;
  if (!o) return { ...base, excluded: true, source: "counter" };
  switch (entry.lever.kind) {
    case "supplier_reduce_deposit": return o.percentBps !== undefined ? { ...base, minPercentBps: o.percentBps, source: "counter" } : null;
    case "supplier_defer_balance": return o.daysAfterShipment !== undefined ? { ...base, maxDays: o.daysAfterShipment, source: "counter" } : null;
    case "buyer_request_deposit": return o.percentBps !== undefined ? { ...base, maxPercentBps: o.percentBps, source: "counter" } : null;
    case "chase_overdue": return o.payWithinDays !== undefined ? { ...base, minDays: o.payWithinDays, source: "counter" } : null;
    case "early_payment_discount": return o.discountBps !== undefined ? { ...base, minDiscountBps: o.discountBps, source: "counter" } : null;
    case "finance_invoice":
      // A different fee is a new cost assumption; a different advance means this lever as asked is not on offer.
      return o.advanceBps === entry.lever.advanceBps && o.feeBps !== undefined ? { ...base, assumedFeeBps: o.feeBps, source: "offer" } : { ...base, excluded: true, source: "offer" };
  }
}
