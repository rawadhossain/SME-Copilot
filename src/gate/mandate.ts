// The owner-signed mandate: the limits the agent must stay within. Wire form has money as strings (it is what is
// canonicalised and signed); the parsed form has bigint. This is a simplified stand-in for verifiable-credential style
// mandates (such as AP2): limits are signed, verified and enforced in code, never in prompts.
import { z } from "zod";

export const PAYMENT_PURPOSES = ["supplier", "loan", "payroll", "tax", "other"] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PROPOSAL_KINDS = [
  "buyer.request_deposit",
  "buyer.request_early_payment",
  "buyer.chase_payment",
  "supplier.reduce_deposit",
  "supplier.defer_balance",
  "lender.apply_invoice_finance",
] as const;

const minor = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer string (minor units)")
  .transform((s) => BigInt(s));
const bps = z.number().int().min(0).max(10000);

export const mandateSchema = z.object({
  version: z.number().int().min(1),
  businessId: z.string().uuid(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  limits: z.object({
    maxEarlyPaymentDiscountBps: bps,
    maxPaymentMinor: minor,
    maxDailyOutflowMinor: minor,
    /** Hard floor for the sandbox bank balance. */
    minBankBalanceMinor: minor,
    /** The agent may never initiate payments for these purposes. */
    forbiddenPurposes: z.array(z.enum(PAYMENT_PURPOSES)),
    allowNewPayees: z.boolean(),
    allowedProposalKinds: z.array(z.enum(PROPOSAL_KINDS)),
    maxFinanceAdvanceBps: bps,
    maxFinanceFeeBps: bps,
    /** Money movements above this amount need two confirmations. */
    requireSecondConfirmationAboveMinor: minor,
    /**
     * Funding offers (Phase K), optional so older signed mandates still verify. The ceiling on the estimated annualised cost of an offer
     * (average-balance figure, basis points) and on the amount one offer advances. They shape the comparison the owner sees; nothing
     * executes a loan, so no gate decision depends on them yet.
     */
    maxFundingCostBps: z.number().int().min(0).max(100000).optional(),
    maxFundingAmountMinor: minor.optional(),
  }),
});

/** Parsed form (money as bigint). */
export type Mandate = z.output<typeof mandateSchema>;
/** Wire form (money as strings): what is canonicalised, signed and stored. */
export type MandateWire = z.input<typeof mandateSchema>;

/** A mandate as stored: canonical JSON text plus the owner's Ed25519 signature over exactly that text. */
export interface SignedMandate {
  canonical: string;
  signature: string;
}
