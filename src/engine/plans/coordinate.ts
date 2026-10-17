// COORDINATED RESCUE STRATEGY (pure, deterministic, no database, no clock, no model). Given a projected shortage it looks for the best FEASIBLE
// COMBINATION of the existing levers. Nothing is added up: every candidate combination is run through the same engine step as a single lever
// (simulateLevers, which rewrites the order events, applies the invoice-level changes and rebuilds the whole forecast), so timing, discounts,
// the finance fee and repayment out of the later customer receipt all interact the way the forecast says they do.
//
// Order of preference (documented in docs/decisions.md):
//   1. the cheapest combination that borrows nothing and keeps every week at or above the reserve,
//   2. else the combination that needs the SMALLEST invoice-finance advance to do so (finance sized on the grid, never "the cap"),
//   3. else the best available (highest lowest balance), clearly marked as not closing the gap.
// Who may do what is not decided here: the caller passes `allow`, which runs the signed-limit and permission-gate checks.
import type { Lever, LeverKind } from "@/domain/plan";
import { money, multiplyRatio } from "@/lib/money";
import type { CommitmentEvent } from "@/domain/commitment-event";
import { buildForecast } from "../forecast";
import { adjustmentsOf } from "../term-changes";
import type { EngineInput } from "../types";
import type { Parties } from "./parties";
import { originalDepositBps, searchPlans, type SearchedPlan, type SearchOptions } from "./search";
import { doNothing, leversToChanges, simulateLevers, type SimResult } from "./simulate";

export const FINANCE_STEP_BPS = 500;
/** The coordinator never builds a plan with more levers than this (finance included), so the owner can read and approve it. */
export const MAX_STRATEGY_LEVERS = 4;
/** How many non-borrowing combinations are tried as the base for sized finance (best lowest balance first, plus every single lever). */
const FINANCE_BASES = 24;
export const DOWNSIDE_DELAY_DAYS = 14;

export type Verdict = "no_shortage" | "closes_without_borrowing" | "closes_with_financing" | "partial" | "no_help";

export interface CoordinateOptions extends Pick<SearchOptions, "horizonWeeks" | "constraints" | "financeFeeBps" | "earlyDiscountCapBps"> {
  /** Lever kinds the signed limits and the learned refusals still allow (finance_invoice included when it is). */
  allowedKinds: LeverKind[];
  /** Signed cap on the finance advance (basis points); null = finance is not allowed. */
  financeCapBps: number | null;
  /** True when this lever set can run: no implied payment breaks a signed limit and the gate does not deny any lever. Memoised here. */
  allow: (levers: Lever[]) => boolean;
  /**
   * True when what this lever asks of its counterparty is supported by something the counterparty already told us in a structured reply
   * (a limit that the ask respects, or a fee the lender already quoted). Everything else is an untested assumption. Used only to break ties
   * between equally cheap options and to label the explanation; it never makes an option feasible or infeasible, and it is NOT a probability.
   */
  known?: (lever: Lever) => boolean;
  /** Compute the fallback if each counterparty refuses (default true; the fallbacks themselves do not nest). */
  withFallbacks?: boolean;
}

/** How far a lever could be softened (a gentler ask) while the strategy still keeps every week at or above the cushion. */
export interface ConcessionRoom {
  lever: Lever;
  /** The gentlest version of this ask that still closes the gap with the other actions unchanged; null for levers that have no such scale. */
  gentlest: Lever | null;
}

/** What the best strategy would be if this counterparty refused its part: the cost of that round of negotiation, known in advance. */
export interface RefusalFallback {
  lever: Lever;
  verdict: Verdict;
  levers: Lever[];
  minBalanceMinor: bigint | null;
  closesGap: boolean;
}

/** One way of acting, as the full forecast sees it. */
export interface StrategyOption {
  id: string;
  levers: Lever[];
  borrows: boolean;
  minBalanceMinor: bigint;
  minBalanceWeek: number;
  firstNegativeWeek: number | null;
  weeksBelowReserve: number;
  costMinor: bigint;
  counterparties: number;
  /** Every week at or above the reserve. */
  closesGap: boolean;
  /** The finance advance this option draws (0 when it does not borrow). */
  advanceMinor: bigint;
  advanceBps: number | null;
}

