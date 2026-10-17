// FLIGHT SIMULATOR: strategy comparison inside a HYPOTHETICAL world. The caller (src/actions/flight-simulator.ts) builds an AgentToolContext whose
// engine input, order events and refusals are the simulated copies; this file only reads that context. Every candidate is a whole-forecast
// recomputation by the existing engine (simulateLevers) and passes the same signed-limit checks and gate dry-run as a real plan. Pure and read-only:
// nothing is proposed, signed, sent or stored, and no sentence carries a number that code did not compute. Acceptance is never predicted.
import { LEVER_KINDS, planId, sortLevers, type Lever, type StrategyView } from "@/domain/plan";
import { adjustmentsOf, buildForecast, comparePlans, DOWNSIDE_DELAY_DAYS, leversToChanges, searchPlans, simulateLevers, type Coordination, type SimResult } from "@/engine";
import type { AgentToolContext } from "./context";
import { baseEventsOf, describeLever, dryRun, formatMinor, impliedPaymentBlockers, isRunnable, leverBounds, leverProblems } from "./plan-builder";
import { coordinateForContext, strategyPlan } from "./strategy";

export type Outcome = "resolves" | "reduces" | "no_help" | "blocked" | "unacceptable";
export type CandidateRole = "nothing" | "todays_plan" | "coordinated" | "no_borrowing" | "finance_alone" | "single";

export interface FlightCandidate {
  id: string;
  role: CandidateRole;
  title: string;
  levers: Lever[];
  leverText: string[];
  outcome: Outcome;
  /** Why it has this outcome, in words built from the figures below. */
  reasons: string[];
  /** Things that could still go wrong with this candidate (not probabilities). */
  risks: string[];
  minBalanceMinor: bigint;
  minBalanceWeek: number;
  firstNegativeWeek: number | null;
  weeksBelowReserve: number;
  /** Cushion minus the lowest balance when positive, else 0. */
  stillShortMinor: bigint;
  costMinor: bigint;
  borrows: boolean;
  advanceMinor: bigint;
  /** Advance plus fee, taken from the customer's later payment (0 when it does not borrow). */
  repaymentMinor: bigint;
  counterparties: number;
  /** Lowest balance if estimated customer payments slip a further 14 days. */
  stressMinBalanceMinor: bigint;
  holdsUnderStress: boolean;
  /** Empty when permitted: why the signed limits, the permission gate or a (simulated) refusal stop it. */
  blockers: string[];
  weeklyClosing: bigint[];
}

export interface FlightEvaluation {
  /** The lowest-balance picture with nothing done, in the simulated world. */
  nothing: FlightCandidate;
  candidates: FlightCandidate[];
  recommendedId: string | null;
  /** Another candidate that also resolves the shortage and holds up better under a further slip, when the recommended one does not hold. */
  resilientAlternativeId: string | null;
  /** Why the recommended one is preferred, and what it relies on. Every line is a template over the figures. */
  whyPreferred: string[];
  strategy: StrategyView | null;
  verdict: Coordination["verdict"] | "no_levers";
  /** Combinations the coordinator tried. */
  evaluated: number;
}

const OUTCOME_RANK: Record<Outcome, number> = { resolves: 0, reduces: 1, no_help: 2, unacceptable: 3, blocked: 4 };

export interface FlightOptions {
  /** The levers of today's best strategy, from the LIVE world; re-tested here to show how the scenario breaks the previous answer. */
  todaysLevers?: Lever[] | null;
  /** Customers who are late in the scenario: asking them for something new is flagged. */
  lateCustomerIds?: string[];
}

