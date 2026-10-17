// What a plan WOULD schedule if every counterparty accepts the terms exactly as asked (Rescue My Cash Flow, signing review). PURE: no database, no clock.
// It uses the same engine step the executor uses to work out the schedule after an agreement (applyTermChanges) and the same "events that exist only
// because of the agreed changes" rule (expectedSchedule), fed with the signed terms instead of the recorded answers. Money stays integer minor units.
// Nothing here is an agreement or a guarantee: it is shown to the owner as "proposed", and the executor still schedules only what the real answers imply.
import type { CommitmentEvent } from "@/domain/commitment-event";
import { applyTermChanges, type TermChanges } from "@/engine";
import { requestSchema } from "@/gate/request";
import type { PlanTerms } from "./plan-terms";

export interface ProjectedItem {
  direction: "payment" | "receipt";
  date: string;
  /** Positive minor units. */
  amountMinor: string;
  currency: string;
  counterpartyId: string;
  /** Plain words for what the money is. */
  purpose: string;
}

export interface ProjectedFee {
  counterpartyId: string;
  invoiceMinor: string;
  /** The highest fee the owner's signed terms allow, in basis points of the invoice, and what that is in money. */
  maxFeeBps: number;
  maxFeeMinor: string;
  currency: string;
}

export interface Projection {
  items: ProjectedItem[];
  fees: ProjectedFee[];
  /** Sum of receipts less sum of payments among the items, minor units (signed string). */
  netMinor: string;
  /** Set when the terms cannot be applied to the confirmed order (the items are then empty). */
  problem: string | null;
}

/** The term changes the plan asks for. A finance lever uses the HIGHEST fee the signed terms allow, so the projection is never rosier than the terms. */
export function changesFromTerms(terms: PlanTerms): TermChanges {
  const c: TermChanges = {};
  for (const e of terms.entries) {
    const l = e.lever;
    switch (l.kind) {
      case "supplier_reduce_deposit": c.supplierDepositBps = l.percentBps; break;
      case "supplier_defer_balance": c.supplierBalanceDeferralDays = l.daysAfterShipment; break;
      case "buyer_request_deposit": c.buyerDepositBps = l.percentBps; break;
      case "finance_invoice": c.invoiceFinance = { advanceBps: l.advanceBps, feeBps: e.bound.kind === "finance_invoice" ? e.bound.maxFeeBps : 0 }; break;
      case "chase_overdue": c.chase = { counterpartyId: l.counterpartyId, payWithinDays: l.payWithinDays }; break;
      case "early_payment_discount": c.earlyPayment = { counterpartyId: l.counterpartyId, daysEarly: l.daysEarly, discountBps: l.discountBps }; break;
    }
  }
  return c;
}

const PURPOSE: Record<string, string> = {
  supplier_deposit: "Supplier deposit", supplier_balance: "Supplier balance", financing: "Invoice-finance advance from the lender", customer_receipt: "Payment from the customer",
};

const sameEvent = (a: CommitmentEvent, b: CommitmentEvent) => a.kind === b.kind && a.date === b.date && a.amountMinor === b.amountMinor;

/** `parties` are the business's own supplier, buyer and lender: the executor falls back to them when the plan has no lever naming that side (same rule as expectedScheduleFor). */
export function projectPlan(terms: PlanTerms, base: CommitmentEvent[], parties: { supplierId: string | null; buyerId: string | null; lenderId: string | null }): Projection {
  const changes = changesFromTerms(terms);
  const entry = (kinds: string[]) => terms.entries.find((e) => kinds.includes(e.lever.kind));
  const who = {
    supplier: entry(["supplier_reduce_deposit", "supplier_defer_balance"])?.lever.counterpartyId ?? parties.supplierId,
    buyer: entry(["buyer_request_deposit"])?.lever.counterpartyId ?? parties.buyerId,
    lender: entry(["finance_invoice"])?.lever.counterpartyId ?? parties.lenderId,
  };
  const fees: ProjectedFee[] = [];
  for (const e of terms.entries) {
    if (e.lever.kind !== "finance_invoice" || e.bound.kind !== "finance_invoice") continue;
    const r = requestSchema.parse(e.request);
    if (r.kind !== "sandbox.submit_application") continue;
    // Integer arithmetic: fee = invoice x bps / 10,000, rounded half up like the engine's share().
    const fee = (r.invoiceAmountMinor * BigInt(e.bound.maxFeeBps) + 5000n) / 10000n;
    fees.push({ counterpartyId: r.lenderId, invoiceMinor: r.invoiceAmountMinor.toString(), maxFeeBps: e.bound.maxFeeBps, maxFeeMinor: fee.toString(), currency: base[0]?.currency ?? "GBP" });
  }
  if (Object.keys(changes).length === 0) return { items: [], fees, netMinor: "0", problem: null };
  let events: CommitmentEvent[];
  try {
    events = applyTermChanges(base, changes);
  } catch (e) {
    return { items: [], fees, netMinor: "0", problem: e instanceof Error ? e.message : "The terms cannot be applied to the confirmed order" };
  }
  const unmatched = [...base];
  const added: CommitmentEvent[] = [];
  for (const e of events) {
    const i = unmatched.findIndex((b) => sameEvent(b, e));
    if (i >= 0) unmatched.splice(i, 1);
    else added.push(e);
  }
  const items: ProjectedItem[] = [];
  for (const e of added) {
    if ((e.kind === "supplier_deposit" || e.kind === "supplier_balance") && e.amountMinor < 0n && who.supplier) items.push({ direction: "payment", date: e.date, amountMinor: (-e.amountMinor).toString(), currency: e.currency, counterpartyId: who.supplier, purpose: PURPOSE[e.kind] });
    else if (e.kind === "financing" && e.amountMinor > 0n && who.lender) items.push({ direction: "receipt", date: e.date, amountMinor: e.amountMinor.toString(), currency: e.currency, counterpartyId: who.lender, purpose: PURPOSE.financing });
    else if (e.kind === "customer_receipt" && e.amountMinor > 0n && who.buyer) items.push({ direction: "receipt", date: e.date, amountMinor: e.amountMinor.toString(), currency: e.currency, counterpartyId: who.buyer, purpose: PURPOSE.customer_receipt });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.direction.localeCompare(b.direction) || a.purpose.localeCompare(b.purpose));
  const net = items.reduce((n, i) => n + (i.direction === "receipt" ? BigInt(i.amountMinor) : -BigInt(i.amountMinor)), 0n);
  return { items, fees, netMinor: net.toString(), problem: null };
}
