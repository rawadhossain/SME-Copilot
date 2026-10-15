// The requests the gate understands. Structured fields only: the gate never reads free text to decide anything.
import { z } from "zod";
import { proposalSchema } from "@/sandbox/proposals";
import { PAYMENT_PURPOSES } from "./mandate";

const uuid = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a real date");
const positiveMinor = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer string (minor units)")
  .transform((s) => BigInt(s));

export const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read.state") }),
  z.object({ kind: z.literal("draft.message"), counterpartyId: uuid, text: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("sandbox.send_proposal"), counterpartyId: uuid, proposal: proposalSchema }),
  z.object({
    kind: z.literal("sandbox.schedule_payment"),
    payeeId: uuid,
    amountMinor: positiveMinor,
    currency: z.string().regex(/^[A-Z]{3}$/),
    scheduledFor: isoDate,
    purpose: z.enum(PAYMENT_PURPOSES),
    /** Filled in when the action is proposed: the payee bank-details hash the owner is approving. */
    payeeBankDetailsHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  z.object({
    kind: z.literal("sandbox.submit_application"),
    lenderId: uuid,
    invoiceAmountMinor: positiveMinor,
    advanceBps: z.number().int().min(0).max(10000),
    /** Optional quoted fee. The actual offer fee is checked again by the verifier. */
    feeBps: z.number().int().min(0).max(10000).optional(),
  }),
  z.object({ kind: z.literal("sandbox.cancel_payment"), paymentId: uuid }),
  /** Takes up a finance offer that the lender made (ADR-016). */
  z.object({ kind: z.literal("sandbox.accept_offer"), applicationId: uuid }),
  /** Compensation: withdraws an agreement or an application (ADR-017). Reduces exposure, so it needs no mandate. */
  z.object({ kind: z.literal("sandbox.withdraw"), target: z.enum(["thread", "application", "payment", "receipt"]), id: uuid }),
  /** Schedules money expected from a customer or lender, backed by an agreed thread or an accepted application (ADR-019). */
  z.object({
    kind: z.literal("sandbox.schedule_receipt"),
    counterpartyId: uuid,
    amountMinor: positiveMinor,
    currency: z.string().regex(/^[A-Z]{3}$/),
    expectedOn: isoDate,
    backingType: z.enum(["thread", "application"]),
    backingId: uuid,
  }),
]);

export type GateRequest = z.output<typeof requestSchema>;
export type GateRequestJson = z.input<typeof requestSchema>;
export type RequestKind = GateRequest["kind"];
export type Tier = "read" | "draft" | "external" | "money";

export function tierOf(kind: RequestKind): Tier {
  switch (kind) {
    case "read.state": return "read";
    case "draft.message": return "draft";
    case "sandbox.send_proposal":
    case "sandbox.submit_application":
    case "sandbox.accept_offer":
    case "sandbox.schedule_receipt":
    case "sandbox.withdraw": return "external";
    case "sandbox.schedule_payment":
    case "sandbox.cancel_payment": return "money";
  }
}