export function evaluateFlight(ctx: AgentToolContext, opts: FlightOptions = {}): FlightEvaluation {
  const reserve = ctx.input.reserve;
  const cur = ctx.currency;
  const m = (v: bigint) => formatMinor(v.toString(), cur);
  const base = baseEventsOf(ctx);
  const sim = (levers: Lever[]): SimResult => simulateLevers(ctx.input, base, levers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps });
  const nothingSim = sim([]);
  const gap = reserve - nothingSim.minBalance > 0n ? reserve - nothingSim.minBalance : 0n;
  const late = new Set(opts.lateCustomerIds ?? []);

  const blockersOf = (levers: Lever[], s: SimResult): string[] => {
    const out = [...leverProblems(ctx, levers)];
    if (out.length === 0) {
      out.push(...impliedPaymentBlockers(ctx, s.events));
      for (const c of dryRun(ctx, levers)) if (c.decision === "deny") out.push(...c.reasons);
    }
    return [...new Set(out)];
  };
  const permitted = (levers: Lever[]) => leverProblems(ctx, levers).length === 0 && isRunnable(ctx, levers) && dryRun(ctx, levers).every((c) => c.decision !== "deny");

  const sumCash = (events: { kind: string; amountMinor: bigint }[]) => events.filter((e) => e.kind === "customer_receipt" || e.kind === "financing").reduce((n, e) => n + e.amountMinor, 0n);
  const stressOf = (s: SimResult) => buildForecast(ctx.input, { events: s.events, horizonWeeks: ctx.horizonWeeks, adjustments: adjustmentsOf(leversToChanges(s.levers, ctx.financeFeeBps)), downsideDelayDays: DOWNSIDE_DELAY_DAYS }).minimum.amount;

  const make = (role: CandidateRole, title: string, s: SimResult): FlightCandidate => {
    const levers = s.levers;
    const advance = s.events.filter((e) => e.kind === "financing" && e.amountMinor > 0n).reduce((n, e) => n + e.amountMinor, 0n);
    const borrows = levers.some((l) => l.kind === "finance_invoice");
    const fee = borrows ? sumCash(base) - sumCash(s.events) : 0n;
    const blockers = levers.length === 0 ? [] : blockersOf(levers, s);
    const stress = stressOf(s);
    const f = s.forecast;
    const short = reserve - s.minBalance > 0n ? reserve - s.minBalance : 0n;
    const unacceptable: string[] = [];
    if (levers.length > 0 && s.minBalance < nothingSim.minBalance) unacceptable.push(`It makes the lowest balance worse (${m(s.minBalance)} against ${m(nothingSim.minBalance)} with no action).`);
    if (levers.length > 0 && gap > 0n && s.cost > gap) unacceptable.push(`It costs ${m(s.cost)}, more than the ${m(gap)} shortfall it is meant to cover.`);
    const outcome: Outcome = levers.length === 0 ? (s.minBalance >= reserve ? "resolves" : "no_help") : blockers.length > 0 ? "blocked" : unacceptable.length > 0 ? "unacceptable" : s.minBalance >= reserve ? "resolves" : s.minBalance > nothingSim.minBalance ? "reduces" : "no_help";
    const lowest = `lowest balance ${m(s.minBalance)} in week ${f.minimum.weekIndex + 1}`;
    const reasons =
      outcome === "blocked" ? [`Not available in this scenario: ${blockers.slice(0, 3).join("; ")}.`, `Shown only for comparison; if it were still possible it would reach a ${lowest}.`]
      : outcome === "unacceptable" ? unacceptable
      : outcome === "resolves" ? [levers.length === 0 ? `Every week stays at or above your cushion (${lowest}).` : `Keeps every week at or above your cushion: ${lowest}.`]
      : outcome === "reduces" ? [`Narrows the shortfall from ${m(gap)} to ${m(short)}, but ${m(short)} is still missing against your cushion (${lowest}).`]
      : [levers.length === 0 ? `Without action: ${lowest}${f.weeksBelowZero.length ? `, below zero in week ${f.weeksBelowZero[0] + 1}` : ""}.` : `Does not lift the lowest balance (${lowest}).`];
    const risks: string[] = [];
    if (levers.length > 0) {
      risks.push(`${s.metrics.counterpartiesNeeded} ${s.metrics.counterpartiesNeeded === 1 ? "party" : "parties"} must agree; whether they do is unknown until they answer.`);
      if (borrows) risks.push(`Borrows ${m(advance)} and repays ${m(advance + fee)} out of the customer's payment, so a later customer payment also delays the repayment.`);
      for (const l of levers) if (late.has(l.counterpartyId)) risks.push(`It asks ${ctx.counterparties.find((c) => c.id === l.counterpartyId)?.name ?? "a customer"}, who is paying late in this scenario.`);
      if (outcome === "resolves" && s.minBalance - reserve < reserve / 10n) risks.push(`The margin over your cushion is small (${m(s.minBalance - reserve)}).`);
    }
    if (stress < reserve) risks.push(`If estimated customer payments slip a further ${DOWNSIDE_DELAY_DAYS} days the lowest balance would be ${m(stress)}${stress < 0n ? ", below zero" : ", under your cushion"}.`);
    return {
      id: levers.length === 0 ? "nothing" : s.id, role, title, levers, leverText: levers.map((l) => describeLever(l, ctx)), outcome, reasons, risks,
      minBalanceMinor: s.minBalance, minBalanceWeek: f.minimum.weekIndex + 1, firstNegativeWeek: s.metrics.firstNegativeWeek, weeksBelowReserve: s.metrics.weeksBelowReserve,
      stillShortMinor: short, costMinor: s.cost, borrows, advanceMinor: advance, repaymentMinor: borrows ? advance + fee : 0n, counterparties: s.metrics.counterpartiesNeeded,
      stressMinBalanceMinor: stress, holdsUnderStress: stress >= reserve, blockers, weeklyClosing: f.weeks.map((w) => w.closing),
    };
  };

  const nothing = make("nothing", "Do nothing", nothingSim);
  // No shortage in this scenario: the right answer is to ask nobody for anything. Rescue actions are not even enumerated.
  if (nothingSim.minBalance >= reserve) {
    const why = [`Every week stays at or above your cushion without any action (lowest balance ${m(nothingSim.minBalance)} in week ${nothing.minBalanceWeek}), so no one needs to be asked for anything.`];
    if (!nothing.holdsUnderStress) why.push(`The margin is thin: if estimated customer payments slip a further ${DOWNSIDE_DELAY_DAYS} days the lowest balance would be ${m(nothing.stressMinBalanceMinor)}.`);
    return { nothing, candidates: [], recommendedId: null, resilientAlternativeId: null, whyPreferred: why, strategy: null, verdict: "no_shortage", evaluated: 0 };
  }
  const byId = new Map<string, FlightCandidate>();
  const add = (role: CandidateRole, title: string, levers: Lever[]) => {
    if (levers.length === 0) return;
    const id = planId(sortLevers(levers));
    if (byId.has(id)) return;
    try { byId.set(id, make(role, title, sim(levers))); } catch { /* a lever that cannot be built in this world is simply not a candidate */ }
  };

  // 1. The coordinated strategy (existing coordinator) and the simpler options it compares itself with.
  const coordination = nothingSim.minBalance < reserve ? coordinateForContext(ctx) : null;
  if (coordination?.selected) add("coordinated", "Coordinated strategy", coordination.selected.levers);

  // 2. What worked before the event, re-tested here: shows how the scenario breaks the previous answer. When nothing changed it IS the coordinated strategy.
  if (opts.todaysLevers && opts.todaysLevers.length > 0) {
    const same = byId.get(planId(sortLevers(opts.todaysLevers)));
    if (same) same.title = "Coordinated strategy (also today's plan, unchanged by this scenario)";
    else add("todays_plan", "Today's recommended plan, re-tested", opts.todaysLevers);
  }
  for (const c of coordination?.comparison ?? []) {
    if (c.role === "no_borrowing") add("no_borrowing", "Best way without borrowing", c.option.levers);
    else if (c.role === "finance_alone") add("finance_alone", "Invoice finance alone", c.option.levers);
  }

  // 3. The best permitted single action of each kind (existing search, one kind at a time).
  const b = leverBounds(ctx);
  for (const kind of LEVER_KINDS) {
    if (!b[kind].available) continue;
    const r = searchPlans(ctx.input, base, ctx.parties, {
      horizonWeeks: ctx.horizonWeeks, financeCapBps: b.finance_invoice.available ? b.finance_invoice.advanceBps.max : null, allowedKinds: [kind], topN: 400,
      constraints: ctx.constraints, financeFeeBps: ctx.financeFeeBps, earlyDiscountCapBps: b.early_payment_discount.available ? b.early_payment_discount.discountBps.max : null,
    });
    const singles = r.ranked.filter((p) => p.levers.length === 1).sort((x, y) => comparePlans(x, y, reserve));
    const best = singles.find((p) => permitted(p.levers));
    if (best) add("single", `Single action: ${describeLever(best.levers[0], ctx)}`, best.levers);
  }

  const order: Record<CandidateRole, number> = { nothing: 0, todays_plan: 1, coordinated: 2, no_borrowing: 3, finance_alone: 4, single: 5 };
  const candidates = [...byId.values()].sort((a, c) => order[a.role] - order[c.role] || OUTCOME_RANK[a.outcome] - OUTCOME_RANK[c.outcome] || (a.minBalanceMinor > c.minBalanceMinor ? -1 : a.minBalanceMinor < c.minBalanceMinor ? 1 : 0));

  // Recommendation: the coordinator's own choice when it is permitted; otherwise the best permitted candidate that does something.
  const coordinated = candidates.find((c) => c.role === "coordinated" && c.outcome !== "blocked");
  const usable = candidates.filter((c) => c.outcome === "resolves" || c.outcome === "reduces");
  const pick = coordinated && (coordinated.outcome === "resolves" || coordinated.outcome === "reduces") ? coordinated
    : [...usable].sort((x, y) => OUTCOME_RANK[x.outcome] - OUTCOME_RANK[y.outcome] || (x.borrows === y.borrows ? 0 : x.borrows ? 1 : -1) || (x.costMinor === y.costMinor ? 0 : x.costMinor < y.costMinor ? -1 : 1) || (x.minBalanceMinor > y.minBalanceMinor ? -1 : x.minBalanceMinor < y.minBalanceMinor ? 1 : 0))[0] ?? null;
  const recommendedId = pick?.id ?? null;
  const resilient = pick && !pick.holdsUnderStress ? candidates.filter((c) => c.id !== pick.id && c.outcome === "resolves" && c.holdsUnderStress).sort((x, y) => (x.costMinor < y.costMinor ? -1 : x.costMinor > y.costMinor ? 1 : 0))[0] ?? null : null;

  const why: string[] = [];
  const todays = candidates.find((c) => c.role === "todays_plan");
  if (todays && todays.outcome === "blocked") why.push(`The plan that worked before this event can no longer be used: ${todays.blockers.slice(0, 2).join("; ")}.`);
  else if (todays && todays.outcome !== "resolves") why.push(`The plan that worked before this event no longer closes the gap: it would now reach a lowest balance of ${m(todays.minBalanceMinor)}, ${m(todays.stillShortMinor)} under your cushion.`);
  if (pick) {
    const resolvers = candidates.filter((c) => c.outcome === "resolves" && c.role !== "nothing");
    if (pick.outcome === "resolves") {
      why.push(`${resolvers.length} of ${candidates.filter((c) => c.role !== "nothing").length} candidates keep every week at or above your cushion in this scenario.`);
      for (const o of resolvers.filter((c) => c.id !== pick.id)) {
        const diffs: string[] = [];
        if (o.costMinor > pick.costMinor) diffs.push(`costs ${m(o.costMinor - pick.costMinor)} more`);
        if (o.borrows && !pick.borrows) diffs.push("borrows");
        if (o.counterparties > pick.counterparties) diffs.push(`needs ${o.counterparties - pick.counterparties} more ${o.counterparties - pick.counterparties === 1 ? "party" : "parties"} to agree`);
        if (diffs.length > 0) why.push(`${o.title} also resolves it but ${diffs.join(", ")}.`);
      }
      why.push(pick.borrows ? "It borrows because nothing that avoids borrowing is enough in this scenario." : "It does not need borrowing.");
    } else {
      why.push(`Nothing available fully closes the gap in this scenario. This is the best of what can be done: it leaves ${m(pick.stillShortMinor)} under your cushion.`);
    }
    if (!pick.holdsUnderStress) why.push(`It does not hold if estimated customer payments slip a further ${DOWNSIDE_DELAY_DAYS} days (lowest balance ${m(pick.stressMinBalanceMinor)}).${resilient ? ` ${resilient.title} does hold, at a cost of ${m(resilient.costMinor)}.` : " No candidate does."}`);
  } else {
    why.push("Nothing available improves on doing nothing in this scenario. The signed limits, or the assumed refusals, leave no permitted action that helps.");
  }

  const strategy = coordination && coordination.selected && pick?.role === "coordinated" ? (strategyPlan(ctx, coordination)?.strategy ?? null) : null;
  return {
    nothing, candidates: candidates.filter((c) => c.role !== "nothing"), recommendedId, resilientAlternativeId: resilient?.id ?? null, whyPreferred: why, strategy,
    verdict: coordination ? coordination.verdict : nothingSim.minBalance >= reserve ? "no_shortage" : "no_levers", evaluated: coordination?.evaluated ?? 0,
  };
}
