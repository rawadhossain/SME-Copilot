// Financing decision (pure, deterministic, no database, no clock, no model). Given the do-nothing forecast, the rescue options that do not
// need borrowing, and the funding candidates that exist, it works out: how much funding is needed and by when, whether a non-borrowing option
// solves it, which candidates are affordable (judged week by week on the forecast, not on the headline rate), and a ranked recommendation.
// Every figure is integer minor units from the engine; the sentences are templates filled from those figures. Nothing here applies for or
// accepts anything.
import { formatMoney, money } from "@/lib/money";
import { diffDays } from "../dates";
import type { Dscr, OfferResult, Stacking, Summary } from "./compare";
import type { FinancingOffer } from "@/domain/financing-offer";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
const cash = (minor: bigint, currency: string) => formatMoney(money(minor, currency), EXPONENTS[currency] ?? 2);
const pct1 = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const x100 = (n: number) => (n / 100).toFixed(2);

// ------------------------------------------------------------------------------------------------------------------ the need

export interface ShortWeek { week: number; start: string; closingMinor: bigint; shortfallMinor: bigint }
export interface FundingNeed {
  needed: boolean;
  belowZero: boolean;
  reserveMinor: bigint;
  /** The deepest gap: reserve minus the lowest closing balance. This is the most that is ever missing at one time. */
  peakShortfallMinor: bigint;
  peakWeek: number | null;
  peakWeekStart: string | null;
  /** The amount needed only to stay at or above zero (lower than the peak when the reserve is the thing being protected). */
  zeroShortfallMinor: bigint;
  firstShortWeek: number | null;
  firstShortStart: string | null;
  /** What is missing in the FIRST short week: the amount needed at that date, which can be less than the peak. */
  firstShortfallMinor: bigint;
  weeksBelowReserve: number;
  weeks: ShortWeek[];
  horizonWeeks: number;
}

export function assessNeed(s: Summary, reserveMinor: bigint, horizonWeeks: number): FundingNeed {
  const weeks: ShortWeek[] = s.weekly.filter((w) => w.closingMinor < reserveMinor).map((w) => ({ week: w.index, start: w.start, closingMinor: w.closingMinor, shortfallMinor: reserveMinor - w.closingMinor }));
  const peak = s.minBalanceMinor < reserveMinor ? reserveMinor - s.minBalanceMinor : 0n;
  return {
    needed: weeks.length > 0,
    belowZero: s.firstNegativeWeek !== null,
    reserveMinor,
    peakShortfallMinor: peak,
    peakWeek: peak > 0n ? s.minBalanceWeek : null,
    peakWeekStart: peak > 0n ? (s.weekly.find((w) => w.index === s.minBalanceWeek)?.start ?? null) : null,
    zeroShortfallMinor: s.minBalanceMinor < 0n ? -s.minBalanceMinor : 0n,
    firstShortWeek: weeks[0]?.week ?? null,
    firstShortStart: weeks[0]?.start ?? null,
    firstShortfallMinor: weeks[0]?.shortfallMinor ?? 0n,
    weeksBelowReserve: weeks.length,
    weeks,
    horizonWeeks,
  };
}

/** The funding that must already have arrived on `date` to keep every week from then on at or above the reserve. */
export function neededBy(need: FundingNeed, asOf: string, date: string): bigint {
  const idx = Math.floor(diffDays(asOf, date) / 7) + 1;
  return need.weeks.filter((w) => w.week >= idx).reduce((m, w) => (w.shortfallMinor > m ? w.shortfallMinor : m), 0n);
}

// ------------------------------------------------------------------------------------------------------------------ alternatives

