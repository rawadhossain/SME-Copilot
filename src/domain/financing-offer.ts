// FinancingOffer: the terms of one funding offer, entered by the owner (or read from the lender's document and confirmed).
// Product-agnostic on purpose: any loan, advance or finance product is a disbursement, optional upfront fees and a list of dated repayments.
// Wire format (JSON): amounts are integer strings in minor units. Parsed output has bigint amounts. Nothing here is simulated.
import { z } from "zod";

export const FINANCING_PRODUCTS = ["invoice_finance", "term_loan", "merchant_advance", "overdraft", "other"] as const;
export type FinancingProduct = (typeof FINANCING_PRODUCTS)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((s) => {
    const ms = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
  }, "not a real calendar date");

const BIGINT_MAX = 9223372036854775807n;
const minor = (allowZero: boolean) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer string in minor units")
    .transform((s) => BigInt(s))
    .refine((n) => n <= BIGINT_MAX, "out of range")
    .refine((n) => allowZero || n > 0n, "must be greater than zero");

export const repaymentSchema = z.object({ date: isoDate, amountMinor: minor(false) });

export const financingOfferSchema = z
  .object({
    /** Short owner label, unique within a comparison (for example "Bank A loan"). */
    id: z.string().trim().min(1).max(60),
    lender: z.string().trim().min(1).max(120),
    product: z.enum(FINANCING_PRODUCTS),
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter code"),
    /** The amount the lender advances before any fee is taken. */
    principalMinor: minor(false),
    /** Fees taken out of the advance at the start (arrangement, broker, admin). */
    upfrontFeesMinor: minor(true).default(0n),
    disbursementDate: isoDate,
    /** Every payment the lender will take, in the lender's own words turned into dated amounts. Fees paid later belong here too. */
    repayments: z.array(repaymentSchema).min(1).max(120),
  })
  .superRefine((o, ctx) => {
    if (o.upfrontFeesMinor >= o.principalMinor) ctx.addIssue({ code: "custom", path: ["upfrontFeesMinor"], message: "upfront fees must be smaller than the amount advanced" });
    o.repayments.forEach((r, i) => {
      if (r.date < o.disbursementDate) ctx.addIssue({ code: "custom", path: ["repayments", i, "date"], message: "a repayment cannot be dated before the advance" });
    });
    const total = o.repayments.reduce((a, r) => a + r.amountMinor, 0n);
    if (total <= o.principalMinor - o.upfrontFeesMinor) ctx.addIssue({ code: "custom", path: ["repayments"], message: "total repayments are not more than the money received, so this is not a cost-bearing offer; check the amounts" });
  });

export type FinancingOffer = z.output<typeof financingOfferSchema>;
export type FinancingOfferJson = z.input<typeof financingOfferSchema>;

export const financingOffersSchema = z
  .array(financingOfferSchema)
  .min(1)
  .max(6)
  .superRefine((offers, ctx) => {
    const seen = new Set<string>();
    offers.forEach((o, i) => {
      if (seen.has(o.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "two offers have the same id" });
      seen.add(o.id);
    });
    if (new Set(offers.map((o) => o.currency)).size > 1) ctx.addIssue({ code: "custom", message: "offers in different currencies cannot be compared" });
  });

export const EQUAL_FREQUENCIES = ["weekly", "fortnightly", "monthly"] as const;
