// FINANCING-OPTION MATCHING. Reads the books, the bank transactions and the confirmed commitments for ONE business, derives a profile, and hands it
// with the synthetic lender catalogue to the pure matcher (src/engine/financing/match.ts). The need is the one assessFunding measures
// (currentFundingNeed). No model, nothing applied for or sent; the only write is one log record. Every result is indicative, never a quote.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { businesses } from "@/db/schema";
import { LENDER_CATALOGUE } from "@/domain/lender-catalogue";
import { matchProducts, type BusinessProfile, type MatchOutput, type MatchResult } from "@/engine";
import { formatDecimal } from "@/lib/money";
import { currentFundingNeed } from "./funding-decision";
import { loadBusinessProfile } from "./funding-profile";
import { appendRecord } from "./log";
import { sha256Hex } from "./plan-terms";
import { toJsonValue } from "@/sandbox/proposals";
import { worldDate } from "./state";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };

/** What the screen needs beyond the pure result, prepared here so the browser does no money arithmetic. */
export interface MatchExtras {
  /** Share of the need the money actually received (after upfront fees) covers, basis points (capped at 10,000); null without a need or an offer. */
  coverageBps: number | null;
  /** The offer in the shape of the funding comparison form (every payment dated), so "Add to comparison" can pre-fill it. */
  compareForm: { id: string; lender: string; product: string; principal: string; upfrontFees: string; disbursementDate: string; schedule: { kind: "dates"; repayments: { date: string; amount: string }[] } } | null;
}

export interface FundingMatch {
  profile: BusinessProfile;
  need: { needed: boolean; amountMinor: bigint; firstShortWeek: number | null };
  match: MatchOutput;
  extras: Record<string, MatchExtras>;
}

function extrasOf(r: MatchResult, currency: string, need: bigint | null): MatchExtras {
  const exp = EXPONENTS[currency] ?? 2;
  const o = r.offer;
  const net = r.netReceivedMinor;
  const covered = need !== null && need > 0n && net !== null ? (net >= need ? 10_000n : (net * 10_000n) / need) : null;
  return {
    coverageBps: covered === null ? null : Number(covered),
    compareForm: o ? {
      id: o.id, lender: o.lender, product: o.product, principal: formatDecimal(o.principalMinor, exp), upfrontFees: formatDecimal(o.upfrontFeesMinor, exp), disbursementDate: o.disbursementDate,
      schedule: { kind: "dates", repayments: o.repayments.map((p) => ({ date: p.date, amount: formatDecimal(p.amountMinor, exp) })) },
    } : null,
  };
}

/** Read-only: everything except the log record. Exported so the check can compare it with the pure functions. */
export async function computeFundingMatch(db: Db, businessId: string): Promise<FundingMatch> {
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const { ctx, events, need } = await currentFundingNeed(db, businessId);
  const profile = await loadBusinessProfile(db, businessId, ctx, events);
  const amount = need.needed ? need.peakShortfallMinor : 0n;
  const match = matchProducts(profile, LENDER_CATALOGUE, need.needed ? amount : null);
  return {
    profile, need: { needed: need.needed, amountMinor: amount, firstShortWeek: need.firstShortWeek }, match,
    extras: Object.fromEntries(match.results.map((r) => [r.productId, extrasOf(r, profile.currency, match.needMinor)])),
  };
}

export async function matchFunding(db: Db, businessId: string): Promise<FundingMatch> {
  const result = await computeFundingMatch(db, businessId);
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.FUNDING_MATCHED, actor: "agent",
    detail: {
      catalogueVersion: result.match.catalogueVersion, asOf: result.match.asOf, needMinor: result.match.needMinor?.toString() ?? null,
      products: result.match.results.map((r) => ({ id: r.productId, verdict: r.verdict, rank: r.rank })), matchHash: sha256Hex(toJsonValue(result.match)),
    },
  });
  return result;
}

// ------------------------------------------------------------------------------------------------------------------ the owner's declared start of trading

export const EARLIEST_TRADING_SINCE = "1950-01-01";
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.").refine((s) => new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "That is not a real calendar date.");
export const declareProfileSchema = z.object({ tradingSince: dateText.nullable() });

/** The owner states when the business started trading (their own statement, never verified here). Null clears it. The only write besides one log record. */
export async function declareTradingSince(db: Db, businessId: string, input: unknown, actorName = "owner") {
  const parsed = declareProfileSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("invalid", parsed.error.issues.map((i) => i.message).join(" "));
  const { tradingSince } = parsed.data;
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  if (tradingSince !== null) {
    if (tradingSince < EARLIEST_TRADING_SINCE) throw new ActionError("invalid", "The date cannot be before 1 January 1950.");
    const asOf = await worldDate(db, businessId);
    if (tradingSince > asOf) throw new ActionError("invalid", `The business cannot have started trading after today's books date (${asOf}).`);
  }
  await db.transaction(async (tx) => {
    await tx.update(businesses).set({ tradingSince }).where(eq(businesses.id, businessId));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.FUNDING_PROFILE_DECLARED, actor: "owner", detail: { tradingSince, declaredBy: actorName, verified: false } });
  });
  return { tradingSince, verified: false as const };
}
