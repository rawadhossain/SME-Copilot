// FUNDING OPTIONS (Phase K). The owner types the terms of funding offers; plain code builds the offers, runs them through the same forecast as
// everything else and compares them with NOT borrowing. Read-only: nothing is stored, sent or signed, and no model is involved.
// All money arrives as decimal strings and is converted here with the money parser; the browser does no arithmetic.
import { z } from "zod";
import { FINANCING_PRODUCTS, financingOffersSchema, type FinancingOffer } from "@/domain/financing-offer";
import { applyTermChanges, compareOffers, equalInstalments, splitTotal, totalFromFactorRate, type FundingComparison } from "@/engine";
import { parseDecimalToMinor, MoneyParseError } from "@/lib/money";
import { checkSignedMandate } from "@/gate";
import { buildContext, PLANNING_HORIZON_WEEKS } from "./agent-run";
import { currentAgreedChanges } from "./shortage";
import { ActionError, type Db } from "./types";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().trim().min(1).max(24);
const frequency = z.enum(["weekly", "fortnightly", "monthly"]);

/** How the lender's repayments are described. The owner picks whichever matches the offer letter. */
const scheduleSchema = z.discriminatedUnion("kind", [
  /** N payments of the same amount. */
  z.object({ kind: z.literal("equal"), firstDate: isoDate, count: z.number().int().min(1).max(120), frequency, amount: decimal }),
  /** The offer states one total to repay, paid in N equal instalments (the last takes the rounding). */
  z.object({ kind: z.literal("total_split"), firstDate: isoDate, count: z.number().int().min(1).max(120), frequency, total: decimal }),
  /** A factor-rate quote (for example 1.35 x the amount), paid in N instalments. */
  z.object({ kind: z.literal("factor"), firstDate: isoDate, count: z.number().int().min(1).max(120), frequency, factor: z.string().regex(/^\d\.\d{1,3}$/, "factor rate looks like 1.35") }),
  /** Every payment listed with its date. */
  z.object({ kind: z.literal("dates"), repayments: z.array(z.object({ date: isoDate, amount: decimal })).min(1).max(120) }),
]);

export const offerFormSchema = z.object({
  id: z.string().trim().min(1).max(60),
  lender: z.string().trim().min(1).max(120),
  product: z.enum(FINANCING_PRODUCTS),
  principal: decimal,
  upfrontFees: decimal.default("0"),
  disbursementDate: isoDate,
  schedule: scheduleSchema,
});

export const compareFundingInputSchema = z.object({
  offers: z.array(offerFormSchema).min(1).max(6),
  /** Debt service coverage the owner wants to see, times 100 (125 = 1.25). Optional. */
  minDscrX100: z.number().int().min(50).max(500).optional(),
});

function minor(value: string, exponent: number, field: string): bigint {
  try {
    return parseDecimalToMinor(value, exponent);
  } catch (e) {
    throw new ActionError("invalid", `${field}: ${e instanceof MoneyParseError ? e.message : "not a valid amount"}`);
  }
}

/** Builds validated offers from the owner's form. Pure. Throws ActionError("invalid") with the field named. */
export function buildOffers(form: z.output<typeof compareFundingInputSchema>["offers"], currency: string): FinancingOffer[] {
  const exp = EXPONENTS[currency];
  if (exp === undefined) throw new ActionError("invalid", `Unsupported currency ${currency}`);
  const built = form.map((f) => {
    const principal = minor(f.principal, exp, `${f.id}: amount`);
    const s = f.schedule;
    let repayments: { date: string; amountMinor: string }[];
    if (s.kind === "equal") repayments = equalInstalments(s.firstDate, s.count, s.frequency, minor(s.amount, exp, `${f.id}: payment`)).map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() }));
    else if (s.kind === "total_split") repayments = splitTotal(s.firstDate, s.count, s.frequency, minor(s.total, exp, `${f.id}: total to repay`)).map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() }));
    else if (s.kind === "factor") {
      const [w, frac] = s.factor.split(".");
      const thousandths = Number(w) * 1000 + Number(frac.padEnd(3, "0"));
      let total: bigint;
      try {
        total = totalFromFactorRate(principal, thousandths);
      } catch (e) {
        throw new ActionError("invalid", `${f.id}: ${e instanceof Error ? e.message : "bad factor rate"}`);
      }
      repayments = splitTotal(s.firstDate, s.count, s.frequency, total).map((r) => ({ date: r.date, amountMinor: r.amountMinor.toString() }));
    } else repayments = s.repayments.map((r) => ({ date: r.date, amountMinor: minor(r.amount, exp, `${f.id}: payment on ${r.date}`).toString() }));
    return {
      id: f.id, lender: f.lender, product: f.product, currency, principalMinor: principal.toString(), upfrontFeesMinor: minor(f.upfrontFees, exp, `${f.id}: upfront fees`).toString(),
      disbursementDate: f.disbursementDate, repayments,
    };
  });
  const parsed = financingOffersSchema.safeParse(built);
  if (!parsed.success) throw new ActionError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "offers"}: ${i.message}`).join("; "));
  return parsed.data;
}

export interface FundingResult {
  comparison: FundingComparison;
  offers: FinancingOffer[];
  /** The owner-signed funding limits applied (null = none signed). mandateValid false means the signed mandate failed its check. */
  limits: { costBps: number | null; amountMinor: bigint | null; mandateValid: boolean };
  /** What the comparison was run against, so the screen can say it plainly. */
  basis: { asOf: string; currency: string; reserveMinor: bigint; horizonWeeks: number; includesPendingCommitments: number; includesAgreedTerms: boolean };
}

export async function compareFunding(db: Db, businessId: string, input: unknown): Promise<FundingResult> {
  const parsed = compareFundingInputSchema.parse(input);
  const ctx = await buildContext(db, businessId, null);
  const offers = buildOffers(parsed.offers, ctx.currency);
  // The same picture the shortage detector uses: the books, the confirmed commitments, and the terms agreed so far.
  const base = ctx.pending.map((p) => p.event);
  const changes = await currentAgreedChanges(db, businessId);
  let events = base;
  let agreed = false;
  try {
    if (Object.keys(changes).length > 0) { events = applyTermChanges(base, changes); agreed = true; }
  } catch {
    events = base; // an agreed term that no longer fits the order is ignored rather than guessed
  }
  // The owner-signed funding limits, when the signed mandate has them. An invalid mandate means no limits are applied and the screen says so.
  const m = checkSignedMandate(ctx.mandate);
  const limits = m.ok ? { costBps: m.mandate.limits.maxFundingCostBps ?? null, amountMinor: m.mandate.limits.maxFundingAmountMinor ?? null } : { costBps: null, amountMinor: null };
  const comparison = compareOffers(ctx.input, events, offers, { horizonWeeks: PLANNING_HORIZON_WEEKS, minDscrX100: parsed.minDscrX100, maxAnnualisedCostBps: limits.costBps, maxAmountMinor: limits.amountMinor });
  return { comparison, offers, limits: { ...limits, mandateValid: m.ok }, basis: { asOf: ctx.asOf, currency: ctx.currency, reserveMinor: ctx.input.reserve, horizonWeeks: PLANNING_HORIZON_WEEKS, includesPendingCommitments: base.length, includesAgreedTerms: agreed } };
}
