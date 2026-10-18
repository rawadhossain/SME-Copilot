// FINANCING DECISION. Answers three owner questions from the same deterministic foundation as everything else: is borrowing needed, does a
// non-borrowing rescue option solve it, and which available funding is affordable week by week. The forecast, the rescue-plan search (the
// non-borrowing levers), the saved funding offers and the sandbox lender's invoice-finance lever are all existing pieces; the judging is
// src/engine/financing/decision.ts (pure). No model is involved and nothing is applied for, accepted or sent: the only write is one log
// record of what was assessed. Taking an option forward goes through the existing rescue plans: review, sign, run, independent check.
import { LEVER_KINDS, type Lever } from "@/domain/plan";
import { describeLever, dryRun, isRunnable, leverBounds, type AgentToolContext } from "@/agent";
import { LENDER_CATALOGUE } from "@/domain/lender-catalogue";
import { addDays, assessNeed, matchProducts, type CatalogueInfo, type MatchResult, compareOffers, decideFunding, diffDays, fromOffer, searchPlans, simulateLevers, summarise, type AlternativeInput, type FundingDecision, type RawCandidate } from "@/engine";
import { formatMoney, money } from "@/lib/money";
import { fundingBasis } from "./funding";
import { listFundingOffers } from "./funding-store";
import { loadBusinessProfile } from "./funding-profile";
import { appendRecord } from "./log";
import { sha256Hex } from "./plan-terms";
import { toJsonValue } from "@/sandbox/proposals";
import { ACTION_EVENTS, type Db } from "./types";
import { PLANNING_HORIZON_WEEKS } from "./agent-run";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
const MAX_ALTERNATIVES = 6;
const NO_APPLY_NOTE = "The app can compare this offer and check its contract, but it cannot apply for or accept it. That is done with the lender directly.";

const kindSet = (l: Lever[]) => l.map((x) => x.kind).sort().join("+");

export interface FundingAssessment {
  decision: FundingDecision;
  basis: { includesAgreedTerms: boolean; savedOffers: number; signedFundingLimits: boolean; financeFeeBpsAssumed: number | null };
}

const catalogueInfo = (r: MatchResult): CatalogueInfo => ({
  productId: r.productId, verdict: r.verdict, reason: r.reason, coversNeed: r.coversNeed, notice: r.notice,
  criteria: r.criteria.map((c) => ({ label: c.label, op: c.op, unit: c.unit, required: c.required, actual: c.actual, status: c.status, note: c.note })),
});

