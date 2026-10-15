// Pure lever simulation (ADR-014): rewrite the order's events with applyTermChanges, run the forecast, summarise.
// No database, no clock, no randomness. Reuses the existing engine; nothing is duplicated.
import type { CommitmentEvent } from "@/domain/commitment-event";
import { sortLevers, planId, type Lever, type PlanMetrics } from "@/domain/plan";
import { buildForecast } from "../forecast";
import { adjustmentsOf, applyTermChanges, type TermChanges } from "../term-changes";
import type { EngineInput, Forecast } from "../types";

/**
 * Planning assumption (ADR-010): the finance fee is 2.0% of the invoice face value. The planner never reads the
 * lender personality, so this is an assumption; the real fee is only known when the application is answered.
 */
export const FINANCE_FEE_BPS_ASSUMPTION = 200;

export class PlanError extends Error {}

export interface SimOptions {
  horizonWeeks: number;
  financeFeeBps?: number;
}

export interface SimResult {
  id: string;
  levers: Lever[];
  events: CommitmentEvent[];
  forecast: Forecast;
  metrics: PlanMetrics;
  minBalance: bigint;
  cost: bigint;
}

export function leversToChanges(levers: Lever[], feeBps = FINANCE_FEE_BPS_ASSUMPTION): TermChanges {
  const kinds = new Set<string>();
  const changes: TermChanges = {};
  for (const l of levers) {
    if (kinds.has(l.kind)) throw new PlanError(`A plan can have at most one "${l.kind}" lever`);
    kinds.add(l.kind);
    switch (l.kind) {
      case "supplier_reduce_deposit": changes.supplierDepositBps = l.percentBps; break;
      case "supplier_defer_balance": changes.supplierBalanceDeferralDays = l.daysAfterShipment; break;
      case "buyer_request_deposit": changes.buyerDepositBps = l.percentBps; break;
      case "finance_invoice": changes.invoiceFinance = { advanceBps: l.advanceBps, feeBps }; break;
      case "chase_overdue": changes.chase = { counterpartyId: l.counterpartyId, payWithinDays: l.payWithinDays }; break;
      case "early_payment_discount": changes.earlyPayment = { counterpartyId: l.counterpartyId, daysEarly: l.daysEarly, discountBps: l.discountBps }; break;
    }
  }
  return changes;
}

const sum = (events: CommitmentEvent[]) => events.reduce((a, e) => a + e.amountMinor, 0n);

export function simulateLevers(input: EngineInput, baseEvents: CommitmentEvent[], levers: Lever[], opts: SimOptions): SimResult {
  const sorted = sortLevers(levers);
  const changes = leversToChanges(sorted, opts.financeFeeBps);
  const events = sorted.length === 0 ? baseEvents : applyTermChanges(baseEvents, changes);
  const forecast = buildForecast(input, { events, horizonWeeks: opts.horizonWeeks, adjustments: adjustmentsOf(changes) });
  const min = forecast.minimum;
  // Renegotiation moves cash in time; finance costs exactly its fee; an early-payment discount is the cash given away.
  const cost = sum(baseEvents) - sum(events) + forecast.adjustmentCostMinor;
  const metrics: PlanMetrics = {
    minBalanceMinor: min.amount.toString(),
    minBalanceWeek: min.weekIndex + 1,
    firstNegativeWeek: forecast.weeksBelowZero.length > 0 ? forecast.weeksBelowZero[0] + 1 : null,
    weeksBelowReserve: forecast.weeks.filter((w) => w.belowReserve).length,
    weeksBelowZero: forecast.weeksBelowZero.length,
    closingAtHorizonMinor: forecast.weeks[forecast.weeks.length - 1].closing.toString(),
    totalCostMinor: (cost > 0n ? cost : 0n).toString(),
    counterpartiesNeeded: new Set(sorted.map((l) => l.counterpartyId)).size,
    horizonWeeks: opts.horizonWeeks,
  };
  return { id: planId(sorted), levers: sorted, events, forecast, metrics, minBalance: min.amount, cost: cost > 0n ? cost : 0n };
}

/** The "do nothing" baseline: the order accepted on its original terms. */
export const doNothing = (input: EngineInput, baseEvents: CommitmentEvent[], opts: SimOptions) => simulateLevers(input, baseEvents, [], opts);
