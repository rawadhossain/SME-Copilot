// THE GATE. A pure function: evaluate(signedMandate, state, request) -> decision. No database, no clock, no randomness.
// State (bank balance, payees, scheduled payments, the as-of date) and the request are passed in. The decision depends
// only on structured fields; free text (notes, messages, labels) is never an input.
import { createHash } from "node:crypto";
import { roleForKind } from "@/sandbox/proposals";
import { formatMoney, money } from "@/lib/money";
import type { Mandate, SignedMandate } from "./mandate";
import { tierOf, type GateRequest, type Tier } from "./request";
import { checkSignedMandate } from "./verify";

export type Decision = "allow" | "needs_approval" | "deny";

export interface LimitCheck {
  limit: string;
  /** What the request would use, as text (money as a plain minor-unit string or a number). */
  value: string;
  /** The mandate bound. */
  bound: string;
  ok: boolean;
}

export interface GateResult {
  decision: Decision;
  tier: Tier;
  reasons: string[];
  limitsChecked: LimitCheck[];
  requiresSecondConfirmation: boolean;
}

export interface GatePayee {
  approved: boolean;
  name: string;
  accountRef: string;
  /** The hash stored when the owner approved these details. */
  bankDetailsHash: string;
}

export interface GateState {
  businessId: string;
  /** The world date (YYYY-MM-DD), passed in. */
  asOf: string;
  currency: string;
  bankBalanceMinor: bigint;
  /** Payments scheduled but not yet executed (they will still leave the bank). */
  pendingScheduledMinor: bigint;
  /** Scheduled plus executed outflow by scheduled_for date (cancelled and failed payments excluded). */
  outflowByDate: Record<string, bigint>;
  payees: Record<string, GatePayee>;
  payments: Record<string, { status: string }>;
  counterparties: Record<string, { role: string }>;
  /** Finance applications (status, lender and the offered terms), for accept/withdraw decisions. */
  applications?: Record<string, { status: string; lenderId: string; advanceBps: number | null; feeBps: number | null; requestedAmountMinor?: bigint; advanceAmountMinor?: bigint }>;
  /** Negotiation threads, for withdraw and receipt-backing decisions. */
  threads?: Record<string, { status: string; counterpartyId?: string; topic?: string }>;
  /** Scheduled receipts, for withdraw decisions. */
  receipts?: Record<string, { status: string }>;
  /**
   * Forecast-aware balance projection (ADR-019). When present, a payment is checked against the PROJECTED balance on its date
   * and on every later date, not against the balance today. Built by code from the deterministic engine (books-only flows), the
   * scheduled receipts that are backed by an agreement, and the scheduled payments. Absent: the check uses the balance today.
   */
  projection?: {
    /** Net flows of the books from the engine forecast (no pending-order events), by date. */
    booksFlows: { date: string; amountMinor: bigint }[];
    /** Scheduled receipts that are backed by an agreed thread or an accepted application. */
    receipts: { date: string; amountMinor: bigint }[];
    /** Scheduled payments (they will still leave the bank). */
    payments: { date: string; amountMinor: bigint }[];
  };
}

/** Lowest projected balance from `from` onward and the date it occurs, after also paying `extra` on `from`. Pure. */
export function projectedLowest(state: GateState, from: string, extra: bigint): { lowest: bigint; on: string } {
  const p = state.projection!;
  const deltas: { date: string; d: bigint }[] = [
    ...p.booksFlows.map((x) => ({ date: x.date, d: x.amountMinor })),
    ...p.receipts.map((x) => ({ date: x.date, d: x.amountMinor })),
    ...p.payments.map((x) => ({ date: x.date, d: -x.amountMinor })),
    { date: from, d: -extra },
  ];
  const dates = [...new Set([from, ...deltas.map((x) => x.date).filter((d) => d >= from)])].sort();
  let lowest: bigint | null = null;
  let on = from;
  for (const date of dates) {
    const bal = state.bankBalanceMinor + deltas.filter((x) => x.date <= date).reduce((a, x) => a + x.d, 0n);
    if (lowest === null || bal < lowest) { lowest = bal; on = date; }
  }
  return { lowest: lowest!, on };
}

export const payeeDetailsHash = (name: string, accountRef: string): string => createHash("sha256").update(`${name}|${accountRef}`, "utf8").digest("hex");

const fmt = (minor: bigint, currency: string) => formatMoney(money(minor, currency), 2);