/** `catalogue: false` leaves the synthetic lender catalogue out entirely (used by the check to prove nothing else changes). */
export async function assessFundingNoLog(db: Db, businessId: string, opts: { catalogue?: boolean } = {}): Promise<FundingAssessment> {
  const { ctx, events, agreed, limits, mandateValid } = await fundingBasis(db, businessId);
  const cur = ctx.currency;
  const m = (v: bigint) => formatMoney(money(v, cur), EXPONENTS[cur] ?? 2);
  const horizon = PLANNING_HORIZON_WEEKS;

  // Rescue levers see the same events the need is measured on: the confirmed commitments with the terms already agreed applied.
  const planCtx: AgentToolContext = agreed ? { ...ctx, pending: events.map((event, i) => ({ ref: `pc${i + 1}`, extractionId: "agreed-terms", event })) } : ctx;
  const bounds = leverBounds(planCtx);

  // 1. Options that do not borrow: the planner's own search, restricted to the levers that are not finance, kept only if they could run.
  const alternatives: AlternativeInput[] = [];
  const kinds = LEVER_KINDS.filter((k) => k !== "finance_invoice" && bounds[k].available);
  if (kinds.length > 0) {
    const r = searchPlans(planCtx.input, events, planCtx.parties, {
      horizonWeeks: horizon, financeCapBps: null, allowedKinds: kinds, topN: 40, constraints: ctx.constraints, financeFeeBps: ctx.financeFeeBps,
      earlyDiscountCapBps: bounds.early_payment_discount.available ? bounds.early_payment_discount.discountBps.max : null,
    });
    const seen = new Set<string>();
    const seenKinds = new Set<string>();
    for (const p of [...r.ranked, ...r.pareto]) {
      if (alternatives.length >= MAX_ALTERNATIVES) break;
      if (seen.has(p.id) || seenKinds.has(kindSet(p.levers))) continue;
      seen.add(p.id);
      if (!isRunnable(planCtx, p.levers) || dryRun(planCtx, p.levers).some((c) => c.decision === "deny")) continue;
      seenKinds.add(kindSet(p.levers));
      alternatives.push({ id: p.id, actions: p.levers.map((l) => describeLever(l, planCtx)), leverKinds: p.levers.map((l) => l.kind), summary: summarise(p.forecast), costMinor: p.cost, counterparties: p.metrics.counterpartiesNeeded });
    }
  }

  // 2. Funding the owner entered (saved offers), through the existing comparison and its signed-limit checks.
  const unavailable: { label: string; reason: string }[] = [];
  const saved = (await listFundingOffers(db, businessId)).offers;
  const offers = saved.filter((o) => o.currency === cur);
  for (const o of saved.filter((x) => x.currency !== cur)) unavailable.push({ label: o.id, reason: `It is in ${o.currency} and your books are in ${cur}.` });
  const comparison = compareOffers(ctx.input, events, offers, { horizonWeeks: horizon, maxAnnualisedCostBps: limits.costBps, maxAmountMinor: limits.amountMinor });
  const toCandidate = (o: (typeof offers)[number], r: (typeof comparison.offers)[number]): RawCandidate => {
    const restrictions: string[] = [];
    if (r.withinAmountCap === false) restrictions.push(`The amount advanced (${m(o.principalMinor)}) is above the funding limit you signed (${m(limits.amountMinor as bigint)}).`);
    if (r.withinCostCap === false) restrictions.push(`Its estimated yearly cost ${(r.cost.annualisedCostBps / 100).toFixed(1)}% is above the limit you signed (${((limits.costBps as number) / 100).toFixed(1)}%).`);
    if (diffDays(ctx.asOf, o.disbursementDate) < 0) restrictions.push("The advance is dated before today, so it cannot fix a gap that is still ahead.");
    return fromOffer(o, r, restrictions, { kind: "none", note: NO_APPLY_NOTE });
  };
  const candidates: RawCandidate[] = offers.map((o, i) => toCandidate(o, comparison.offers[i]));

  // 2b. Products of the synthetic lender catalogue the business is ELIGIBLE for and that the app cannot apply for, sized to the need and judged like any
  // other candidate. Only when there is a gap. Invoice finance is NOT added here: it already enters below through the sandbox lever, so adding the
  // catalogue product too would count the same receivables twice; its catalogue verdict is attached to that option instead.
  let invoiceFinanceCatalogue: CatalogueInfo | null = null;
  if (opts.catalogue !== false) {
    const gap = assessNeed(comparison.doNotBorrow, ctx.input.reserve, horizon);
    const match = matchProducts(await loadBusinessProfile(db, businessId, ctx, events), LENDER_CATALOGUE, gap.needed ? gap.peakShortfallMinor : null);
    const ifin = match.results.find((r) => r.kind === "invoice_finance");
    if (ifin) invoiceFinanceCatalogue = catalogueInfo(ifin);
    if (gap.needed) {
      const taken = new Set(offers.map((o) => o.id));
      const picks = match.results.filter((r) => r.verdict === "eligible" && !r.executable && r.kind !== "invoice_finance" && r.offer !== null && !taken.has(r.offer.id));
      const catOffers = picks.map((r) => r.offer!);
      if (catOffers.length > 0) {
        const catCmp = compareOffers(ctx.input, events, catOffers, { horizonWeeks: horizon, maxAnnualisedCostBps: limits.costBps, maxAmountMinor: limits.amountMinor });
        picks.forEach((p, i) => {
          const c = toCandidate(catOffers[i], catCmp.offers[i]);
          candidates.push({
            ...c, source: "catalogue", label: p.label, termsAssumed: true, indicative: true, catalogue: catalogueInfo(p),
            route: { kind: "none", note: "Indicative terms from a synthetic catalogue, not a quote. The app cannot apply for this; use 'Add to comparison' to compare it beside a real offer." },
          });
        });
      }
    }
  }

  // 3. The sandbox lender's invoice finance: a rescue-plan lever, so it can go through review, signing and execution. Fee is the planning assumption.
  let financeFeeBps: number | null = null;
  const lender = ctx.counterparties.find((c) => c.id === ctx.parties.lenderId);
  const receipt = events.find((e) => e.kind === "customer_receipt");
  if (events.some((e) => e.kind === "financing")) unavailable.push({ label: "Invoice finance", reason: "Invoice finance is already agreed for the order, so it is part of the forecast above." });
  else if (!bounds.finance_invoice.available) unavailable.push({ label: "Invoice finance", reason: !bounds.mandateValid ? `Your signed limits are not valid (${bounds.mandateProblem}).` : "Your signed limits do not allow it, or the lender already refused." });
  else if (!lender || !receipt) unavailable.push({ label: "Invoice finance", reason: "There is no confirmed customer payment to finance, or no lender to ask." });
  else {
    const lever: Lever = { kind: "finance_invoice", counterpartyId: lender.id, advanceBps: bounds.finance_invoice.advanceBps.max };
    const gate = dryRun(planCtx, [lever])[0];
    if (gate.decision === "deny") unavailable.push({ label: "Invoice finance", reason: `The permission gate would deny it: ${gate.reasons.join("; ")}` });
    else {
      financeFeeBps = ctx.financeFeeBps;
      const sim = simulateLevers(planCtx.input, events, [lever], { horizonWeeks: horizon, financeFeeBps });
      const advance = sim.events.filter((e) => e.kind === "financing" && e.amountMinor > 0n).reduce((a, e) => a + e.amountMinor, 0n);
      const advanceEvent = sim.events.find((e) => e.kind === "financing" && e.amountMinor > 0n);
      const fee = sim.cost;
      const days = advanceEvent ? diffDays(advanceEvent.date, receipt.date) : 0;
      candidates.push({
        id: "invoice-finance", source: "sandbox_invoice_finance", label: "Invoice finance", lender: lender.name, product: "invoice_finance",
        advanceMinor: advance, netReceivedMinor: advance, disbursementDate: advanceEvent?.date ?? addDays(receipt.date, -60),
        totalRepaymentMinor: advance + fee, totalCostMinor: fee,
        annualisedCostBps: advance > 0n && days > 0 ? Number((fee * 365n * 10000n * 2n + advance * BigInt(days)) / (advance * BigInt(days) * 2n)) : null,
        firstRepaymentDate: receipt.date, lastRepaymentDate: receipt.date, repaymentCount: 1,
        summary: summarise(sim.forecast), dscr: null, stacking: null, repaymentsAfterWindowMinor: 0n, termsAssumed: true, restrictions: [],
        ...(invoiceFinanceCatalogue ? { catalogue: invoiceFinanceCatalogue } : {}),
        route: { kind: "rescue_plan", note: `Shown as a rescue plan to review. ${gate.decision === "needs_approval" ? "The permission gate asks for your approval. " : ""}The fee is a planning assumption (${(financeFeeBps / 100).toFixed(1)}% of the invoice); the sandbox lender sets the real terms when it answers, and nothing is sent until you sign.` },
      });
    }
  }

  const decision = decideFunding({ asOf: ctx.asOf, currency: cur, horizonWeeks: horizon, reserveMinor: ctx.input.reserve, baseline: comparison.doNotBorrow, alternatives, candidates, unavailable });
  return { decision, basis: { includesAgreedTerms: agreed, savedOffers: saved.length, signedFundingLimits: mandateValid && (limits.costBps !== null || limits.amountMinor !== null), financeFeeBpsAssumed: financeFeeBps } };
}

