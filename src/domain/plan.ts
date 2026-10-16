// Levers and plans (ADR-014, ADR-015). A lever maps 1:1 to an existing proposal kind and to applyTermChanges.
// The model's submission schema has NO computed numbers: only levers, title, rationale and contingencies.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "@/gate/canonical";

const uuid = z.string().uuid();
const bps = z.number().int().min(0).max(10000);

export const leverSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supplier_reduce_deposit"), counterpartyId: uuid, percentBps: bps }),
  z.object({ kind: z.literal("supplier_defer_balance"), counterpartyId: uuid, daysAfterShipment: z.number().int().min(1).max(180) }),
  z.object({ kind: z.literal("buyer_request_deposit"), counterpartyId: uuid, percentBps: z.number().int().min(1).max(10000) }),
  z.object({ kind: z.literal("finance_invoice"), counterpartyId: uuid, advanceBps: z.number().int().min(1).max(10000) }),
  /** Ask an overdue buyer to pay its overdue invoices within N days (ADR-024). Cash timing only; no cost. */
  z.object({ kind: z.literal("chase_overdue"), counterpartyId: uuid, payWithinDays: z.number().int().min(1).max(30) }),
  /** Offer a buyer a discount for paying its not-yet-due invoices N days earlier (ADR-024). The discount is a cost. */
  z.object({ kind: z.literal("early_payment_discount"), counterpartyId: uuid, daysEarly: z.number().int().min(1).max(60), discountBps: z.number().int().min(1).max(10000) }),
]);
export type Lever = z.output<typeof leverSchema>;
export type LeverKind = Lever["kind"];
export const LEVER_KINDS: LeverKind[] = ["supplier_reduce_deposit", "supplier_defer_balance", "buyer_request_deposit", "finance_invoice", "chase_overdue", "early_payment_discount"];

/** An ordered alternative: if the lever at ifRefusedLeverIndex is refused, use these levers instead. */
export const contingencySchema = z.object({
  ifRefusedLeverIndex: z.number().int().min(0).max(5),
  useLevers: z.array(leverSchema).max(6),
});
export type Contingency = z.output<typeof contingencySchema>;

/** What the model submits. No computed numbers by design. */
export const planSubmissionSchema = z.object({
  title: z.string().min(1).max(120),
  levers: z.array(leverSchema).min(1).max(6),
  contingencies: z.array(contingencySchema).max(6).default([]),
  rationale: z.string().min(1).max(600),
});
export type PlanSubmission = z.output<typeof planSubmissionSchema>;

export const submitPlansInputSchema = z.object({ plans: z.array(planSubmissionSchema).min(1).max(3) });

const leverOrder = (l: Lever) => `${LEVER_KINDS.indexOf(l.kind)}:${canonicalize(l)}`;
export const sortLevers = (levers: Lever[]): Lever[] => [...levers].sort((a, b) => leverOrder(a).localeCompare(leverOrder(b)));

/** Deterministic plan id: a hash of the sorted levers (the same levers always give the same id). */
export function planId(levers: Lever[]): string {
  return createHash("sha256").update(canonicalize(sortLevers(levers)), "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- computed results (never supplied by the model)

export interface PlanMetrics {
  /** All money as integer-minor-unit strings. */
  minBalanceMinor: string;
  minBalanceWeek: number; // 1-based
  firstNegativeWeek: number | null; // 1-based, or null
  weeksBelowReserve: number;
  /** Weeks whose closing balance is below zero (absent on plans stored before Batch 10). */
  weeksBelowZero?: number;
  closingAtHorizonMinor: string;
  totalCostMinor: string;
  counterpartiesNeeded: number;
  horizonWeeks: number;
}

export interface LeverCheck {
  lever: Lever;
  request: unknown; // the sandbox proposal request the lever would become (structured)
  decision: "allow" | "needs_approval" | "deny";
  reasons: string[];
}

export interface PlanView {
  id: string;
  title: string;
  levers: Lever[];
  contingencies: Contingency[];
  rationale: string;
  source: "ai" | "deterministic" | "owner";
  /** Set when the owner adjusted the levers of another plan (Batch 13); that plan's id. */
  editedFrom?: string;
  /** The owner's own plain-text notes per counterparty id (Batch 13). Kept with the plan and the log; NOT part of the signed terms and not sent. */
  ownerNotes?: Record<string, string>;
  /** True when contingencies of the base plan could not be carried over to the edited terms. */
  contingenciesDropped?: boolean;
  metrics: PlanMetrics;
  checks: LeverCheck[];
  assumptions: string[];
  /** Set by code, never by the model (for example: the plan dips below zero while a feasible plan exists). */
  warnings?: string[];
  /** Set by code: the plan cannot run as it stands because a payment its terms imply breaks a signed limit (for example the supplier balance above the per-payment limit). Owner edits with blockers are refused. */
  blockers?: string[];
  proseFlagged: boolean;
  removedSentences: string[];
  /** Finance fee (basis points of the invoice) that the metrics assume; set when the plan has a finance lever. */
  financeFeeBps?: number;
}
