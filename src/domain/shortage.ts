// The structured reason a shortage was flagged (ADR-026). Numbers and enums only; it is stored with the run and shown to the planner.
import { z } from "zod";

export const shortageReasonSchema = z.object({
  kind: z.enum(["below_zero", "below_reserve"]),
  variant: z.enum(["baseline", "downside"]),
  horizonWeeks: z.number().int().min(1).max(26),
  /** Lowest weekly closing balance in the horizon and its 1-based week (minor units, string). */
  minBalanceMinor: z.string().regex(/^-?\d+$/),
  minBalanceWeek: z.number().int().min(1),
  firstNegativeWeek: z.number().int().min(1).nullable(),
  firstBelowReserveWeek: z.number().int().min(1).nullable(),
  reserveMinor: z.string().regex(/^-?\d+$/),
  /** Reserve minus the lowest balance when positive, else 0. */
  shortfallMinor: z.string().regex(/^\d+$/),
  /** Hash of the forecast that was flagged. The same hash is the same shortage (idempotency). */
  forecastHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** What started the check. */
  source: z.enum(["commitment_confirmed", "api"]),
});
export type ShortageReason = z.output<typeof shortageReasonSchema>;
