// RECOVERY RULES (pure). When an approved strategy stops being true, these functions say which of its promises were broken and how the cash
// position moved. No database, no clock, no model. The inputs are records the caller read just now (books, sandbox receipts, current forecast);
// nothing here trusts an old forecast or an earlier explanation. All money is integer minor units.
import type { CommitmentEvent } from "@/domain/commitment-event";
import { addDays, diffDays } from "./dates";
import { isForecast } from "./open";
import type { ChaseAdjustment, EarlyPaymentAdjustment, InvoiceRecord } from "./types";

/** A promised date counts as missed only this many days later (a receipt due today is not late yet). */
export const LATE_GRACE_DAYS = 1;
/** When a promised receipt is late, plan as if it arrives this many days after today. An assumption, shown as one. */
export const ASSUMED_LATE_DELAY_DAYS = 14;
/** A change is material when it moves the lowest balance by at least this share of the cushion (basis points), or crosses the cushion. */
export const MATERIAL_BPS_OF_RESERVE = 500;

export interface ScheduledReceipt { id: string; counterpartyId: string; amountMinor: bigint; expectedOn: string; status: string }
export interface LateReceipt { id: string; counterpartyId: string; amountMinor: bigint; expectedOn: string; daysLate: number }

/** Sandbox receipts the bank should have credited by now and has not. Received and cancelled receipts are never late. */
export function lateReceipts(receipts: ScheduledReceipt[], asOf: string, graceDays: number = LATE_GRACE_DAYS): LateReceipt[] {
  return receipts
    .filter((r) => r.status === "scheduled" && diffDays(r.expectedOn, asOf) >= graceDays)
    .map((r) => ({ id: r.id, counterpartyId: r.counterpartyId, amountMinor: r.amountMinor, expectedOn: r.expectedOn, daysLate: diffDays(r.expectedOn, asOf) }))
    .sort((a, b) => a.expectedOn.localeCompare(b.expectedOn) || a.id.localeCompare(b.id));
}

/**
 * Moves the forecast events that stand for late receipts. Each receipt matches at most one event (same date and amount, cash in), so a receipt is
 * never delayed twice and never counted twice. "arrives" puts it `delayDays` after today (the expected case); "never" removes it from the horizon
 * (the worst case). A receipt with no matching event changes nothing and is returned as unmatched.
 */
export function delayReceipts(events: CommitmentEvent[], late: LateReceipt[], asOf: string, mode: { arrives: number } | "never"): { events: CommitmentEvent[]; matched: LateReceipt[]; unmatched: LateReceipt[] } {
  const out = events.map((e) => ({ ...e }));
  const used = new Set<number>();
  const matched: LateReceipt[] = [];
  const unmatched: LateReceipt[] = [];
  for (const r of late) {
    const i = out.findIndex((e, k) => !used.has(k) && e.amountMinor > 0n && e.amountMinor === r.amountMinor && e.date === r.expectedOn);
    if (i < 0) { unmatched.push(r); continue; }
    used.add(i);
    matched.push(r);
    if (mode !== "never") {
      out[i].date = addDays(asOf, mode.arrives);
      out[i].label = `${out[i].label} [${r.daysLate} days late; assumed ${mode.arrives} days from today]`.slice(0, 200);
    }
  }
  const kept = out.filter((_, k) => !(mode === "never" && used.has(k)));
  return { events: kept, matched, unmatched };
}

export interface BrokenPromise {
  kind: "chase" | "early_payment";
  counterpartyId: string;
  invoiceIds: string[];
  /** The part of these invoices still unpaid. */
  amountMinor: bigint;
  promisedBy: string;
  daysLate: number;
}

/**
 * Invoice promises from agreements in force (a customer said it would pay overdue invoices within N days, or pay N days early) that were not kept.
 * The promise date is fixed by the day the strategy was planned (`planDate`), never by today: a promise "within 7 days" must not slide forward
 * every time the forecast is rebuilt. Only invoices still unpaid after the ledger's payments count.
 */
export function brokenInvoicePromises(a: { invoices: InvoiceRecord[]; planDate: string; asOf: string; chase: ChaseAdjustment[]; early: EarlyPaymentAdjustment[]; graceDays?: number }): BrokenPromise[] {
  const grace = a.graceDays ?? LATE_GRACE_DAYS;
  const out: BrokenPromise[] = [];
  const collect = (kind: BrokenPromise["kind"], cp: string, promisedBy: (i: InvoiceRecord) => string | null) => {
    const hits = a.invoices.filter((i) => i.counterpartyId === cp && isForecast(i)).map((i) => ({ i, by: promisedBy(i) })).filter((x): x is { i: InvoiceRecord; by: string } => x.by !== null && diffDays(x.by, a.asOf) >= grace);
    if (hits.length === 0) return;
    const by = hits.map((h) => h.by).sort()[0];
    out.push({ kind, counterpartyId: cp, invoiceIds: hits.map((h) => h.i.id).sort(), amountMinor: hits.reduce((n, h) => n + (h.i.outstanding ?? h.i.amount), 0n), promisedBy: by, daysLate: diffDays(by, a.asOf) });
  };
  for (const c of a.chase) collect("chase", c.counterpartyId, (i) => (i.dueOn < a.planDate ? addDays(a.planDate, c.payWithinDays) : null));
  for (const e of a.early) collect("early_payment", e.counterpartyId, (i) => { if (i.dueOn < a.planDate) return null; const d = addDays(i.dueOn, -e.daysEarly); return d < a.planDate ? a.planDate : d; });
  return out.sort((x, y) => `${x.kind}:${x.counterpartyId}`.localeCompare(`${y.kind}:${y.counterpartyId}`));
}

export interface PositionView { minBalanceMinor: bigint; minBalanceWeek: number; reserveMinor: bigint }

export interface PositionChange {
  /** Now minus promised (negative = worse). */
  deltaMinor: bigint;
  promisedBelowReserve: boolean;
  nowBelowReserve: boolean;
  /** The strategy promised the cushion and it no longer holds. */
  newBreach: boolean;
  thresholdMinor: bigint;
  /** Worse by at least the threshold, or a new breach. */
  material: boolean;
}

export const materialThreshold = (reserveMinor: bigint): bigint => {
  const t = (reserveMinor * BigInt(MATERIAL_BPS_OF_RESERVE)) / 10000n;
  return t > 0n ? t : 1n;
};

/** How the lowest balance moved between what the strategy promised and what the records say now. */
export function positionChange(promised: PositionView, now: PositionView): PositionChange {
  const deltaMinor = now.minBalanceMinor - promised.minBalanceMinor;
  const promisedBelowReserve = promised.minBalanceMinor < promised.reserveMinor;
  const nowBelowReserve = now.minBalanceMinor < now.reserveMinor;
  const thresholdMinor = materialThreshold(now.reserveMinor);
  const newBreach = nowBelowReserve && !promisedBelowReserve;
  return { deltaMinor, promisedBelowReserve, nowBelowReserve, newBreach, thresholdMinor, material: newBreach || -deltaMinor >= thresholdMinor };
}
