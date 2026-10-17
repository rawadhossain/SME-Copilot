// Plain-language description of EXACTLY what a plan signature covers (Batch 10). Pure: it reads the same PlanTerms object that is hashed
// and signed, so the words on the signing screen cannot drift from the signed bytes. All numbers come from the terms.
import { formatMoney, money } from "@/lib/money";
import { requestSchema } from "@/gate/request";
import type { CommitmentEvent } from "@/domain/commitment-event";
import { projectPlan, type ProjectedFee, type ProjectedItem } from "./plan-projection";
import type { PlanTerms } from "./plan-terms";

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;

export interface SigningSummary {
  /** What the system will ask each counterparty, in order. */
  asks: { counterparty: string; text: string; accepts: string }[];
  /** What happens if everyone agrees. */
  then: string[];
  /** What the system will NOT do. */
  never: string[];
  confirmations: 1 | 2;
  /** The payments and receipts the plan would schedule if every term is accepted exactly as asked (proposed, not agreed). Present when the confirmed order is known. */
  schedule?: (ProjectedItem & { counterparty: string })[];
  /** The highest finance fee the signed terms allow, in money. */
  fees?: (ProjectedFee & { counterparty: string })[];
  /** Receipts less payments among the scheduled items (signed minor units, string). */
  scheduleNetMinor?: string;
  /** Set when the terms could not be applied to the confirmed order. */
  scheduleProblem?: string | null;
}

export function describeTerms(terms: PlanTerms, names: Record<string, string>, currency: string, ctx?: { baseEvents: CommitmentEvent[]; parties: { supplierId: string | null; buyerId: string | null; lenderId: string | null } }): SigningSummary {
  const gbp = (minor: bigint | string) => formatMoney(money(BigInt(minor), currency), 2);
  const asks: SigningSummary["asks"] = [];
  for (const e of terms.entries) {
    const r = requestSchema.parse(e.request);
    const cpId = r.kind === "sandbox.send_proposal" ? r.counterpartyId : r.kind === "sandbox.submit_application" ? r.lenderId : "";
    const counterparty = names[cpId] ?? "the other side";
    const b = e.bound;
    const l = e.lever;
    switch (l.kind) {
      case "supplier_reduce_deposit":
        asks.push({ counterparty, text: `Ask to cut the deposit to ${pct(l.percentBps)}.`, accepts: b.kind === "supplier_reduce_deposit" && b.maxPercentBps > l.percentBps ? `A counter up to ${pct(b.maxPercentBps)}.` : "Only exactly this." });
        break;
      case "supplier_defer_balance":
        asks.push({ counterparty, text: `Ask to take the balance ${l.daysAfterShipment} days after shipment.`, accepts: b.kind === "supplier_defer_balance" && b.minDays < l.daysAfterShipment ? `A counter down to ${b.minDays} days.` : "Only exactly this." });
        break;
      case "buyer_request_deposit":
        asks.push({ counterparty, text: `Ask for a ${pct(l.percentBps)} deposit on the order.`, accepts: b.kind === "buyer_request_deposit" && b.minPercentBps < l.percentBps ? `A counter down to ${pct(b.minPercentBps)}.` : "Only exactly this." });
        break;
      case "finance_invoice": {
        const amount = r.kind === "sandbox.submit_application" ? gbp(r.invoiceAmountMinor) : "";
        const fin = b.kind === "finance_invoice" ? b : null;
        asks.push({
          counterparty, text: `Apply for an invoice-finance advance of ${pct(l.advanceBps)} on an invoice of ${amount}.`,
          accepts: `An offer with that advance and a fee up to ${pct(fin?.maxFeeBps ?? 0)} of the invoice${fin?.maxInvoiceMinor && fin.maxInvoiceMinor !== (r.kind === "sandbox.submit_application" ? r.invoiceAmountMinor.toString() : "") ? `; the invoice may be re-quoted up to ${gbp(fin.maxInvoiceMinor)} if the buyer agrees a smaller deposit` : ""}.`,
        });
        break;
      }
      case "chase_overdue":
        asks.push({ counterparty, text: `Ask to pay its overdue invoices within ${l.payWithinDays} days.`, accepts: b.kind === "chase_overdue" && b.maxDays > l.payWithinDays ? `A counter up to ${b.maxDays} days.` : "Only exactly this." });
        break;
      case "early_payment_discount":
        asks.push({ counterparty, text: `Offer a ${pct(l.discountBps)} discount to pay ${l.daysEarly} days earlier.`, accepts: b.kind === "early_payment_discount" && b.maxDiscountBps > l.discountBps ? `A counter up to ${pct(b.maxDiscountBps)} (your signed limit may be lower).` : "Only exactly this." });
        break;
    }
  }
  const usesSupplier = terms.entries.some((e) => e.lever.kind === "supplier_reduce_deposit" || e.lever.kind === "supplier_defer_balance");
  const projection = ctx ? projectPlan(terms, ctx.baseEvents, ctx.parties) : null;
  const nameOf = (id: string) => names[id] ?? "the other side";
  return {
    asks,
    ...(projection ? { schedule: projection.items.map((i) => ({ ...i, counterparty: nameOf(i.counterpartyId) })), fees: projection.fees.map((f) => ({ ...f, counterparty: nameOf(f.counterpartyId) })), scheduleNetMinor: projection.netMinor, scheduleProblem: projection.problem } : {}),
    then: [
      "Anything outside the accepted terms stops the plan: nothing is committed or paid, the agreements already reached are kept on hold, and you decide whether to revise the terms, ask for a re-plan or withdraw everything.",
      "If everyone agrees, the system schedules only the payments and receipts those exact terms imply, each one checked again against your signed limits and your projected balance.",
      "An independent check then recomputes your forecast from what was actually agreed and tells you if it differs from the plan.",
    ],
    never: [
      "Pay anyone who is not an approved payee, or move money above your signed limits.",
      "Accept an answer outside the terms above, or act after this authorisation expires or your limits change.",
      ...(usesSupplier ? ["Pay the supplier without your second confirmation (this plan can schedule payments above the second-confirmation threshold)."] : []),
    ],
    confirmations: terms.confirmations ?? 1,
  };
}
