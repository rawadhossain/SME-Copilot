// Invoices and bills: balances, payment state, payment validation and the overlap rules that stop one piece of cash being counted twice.
// Pure. Integer minor units only. No database, no clock (callers pass today / asOf).
import { z } from "zod";
import { diffDays } from "@/engine/dates";

export type DocKind = "invoice" | "bill";

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const; // "overdue" is worked out from the due date, never stored by this feature
export const BILL_STATUSES = ["unpaid", "paid", "void"] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a real calendar date");

/** A payment as the ledger sees it. Voided payments are history only: they never count. */
export interface PaymentLite {
  id: string;
  amountMinor: bigint;
  paidOn: string;
  voided: boolean;
}

export interface Balance {
  /** Every live payment, whatever its date. */
  paidMinor: bigint;
  /** What is still owed now (amount minus every live payment), never below zero. */
  outstandingMinor: bigint;
  /** Live payments dated on or before asOf: the ones the bank balance can already contain. */
  paidByAsOfMinor: bigint;
  /** What the forecast still has to collect or pay: amount minus payments already in the opening balance. */
  outstandingAtAsOfMinor: bigint;
  lastPaidOn: string | null;
}

/**
 * A document marked paid with no payment rows is an older record (imported or seeded): it counts as paid in full on its paid date.
 * Once it has any live payment rows, the rows are the truth and the stored status is only a cache.
 */
export function balanceOf(doc: { amountMinor: bigint; status: string; paidOn: string | null }, payments: PaymentLite[], asOf: string): Balance {
  const live = payments.filter((p) => !p.voided);
  if (live.length === 0 && doc.status === "paid") {
    return { paidMinor: doc.amountMinor, outstandingMinor: 0n, paidByAsOfMinor: doc.amountMinor, outstandingAtAsOfMinor: 0n, lastPaidOn: doc.paidOn };
  }
  const sum = (rows: PaymentLite[]) => rows.reduce((a, p) => a + p.amountMinor, 0n);
  const floor0 = (n: bigint) => (n < 0n ? 0n : n);
  const paid = sum(live);
  const byAsOf = sum(live.filter((p) => p.paidOn <= asOf));
  return {
    paidMinor: paid,
    outstandingMinor: floor0(doc.amountMinor - paid),
    paidByAsOfMinor: byAsOf,
    outstandingAtAsOfMinor: floor0(doc.amountMinor - byAsOf),
    lastPaidOn: live.length > 0 ? live.reduce((d, p) => (p.paidOn > d ? p.paidOn : d), live[0].paidOn) : null,
  };
}

export type PayState = "draft" | "void" | "paid" | "partial" | "overdue" | "partial_overdue" | "open";

/** The state the owner sees. `asOf` is the books date the forecast uses, so "overdue" agrees with the forecast. */
export function stateOf(doc: { status: string; dueOn: string }, b: Balance, asOf: string): { state: PayState; overdueDays: number } {
  if (doc.status === "void") return { state: "void", overdueDays: 0 };
  if (doc.status === "draft") return { state: "draft", overdueDays: 0 };
  if (b.outstandingMinor === 0n) return { state: "paid", overdueDays: 0 };
  const overdueDays = doc.dueOn < asOf ? diffDays(doc.dueOn, asOf) : 0;
  const partial = b.paidMinor > 0n;
  if (overdueDays > 0) return { state: partial ? "partial_overdue" : "overdue", overdueDays };
  return { state: partial ? "partial" : "open", overdueDays };
}

/** The status string to store after a payment changes. Only paid / not paid is derived; draft and void are never touched here. */
export function storedStatusAfterPayment(kind: DocKind, current: string, b: Balance): string {
  if (current === "void" || current === "draft") return current;
  if (b.outstandingMinor === 0n && b.paidMinor > 0n) return "paid";
  return kind === "invoice" ? "sent" : "unpaid";
}

// ---------------------------------------------------------------- input schemas

const decimal = z.string().trim().min(1).max(24);

