// Deterministic plan search (ADR-014): enumerate lever combinations over small discrete grids, compute each with the
// engine, rank them, and return the top N plus the Pareto set (cost vs minimum balance). Pure and deterministic.
// There are NO acceptance probabilities: counterparty agreement is unknown until asked.
import type { CommitmentEvent } from "@/domain/commitment-event";
import type { Constraint } from "@/domain/constraints";
import type { Lever, LeverKind } from "@/domain/plan";
import { isForecast } from "../open";
import type { EngineInput } from "../types";
import type { Parties } from "./parties";
import { doNothing, simulateLevers, type SimResult } from "./simulate";

export interface SearchOptions {
  horizonWeeks: number;
  /** Mandate cap on the invoice-finance advance (null = finance not allowed). */
  financeCapBps: number | null;
  allowedKinds?: LeverKind[];
  topN: number;
  maxCounterparties?: number;
  /** Keep only plans whose minimum balance is at least the reserve, or at least zero. */
  requireAtLeast?: "reserve" | "zero" | null;
  maxCostMinor?: bigint | null;
  /** Constraints learned from counterparty replies (ADR-021): grids are narrowed to what the counterparty may accept. */
  constraints?: Constraint[];
  /** Finance fee to assume (basis points of the invoice); default is the planning assumption. */
  financeFeeBps?: number;
  /** Mandate cap on an early-payment discount (null = early payment not allowed). */
  earlyDiscountCapBps?: number | null;
}

export interface SearchedPlan extends SimResult {
  /** Distance from the original terms (see ADR-014); smaller means fewer and gentler changes. */
  deviation: number;
  /** Generation order in the search: the last tie-break, so equal plans rank the same in every business (ids are random). */
  order: number;
}

export interface SearchResult {
  baseline: SimResult;
  ranked: SearchedPlan[];
  pareto: SearchedPlan[];
  evaluated: number;
}

/** The search never builds a plan with more levers than this, which keeps the grid small and plans easy for an owner to read. */
export const MAX_SEARCH_LEVERS = 4;
export const DEPOSIT_GRID_BPS = [2500, 2000, 1500];
export const DEFERRAL_GRID_DAYS = [14, 30];
export const BUYER_DEPOSIT_GRID_BPS = [1000, 2000];
/** Chase: pay within these many days of now (ADR-024). Early payment: (days earlier, discount) pairs, filtered by the mandate cap. */
export const CHASE_GRID_DAYS = [7, 14];
export const EARLY_PAYMENT_GRID: { daysEarly: number; discountBps: number }[] = [{ daysEarly: 15, discountBps: 100 }, { daysEarly: 15, discountBps: 150 }, { daysEarly: 20, discountBps: 150 }];

/** Customers with open invoices past their due date (chase candidates), by id. */
export function overdueBuyers(input: EngineInput): string[] {
  return byName(input, input.invoices.filter((i) => isForecast(i) && i.dueOn < input.asOf));
}
/** Customers with open invoices not yet due (early-payment candidates), by id. */
export function earlyPaymentBuyers(input: EngineInput): string[] {
  return byName(input, input.invoices.filter((i) => isForecast(i) && i.dueOn >= input.asOf));
}
/** Distinct customer ids in NAME order (then id), so the search order does not depend on random ids. */
function byName(_input: EngineInput, rows: { counterpartyId: string; counterpartyName: string }[]): string[] {
  const m = new Map(rows.map((r) => [r.counterpartyId, r.counterpartyName]));
  return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).map(([id]) => id);
}

/** The supplier deposit as basis points of the quote total, from the order own events. */
export function originalDepositBps(baseEvents: CommitmentEvent[]): number | null {
  const dep = baseEvents.find((e) => e.kind === "supplier_deposit");
  const bal = baseEvents.find((e) => e.kind === "supplier_balance");
  if (!dep || !bal) return null;
  const total = -(dep.amountMinor + bal.amountMinor);
  return total > 0n ? Number(((-dep.amountMinor) * 10000n + total / 2n) / total) : null;
}

const group = (p: SimResult, reserve: bigint): number => (p.minBalance >= reserve ? 0 : p.minBalance >= 0n ? 1 : 2);

/**
 * Ranking (ADR-014): (1) group A, minimum balance at or above the reserve; then group B, at or above zero; then group C,
 * the rest by minimum balance descending; (2) lower total cost; (3) fewer counterparties; (4) smaller deviation from
 * the original terms; (5) plan id.
 */
export function comparePlans(a: SearchedPlan, b: SearchedPlan, reserve: bigint): number {
  const ga = group(a, reserve);
  const gb = group(b, reserve);
  if (ga !== gb) return ga - gb;
  if (ga === 2 && a.minBalance !== b.minBalance) return a.minBalance > b.minBalance ? -1 : 1;
  if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
  if (a.metrics.counterpartiesNeeded !== b.metrics.counterpartiesNeeded) return a.metrics.counterpartiesNeeded - b.metrics.counterpartiesNeeded;
  if (a.deviation !== b.deviation) return a.deviation - b.deviation;
  return a.order - b.order || a.id.localeCompare(b.id);
}

