// Counterparty personality, stored as JSON in counterparties.profile and validated here. Missing fields get safe defaults.
import { z } from "zod";

const bps = z.number().int().min(0).max(10000);

export const TEMPERAMENTS = ["cooperative", "stingy", "hostile"] as const;

export const profileSchema = z.object({
  temperament: z.enum(TEMPERAMENTS).default("cooperative"),
  // Buyer: the largest deposit it will pay up front, and the discount it demands per 30 days of early payment.
  maxBuyerDepositBps: bps.default(0),
  minDiscountBpsPer30Days: bps.default(300),
  // Buyer: the soonest it will commit to pay an overdue invoice, in days from now.
  minDaysToPayOverdue: z.number().int().min(0).max(180).default(14),
  // Supplier: its standard deposit, how far below that it will go, and the longest balance deferral it allows.
  standardDepositBps: bps.default(3000),
  maxSupplierDepositReductionBps: bps.default(0),
  maxBalanceDeferralDays: z.number().int().min(0).max(180).default(0),
  // Lender: the highest advance it will offer against an invoice, and its fee on the invoice face value.
  maxAdvanceBps: bps.default(0),
  feeBps: bps.default(200),
});

export type Profile = z.output<typeof profileSchema>;

export function parseProfile(raw: unknown): Profile {
  return profileSchema.parse(raw ?? {});
}
