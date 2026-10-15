// Plain data types for the pure cash engine. No database types, no Date objects, no floats for money.
import type { CommitmentEvent } from "@/domain/commitment-event";

export const HORIZON_WEEKS = 13; // default
export const MAX_HORIZON_WEEKS = 26;
export const ENGINE_VERSION = "1";

/** How certain a figure is. actual = bank balance; confirmed = known record; estimate = adjusted by a learned pattern; assumption = scenario input. */
export type Provenance = "actual" | "confirmed" | "estimate" | "assumption";
export type SourceType = "invoice" | "bill" | "commitment" | "pattern_invoice" | "pattern_bill" | "event";
export type Frequency = "weekly" | "fortnightly" | "monthly" | "quarterly" | "annual";

export interface InvoiceRecord {
  id: string;
  number: string;
  counterpartyId: string;
  counterpartyName: string;
  issuedOn: string;
  dueOn: string;
  amount: bigint; // positive: money owed to us
  status: "open" | "paid";
  paidOn?: string; // set when status is paid and the date is known
}

export interface BillRecord {
  id: string;
  reference: string;
  counterpartyId: string;
  counterpartyName: string;
  issuedOn: string;
  dueOn: string;
  amount: bigint; // positive: money we owe
  status: "open" | "paid";
  paidOn?: string;
}

export interface CommitmentRecord {
  id: string;
  name: string;
  amount: bigint; // signed: negative = outflow
  frequency: Frequency;
  nextDueOn: string;
  kind: "confirmed" | "estimate";
}

/**
 * How overdue customer invoices enter the forecast (ADR-023). An invoice past its due date is NOT assumed to arrive today:
 * it arrives `delayDays` after asOf, or `longDelayDays` after asOf when it is more than `longAfterDays` overdue, unless the
 * customer's own lateness pattern says later. Configurable (OVERDUE_COLLECTION_DELAY_DAYS and friends); the note on every
 * overdue line states the assumption used.
 */
export interface OverdueAssumption {
  delayDays: number;
  longAfterDays: number;
  longDelayDays: number;
}
export const DEFAULT_OVERDUE: OverdueAssumption = { delayDays: 14, longAfterDays: 30, longDelayDays: 30 };

/** A buyer agreed to pay its overdue invoices within N days of asOf (lever: chase_overdue). */
export interface ChaseAdjustment { counterpartyId: string; payWithinDays: number }
/** A buyer agreed to pay its not-yet-due invoices N days earlier for a discount (lever: early_payment_discount). */
export interface EarlyPaymentAdjustment { counterpartyId: string; daysEarly: number; discountBps: number }
export interface InvoiceAdjustments { chase: ChaseAdjustment[]; early: EarlyPaymentAdjustment[] }

export interface EngineInput {
  /** Forecast starts on this date. The opening balance is the balance at the start of asOf (before items dated asOf). */
  asOf: string;
  currency: string;
  openingBalance: bigint;
  /** Owner-set reserve: the level the owner wants closing balances to stay above. */
  reserve: bigint;
  /** Forecast length in weeks (1 to 26). Defaults to 13. */
  horizonWeeks?: number;
  /** Overdue assumption; DEFAULT_OVERDUE when absent. */
  overdue?: OverdueAssumption;
  invoices: InvoiceRecord[];
  bills: BillRecord[];
  commitments: CommitmentRecord[];
}

export interface ForecastOptions {
  /** Scenario commitments laid on top of the books. */
  events?: CommitmentEvent[];
  /** Downside variant: delay every estimated customer receipt by this many days; those lines become assumptions. */
  downsideDelayDays?: number;
  /** Project invoices and bills not yet issued from each counterparty's history (default true). */
  runRate?: boolean;
  /** Forecast length in weeks (1 to 26); overrides input.horizonWeeks. Default 13. */
  horizonWeeks?: number;
  /** Counterparty ids whose lateness shift is ignored (used by driver attribution). */
  noShiftFor?: string[];
  /** Agreed invoice-level changes from the chase and early-payment levers (they act on books invoices, not on order events). */
  adjustments?: InvoiceAdjustments;
}

export interface ForecastItem {
  date: string;
  weekIndex: number;
  amount: bigint; // signed
  kind: Provenance;
  sourceType: SourceType;
  sourceId: string;
  label: string;
  note?: string;
  counterpartyId?: string;
}

export interface WeekBucket {
  index: number;
  start: string;
  end: string;
  opening: bigint;
  inflow: bigint; // sum of positive items
  outflow: bigint; // sum of negative items, as a positive number
  closing: bigint;
  belowReserve: boolean;
}

export interface Forecast {
  engineVersion: string;
  asOf: string;
  currency: string;
  variant: "baseline" | "downside";
  reserve: bigint;
  openingBalance: bigint;
  horizonWeeks: number;
  weeks: WeekBucket[];
  items: ForecastItem[];
  /** Items dated after the last week; informational only. */
  outsideHorizon: ForecastItem[];
  minimum: { amount: bigint; weekIndex: number; weekStart: string };
  /** First week whose closing balance is below the reserve, with the shortfall (reserve - closing). */
  firstBreach: { weekIndex: number; weekStart: string; closing: bigint; shortfall: bigint } | null;
  /** Reserve minus the minimum closing balance when positive, else 0. The deepest shortfall. */
  maxShortfall: bigint;
  /** Weeks whose closing balance is below zero (cash out). */
  weeksBelowZero: number[];
  /** Discounts given through early-payment adjustments: a cost of the plan, in minor units. */
  adjustmentCostMinor: bigint;
  parameters: { downsideDelayDays: number | null; runRate: boolean; eventCount: number; horizonWeeks: number };
}

export interface LatenessStat {
  counterpartyId: string;
  counterpartyName: string;
  paidCount: number;
  /** Median days late (paid date minus due date), floored at 0. */
  shiftDays: number;
}