export const documentInputSchema = z.object({
  /** Existing customer / supplier, or a new one by name. Exactly one. */
  counterpartyId: z.string().uuid().optional(),
  newCounterpartyName: z.string().trim().min(1).max(120).optional(),
  number: z.string().trim().min(1).max(60),
  issuedOn: isoDate,
  dueOn: isoDate,
  amount: decimal,
  /** Invoices only: draft stays out of the forecast until it is sent. */
  status: z.enum(["draft", "sent"]).optional(),
  /** Resolve an overlap: this document is already counted in the forecast by this item ("order:pc1"). */
  countedIn: z.string().trim().max(80).nullable().optional(),
  /** Resolve an overlap the other way: the owner says it is a separate item and should be counted. */
  acknowledgeOverlaps: z.boolean().optional(),
});
export type DocumentInput = z.infer<typeof documentInputSchema>;

export const documentEditSchema = z.object({
  counterpartyId: z.string().uuid().optional(),
  number: z.string().trim().min(1).max(60).optional(),
  issuedOn: isoDate.optional(),
  dueOn: isoDate.optional(),
  amount: decimal.optional(),
  status: z.enum(["draft", "sent"]).optional(),
  countedIn: z.string().trim().max(80).nullable().optional(),
  acknowledgeOverlaps: z.boolean().optional(),
  /** Void the document. Refused while it has live payments. */
  void: z.boolean().optional(),
  reason: z.string().trim().max(200).optional(),
});
export type DocumentEdit = z.infer<typeof documentEditSchema>;

