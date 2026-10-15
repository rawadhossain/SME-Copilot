// Structured proposals and responses. Terms are typed fields; free text never carries a decision.
import { z } from "zod";

const bps = z.number().int().min(0).max(10000);
const positiveMinor = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer string (minor units)")
  .transform((s) => BigInt(s));
const currency = z.string().regex(/^[A-Z]{3}$/);

export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("buyer.request_deposit"), percentBps: bps }),
  z.object({ kind: z.literal("buyer.request_early_payment"), daysEarly: z.number().int().min(1).max(120), discountBps: bps }),
  z.object({ kind: z.literal("buyer.chase_payment"), payWithinDays: z.number().int().min(1).max(90) }),
  z.object({ kind: z.literal("supplier.reduce_deposit"), percentBps: bps }),
  z.object({ kind: z.literal("supplier.defer_balance"), daysAfterShipment: z.number().int().min(1).max(180) }),
  z.object({ kind: z.literal("lender.apply_invoice_finance"), invoiceAmountMinor: positiveMinor, currency, advanceBps: bps }),
]);

/** Wire format (amounts as strings). */
export type ProposalJson = z.input<typeof proposalSchema>;
/** Parsed form (amounts as bigint). */
export type Proposal = z.output<typeof proposalSchema>;
export type ProposalKind = Proposal["kind"];

export const OUTCOMES = ["accept", "counter", "reject", "offer", "decline"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type TermValue = number | bigint;

export interface SimResponse {
  outcome: Outcome;
  /** The agreed, countered or offered terms. Only these structured fields may drive decisions. */
  terms: Record<string, TermValue> | null;
  /** Short templated text. Display only. For a hostile counterparty it may contain manipulation. */
  note: string;
}

/** Counterparty role each proposal family may be sent to. */
export const KIND_ROLE: Record<string, "customer" | "supplier" | "lender"> = {
  buyer: "customer",
  supplier: "supplier",
  lender: "lender",
};

export function roleForKind(kind: ProposalKind): "customer" | "supplier" | "lender" {
  return KIND_ROLE[kind.split(".")[0]];
}

/** bigint-safe JSON: bigint becomes a decimal string. */
export function toJsonValue<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export const responseJsonSchema = z.object({
  outcome: z.enum(OUTCOMES),
  terms: z.record(z.string(), z.union([z.number(), z.string()])).nullable(),
  note: z.string(),
});