export interface LeverContribution {
  lever: Lever;
  /** Lowest balance if only this lever were used. */
  aloneMinBalanceMinor: bigint;
  /** Lowest balance if the strategy were run without this lever. */
  withoutItMinBalanceMinor: bigint;
  /** Without it the gap would not close (or would be deeper). */
  needed: boolean;
}

export interface Audit {
  /** Invoices or bills that appear more than once in the combined forecast (must be empty). */
  duplicateSources: string[];
  /** The customer order's cash (deposit, advance, later receipt, fee) adds up to the original receipt, recomputed independently of the engine. */
  orderCashConserved: boolean | null;
  /** Chase and early payment aimed at the same customer: allowed (they act on different invoices, overdue versus not yet due), but named. */
  sameCustomerBothLevers: boolean;
  ok: boolean;
}

export interface Coordination {
  verdict: Verdict;
  baseline: SimResult;
  reserveMinor: bigint;
  /** The strategy the agent would put forward; null when there is no shortage or nothing helps. */
  selected: (StrategyOption & { sim: SimResult }) | null;
  /** The simpler options it was compared with: best single lever, best way without borrowing, finance alone. */
  comparison: { role: "single_lever" | "no_borrowing" | "finance_alone" | "without_finance_part"; option: StrategyOption }[];
  contributions: LeverContribution[];
  /** Combined lowest-balance gain against the sum of each lever's own gain: they differ because the levers interact. */
  interaction: { sumOfOwnGainsMinor: bigint; combinedGainMinor: bigint } | null;
  audit: Audit;
  /** For each action with a scale (deposit, deferral, chase), how gentle the ask can get before the gap stays open. */
  room: ConcessionRoom[];
  /** For each action: the best strategy left if that counterparty refuses it. */
  fallbacks: RefusalFallback[];
  /** The selected strategy re-run with every estimated customer receipt 14 days late (the engine's downside variant). */
  downside: { minBalanceMinor: bigint; holdsReserve: boolean } | null;
  /** Present when the selected strategy borrows. `smallestAdvanceBps` is the smallest grid step that closes the gap with these other levers. */
  financing: { advanceBps: number; advanceMinor: bigint; feeBps: number; capBps: number; aloneAdvanceBps: number | null } | null;
  evaluated: number;
}

const advanceOf = (events: CommitmentEvent[]): bigint => events.filter((e) => e.kind === "financing" && e.amountMinor > 0n).reduce((a, e) => a + e.amountMinor, 0n);