export const paymentInputSchema = z.object({
  amount: decimal,
  paidOn: isoDate.optional(),
  /** The bank transaction this payment is. Its date becomes the payment date. */
  transactionId: z.string().uuid().optional(),
  note: z.string().trim().max(200).optional(),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const paymentVoidSchema = z.object({ reason: z.string().trim().min(1).max(200) });

/** Reasons a payment cannot be recorded. Empty means fine. Pure. */
export function paymentProblems(i: { amountMinor: bigint; outstandingMinor: bigint; paidOn: string; issuedOn: string; latestAllowed: string; docStatus: string }): string[] {
  const out: string[] = [];
  if (i.docStatus === "void") out.push("This document is void, so it cannot take payments.");
  if (i.docStatus === "draft") out.push("This invoice is still a draft. Mark it sent before recording a payment.");
  if (i.amountMinor <= 0n) out.push("A payment must be more than zero.");
  if (i.amountMinor > i.outstandingMinor) out.push("That is more than the amount still owed.");
  if (i.paidOn < i.issuedOn) out.push("A payment cannot be dated before the document was issued.");
  if (i.paidOn > i.latestAllowed) out.push("A payment cannot be dated in the future.");
  return out;
}

// ---------------------------------------------------------------- overlaps

export type OverlapType = "order" | "recurring" | "scheduled";

/** Something already in the forecast that this document may be the same money as. */
export interface Overlap {
  /** What gets stored in counted_in if the owner says it is the same thing. */
  ref: string;
  type: OverlapType;
  label: string;
  date: string;
  amountMinor: bigint;
}

export interface OverlapSources {
  /** Confirmed orders in the forecast (cash events). ref is "<extractionId>:<kind>:<date>", stable when other orders are confirmed. amountMinor is signed. */
  orders: { ref: string; kind: string; date: string; amountMinor: bigint; label: string }[];
  /** Recurring commitments (rent, payroll...). amountMinor is signed. */
  recurring: { id: string; name: string; amountMinor: bigint; dates: string[] }[];
  /** Payments / receipts already scheduled in the practice bank for this counterparty. amountMinor is positive. */
  scheduled: { id: string; direction: "out" | "in"; date: string; amountMinor: bigint; label: string }[];
}

export const OVERLAP_WINDOW_DAYS = 14;
export const RECURRING_WINDOW_DAYS = 7;

/**
 * Items already in the forecast that look like the same money as this document: same direction, EXACT same amount, and a date close to the
 * due date. Amounts are matched exactly on purpose: a fuzzy match would hide real invoices. The owner decides; nothing is merged silently.
 */
export function findOverlaps(doc: { kind: DocKind; amountMinor: bigint; dueOn: string }, src: OverlapSources): Overlap[] {
  const out: Overlap[] = [];
  const near = (d: string, days: number) => Math.abs(diffDays(doc.dueOn, d)) <= days;
  const wanted = doc.kind === "invoice" ? ["customer_receipt"] : ["supplier_deposit", "supplier_balance", "cost"];
  const orders = src.orders.filter((o) => wanted.includes(o.kind) && (doc.kind === "invoice" ? o.amountMinor > 0n : o.amountMinor < 0n));
  for (const o of orders) {
    if ((o.amountMinor < 0n ? -o.amountMinor : o.amountMinor) === doc.amountMinor && near(o.date, OVERLAP_WINDOW_DAYS)) out.push({ ref: `order:${o.ref}`, type: "order", label: o.label, date: o.date, amountMinor: doc.amountMinor });
  }
  if (doc.kind === "bill") {
    // A bill for a whole supplier order (deposit and balance together).
    const supplier = orders.filter((o) => o.kind === "supplier_deposit" || o.kind === "supplier_balance");
    const sameOrder = new Set(supplier.map((o) => o.ref.split(":")[0])).size === 1;
    if (supplier.length === 2 && sameOrder && -supplier.reduce((a, o) => a + o.amountMinor, 0n) === doc.amountMinor && supplier.some((o) => near(o.date, OVERLAP_WINDOW_DAYS))) {
      out.push({ ref: `order:${supplier[0].ref.split(":")[0]}:supplier`, type: "order", label: `${supplier[0].label} (deposit and balance together)`, date: supplier[0].date, amountMinor: doc.amountMinor });
    }
  }
  for (const c of src.recurring) {
    const signedOk = doc.kind === "invoice" ? c.amountMinor > 0n : c.amountMinor < 0n;
    const mag = c.amountMinor < 0n ? -c.amountMinor : c.amountMinor;
    const when = c.dates.find((d) => near(d, RECURRING_WINDOW_DAYS));
    if (signedOk && mag === doc.amountMinor && when) out.push({ ref: `recurring:${c.id}`, type: "recurring", label: c.name, date: when, amountMinor: doc.amountMinor });
  }
  for (const s of src.scheduled) {
    if (s.direction === (doc.kind === "invoice" ? "in" : "out") && s.amountMinor === doc.amountMinor && near(s.date, OVERLAP_WINDOW_DAYS)) out.push({ ref: `scheduled:${s.id}`, type: "scheduled", label: s.label, date: s.date, amountMinor: doc.amountMinor });
  }
  return out;
}

export interface BankCandidate {
  id: string;
  postedOn: string;
  /** Signed, as in the bank. */
  amountMinor: bigint;
  description: string;
  counterpartyId: string | null;
  /** Bank amount not yet used by payments recorded against other documents. Positive. */
  remainingMinor: bigint;
}

/**
 * Bank transactions that could be this document's payment: right direction, enough unused amount, posted on or after the issue date.
 * Ranked: same counterparty and exact remaining amount first, then same counterparty, then exact amount. Pure and deterministic.
 */
export function rankBankCandidates(doc: { kind: DocKind; counterpartyId: string; issuedOn: string; outstandingMinor: bigint }, txns: BankCandidate[]): BankCandidate[] {
  const scored = txns
    .filter((t) => (doc.kind === "invoice" ? t.amountMinor > 0n : t.amountMinor < 0n) && t.remainingMinor > 0n && t.postedOn >= doc.issuedOn)
    .map((t) => {
      const same = t.counterpartyId === doc.counterpartyId;
      const exact = t.remainingMinor === doc.outstandingMinor;
      return { t, score: (same ? 2 : 0) + (exact ? 2 : 0) };
    })
    .filter((x) => x.score >= 2);
  scored.sort((a, b) => b.score - a.score || (a.t.postedOn < b.t.postedOn ? 1 : a.t.postedOn > b.t.postedOn ? -1 : a.t.id.localeCompare(b.t.id)));
  return scored.slice(0, 5).map((x) => x.t);
}

/** A payment the owner cannot link to a bank line that does not match it. Empty means fine. */
export function transactionLinkProblems(doc: { kind: DocKind; currency: string; counterpartyId: string }, t: { amountMinor: bigint; currency: string; remainingMinor: bigint; counterpartyId: string | null }, payment: bigint): string[] {
  const out: string[] = [];
  if (t.currency !== doc.currency) out.push("The bank transaction is in a different currency.");
  if (doc.kind === "invoice" ? t.amountMinor <= 0n : t.amountMinor >= 0n) out.push(doc.kind === "invoice" ? "That bank line is money going out, not a customer payment." : "That bank line is money coming in, not a supplier payment.");
  if (payment > t.remainingMinor) out.push("The bank transaction does not have that much left; other payments already use part of it.");
  if (t.counterpartyId && t.counterpartyId !== doc.counterpartyId) out.push("That bank line belongs to a different customer or supplier.");
  return out;
}
