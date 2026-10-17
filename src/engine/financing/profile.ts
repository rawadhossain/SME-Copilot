// Business profile for financing-option matching. Pure and deterministic: integer minor units, no database, no clock, no model.
// Derived only from what the loader already gives the engine and the insights: bank transactions, invoices and confirmed commitments.
// The "as of" date is the business's stored as-of, passed in.
import type { InvoiceRecord } from "../types";
import { addMonths, diffDays } from "../dates";
import { classifyTransaction, type InsightTx } from "../insights";
import { isForecast, owedOf } from "../open";

/** An order the owner has confirmed: a customer receipt among the confirmed commitments. */
export interface ConfirmedOrderInput { valueMinor: bigint; receiptDate: string; customerName: string | null }

export interface ProfileInput {
  asOf: string;
  currency: string;
  /** All bank transactions on or before asOf (later ones are ignored). */
  transactions: Pick<InsightTx, "postedOn" | "amount" | "description" | "counterpartyRole">[];
  invoices: InvoiceRecord[];
  orders: ConfirmedOrderInput[];
  /** The date the owner says the business started trading (declared, not verified), or null. */
  tradingSince?: string | null;
}

export interface BusinessProfile {
  asOf: string;
  currency: string;
  firstTransactionOn: string | null;
  /** The owner's declared start of trading (not verified), or null. */
  tradingSince: string | null;
  /** Whole months from the EARLIER of the declared date and the first bank transaction to asOf. */
  monthsOfHistory: number;
  /** Where monthsOfHistory comes from: the declared date (when it is earlier than the bank statement) or the bank statement. */
  historySource: "declared" | "bank_statement";
  /** Whole months covered by the bank statement alone (first transaction to asOf). */
  bankMonthsOfHistory: number;
  /** Whole months from the declared date to asOf; null when nothing is declared. */
  declaredMonthsOfHistory: number | null;
  /** Customer receipts over the available history, scaled to 365 days. */
  annualisedTurnoverMinor: bigint;
  /** True when the BANK window is under 12 months, so the annual figure is an extrapolation from that window (declared history never counts here). */
  turnoverAnnualisedFromShortHistory: boolean;
  /** Annualised turnover / 12. */
  averageMonthlyTurnoverMinor: bigint;
  customerReceiptsMinor: bigint;
  /** Length of the bank window the turnover is measured over, in days. */
  historyDays: number;
  openReceivablesMinor: bigint;
  openInvoiceCount: number;
  /** Share of open receivables more than 30 days past due, basis points (rounded down). */
  overdueOver30ShareBps: number;
  /** Largest single customer's share of open receivables, basis points (rounded down). */
  topCustomerShareBps: number;
  topCustomerName: string | null;
  confirmedOrder: { count: number; largestValueMinor: bigint; customerName: string | null; receiptDate: string } | null;
}

const bpsOf = (a: bigint, b: bigint): number => (b > 0n ? Number((a * 10_000n) / b) : 0);

export function deriveBusinessProfile(input: ProfileInput): BusinessProfile {
  const { asOf } = input;
  const txs = input.transactions.filter((t) => t.postedOn <= asOf);
  const first = txs.length === 0 ? null : txs.reduce((m, t) => (t.postedOn < m ? t.postedOn : m), txs[0].postedOn);

  const monthsFrom = (start: string | null) => { let m = 0; if (start) while (addMonths(start, m + 1) <= asOf) m++; return m; };
  const declared = input.tradingSince && input.tradingSince <= asOf ? input.tradingSince : null;
  const bankMonths = monthsFrom(first);
  const useDeclared = declared !== null && (first === null || declared < first);
  const months = monthsFrom(useDeclared ? declared : first);
  const historyDays = first ? diffDays(first, asOf) + 1 : 0;

  // Customer receipts only: the insights classifier leaves transfers and lender money out of "customer_receipt".
  const receipts = txs.filter((t) => classifyTransaction(t) === "customer_receipt").reduce((a, t) => a + t.amount, 0n);
  const annual = historyDays > 0 ? (receipts * 365n) / BigInt(historyDays) : 0n;

  const open = input.invoices.filter(isForecast);
  const total = open.reduce((a, i) => a + owedOf(i), 0n);
  const overdue = open.filter((i) => diffDays(i.dueOn, asOf) > 30).reduce((a, i) => a + owedOf(i), 0n);
  const byCustomer = new Map<string, { name: string; owed: bigint }>();
  for (const i of open) {
    const c = byCustomer.get(i.counterpartyId) ?? { name: i.counterpartyName, owed: 0n };
    c.owed += owedOf(i);
    byCustomer.set(i.counterpartyId, c);
  }
  const top = [...byCustomer.entries()].sort((a, b) => (a[1].owed === b[1].owed ? (a[0] < b[0] ? -1 : 1) : a[1].owed > b[1].owed ? -1 : 1))[0]?.[1] ?? null;

  const orders = input.orders.filter((o) => o.valueMinor > 0n);
  const largest = orders.sort((a, b) => (a.valueMinor === b.valueMinor ? (a.receiptDate < b.receiptDate ? -1 : 1) : a.valueMinor > b.valueMinor ? -1 : 1))[0] ?? null;

  return {
    asOf, currency: input.currency, firstTransactionOn: first, tradingSince: declared, monthsOfHistory: months,
    historySource: useDeclared ? "declared" : "bank_statement", bankMonthsOfHistory: bankMonths, declaredMonthsOfHistory: declared ? monthsFrom(declared) : null,
    annualisedTurnoverMinor: annual, turnoverAnnualisedFromShortHistory: bankMonths < 12, averageMonthlyTurnoverMinor: annual / 12n,
    customerReceiptsMinor: receipts, historyDays,
    openReceivablesMinor: total, openInvoiceCount: open.length, overdueOver30ShareBps: bpsOf(overdue, total),
    topCustomerShareBps: top ? bpsOf(top.owed, total) : 0, topCustomerName: top?.name ?? null,
    confirmedOrder: largest ? { count: orders.length, largestValueMinor: largest.valueMinor, customerName: largest.customerName, receiptDate: largest.receiptDate } : null,
  };
}
