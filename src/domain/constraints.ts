// Constraints learned from a counterparty's STRUCTURED reply (ADR-021): a refused lever, a cap on a deposit, a floor on a
// supplier deposit, a longest deferral, or a lender fee that differs from the planning assumption. Only numbers and flags that
// the simulator or counterparty put in the structured response fields; free text never becomes a constraint. Pure.
import { z } from "zod";
import { LEVER_KINDS, type Lever, type LeverKind } from "./plan";

const bps = z.number().int().min(0).max(10000);

export const constraintSchema = z.object({
  kind: z.enum(LEVER_KINDS as unknown as [LeverKind, ...LeverKind[]]),
  counterpartyId: z.string().uuid(),
  /** The counterparty refused this lever outright. */
  excluded: z.boolean().default(false),
  /** Supplier deposit: the counterparty will not go below this share (basis points). */
  minPercentBps: bps.optional(),
  /** Buyer deposit: the counterparty will not pay more than this share. */
  maxPercentBps: bps.optional(),
  /** Balance deferral: the longest the counterparty allows. */
  maxDays: z.number().int().min(0).max(180).optional(),
  /** Chase: the buyer will not pay overdue invoices sooner than this many days. */
  minDays: z.number().int().min(0).max(180).optional(),
  /** Early payment: the buyer wants at least this discount for paying earlier (basis points). */
  minDiscountBps: bps.optional(),
  /** Finance: the fee the lender really charges, as basis points of the invoice. */
  assumedFeeBps: bps.optional(),
  source: z.enum(["reject", "decline", "counter", "offer"]),
  /** The re-plan round in which this was learned (1 = learned during the first execution). */
  round: z.number().int().min(1),
});
export type Constraint = z.output<typeof constraintSchema>;

export const MAX_REPLAN_ROUNDS = 2;
/** Owner-driven revisions (Batch 13) are not limited by the agent's two rounds, but are capped so a negotiation cannot loop forever. */
export const MAX_OWNER_REVISIONS = 6;

/** Merges constraints: per (kind, counterparty) the tightest value of each field wins. */
export function mergeConstraints(...lists: Constraint[][]): Constraint[] {
  const out = new Map<string, Constraint>();
  for (const c of lists.flat()) {
    const key = `${c.kind}:${c.counterpartyId}`;
    const prev = out.get(key);
    if (!prev) { out.set(key, { ...c }); continue; }
    const pick = (a: number | undefined, b: number | undefined, f: (x: number, y: number) => number) => (a === undefined ? b : b === undefined ? a : f(a, b));
    out.set(key, {
      ...prev,
      excluded: prev.excluded || c.excluded,
      minPercentBps: pick(prev.minPercentBps, c.minPercentBps, Math.max),
      maxPercentBps: pick(prev.maxPercentBps, c.maxPercentBps, Math.min),
      maxDays: pick(prev.maxDays, c.maxDays, Math.min),
      minDays: pick(prev.minDays, c.minDays, Math.max),
      minDiscountBps: pick(prev.minDiscountBps, c.minDiscountBps, Math.max),
      assumedFeeBps: pick(prev.assumedFeeBps, c.assumedFeeBps, Math.max),
      source: c.source,
      round: Math.max(prev.round, c.round),
    });
  }
  return [...out.values()].sort((a, b) => `${a.kind}:${a.counterpartyId}`.localeCompare(`${b.kind}:${b.counterpartyId}`));
}

/** The lender fee to assume when planning: the largest fee any lender constraint observed, else the default. */
export const assumedFeeBps = (constraints: Constraint[], fallback: number): number =>
  constraints.reduce((m, c) => (c.kind === "finance_invoice" && c.assumedFeeBps !== undefined ? Math.max(m, c.assumedFeeBps) : m), fallback);

/** Reasons a lever breaks a learned constraint. Empty when it is fine. */
export function constraintProblems(levers: Lever[], constraints: Constraint[]): string[] {
  const problems: string[] = [];
  for (const l of levers) {
    for (const c of constraints.filter((x) => x.kind === l.kind && x.counterpartyId === l.counterpartyId)) {
      if (c.excluded) problems.push(`${l.kind}: this counterparty refused this lever; it cannot be used again`);
      if (l.kind === "supplier_reduce_deposit" && c.minPercentBps !== undefined && l.percentBps < c.minPercentBps) problems.push(`${l.kind}: the counterparty will not go below a ${c.minPercentBps / 100}% deposit`);
      if (l.kind === "buyer_request_deposit" && c.maxPercentBps !== undefined && l.percentBps > c.maxPercentBps) problems.push(`${l.kind}: the counterparty will not pay more than a ${c.maxPercentBps / 100}% deposit`);
      if (l.kind === "supplier_defer_balance" && c.maxDays !== undefined && l.daysAfterShipment > c.maxDays) problems.push(`${l.kind}: the counterparty allows at most ${c.maxDays} days`);
      if (l.kind === "chase_overdue" && c.minDays !== undefined && l.payWithinDays < c.minDays) problems.push(`${l.kind}: the counterparty will not pay sooner than ${c.minDays} days`);
      if (l.kind === "early_payment_discount" && c.minDiscountBps !== undefined && l.discountBps < c.minDiscountBps) problems.push(`${l.kind}: the counterparty wants at least a ${c.minDiscountBps / 100}% discount`);
    }
  }
  return problems;
}
