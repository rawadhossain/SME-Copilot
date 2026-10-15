// CommitmentEvent: a single dated cash movement that is not (yet) in the books, e.g. a purchase order
// receipt or a supplier deposit. Scenarios are lists of these. The future document reader will output
// exactly this shape, so it is validated at every boundary.
import { z } from "zod";

export const COMMITMENT_EVENT_KINDS = ["customer_receipt", "supplier_deposit", "supplier_balance", "cost", "financing", "other"] as const;
export const COMMITMENT_EVENT_SOURCES = ["manual", "document"] as const;
export const COMMITMENT_EVENT_CONFIDENCE = ["high", "medium", "low"] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((s) => {
    const ms = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
  }, "not a real calendar date");

const BIGINT_MAX = 9223372036854775807n;

/**
 * Wire format (JSON): amountMinor is a signed integer string. Parsed output has amountMinor as bigint.
 * Positive = cash in, negative = cash out. Zero is rejected.
 */
export const commitmentEventSchema = z.object({
  date: isoDate,
  amountMinor: z
    .string()
    .regex(/^-?\d+$/, "amountMinor must be an integer string")
    .transform((s, ctx) => {
      try {
        return BigInt(s);
      } catch {
        ctx.addIssue({ code: "custom", message: "amountMinor is not an integer" });
        return z.NEVER;
      }
    })
    .refine((n) => n !== 0n, "amountMinor must not be zero")
    .refine((n) => n <= BIGINT_MAX && n >= -BIGINT_MAX, "amountMinor out of range"),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter code"),
  label: z.string().trim().min(1).max(200),
  kind: z.enum(COMMITMENT_EVENT_KINDS),
  source: z.enum(COMMITMENT_EVENT_SOURCES),
  confidence: z.enum(COMMITMENT_EVENT_CONFIDENCE),
  /** Optional pointer to where it came from (document id, quote number). Free text, treated as data. */
  sourceRef: z.string().max(200).optional(),
});

export type CommitmentEvent = z.output<typeof commitmentEventSchema>;
export type CommitmentEventJson = z.input<typeof commitmentEventSchema>;

export const commitmentEventsSchema = z.array(commitmentEventSchema).max(50);

export function commitmentEventToJson(e: CommitmentEvent): CommitmentEventJson {
  return { ...e, amountMinor: e.amountMinor.toString() };
}