function optionOf(sim: SimResult, reserve: bigint): StrategyOption {
  const fin = sim.levers.find((l) => l.kind === "finance_invoice");
  return {
    id: sim.id, levers: sim.levers, borrows: !!fin, minBalanceMinor: sim.minBalance, minBalanceWeek: sim.forecast.minimum.weekIndex + 1,
    firstNegativeWeek: sim.metrics.firstNegativeWeek, weeksBelowReserve: sim.metrics.weeksBelowReserve, costMinor: sim.cost, counterparties: sim.metrics.counterpartiesNeeded,
    closesGap: sim.minBalance >= reserve, advanceMinor: fin ? advanceOf(sim.events) : 0n, advanceBps: fin && fin.kind === "finance_invoice" ? fin.advanceBps : null,
  };
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function coordinate(input: EngineInput, baseEvents: CommitmentEvent[], parties: Parties, o: CoordinateOptions): Coordination {
  const reserve = input.reserve;
  const sim = (levers: Lever[]) => simulateLevers(input, baseEvents, levers, { horizonWeeks: o.horizonWeeks, financeFeeBps: o.financeFeeBps });
  const baseline = doNothing(input, baseEvents, { horizonWeeks: o.horizonWeeks });
  const empty: Coordination = { verdict: "no_shortage", baseline, reserveMinor: reserve, selected: null, comparison: [], contributions: [], interaction: null, audit: { duplicateSources: [], orderCashConserved: null, sameCustomerBothLevers: false, ok: true }, room: [], fallbacks: [], downside: null, financing: null, evaluated: 0 };
  if (baseline.minBalance >= reserve) return empty;

  const allowMemo = new Map<string, boolean>();
  const allow = (levers: Lever[]) => {
    const k = levers.map((l) => JSON.stringify(l)).join("|");
    if (!allowMemo.has(k)) allowMemo.set(k, o.allow(levers));
    return allowMemo.get(k)!;
  };

  // 1. Every non-borrowing combination, each with its own full forecast (the same search the planner uses).
  const nbKinds = o.allowedKinds.filter((k) => k !== "finance_invoice");
  const search = searchPlans(input, baseEvents, parties, {
    horizonWeeks: o.horizonWeeks, financeCapBps: null, allowedKinds: nbKinds, topN: 1_000_000, constraints: o.constraints, financeFeeBps: o.financeFeeBps, earlyDiscountCapBps: o.earlyDiscountCapBps,
  });
  const pool: SearchedPlan[] = search.ranked.filter((p) => p.levers.length <= MAX_STRATEGY_LEVERS);
  let evaluated = search.evaluated;
  // Equal cost: fewer asks that no counterparty has ever backed (untested) comes first. Cost still decides first: this never trades money for a guess.
  const untested = (levers: Lever[]) => (o.known ? levers.filter((l) => !o.known!(l)).length : 0);
  const byPref = (a: SearchedPlan, b: SearchedPlan) => cmp(a.cost, b.cost) || untested(a.levers) - untested(b.levers) || a.metrics.counterpartiesNeeded - b.metrics.counterpartiesNeeded || a.levers.length - b.levers.length || a.deviation - b.deviation || a.order - b.order || a.id.localeCompare(b.id);
  const firstAllowed = (xs: SearchedPlan[]) => xs.find((p) => allow(p.levers));

  // 2. Can any combination that borrows nothing keep every week at or above the reserve?
  const adequate = pool.filter((p) => p.minBalance >= reserve).sort(byPref);
  const bestNoBorrow = firstAllowed(adequate);

  // The simpler alternatives shown next to the choice.
  const singles = pool.filter((p) => p.levers.length === 1 && allow(p.levers)).sort((a, b) => cmp(b.minBalance, a.minBalance) || cmp(a.cost, b.cost) || a.order - b.order);
  const bestSingle = singles[0];
  const bestNbAny = pool.filter((p) => allow(p.levers)).sort((a, b) => cmp(b.minBalance, a.minBalance) || cmp(a.cost, b.cost) || a.levers.length - b.levers.length || a.order - b.order)[0];

  // 3. Finance, sized: for each base combination the smallest advance (on a grid) that closes the gap, else the cap.
  const hasReceipt = baseEvents.some((e) => e.kind === "customer_receipt");
  const financeOpen =
    o.allowedKinds.includes("finance_invoice") && !!o.financeCapBps && !!parties.lenderId && hasReceipt && !baseEvents.some((e) => e.kind === "financing") &&
    !(o.constraints ?? []).some((c) => c.kind === "finance_invoice" && c.counterpartyId === parties.lenderId && c.excluded);
  const grid: number[] = [];
  if (financeOpen) {
    for (let b = FINANCE_STEP_BPS; b < o.financeCapBps!; b += FINANCE_STEP_BPS) grid.push(b);
    grid.push(o.financeCapBps!);
  }
  const financed = (base: Lever[], advanceBps: number) => sim([...base, { kind: "finance_invoice", counterpartyId: parties.lenderId!, advanceBps }]);
  interface Sized { sim: SimResult; baseLevers: Lever[]; closes: boolean }
  const sized: Sized[] = [];
  const sizeFinance = () => {
    if (!financeOpen) return;
    const bases: SearchedPlan[] = [...pool.filter((p) => p.levers.length === 1), ...[...pool].sort((a, b) => cmp(b.minBalance, a.minBalance) || cmp(a.cost, b.cost) || a.order - b.order)].filter((p, i, a) => a.findIndex((q) => q.id === p.id) === i).filter((p) => p.levers.length <= MAX_STRATEGY_LEVERS - 1 && allow(p.levers)).slice(0, FINANCE_BASES);
    const baseLevers: Lever[][] = [[], ...bases.map((p) => p.levers)];
    for (const bl of baseLevers) {
      let best: SimResult | null = null;
      let closes = false;
      for (const g of grid) {
        const s = financed(bl, g);
        evaluated++;
        best = s;
        if (s.minBalance >= reserve) { closes = true; break; }
      }
      if (best && allow(best.levers)) sized.push({ sim: best, baseLevers: bl, closes });
    }
  };

  let verdict: Verdict;
  let chosen: SimResult | null = null;
  let financing: Coordination["financing"] = null;
  if (bestNoBorrow) {
    verdict = "closes_without_borrowing";
    chosen = bestNoBorrow;
  } else {
    sizeFinance();
    const closing = sized.filter((s) => s.closes).sort((a, b) => cmp(advanceOf(a.sim.events), advanceOf(b.sim.events)) || cmp(a.sim.cost, b.sim.cost) || untested(a.sim.levers) - untested(b.sim.levers) || a.sim.metrics.counterpartiesNeeded - b.sim.metrics.counterpartiesNeeded || a.sim.levers.length - b.sim.levers.length || a.sim.id.localeCompare(b.sim.id))[0];
    if (closing) {
      verdict = "closes_with_financing";
      chosen = closing.sim;
    } else {
      // Nothing closes the gap. Offer the best available: highest lowest balance, then lowest cost; it must at least improve on doing nothing.
      const cands: SimResult[] = [...sized.map((s) => s.sim), ...(bestNbAny ? [bestNbAny] : [])].sort((a, b) => cmp(b.minBalance, a.minBalance) || cmp(a.cost, b.cost) || a.levers.length - b.levers.length || a.id.localeCompare(b.id));
      const top = cands[0];
      if (top && top.minBalance > baseline.minBalance) { verdict = "partial"; chosen = top; } else verdict = "no_help";
    }
  }
  if (!chosen) return { ...empty, verdict, evaluated, comparison: bestSingle ? [{ role: "single_lever", option: optionOf(bestSingle, reserve) }] : [] };

  const selected = { ...optionOf(chosen, reserve), sim: chosen };
  const comparison: Coordination["comparison"] = [];
  if (bestSingle && bestSingle.id !== chosen.id) comparison.push({ role: "single_lever", option: optionOf(bestSingle, reserve) });
  if (selected.borrows) {
    if (bestNbAny && bestNbAny.id !== chosen.id) comparison.push({ role: "no_borrowing", option: optionOf(bestNbAny, reserve) });
    const alone = sized.find((s) => s.baseLevers.length === 0);
    if (alone && alone.sim.id !== chosen.id) comparison.push({ role: "finance_alone", option: optionOf(alone.sim, reserve) });
    const fin = chosen.levers.find((l) => l.kind === "finance_invoice");
    const rest = chosen.levers.filter((l) => l.kind !== "finance_invoice");
    if (rest.length > 0 && fin) comparison.push({ role: "without_finance_part", option: optionOf(sim(rest), reserve) });
    financing = { advanceBps: selected.advanceBps!, advanceMinor: selected.advanceMinor, feeBps: o.financeFeeBps ?? 0, capBps: o.financeCapBps!, aloneAdvanceBps: alone?.closes ? (alone.sim.levers[0] as Extract<Lever, { kind: "finance_invoice" }>).advanceBps : null };
  }

  // 4. Each lever's own effect and what the strategy would be without it (the combination is not the sum of its parts).
  const contributions: LeverContribution[] = chosen.levers.map((l) => {
    const without = chosen!.levers.filter((x) => x !== l);
    const wo = without.length === 0 ? baseline.minBalance : sim(without).minBalance;
    return { lever: l, aloneMinBalanceMinor: sim([l]).minBalance, withoutItMinBalanceMinor: wo, needed: verdict === "partial" ? wo < chosen!.minBalance : wo < reserve };
  });
  const interaction = chosen.levers.length > 1 ? { sumOfOwnGainsMinor: contributions.reduce((a, c) => a + (c.aloneMinBalanceMinor - baseline.minBalance), 0n), combinedGainMinor: chosen.minBalance - baseline.minBalance } : null;

  const down = buildForecast(input, { events: chosen.events, horizonWeeks: o.horizonWeeks, adjustments: adjustmentsOf(leversToChanges(chosen.levers, o.financeFeeBps)), downsideDelayDays: DOWNSIDE_DELAY_DAYS });
  const downside = { minBalanceMinor: down.minimum.amount, holdsReserve: down.minimum.amount >= reserve };
  const room = chosen.levers.map((l): ConcessionRoom => ({ lever: l, gentlest: gentlestThatCloses(l) }));
  function gentlestThatCloses(l: Lever): Lever | null {
    const others = chosen!.levers.filter((x) => x !== l);
    const orig = originalDepositBps(baseEvents);
    const steps: Lever[] = [];
    if (l.kind === "supplier_reduce_deposit" && orig !== null) for (let v = l.percentBps + 500; v < orig; v += 500) steps.push({ ...l, percentBps: v });
    else if (l.kind === "supplier_defer_balance") for (let d = l.daysAfterShipment - 7; d >= 1; d -= 7) steps.push({ ...l, daysAfterShipment: d });
    else if (l.kind === "buyer_request_deposit") for (let v = l.percentBps - 500; v >= 500; v -= 500) steps.push({ ...l, percentBps: v });
    else if (l.kind === "chase_overdue") for (let d = l.payWithinDays + 7; d <= 30; d += 7) steps.push({ ...l, payWithinDays: d });
    else return null;
    let best: Lever = l;
    for (const st of steps) {
      if (sim([...others, st]).minBalance >= (verdict === "partial" ? chosen!.minBalance : reserve)) best = st;
      else break;
    }
    return best;
  }
  // The cost of a refusal, worked out now: the best strategy that remains if each counterparty says no to its part.
  const fallbacks: RefusalFallback[] =
    o.withFallbacks === false
      ? []
      : chosen.levers.map((l): RefusalFallback => {
          const refused = { kind: l.kind, counterpartyId: l.counterpartyId, excluded: true, source: "reject", round: 99 } as NonNullable<CoordinateOptions["constraints"]>[number];
          const again = coordinate(input, baseEvents, parties, { ...o, constraints: [...(o.constraints ?? []), refused], withFallbacks: false });
          return { lever: l, verdict: again.verdict, levers: again.selected?.levers ?? [], minBalanceMinor: again.selected ? again.selected.minBalanceMinor : null, closesGap: !!again.selected && again.selected.closesGap };
        });
  return { verdict, baseline, reserveMinor: reserve, selected, comparison, contributions, interaction, audit: auditOf(baseEvents, chosen, o.financeFeeBps ?? 0), room, fallbacks, downside, financing, evaluated };
}

/** Independent checks on a combined result: nothing is counted twice and the customer order's cash adds up. */
export function auditOf(baseEvents: CommitmentEvent[], s: SimResult, feeBps: number): Audit {
  const seen = new Map<string, number>();
  for (const it of s.forecast.items) if (it.sourceType === "invoice" || it.sourceType === "bill") seen.set(`${it.sourceType}:${it.sourceId}`, (seen.get(`${it.sourceType}:${it.sourceId}`) ?? 0) + 1);
  const duplicateSources = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  let orderCashConserved: boolean | null = null;
  const baseReceipt = baseEvents.find((e) => e.kind === "customer_receipt");
  const fin = s.levers.find((l) => l.kind === "finance_invoice");
  const dep = s.levers.find((l) => l.kind === "buyer_request_deposit");
  if (baseReceipt && (fin || dep)) {
    const m = (v: bigint, bps: number) => multiplyRatio(money(v, baseReceipt.currency), { num: BigInt(bps), den: 10000n }, "half-up").amountMinor;
    const upfront = dep && dep.kind === "buyer_request_deposit" ? m(baseReceipt.amountMinor, dep.percentBps) : 0n;
    const remaining = baseReceipt.amountMinor - upfront;
    const fee = fin ? m(remaining, feeBps) : 0n;
    const customerCash = s.events.filter((e) => e.kind === "customer_receipt" || e.kind === "financing").reduce((a, e) => a + e.amountMinor, 0n);
    const baseCustomerCash = baseEvents.filter((e) => e.kind === "customer_receipt" || e.kind === "financing").reduce((a, e) => a + e.amountMinor, 0n);
    orderCashConserved = customerCash === baseCustomerCash - fee;
  }
  const chase = s.levers.find((l) => l.kind === "chase_overdue");
  const early = s.levers.find((l) => l.kind === "early_payment_discount");
  const sameCustomerBothLevers = !!chase && !!early && chase.counterpartyId === early.counterpartyId;
  return { duplicateSources, orderCashConserved, sameCustomerBothLevers, ok: duplicateSources.length === 0 && orderCashConserved !== false };
}