/** The financing decision (no write): the same assessment, for read-only callers such as the Copilot. */
export { assessFundingNoLog as assessFundingReadOnly };

/** The financing decision, with one log record of what was assessed. */
export async function assessFunding(db: Db, businessId: string, opts: { catalogue?: boolean } = {}): Promise<FundingAssessment> {
  const result = await assessFundingNoLog(db, businessId, opts);
  const decision = result.decision;
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.FUNDING_DECISION_MADE, actor: "agent",
    detail: {
      recommendation: decision.recommendation.kind, candidateId: decision.recommendation.candidateId, alternativeId: decision.recommendation.alternativeId,
      peakShortfallMinor: decision.need.peakShortfallMinor.toString(), candidates: decision.candidates.map((c) => ({ id: c.id, affordability: c.affordability, rank: c.rank })),
      alternatives: decision.alternatives.map((a) => ({ id: a.id, outcome: a.outcome })), decisionHash: sha256Hex(toJsonValue(decision)),
    },
  });
  return result;
}

/** The funding need exactly as assessFunding measures it: the same books, confirmed commitments and agreed terms, the same horizon and reserve, "do not borrow" as the baseline. */
export async function currentFundingNeed(db: Db, businessId: string) {
  const { ctx, events } = await fundingBasis(db, businessId);
  const baseline = compareOffers(ctx.input, events, [], { horizonWeeks: PLANNING_HORIZON_WEEKS }).doNotBorrow;
  return { ctx, events, need: assessNeed(baseline, ctx.input.reserve, PLANNING_HORIZON_WEEKS) };
}