export function searchPlans(input: EngineInput, baseEvents: CommitmentEvent[], parties: Parties, opts: SearchOptions): SearchResult {
  const kinds = new Set<LeverKind>(opts.allowedKinds ?? ["supplier_reduce_deposit", "supplier_defer_balance", "buyer_request_deposit", "finance_invoice"]);
  const orig = originalDepositBps(baseEvents);
  const cs = opts.constraints ?? [];
  const forLever = (kind: LeverKind, cpId: string | null) => cs.filter((c) => c.kind === kind && c.counterpartyId === cpId);
  const refused = (kind: LeverKind, cpId: string | null) => forLever(kind, cpId).some((c) => c.excluded);
  const lowest = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined).reduce<number | undefined>((m, x) => (m === undefined ? x : Math.min(m, x)), undefined);
  const highest = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined).reduce<number | undefined>((m, x) => (m === undefined ? x : Math.max(m, x)), undefined);
  const withCap = (grid: number[], cap: number | undefined) => (cap === undefined ? grid : [...new Set([...grid.filter((g) => g <= cap), ...(cap >= 1 ? [cap] : [])])].sort((a, b) => b - a));
  // Supplier deposit: values at or above the supplier floor; the floor itself is tried (it is the lowest the supplier allows).
  const depMin = highest(forLever("supplier_reduce_deposit", parties.supplierId).map((c) => c.minPercentBps));
  const depGrid = orig === null ? [] : [...new Set([...DEPOSIT_GRID_BPS, ...(depMin !== undefined ? [depMin] : [])])].filter((d) => d < orig && (depMin === undefined || d >= depMin)).sort((a, b) => b - a);
  const deferMax = lowest(forLever("supplier_defer_balance", parties.supplierId).map((c) => c.maxDays));
  const buyMax = lowest(forLever("buyer_request_deposit", parties.buyerId).map((c) => c.maxPercentBps));
  const fee = opts.financeFeeBps;
  const hasReceipt = baseEvents.some((e) => e.kind === "customer_receipt");
  const hasBalance = baseEvents.some((e) => e.kind === "supplier_balance");
  const depositOptions: (number | null)[] = [null, ...(kinds.has("supplier_reduce_deposit") && parties.supplierId && !refused("supplier_reduce_deposit", parties.supplierId) ? depGrid : [])];
  const deferOptions: (number | null)[] = [null, ...(kinds.has("supplier_defer_balance") && hasBalance && parties.supplierId && !refused("supplier_defer_balance", parties.supplierId) ? withCap(DEFERRAL_GRID_DAYS, deferMax) : [])];
  const buyerOptions: (number | null)[] = [null, ...(kinds.has("buyer_request_deposit") && hasReceipt && parties.buyerId && !refused("buyer_request_deposit", parties.buyerId) ? withCap(BUYER_DEPOSIT_GRID_BPS, buyMax) : [])];
  const financeOptions: (number | null)[] = [null, ...(kinds.has("finance_invoice") && hasReceipt && parties.lenderId && opts.financeCapBps && !refused("finance_invoice", parties.lenderId) ? [opts.financeCapBps] : [])];

  // Chase and early payment (ADR-024): one buyer each, from the invoices in the books; grids are bounded and deterministic.
  const chaseMin = (cp: string) => highest(forLever("chase_overdue", cp).map((c) => c.minDays));
  const chaseOptions: ({ cp: string; days: number } | null)[] = [null];
  if (kinds.has("chase_overdue")) {
    for (const cp of overdueBuyers(input)) {
      if (refused("chase_overdue", cp)) continue;
      const floor = chaseMin(cp);
      const grid = [...new Set([...CHASE_GRID_DAYS, ...(floor !== undefined && floor <= 30 ? [floor] : [])])].filter((d) => floor === undefined || d >= floor).sort((a, b) => a - b);
      for (const days of grid) chaseOptions.push({ cp, days });
    }
  }
  const earlyOptions: ({ cp: string; daysEarly: number; discountBps: number } | null)[] = [null];
  if (kinds.has("early_payment_discount") && opts.earlyDiscountCapBps) {
    for (const cp of earlyPaymentBuyers(input)) {
      if (refused("early_payment_discount", cp)) continue;
      const floor = highest(forLever("early_payment_discount", cp).map((c) => c.minDiscountBps));
      const pairs = EARLY_PAYMENT_GRID.map((p) => ({ ...p, discountBps: Math.max(p.discountBps, floor ?? 0) })).filter((p) => p.discountBps <= opts.earlyDiscountCapBps!);
      for (const p of new Map(pairs.map((x) => [`${x.daysEarly}:${x.discountBps}`, x])).values()) earlyOptions.push({ cp, ...p });
    }
  }

  const baseline = doNothing(input, baseEvents, { horizonWeeks: opts.horizonWeeks });
  const all: SearchedPlan[] = [];
  for (const dep of depositOptions) for (const def of deferOptions) for (const buy of buyerOptions) for (const fin of financeOptions) for (const chs of chaseOptions) for (const ear of earlyOptions) {
    const levers: Lever[] = [];
    if (dep !== null) levers.push({ kind: "supplier_reduce_deposit", counterpartyId: parties.supplierId!, percentBps: dep });
    if (def !== null) levers.push({ kind: "supplier_defer_balance", counterpartyId: parties.supplierId!, daysAfterShipment: def });
    if (buy !== null) levers.push({ kind: "buyer_request_deposit", counterpartyId: parties.buyerId!, percentBps: buy });
    if (fin !== null) levers.push({ kind: "finance_invoice", counterpartyId: parties.lenderId!, advanceBps: fin });
    if (chs !== null) levers.push({ kind: "chase_overdue", counterpartyId: chs.cp, payWithinDays: chs.days });
    if (ear !== null) levers.push({ kind: "early_payment_discount", counterpartyId: ear.cp, daysEarly: ear.daysEarly, discountBps: ear.discountBps });
    if (levers.length === 0) continue;
    if (levers.length > MAX_SEARCH_LEVERS) continue;
    const sim = simulateLevers(input, baseEvents, levers, { horizonWeeks: opts.horizonWeeks, financeFeeBps: fee });
    const deviation = (dep !== null && orig !== null ? orig - dep : 0) + (def !== null ? def * 100 : 0) + (buy ?? 0) + (fin ?? 0) + (chs !== null ? (30 - chs.days) * 10 : 0) + (ear !== null ? ear.discountBps + ear.daysEarly * 10 : 0);
    all.push({ ...sim, deviation, order: all.length });
  }

  const reserve = input.reserve;
  const keep = (p: SearchedPlan) =>
    (opts.maxCounterparties === undefined || p.metrics.counterpartiesNeeded <= opts.maxCounterparties) &&
    (!opts.requireAtLeast || p.minBalance >= (opts.requireAtLeast === "reserve" ? reserve : 0n)) &&
    (opts.maxCostMinor == null || p.cost <= opts.maxCostMinor);
  const candidates = all.filter(keep);
  const ranked = [...candidates].sort((a, b) => comparePlans(a, b, reserve));

  // Pareto set: no other plan has lower-or-equal cost and higher-or-equal minimum balance with one strictly better.
  // Of several plans with the same (cost, minimum), the least deviating one is kept.
  const nonDominated = candidates.filter((p) => !candidates.some((q) => q !== p && q.cost <= p.cost && q.minBalance >= p.minBalance && (q.cost < p.cost || q.minBalance > p.minBalance)));
  const seen = new Set<string>();
  const pareto = [...nonDominated]
    .sort((a, b) => a.deviation - b.deviation || a.order - b.order || a.id.localeCompare(b.id))
    .filter((p) => {
      const k = `${p.cost}:${p.minBalance}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.cost !== b.cost ? (a.cost < b.cost ? -1 : 1) : a.minBalance > b.minBalance ? -1 : a.minBalance < b.minBalance ? 1 : 0));

  // Visibility of the books-level levers (Batch 10): if the top N contain no plan that uses chase or early payment, the best plan that does
// and is in the same feasibility group as the best plan takes the last slot, so the owner always sees one such option when one is as safe.
  const usesBooksLever = (p: SearchedPlan) => p.levers.some((l) => l.kind === "chase_overdue" || l.kind === "early_payment_discount");
  // Variety (Batch 11): the top N should be different KINDS of plan, not five variations of one. Among plans in the same feasibility group
  // as the best, take the best of each distinct lever-kind set first; then fill the rest in rank order.
  const kindKey = (p: SearchedPlan) => p.levers.map((l) => l.kind).sort().join("+");
  let top: SearchedPlan[] = [];
  if (ranked.length > 0) {
    const g0 = group(ranked[0], reserve);
    const seenKinds = new Set<string>();
    for (const p of ranked) if (group(p, reserve) === g0 && !seenKinds.has(kindKey(p)) && top.length < opts.topN) { seenKinds.add(kindKey(p)); top.push(p); }
    for (const p of ranked) if (top.length < opts.topN && !top.includes(p)) top.push(p);
  }
  if (top.length > 1 && !top.some(usesBooksLever)) {
    const cand = ranked.find((p) => usesBooksLever(p) && group(p, reserve) === group(top[0], reserve));
    if (cand) top = [...top.slice(0, -1), cand];
  }
  return { baseline, ranked: top, pareto, evaluated: all.length };
}
