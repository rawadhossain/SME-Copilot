// Pure: rewrite the sample order's CommitmentEvents for negotiated levers. Percentages use the money helpers with
// half-up rounding (ADR-008/ADR-009). Feed the result to runScenario to re-run the forecast.
import type { CommitmentEvent } from "@/domain/commitment-event";
import { money, multiplyRatio } from "@/lib/money";
import { addDays } from "./dates";
import type { InvoiceAdjustments } from "./types";

export interface TermChanges {
  /** Chase (ADR-024): the buyer pays its overdue invoices within N days of asOf. Acts on books invoices, see adjustmentsOf. */
  chase?: { counterpartyId: string; payWithinDays: number };
  /** Early payment (ADR-024): the buyer pays its not-yet-due invoices N days earlier for a discount. */
  earlyPayment?: { counterpartyId: string; daysEarly: number; discountBps: number };
  /** New supplier deposit as basis points of the supplier quote total (30% = 3000). The balance becomes the remainder. */
  supplierDepositBps?: number;
  /** Pay the supplier balance this many days after the original (on shipment) date. */
  supplierBalanceDeferralDays?: number;
  /** The buyer pays this share of the order on acceptance; the later receipt is reduced by the same amount. */
  buyerDepositBps?: number;
  /**
   * Invoice finance on the remaining customer receipt: the lender advances advanceBps of the invoice on advanceDate and
   * charges feeBps of the invoice face value. When the customer pays, the lender is repaid first, so the receipt event
   * shrinks by advance + fee. Assumption: the invoice is raised at first delivery, 60 days before the receipt date, and
   * the advance arrives that day unless advanceDate says otherwise.
   */
  invoiceFinance?: { advanceBps: number; feeBps: number; advanceDate?: string };
}

const bpsOk = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10000;

function share(amount: bigint, bps: number, currency: string): bigint {
  return multiplyRatio(money(amount, currency), { num: BigInt(bps), den: 10000n }, "half-up").amountMinor;
}
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;

export function applyTermChanges(baseEvents: CommitmentEvent[], changes: TermChanges): CommitmentEvent[] {
  const events = baseEvents.map((e) => ({ ...e }));
  const find = (kind: CommitmentEvent["kind"]) => events.find((e) => e.kind === kind);
  const dep = find("supplier_deposit");
  const bal = find("supplier_balance");
  const rec = find("customer_receipt");
  const added: CommitmentEvent[] = [];

  for (const v of [changes.supplierDepositBps, changes.buyerDepositBps, changes.invoiceFinance?.advanceBps, changes.invoiceFinance?.feeBps]) {
    if (v !== undefined && !bpsOk(v)) throw new Error("basis points must be an integer from 0 to 10000");
  }

  if (changes.supplierDepositBps !== undefined) {
    if (!dep || !bal) throw new Error("supplier deposit/balance events not found");
    const total = -(dep.amountMinor + bal.amountMinor);
    const newDep = share(total, changes.supplierDepositBps, dep.currency);
    dep.amountMinor = -newDep;
    bal.amountMinor = -(total - newDep);
    dep.label += ` [renegotiated to ${pct(changes.supplierDepositBps)}]`;
  }
  if (changes.supplierBalanceDeferralDays !== undefined) {
    if (!bal) throw new Error("supplier balance event not found");
    if (!Number.isInteger(changes.supplierBalanceDeferralDays) || changes.supplierBalanceDeferralDays < 0) throw new Error("deferral days must be a non-negative integer");
    bal.date = addDays(bal.date, changes.supplierBalanceDeferralDays);
    bal.label += ` [deferred ${changes.supplierBalanceDeferralDays} days]`;
  }
  if (changes.buyerDepositBps !== undefined) {
    if (!rec) throw new Error("customer receipt event not found");
    const upfront = share(rec.amountMinor, changes.buyerDepositBps, rec.currency);
    const when = events.reduce((d, e) => (e.date < d ? e.date : d), events[0].date); // on acceptance = the earliest event date
    if (upfront > 0n) {
      added.push({ date: when, amountMinor: upfront, currency: rec.currency, kind: "customer_receipt", source: rec.source, confidence: rec.confidence, label: `Buyer deposit (${pct(changes.buyerDepositBps)}) on acceptance`, sourceRef: rec.sourceRef });
      rec.amountMinor -= upfront;
      rec.label += ` [after ${pct(changes.buyerDepositBps)} deposit]`;
    }
  }
  if (changes.invoiceFinance) {
    if (!rec) throw new Error("customer receipt event not found");
    const { advanceBps, feeBps } = changes.invoiceFinance;
    const advance = share(rec.amountMinor, advanceBps, rec.currency);
    const fee = share(rec.amountMinor, feeBps, rec.currency); // fee on the invoice face value
    added.push({
      date: changes.invoiceFinance.advanceDate ?? addDays(rec.date, -60), amountMinor: advance, currency: rec.currency, kind: "financing", source: rec.source,
      confidence: rec.confidence, label: `Invoice-finance advance (${pct(advanceBps)})`, sourceRef: rec.sourceRef,
    });
    rec.amountMinor -= advance + fee;
    rec.label += ` [net of ${pct(advanceBps)} advance and ${pct(feeBps)} fee]`;
  }

  return [...events.filter((e) => e.amountMinor !== 0n), ...added];
}

/** The invoice-level adjustments (chase and early payment) of a set of term changes, for buildForecast. */
export function adjustmentsOf(changes: TermChanges): InvoiceAdjustments {
  return {
    chase: changes.chase ? [{ counterpartyId: changes.chase.counterpartyId, payWithinDays: changes.chase.payWithinDays }] : [],
    early: changes.earlyPayment ? [{ ...changes.earlyPayment }] : [],
  };
}