/** One rescue option that does not borrow: chase an overdue invoice, early-payment discount, supplier deposit or terms, buyer deposit. */
export interface AlternativeInput {
  id: string;
  /** What the owner would ask for, in words built from the lever (for example "Chase Acme: pay within 7 days"). */
  actions: string[];
  leverKinds: string[];
  summary: Summary;
  /** Cost of the option (for example an early-payment discount), minor units. */
  costMinor: bigint;
  counterparties: number;
}
export type AlternativeOutcome = "removes_need" | "reduces_need" | "no_help";
export interface AlternativeResult extends AlternativeInput {
  outcome: AlternativeOutcome;
  lowestBalanceMinor: bigint;
  lowestBalanceWeek: number;
  /** Peak shortfall that is still left with this option. */
  remainingShortfallMinor: bigint;
  reducesNeedByMinor: bigint;
  weeksBelowReserve: number;
  firstNegativeWeek: number | null;
}

function rankAlternatives(need: FundingNeed, alts: AlternativeInput[]): AlternativeResult[] {
  const out = alts.map((a): AlternativeResult => {
    const remaining = a.summary.minBalanceMinor < need.reserveMinor ? need.reserveMinor - a.summary.minBalanceMinor : 0n;
    const outcome: AlternativeOutcome = a.summary.weeksBelowReserve === 0 ? "removes_need" : remaining < need.peakShortfallMinor ? "reduces_need" : "no_help";
    return { ...a, outcome, lowestBalanceMinor: a.summary.minBalanceMinor, lowestBalanceWeek: a.summary.minBalanceWeek, remainingShortfallMinor: remaining, reducesNeedByMinor: need.peakShortfallMinor - remaining, weeksBelowReserve: a.summary.weeksBelowReserve, firstNegativeWeek: a.summary.firstNegativeWeek };
  });
  const tier = { removes_need: 0, reduces_need: 1, no_help: 2 } as const;
  const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort((a, b) => tier[a.outcome] - tier[b.outcome] || (a.outcome === "removes_need" ? cmp(a.costMinor, b.costMinor) || a.counterparties - b.counterparties : cmp(a.remainingShortfallMinor, b.remainingShortfallMinor) || cmp(a.costMinor, b.costMinor)) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------------------------------------------------------ candidates

export type CandidateSource = "owner_entered_offer" | "sandbox_invoice_finance" | "catalogue";

/** What the synthetic lender catalogue says about a product: shown beside a candidate (never a quote). */
export interface CatalogueInfo {
  productId: string;
  verdict: "eligible" | "near_miss" | "not_eligible";
  reason: string;
  coversNeed: boolean | null;
  criteria: { label: string; op: "min" | "max"; unit: "months" | "count" | "bps" | "money"; required: bigint; actual: bigint | null; status: "met" | "not_met" | "not_applicable"; note: string | null }[];
  notice: string;
}
export type Affordability = "affordable" | "affordable_with_caution" | "partly_covers" | "not_affordable";

/** What the engine knows about one way of borrowing, before it is judged. Offers entered by the owner and the sandbox lender both become this. */
export interface RawCandidate {
  id: string;
  source: CandidateSource;
  label: string;
  lender: string;
  product: string;
  advanceMinor: bigint;
  netReceivedMinor: bigint;
  disbursementDate: string;
  totalRepaymentMinor: bigint;
  totalCostMinor: bigint;
  annualisedCostBps: number | null;
  firstRepaymentDate: string | null;
  lastRepaymentDate: string | null;
  repaymentCount: number;
  summary: Summary;
  dscr: Dscr | null;
  stacking: Stacking | null;
  repaymentsAfterWindowMinor: bigint;
  /** Terms that are an assumption, not a quote (the sandbox lender's fee). */
  termsAssumed: boolean;
  /** Reasons the owner's signed limits or the gate would stop this one. */
  restrictions: string[];
  /** How the owner can proceed, decided by the caller from what the application really supports. */
  route: { kind: "rescue_plan" | "none"; note: string };
  /** Set only on candidates that come from, or are described by, the synthetic lender catalogue. */
  catalogue?: CatalogueInfo;
  /** True for catalogue offers: indicative terms, not a quote. */
  indicative?: true;
}

export interface FundingCandidate extends RawCandidate {
  affordability: Affordability;
  rank: number;
  lowestBalanceMinor: bigint;
  lowestBalanceWeek: number;
  lowestBalanceChangeMinor: bigint;
  /** Peak shortfall still left with this candidate. */
  remainingShortfallMinor: bigint;
  weeksBelowReserve: number;
  firstNegativeWeek: number | null;
  /** Weeks that were above the reserve without borrowing and fall below it with this candidate (the repayments caused them). */
  newShortWeeks: number[];
  /** The largest amount by which a week is lower than if the owner had not borrowed, and which week (the repayment squeeze). */
  worstWeekVsNotBorrowing: { week: number; lowerByMinor: bigint } | null;
  /** Part of the money received that is more than the peak shortfall. */
  moreThanNeededMinor: bigint;
  /** Why it was judged as it was, each a complete sentence built from engine figures. */
  reasons: string[];
}

export function fromOffer(o: FinancingOffer, r: OfferResult, restrictions: string[], route: RawCandidate["route"]): RawCandidate {
  const dates = o.repayments.map((x) => x.date).sort();
  return {
    id: o.id, source: "owner_entered_offer", label: o.id, lender: o.lender, product: o.product,
    advanceMinor: o.principalMinor, netReceivedMinor: r.cost.netReceivedMinor, disbursementDate: o.disbursementDate,
    totalRepaymentMinor: r.cost.totalRepaymentMinor, totalCostMinor: r.cost.totalCostMinor, annualisedCostBps: r.cost.annualisedCostBps,
    firstRepaymentDate: dates[0] ?? null, lastRepaymentDate: r.cost.lastRepaymentDate, repaymentCount: o.repayments.length,
    summary: r.summary, dscr: r.dscr, stacking: r.stacking, repaymentsAfterWindowMinor: r.repaymentsAfterWindowMinor, termsAssumed: false, restrictions, route,
  };
}

function judge(raw: RawCandidate, base: Summary, need: FundingNeed): Omit<FundingCandidate, "rank"> {
  const s = raw.summary;
  const reserve = need.reserveMinor;
  const baseByWeek = new Map(base.weekly.map((w) => [w.index, w.closingMinor]));
  const newShortWeeks = s.weekly.filter((w) => w.closingMinor < reserve && (baseByWeek.get(w.index) ?? 0n) >= reserve).map((w) => w.index);
  let worst: FundingCandidate["worstWeekVsNotBorrowing"] = null;
  for (const w of s.weekly) {
    const diff = (baseByWeek.get(w.index) ?? 0n) - w.closingMinor;
    if (diff > 0n && (!worst || diff > worst.lowerByMinor)) worst = { week: w.index, lowerByMinor: diff };
  }
  return {
    ...raw,
    affordability: "affordable", // set by classify
    lowestBalanceMinor: s.minBalanceMinor, lowestBalanceWeek: s.minBalanceWeek, lowestBalanceChangeMinor: s.minBalanceMinor - base.minBalanceMinor,
    remainingShortfallMinor: s.minBalanceMinor < reserve ? reserve - s.minBalanceMinor : 0n,
    weeksBelowReserve: s.weeksBelowReserve, firstNegativeWeek: s.firstNegativeWeek, newShortWeeks, worstWeekVsNotBorrowing: worst,
    moreThanNeededMinor: need.peakShortfallMinor > 0n && raw.netReceivedMinor > need.peakShortfallMinor ? raw.netReceivedMinor - need.peakShortfallMinor : 0n,
    reasons: [],
  };
}

/** Classifies one candidate. Kept apart from `judge` so the sentences can name the currency. */
function classify(c: Omit<FundingCandidate, "rank">, base: Summary, need: FundingNeed, asOf: string, currency: string): Omit<FundingCandidate, "rank"> {
  const m = (v: bigint) => cash(v, currency);
  const reasons: string[] = [];
  const cautions: string[] = [];
  let hard = c.restrictions.length > 0;
  reasons.push(...c.restrictions);

  const newNegative = c.firstNegativeWeek !== null && (base.firstNegativeWeek === null || c.firstNegativeWeek < base.firstNegativeWeek);
  if (newNegative) { hard = true; reasons.push(`Cash would go below zero in week ${c.firstNegativeWeek} with this, which does not happen without it.`); }
  if (c.newShortWeeks.length > 0) {
    hard = true;
    reasons.push(`The repayments would push cash below your ${m(need.reserveMinor)} safety cushion in ${c.newShortWeeks.length === 1 ? "week" : "weeks"} ${c.newShortWeeks.slice(0, 6).join(", ")}${c.newShortWeeks.length > 6 ? " and later" : ""}, weeks that are fine without it.`);
  }
  if (c.lowestBalanceChangeMinor <= 0n && need.needed) { hard = true; reasons.push(`It does not raise your lowest balance (${m(c.lowestBalanceMinor)} in week ${c.lowestBalanceWeek}): the repayments bring cash back down before enough comes in, so it only delays the gap.`); }

  const arrivesLate = need.firstShortWeek !== null && Math.floor(diffDays(asOf, c.disbursementDate) / 7) + 1 > need.firstShortWeek;
  if (arrivesLate) reasons.push(`The money arrives on ${c.disbursementDate}, after the gap starts in week ${need.firstShortWeek}.`);
  const covers = c.weeksBelowReserve === 0;
  if (!covers && !hard) reasons.push(c.remainingShortfallMinor > 0n ? `Your cash still falls ${m(c.remainingShortfallMinor)} short of the safety cushion at its lowest point (week ${c.lowestBalanceWeek}).` : `${c.weeksBelowReserve} week${c.weeksBelowReserve === 1 ? " is" : "s are"} still below the safety cushion.`);

  if (c.dscr && c.dscr.warn) cautions.push(c.dscr.ratioX100 !== null && c.dscr.ratioX100 <= 0 ? "Your operating cash flow over the forecast is not positive, so the repayments would be paid from the money borrowed or from the cushion." : `Debt service coverage is ${x100(c.dscr.ratioX100 as number)}, below the ${x100(c.dscr.minRequiredX100)} lenders usually want.`);
  if (c.stacking && c.stacking.warn && c.stacking.peakWeek !== null) cautions.push(`Week ${c.stacking.peakWeek} carries ${m(c.stacking.peakWeeklyRepaymentMinor)} of repayments${c.stacking.burdenBps !== null ? `, ${pct1(c.stacking.burdenBps)} of an average week's money in` : ""}.`);
  if (c.repaymentsAfterWindowMinor > 0n) cautions.push(`${m(c.repaymentsAfterWindowMinor)} of repayments fall after the ${need.horizonWeeks}-week forecast, so affordability beyond it is not tested.`);
  if (c.termsAssumed) cautions.push("The terms are an assumption, not a quote: the real fee is known only when the lender answers.");
  if (c.moreThanNeededMinor > 0n) cautions.push(`It brings in ${m(c.moreThanNeededMinor)} more than the gap needs, and you pay for all of it.`);

  const affordability: Affordability = hard ? "not_affordable" : !covers ? "partly_covers" : cautions.length > 0 ? "affordable_with_caution" : "affordable";
  if (affordability === "affordable") reasons.push(`Keeps every week of the forecast at or above your ${m(need.reserveMinor)} cushion, with repayments included.`);
  return { ...c, affordability, reasons: [...reasons, ...cautions] };
}

const TIER: Record<Affordability, number> = { affordable: 0, affordable_with_caution: 1, partly_covers: 2, not_affordable: 3 };

function rankCandidates(list: Omit<FundingCandidate, "rank">[]): FundingCandidate[] {
  const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  // Within a tier: lower total cost, then a higher lowest balance, then a later first repayment (more breathing room), then name.
  const sorted = [...list].sort((a, b) => TIER[a.affordability] - TIER[b.affordability] || cmp(a.totalCostMinor, b.totalCostMinor) || cmp(b.lowestBalanceMinor, a.lowestBalanceMinor) || (a.firstRepaymentDate ?? "9999") .localeCompare(b.firstRepaymentDate ?? "9999") * -1 || a.id.localeCompare(b.id));
  return sorted.map((c, i) => ({ ...c, rank: i + 1 }));
}

// ------------------------------------------------------------------------------------------------------------------ the decision

export type RecommendationKind = "no_funding_needed" | "avoid_borrowing" | "borrow" | "borrow_partial_only" | "no_suitable_offer";

export interface Recommendation {
  kind: RecommendationKind;
  headline: string;
  reasons: string[];
  alternativeId: string | null;
  candidateId: string | null;
  /** What is still missing after the recommended non-borrowing option, if any. */
  remainingNeedMinor: bigint;
  /** What a lender would have to provide, and by when, to close the gap: the amount that must already have arrived by that date. */
  target: { amountMinor: bigint; byDate: string } | null;
}

export interface FundingDecision {
  v: 1;
  asOf: string;
  currency: string;
  horizonWeeks: number;
  need: FundingNeed;
  alternatives: AlternativeResult[];
  candidates: FundingCandidate[];
  /** Things the owner should know that are not a candidate (an option that is unavailable and why). */
  unavailable: { label: string; reason: string }[];
  recommendation: Recommendation;
  caveats: string[];
}

export interface DecideInput {
  asOf: string;
  currency: string;
  horizonWeeks: number;
  reserveMinor: bigint;
  /** The do-nothing picture. */
  baseline: Summary;
  alternatives: AlternativeInput[];
  candidates: RawCandidate[];
  unavailable?: { label: string; reason: string }[];
}

export function decideFunding(inp: DecideInput): FundingDecision {
  const { asOf, currency, horizonWeeks } = inp;
  const m = (v: bigint) => cash(v, currency);
  const need = assessNeed(inp.baseline, inp.reserveMinor, horizonWeeks);
  const alternatives = rankAlternatives(need, inp.alternatives);
  const candidates = rankCandidates(inp.candidates.map((raw) => classify(judge(raw, inp.baseline, need), inp.baseline, need, asOf, currency)));
  const caveats = [
    "Everything shown is computed from your books and confirmed orders. Nothing has been applied for, accepted or signed.",
    "A customer or supplier has to agree to any rescue option; until they answer, it is a request, not a result.",
    "Offers are the terms you typed in. Whether a lender would approve you is not known here.",
  ];
  const best = alternatives[0] ?? null;
  const usable = candidates.filter((c) => c.affordability === "affordable" || c.affordability === "affordable_with_caution");
  const partial = candidates.filter((c) => c.affordability === "partly_covers");
  const byDate = need.firstShortStart;
  const target = need.needed && byDate ? { amountMinor: neededBy(need, asOf, byDate), byDate } : null;
  let rec: Recommendation;

  if (!need.needed) {
    rec = { kind: "no_funding_needed", headline: `No borrowing is needed. Your forecast stays above your ${m(need.reserveMinor)} safety cushion for the next ${horizonWeeks} weeks.`, reasons: [`Your lowest balance is ${m(inp.baseline.minBalanceMinor)} in week ${inp.baseline.minBalanceWeek}.`, "Borrowing would only add cost."], alternativeId: null, candidateId: null, remainingNeedMinor: 0n, target: null };
  } else if (best && best.outcome === "removes_need") {
    const cheapest = [...candidates].sort((a, b) => (a.totalCostMinor < b.totalCostMinor ? -1 : 1))[0];
    const reasons = [
      `${best.actions.join("; ")}. With that, your lowest balance is ${m(best.lowestBalanceMinor)} (week ${best.lowestBalanceWeek}), above your ${m(need.reserveMinor)} cushion in every week.`,
      best.costMinor > 0n ? `It costs ${m(best.costMinor)}.` : "It has no direct cost.",
      cheapest ? `The cheapest funding offer entered would cost ${m(cheapest.totalCostMinor)} in interest and fees.` : "No funding offers are entered, and none is needed for this.",
    ];
    if (usable[0]) reasons.push(`If they say no, the fallback is ${usable[0].label} (${m(usable[0].totalCostMinor)} total cost).`);
    rec = { kind: "avoid_borrowing", headline: `Avoid borrowing: asking ${best.counterparties === 1 ? "one counterparty" : `${best.counterparties} counterparties`} could close the ${m(need.peakShortfallMinor)} gap.`, reasons, alternativeId: best.id, candidateId: null, remainingNeedMinor: 0n, target };
  } else if (usable[0]) {
    const c = usable[0];
    const reasons = [
      `${c.label} brings in ${m(c.netReceivedMinor)} on ${c.disbursementDate} and keeps every week of the forecast at or above your cushion, with its repayments included.`,
      `Total cost ${m(c.totalCostMinor)}${c.annualisedCostBps !== null ? ` (about ${pct1(c.annualisedCostBps)} a year)` : ""}; repayments ${c.firstRepaymentDate ? `run from ${c.firstRepaymentDate} to ${c.lastRepaymentDate}` : `are settled from your customer's payment`}.`,
    ];
    if (best && best.outcome === "reduces_need") reasons.push(`Asking first would help: "${best.actions.join("; ")}" cuts the gap from ${m(need.peakShortfallMinor)} to ${m(best.remainingShortfallMinor)}, so you could borrow less.`);
    else reasons.push("No option that avoids borrowing closes the gap on its own.");
    if (c.affordability === "affordable_with_caution") reasons.push(...c.reasons.filter((r) => !r.startsWith("Keeps every week")).map((r) => `Caution: ${r}`));
    rec = { kind: "borrow", headline: `Borrowing looks necessary. ${c.label} is the best available fit${c.affordability === "affordable_with_caution" ? ", with cautions" : ""}.`, reasons, alternativeId: best && best.outcome === "reduces_need" ? best.id : null, candidateId: c.id, remainingNeedMinor: best && best.outcome === "reduces_need" ? best.remainingShortfallMinor : need.peakShortfallMinor, target };
  } else if (partial[0]) {
    const c = partial[0];
    rec = {
      kind: "borrow_partial_only",
      headline: `No available offer fully closes the gap. ${c.label} helps most but leaves ${m(c.remainingShortfallMinor)} short of your cushion.`,
      reasons: [...c.reasons, ...(best && best.outcome === "reduces_need" ? [`"${best.actions.join("; ")}" also narrows the gap, to ${m(best.remainingShortfallMinor)}.`] : []), ...(target ? [`To close it you need ${m(target.amountMinor)} in hand by ${target.byDate}.`] : [])],
      alternativeId: best && best.outcome === "reduces_need" ? best.id : null, candidateId: c.id, remainingNeedMinor: c.remainingShortfallMinor, target,
    };
  } else {
    const why = candidates.length === 0 ? ["No funding offers are entered or available."] : candidates.slice(0, 4).map((c) => `${c.label}: ${c.reasons[0]}`);
    rec = {
      kind: "no_suitable_offer",
      headline: `There is a ${m(need.peakShortfallMinor)} gap and no suitable way to borrow for it among the offers available.`,
      reasons: [...why, ...(best && best.outcome === "reduces_need" ? [`"${best.actions.join("; ")}" would narrow the gap to ${m(best.remainingShortfallMinor)}.`] : []), ...(target ? [`A suitable offer would have to provide ${m(target.amountMinor)} by ${target.byDate} without pushing another week below the cushion.`] : [])],
      alternativeId: best && best.outcome === "reduces_need" ? best.id : null, candidateId: null, remainingNeedMinor: best && best.outcome === "reduces_need" ? best.remainingShortfallMinor : need.peakShortfallMinor, target,
    };
  }
  return { v: 1, asOf, currency, horizonWeeks, need, alternatives, candidates, unavailable: inp.unavailable ?? [], recommendation: rec, caveats };
}

