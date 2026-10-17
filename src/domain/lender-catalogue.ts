// SYNTHETIC LENDER CATALOGUE for financing-option matching. Fictional lenders and invented terms: nothing here describes a real bank or product,
// and nothing here is a quote. It is a typed, zod-validated fixture (no table, no migration). Money is integer minor units in the stated currency.
// The invoice-finance product is aligned with the sandbox lender profile (src/sandbox/personalities.ts: maxAdvanceBps 8000, feeBps 200, fee charged on
// the invoice face value) and with the invoice-finance lever (80% cap in the signed mandate, 2% fee assumption).
import { z } from "zod";

export const CATALOGUE_VERSION = "2026-10-cat-1";
export const SYNTHETIC_NOTICE = "Indicative terms from a synthetic catalogue, not a quote.";

export const PRODUCT_KINDS = ["invoice_finance", "order_finance", "working_capital_loan", "revolving_line", "seasonal_loan", "revenue_advance"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** Each criterion has a fixed unit: months, count, bps (basis points) or money (minor units). */
export const CRITERION_UNITS = {
  history_months: "months", open_invoices: "count", top_customer_share: "bps", overdue_30_share: "bps", annual_turnover: "money", confirmed_order: "count",
} as const;
export type CriterionId = keyof typeof CRITERION_UNITS;
const criterionIds = Object.keys(CRITERION_UNITS) as [CriterionId, ...CriterionId[]];

const criterionSchema = z.object({ id: z.enum(criterionIds), op: z.enum(["min", "max"]), value: z.bigint().nonnegative() });
export type Criterion = z.output<typeof criterionSchema>;

const bps = z.number().int().min(0).max(10_000);
const pricingSchema = z.discriminatedUnion("kind", [
  /** Advance against open invoices; the fee is a share of the invoice face value, taken from the advance (as the sandbox lender does). */
  z.object({ kind: z.literal("invoice_fee"), advanceBps: bps, feeBpsOfFaceValue: bps, collectionDays: z.number().int().min(1).max(180) }),
  /** Advance against a confirmed customer order; a flat fee on the amount advanced, taken upfront; repaid when the customer pays. */
  z.object({ kind: z.literal("order_fee"), advanceBps: bps, feeBpsOfAdvance: bps }),
  /** Reducing-balance loan: nominal yearly rate, monthly instalments after an optional holiday (interest during the holiday is added to the balance). */
  z.object({ kind: z.literal("amortising"), aprBps: bps, termMonthsMin: z.number().int().min(1), termMonthsMax: z.number().int().max(120), termMonths: z.number().int().min(1), holidayMonths: z.number().int().min(0).max(12) }),
  /** Credit line: interest on the amount drawn each month, principal at the end, arrangement fee on the limit. */
  z.object({ kind: z.literal("revolving"), aprBps: bps, arrangementBpsOfLimit: bps, termMonths: z.number().int().min(1).max(60) }),
  /** Factor-rate advance: total repaid = amount x factor (in thousandths: 1250 = 1.25), in equal monthly instalments. */
  z.object({ kind: z.literal("factor"), factorThousandths: z.number().int().min(1001).max(3000), instalments: z.number().int().min(1).max(36) }),
]);
export type Pricing = z.output<typeof pricingSchema>;

export const REPAYMENT_SHAPES = ["single_at_collection", "monthly_instalments", "interest_only_then_principal", "grace_then_instalments", "factor_instalments"] as const;
const shapeOf = (p: Pricing): (typeof REPAYMENT_SHAPES)[number] =>
  p.kind === "invoice_fee" || p.kind === "order_fee" ? "single_at_collection" : p.kind === "amortising" ? (p.holidayMonths > 0 ? "grace_then_instalments" : "monthly_instalments") : p.kind === "revolving" ? "interest_only_then_principal" : "factor_instalments";

export const lenderProductSchema = z
  .object({
    id: z.string().min(1).max(40),
    lenderName: z.string().min(1).max(80),
    kind: z.enum(PRODUCT_KINDS),
    label: z.string().min(1).max(80),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinMinor: z.bigint().positive(),
    amountMaxMinor: z.bigint().positive(),
    /** Amounts are offered in multiples of this (the smallest amount that covers a need is rounded up to it). */
    stepMinor: z.bigint().positive(),
    /** Used to size an offer when the business has no funding need to size to. */
    defaultAmountMinor: z.bigint().positive(),
    pricing: pricingSchema,
    disbursementDays: z.number().int().min(0).max(30),
    repaymentShape: z.enum(REPAYMENT_SHAPES),
    criteria: z.array(criterionSchema),
    /** Caps the amount at this many months of average monthly customer receipts; null = no turnover cap. */
    turnoverMonthsCap: z.number().int().positive().nullable(),
    /** True when the app has a route to act on it (a rescue-plan lever to the sandbox lender). False = compare only. */
    executable: z.boolean(),
    synthetic: z.literal(true),
    notice: z.literal(SYNTHETIC_NOTICE),
  })
  .superRefine((p, ctx) => {
    if (p.amountMinMinor > p.amountMaxMinor) ctx.addIssue({ code: "custom", message: "min amount above max amount" });
    if (p.defaultAmountMinor < p.amountMinMinor || p.defaultAmountMinor > p.amountMaxMinor) ctx.addIssue({ code: "custom", message: "default amount outside the range" });
    if (p.repaymentShape !== shapeOf(p.pricing)) ctx.addIssue({ code: "custom", message: "repayment shape does not match the pricing" });
  });
export type LenderProduct = z.output<typeof lenderProductSchema>;

const GBP = (pounds: number): bigint => BigInt(pounds) * 100n;
const base = { currency: "GBP", synthetic: true as const, notice: SYNTHETIC_NOTICE as typeof SYNTHETIC_NOTICE, stepMinor: GBP(100) };

const RAW: z.input<typeof lenderProductSchema>[] = [
  {
    ...base, id: "ifin-clearwater", lenderName: "Clearwater Business Finance Ltd (SYNTHETIC)", kind: "invoice_finance", label: "Invoice finance",
    amountMinMinor: GBP(5_000), amountMaxMinor: GBP(250_000), defaultAmountMinor: GBP(20_000),
    pricing: { kind: "invoice_fee", advanceBps: 8000, feeBpsOfFaceValue: 200, collectionDays: 45 }, disbursementDays: 2, repaymentShape: "single_at_collection",
    criteria: [
      { id: "history_months", op: "min", value: 6n }, { id: "open_invoices", op: "min", value: 3n },
      { id: "top_customer_share", op: "max", value: 6000n }, { id: "overdue_30_share", op: "max", value: 3500n },
    ],
    turnoverMonthsCap: null, executable: true,
  },
  {
    ...base, id: "ordfin-tallowrow", lenderName: "Tallow Row Trade Finance Ltd (SYNTHETIC)", kind: "order_finance", label: "Order finance (funds a supplier deposit)",
    amountMinMinor: GBP(10_000), amountMaxMinor: GBP(150_000), defaultAmountMinor: GBP(20_000),
    pricing: { kind: "order_fee", advanceBps: 7000, feeBpsOfAdvance: 400 }, disbursementDays: 5, repaymentShape: "single_at_collection",
    criteria: [{ id: "confirmed_order", op: "min", value: 1n }, { id: "history_months", op: "min", value: 6n }],
    turnoverMonthsCap: null, executable: false,
  },
  {
    ...base, id: "wcl-fenwick", lenderName: "Fenwick & Dale Business Lending Ltd (SYNTHETIC)", kind: "working_capital_loan", label: "Working capital loan",
    amountMinMinor: GBP(10_000), amountMaxMinor: GBP(100_000), defaultAmountMinor: GBP(30_000),
    pricing: { kind: "amortising", aprBps: 1600, termMonthsMin: 6, termMonthsMax: 18, termMonths: 12, holidayMonths: 0 }, disbursementDays: 4, repaymentShape: "monthly_instalments",
    criteria: [{ id: "history_months", op: "min", value: 12n }, { id: "annual_turnover", op: "min", value: GBP(250_000) }, { id: "overdue_30_share", op: "max", value: 3500n }],
    turnoverMonthsCap: 2, executable: false,
  },
  {
    ...base, id: "rcf-marlowe", lenderName: "Marlowe Credit Lines Ltd (SYNTHETIC)", kind: "revolving_line", label: "Revolving credit line",
    amountMinMinor: GBP(25_000), amountMaxMinor: GBP(150_000), defaultAmountMinor: GBP(40_000),
    pricing: { kind: "revolving", aprBps: 1200, arrangementBpsOfLimit: 50, termMonths: 12 }, disbursementDays: 7, repaymentShape: "interest_only_then_principal",
    criteria: [{ id: "history_months", op: "min", value: 12n }, { id: "annual_turnover", op: "min", value: GBP(400_000) }],
    turnoverMonthsCap: 3, executable: false,
  },
  {
    ...base, id: "seas-quarterbright", lenderName: "Quarterbright Seasonal Finance Ltd (SYNTHETIC)", kind: "seasonal_loan", label: "Seasonal loan (3-month repayment holiday)",
    amountMinMinor: GBP(20_000), amountMaxMinor: GBP(120_000), defaultAmountMinor: GBP(40_000),
    pricing: { kind: "amortising", aprBps: 2000, termMonthsMin: 12, termMonthsMax: 12, termMonths: 12, holidayMonths: 3 }, disbursementDays: 6, repaymentShape: "grace_then_instalments",
    criteria: [{ id: "history_months", op: "min", value: 18n }, { id: "annual_turnover", op: "min", value: GBP(300_000) }],
    turnoverMonthsCap: null, executable: false,
  },
  {
    ...base, id: "rev-quickfern", lenderName: "Quickfern Advances Ltd (SYNTHETIC)", kind: "revenue_advance", label: "Revenue advance (factor rate)",
    amountMinMinor: GBP(5_000), amountMaxMinor: GBP(40_000), defaultAmountMinor: GBP(10_000),
    pricing: { kind: "factor", factorThousandths: 1250, instalments: 6 }, disbursementDays: 1, repaymentShape: "factor_instalments",
    criteria: [{ id: "history_months", op: "min", value: 3n }, { id: "annual_turnover", op: "min", value: GBP(120_000) }],
    turnoverMonthsCap: null, executable: false,
  },
];

export const LENDER_CATALOGUE: readonly LenderProduct[] = z
  .array(lenderProductSchema)
  .superRefine((ps, ctx) => { if (new Set(ps.map((p) => p.id)).size !== ps.length) ctx.addIssue({ code: "custom", message: "duplicate product id" }); })
  .parse(RAW);