export function evaluate(signed: SignedMandate | null, state: GateState, request: GateRequest, opts: { publicKey?: string } = {}): GateResult {
  const tier = tierOf(request.kind);
  if (tier === "read" || tier === "draft") {
    return { decision: "allow", tier, reasons: [`${tier} actions are always allowed`], limitsChecked: [], requiresSecondConfirmation: false };
  }

  const deny = (reasons: string[], limitsChecked: LimitCheck[] = []): GateResult => ({ decision: "deny", tier, reasons, limitsChecked, requiresSecondConfirmation: false });

  // Withdrawing an agreement or application only reduces exposure, so it is allowed without a mandate (ADR-017).
  if (request.kind === "sandbox.withdraw") {
    const target = request.target === "thread" ? state.threads?.[request.id] : request.target === "application" ? state.applications?.[request.id] : request.target === "payment" ? state.payments[request.id] : state.receipts?.[request.id];
    const withdrawable = request.target === "thread" ? !!target
      : request.target === "application" ? !!target && (target.status === "offered" || target.status === "accepted" || target.status === "withdrawn")
      : !!target && (target.status === "scheduled" || target.status === "cancelled");
    const check: LimitCheck = { limit: "withdrawTarget", value: target ? target.status : "unknown", bound: "an existing, withdrawable target", ok: withdrawable };
    return withdrawable
      ? { decision: "allow", tier, reasons: ["Withdrawing reduces exposure; always allowed for an existing target"], limitsChecked: [check], requiresSecondConfirmation: false }
      : deny([target ? `A ${request.target} that is ${target.status} cannot be withdrawn` : `Unknown ${request.target}`], [check]);
  }

  // 1. The mandate must be validly signed, current, and for this business.
  const check = checkSignedMandate(signed, opts.publicKey);
  if (!check.ok) return deny([`${check.reason}: all external and money actions are denied`]);
  const m: Mandate = check.mandate;
  if (m.businessId !== state.businessId) return deny(["Mandate is for a different business"]);
  if (state.asOf > m.expiresAt.slice(0, 10)) return deny([`Mandate expired on ${m.expiresAt.slice(0, 10)}`]);
  if (state.asOf < m.issuedAt.slice(0, 10)) return deny([`Mandate is not valid before ${m.issuedAt.slice(0, 10)}`]);
  if (m.currency !== state.currency) return deny([`Mandate currency ${m.currency} differs from the business currency ${state.currency}`]);

  const L = m.limits;
  const limits: LimitCheck[] = [];
  const reasons: string[] = [];
  const add = (limit: string, value: string, bound: string, ok: boolean, why: string) => {
    limits.push({ limit, value, bound, ok });
    if (!ok) reasons.push(why);
  };
  let second = false;

  switch (request.kind) {
    case "sandbox.send_proposal": {
      const p = request.proposal;
      add("allowedProposalKinds", p.kind, L.allowedProposalKinds.join(","), (L.allowedProposalKinds as string[]).includes(p.kind), `Proposal kind ${p.kind} is not allowed by the mandate`);
      const cp = state.counterparties[request.counterpartyId];
      add("counterparty", request.counterpartyId, "known counterparty of the right role", !!cp && cp.role === roleForKind(p.kind), "Unknown counterparty, or the proposal kind does not fit its role");
      if (p.kind === "buyer.request_early_payment") {
        add("maxEarlyPaymentDiscountBps", String(p.discountBps), String(L.maxEarlyPaymentDiscountBps), p.discountBps <= L.maxEarlyPaymentDiscountBps,
          `Early-payment discount ${p.discountBps / 100}% exceeds the mandate maximum of ${L.maxEarlyPaymentDiscountBps / 100}%`);
      }
      if (p.kind === "lender.apply_invoice_finance") {
        add("maxFinanceAdvanceBps", String(p.advanceBps), String(L.maxFinanceAdvanceBps), p.advanceBps <= L.maxFinanceAdvanceBps,
          `Advance ${p.advanceBps / 100}% exceeds the mandate maximum of ${L.maxFinanceAdvanceBps / 100}%`);
      }
      break;
    }

    case "sandbox.submit_application": {
      const lender = state.counterparties[request.lenderId];
      add("counterparty", request.lenderId, "known lender", !!lender && lender.role === "lender", "Unknown lender");
      add("allowedProposalKinds", "lender.apply_invoice_finance", L.allowedProposalKinds.join(","), (L.allowedProposalKinds as string[]).includes("lender.apply_invoice_finance"), "Invoice-finance applications are not allowed by the mandate");
      add("maxFinanceAdvanceBps", String(request.advanceBps), String(L.maxFinanceAdvanceBps), request.advanceBps <= L.maxFinanceAdvanceBps,
        `Advance ${request.advanceBps / 100}% exceeds the mandate maximum of ${L.maxFinanceAdvanceBps / 100}%`);
      if (request.feeBps !== undefined) {
        add("maxFinanceFeeBps", String(request.feeBps), String(L.maxFinanceFeeBps), request.feeBps <= L.maxFinanceFeeBps, `Fee ${request.feeBps / 100}% exceeds the mandate maximum of ${L.maxFinanceFeeBps / 100}%`);
      }
      break;
    }

    case "sandbox.accept_offer": {
      const app = state.applications?.[request.applicationId];
      add("applicationOffered", app ? app.status : "unknown", "offered", !!app && app.status === "offered", app ? `Application is ${app.status}; only an offered application can be taken up` : "Unknown application");
      add("allowedProposalKinds", "lender.apply_invoice_finance", L.allowedProposalKinds.join(","), (L.allowedProposalKinds as string[]).includes("lender.apply_invoice_finance"), "Invoice-finance is not allowed by the mandate");
      if (app) {
        const lender = state.counterparties[app.lenderId];
        add("counterparty", app.lenderId, "known lender", !!lender && lender.role === "lender", "Unknown lender");
        add("maxFinanceAdvanceBps", String(app.advanceBps ?? "none"), String(L.maxFinanceAdvanceBps), app.advanceBps !== null && app.advanceBps <= L.maxFinanceAdvanceBps, "The offered advance is above the mandate maximum");
        add("maxFinanceFeeBps", String(app.feeBps ?? "none"), String(L.maxFinanceFeeBps), app.feeBps !== null && app.feeBps <= L.maxFinanceFeeBps,
          `The lender's fee ${(app.feeBps ?? 0) / 100}% is above the mandate maximum of ${L.maxFinanceFeeBps / 100}%`);
      }
      break;
    }

    case "sandbox.schedule_receipt": {
      const cp = state.counterparties[request.counterpartyId];
      add("counterparty", request.counterpartyId, "known customer or lender", !!cp && (cp.role === "customer" || cp.role === "lender"), "Unknown counterparty, or not a customer or lender");
      if (request.backingType === "thread") {
        const t = state.threads?.[request.backingId];
        add("receiptBacking", t ? t.status : "unknown", "an agreed thread with this customer", !!t && t.status === "agreed" && t.counterpartyId === request.counterpartyId && cp?.role === "customer",
          "A receipt must be backed by an agreed negotiation thread with the same customer");
        add("allowedProposalKinds", t?.topic ?? "unknown", L.allowedProposalKinds.join(","), !!t?.topic && (L.allowedProposalKinds as string[]).includes(t.topic), "The backing proposal kind is not allowed by the mandate");
      } else {
        const a = state.applications?.[request.backingId];
        if (cp?.role === "lender") {
          // The advance itself: from the accepted application's lender, and no more than the advance the lender offered.
          add("receiptBacking", a ? a.status : "unknown", "an accepted application from this lender", !!a && a.status === "accepted" && a.lenderId === request.counterpartyId, "A lender receipt must be backed by an accepted application from the same lender");
          add("receiptWithinOffer", request.amountMinor.toString(), String(a?.advanceAmountMinor ?? "unknown"), !!a && a.advanceAmountMinor !== undefined && request.amountMinor <= a.advanceAmountMinor, "The receipt is larger than the advance the lender offered");
        } else {
          // The customer's later payment, reduced because an application was taken up: bounded by the invoice it was for.
          add("receiptBacking", a ? a.status : "unknown", "an accepted application", !!a && a.status === "accepted", "A receipt must be backed by an accepted application");
          add("receiptWithinApplication", request.amountMinor.toString(), String(a?.requestedAmountMinor ?? "unknown"), !!a && a.requestedAmountMinor !== undefined && request.amountMinor <= a.requestedAmountMinor, "The receipt is larger than the invoice the application was for");
        }
      }
      add("currency", request.currency, state.currency, request.currency === state.currency, `Receipt currency ${request.currency} differs from the account currency ${state.currency}`);
      add("expectedOn", request.expectedOn, `on or after ${state.asOf}`, request.expectedOn >= state.asOf, "Receipt date is in the past");
      break;
    }

    case "sandbox.schedule_payment": {
      const payee = state.payees[request.payeeId];
      add("approvedPayee", request.payeeId, "payee on the approved list", !!payee && payee.approved,
        payee ? "Payee is not approved (new payees and changed bank details need the owner to approve again)" : "Payee is not on the approved list (new payees are not allowed)");
      if (payee) {
        // Bank details must not have changed behind the owner's back, nor since the owner approved this exact payment.
        add("bankDetailsUnchanged", "current details", "approved details", payee.bankDetailsHash === payeeDetailsHash(payee.name, payee.accountRef),
          "Payee bank details do not match the hash recorded when the owner approved them");
        if (request.payeeBankDetailsHash !== undefined) {
          add("bankDetailsSinceProposal", "current details", "details at proposal", request.payeeBankDetailsHash === payee.bankDetailsHash, "Payee bank details changed since this payment was proposed");
        }
      }
      add("currency", request.currency, state.currency, request.currency === state.currency, `Payment currency ${request.currency} differs from the account currency ${state.currency}`);
      add("scheduledFor", request.scheduledFor, `on or after ${state.asOf}`, request.scheduledFor >= state.asOf, "Payment date is in the past");
      add("maxPaymentMinor", request.amountMinor.toString(), L.maxPaymentMinor.toString(), request.amountMinor <= L.maxPaymentMinor,
        `Payment ${fmt(request.amountMinor, state.currency)} exceeds the per-payment limit of ${fmt(L.maxPaymentMinor, state.currency)}`);
      const day = (state.outflowByDate[request.scheduledFor] ?? 0n) + request.amountMinor;
      add("maxDailyOutflowMinor", day.toString(), L.maxDailyOutflowMinor.toString(), day <= L.maxDailyOutflowMinor,
        `Outflow on ${request.scheduledFor} would be ${fmt(day, state.currency)}, above the daily limit of ${fmt(L.maxDailyOutflowMinor, state.currency)}`);
      if (state.projection) {
        // Forecast-aware (ADR-019): the projected balance on the payment date and every later date, never below the floor.
        const low = projectedLowest(state, request.scheduledFor, request.amountMinor);
        add("projectedBalanceFloor", low.lowest.toString(), L.minBankBalanceMinor.toString(), low.lowest >= L.minBankBalanceMinor,
          `Projected balance would be ${fmt(low.lowest, state.currency)} on ${low.on} after this payment, below the floor of ${fmt(L.minBankBalanceMinor, state.currency)}`);
      } else {
        const after = state.bankBalanceMinor - state.pendingScheduledMinor - request.amountMinor;
        add("minBankBalanceMinor", after.toString(), L.minBankBalanceMinor.toString(), after >= L.minBankBalanceMinor,
          `Bank balance after this payment and pending payments would be ${fmt(after, state.currency)}, below the floor of ${fmt(L.minBankBalanceMinor, state.currency)}`);
      }
      add("forbiddenPurposes", request.purpose, L.forbiddenPurposes.join(",") || "none", !(L.forbiddenPurposes as string[]).includes(request.purpose),
        `Payments for purpose "${request.purpose}" are forbidden for the agent`);
      second = request.amountMinor > L.requireSecondConfirmationAboveMinor;
      limits.push({ limit: "requireSecondConfirmationAboveMinor", value: request.amountMinor.toString(), bound: L.requireSecondConfirmationAboveMinor.toString(), ok: true });
      break;
    }

    case "sandbox.cancel_payment": {
      const pay = state.payments[request.paymentId];
      add("paymentCancellable", pay ? pay.status : "unknown", "scheduled", !!pay && pay.status === "scheduled",
        pay ? `Payment is ${pay.status}; only a scheduled payment can be cancelled (executed payments are irreversible)` : "Unknown payment");
      break;
    }
  }

  if (reasons.length > 0) return deny(reasons, limits);
  return {
    decision: "needs_approval",
    tier,
    reasons: ["Within all mandate limits; owner approval is required" + (second ? " (two confirmations, above the second-confirmation threshold)" : "")],
    limitsChecked: limits,
    requiresSecondConfirmation: second,
  };
}
