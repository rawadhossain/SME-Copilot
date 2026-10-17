// ADAPTIVE NEGOTIATION: what a counterparty's reply actually changed, and which next step is best. PURE and deterministic: structured replies and
// engine results in, a decision with its reasons out. No model, no database, no free text from a counterparty (only numbers and flags that the
// executor recorded). It never decides what is ALLOWED: signed limits and learned refusals are applied by the caller's validators, and every
// candidate that fails them arrives here already marked rejected. Owner approval is never skipped.
import type { Constraint } from "@/domain/constraints";
import type { Lever } from "@/domain/plan";
import { formatMoney, money } from "@/lib/money";

export interface BranchLite { index: number; kind: string; counterpartyId: string; status: string; reason?: string; agreedTerms?: Record<string, number>; offer?: { advanceBps: number; feeBps: number } }
export interface EntryLite { index: number; lever: Lever; bound: { kind: string; [k: string]: unknown } }

export type ResponseOutcome = "refused" | "countered_accepted" | "countered_beyond_limit" | "countered_infeasible" | "offer_differs";
export interface ResponseChange {
  index: number;
  kind: Lever["kind"];
  counterpartyId: string;
  outcome: ResponseOutcome;
  /** What was asked, what they came back with (null for a refusal), and the signed limit, as plain sentences built from numbers. */
  asked: string;
  theirs: string | null;
  limit: string | null;
  summary: string;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;

/** The terms a lever asks for, in words. */
export function leverTerms(l: Lever): string {
  switch (l.kind) {
    case "supplier_reduce_deposit": return `a ${pct(l.percentBps)} deposit to the supplier`;
    case "supplier_defer_balance": return `paying the supplier balance ${l.daysAfterShipment} days after shipment`;
    case "buyer_request_deposit": return `a ${pct(l.percentBps)} deposit from the customer`;
    case "finance_invoice": return `a ${pct(l.advanceBps)} advance against an invoice`;
    case "chase_overdue": return `the customer paying overdue invoices within ${l.payWithinDays} days`;
    case "early_payment_discount": return `a ${pct(l.discountBps)} discount for paying ${l.daysEarly} days early`;
  }
}

/** The lever with the counterparty's own value in place of the one asked for (a counter or observed position), or null when it has none. */
export function withTheirTerms(l: Lever, c: Constraint | undefined, agreed?: Record<string, number>): Lever | null {
  if (agreed) {
    if (l.kind === "supplier_reduce_deposit" && agreed.percentBps !== undefined) return { ...l, percentBps: agreed.percentBps };
    if (l.kind === "supplier_defer_balance" && agreed.daysAfterShipment !== undefined) return { ...l, daysAfterShipment: agreed.daysAfterShipment };
    if (l.kind === "buyer_request_deposit" && agreed.percentBps !== undefined) return { ...l, percentBps: agreed.percentBps };
    if (l.kind === "chase_overdue" && agreed.payWithinDays !== undefined) return { ...l, payWithinDays: agreed.payWithinDays };
    if (l.kind === "early_payment_discount" && agreed.discountBps !== undefined) return { ...l, discountBps: agreed.discountBps };
  }
  if (!c || c.excluded) return null;
  if (l.kind === "supplier_reduce_deposit" && c.minPercentBps !== undefined) return { ...l, percentBps: c.minPercentBps };
  if (l.kind === "supplier_defer_balance" && c.maxDays !== undefined) return { ...l, daysAfterShipment: c.maxDays };
  if (l.kind === "buyer_request_deposit" && c.maxPercentBps !== undefined) return { ...l, percentBps: c.maxPercentBps };
  if (l.kind === "chase_overdue" && c.minDays !== undefined) return { ...l, payWithinDays: c.minDays };
  if (l.kind === "early_payment_discount" && c.minDiscountBps !== undefined) return { ...l, discountBps: c.minDiscountBps };
  return null;
}

const limitText = (e: EntryLite): string | null => {
  const b = e.bound as Record<string, number>;
  switch (e.lever.kind) {
    case "supplier_reduce_deposit": return `you allowed a deposit of up to ${pct(b.maxPercentBps)}`;
    case "supplier_defer_balance": return `you allowed no less than ${b.minDays} days`;
    case "buyer_request_deposit": return `you allowed no less than ${pct(b.minPercentBps)}`;
    case "chase_overdue": return `you allowed up to ${b.maxDays} days`;
    case "early_payment_discount": return `you allowed a discount of up to ${pct(b.maxDiscountBps)}`;
    case "finance_invoice": return `you allowed a fee of up to ${pct(b.maxFeeBps)}`;
  }
};

/** What each counterparty's reply changed, from the executor's structured record (never from reply text). */
export function interpretResponses(entries: EntryLite[], branches: BranchLite[], constraints: Constraint[]): ResponseChange[] {
  const out: ResponseChange[] = [];
  for (const b of branches) {
    const e = entries.find((x) => x.index === b.index);
    if (!e) continue;
    const c = constraints.find((x) => x.kind === e.lever.kind && x.counterpartyId === b.counterpartyId);
    const asked = leverTerms(e.lever);
    const base = { index: b.index, kind: e.lever.kind, counterpartyId: b.counterpartyId, asked };
    if (b.status === "needs_replan" && c) {
      if (c.excluded) { out.push({ ...base, outcome: "refused", theirs: null, limit: null, summary: `They refused ${asked}. It will not be asked again.` }); continue; }
      if (e.lever.kind === "finance_invoice") {
        out.push({ ...base, outcome: "offer_differs", theirs: c.assumedFeeBps !== undefined ? `a fee of ${pct(c.assumedFeeBps)}` : "different terms", limit: limitText(e), summary: `The lender's offer differed from ${asked}: ${c.assumedFeeBps !== undefined ? `a fee of ${pct(c.assumedFeeBps)}` : "different terms"} (${limitText(e)}).` });
        continue;
      }
      const theirs = withTheirTerms(e.lever, c);
      const theirText = theirs ? leverTerms(theirs) : null;
      const infeasible = b.reason?.startsWith("counter not financially feasible: ");
      if (infeasible) { out.push({ ...base, outcome: "countered_infeasible", theirs: theirText, limit: limitText(e), summary: `They countered with ${theirText ?? "different terms"}. That is inside your tolerance but not affordable: ${b.reason!.slice("counter not financially feasible: ".length)}. It was not accepted.` }); continue; }
      out.push({ ...base, outcome: "countered_beyond_limit", theirs: theirText, limit: limitText(e), summary: `They would not agree to ${asked}${theirText ? `; they want ${theirText}, which is outside what you allowed (${limitText(e)})` : ""}.` });
    } else if ((b.status === "agreed" || b.status === "offered" || b.status === "committed") && b.agreedTerms) {
      const got = withTheirTerms(e.lever, undefined, b.agreedTerms);
      if (got && leverTerms(got) !== asked) out.push({ ...base, outcome: "countered_accepted", theirs: leverTerms(got), limit: limitText(e), summary: `They countered with ${leverTerms(got)} instead of ${asked}. That is inside your limits, so it was accepted.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- candidates

export interface Candidate {
  id: string;
  label: string;
  kind: "revised_plan" | "counter_offer" | "original" | "do_nothing";
  levers: Lever[];
  /** Null when rejected before it could be computed. */
  metrics: { minBalanceMinor: string; minBalanceWeek: number; firstNegativeWeek: number | null; totalCostMinor: string; counterpartiesNeeded: number } | null;
  /** Reasons it cannot be proposed (signed limit, learned refusal, gate denial, cash). Empty means feasible. */
  rejectedBecause: string[];
  /** For a rejected counter-offer: what it would have done, so the owner can decide whether the limit is worth changing. Information only. */
  ifAccepted?: { minBalanceMinor: string; totalCostMinor: string } | null;
  assumptions?: string[];
}

export const feasible = (c: Candidate): boolean => c.rejectedBecause.length === 0 && c.metrics !== null;
const grp = (min: bigint, reserve: bigint) => (min >= reserve ? 0 : min >= 0n ? 1 : 2);

/** Same order as the planner's ranking (cushion kept, then cheaper, then fewer parties), so adaptation never contradicts the plan search. */
export function compareCandidates(a: Candidate, b: Candidate, reserve: bigint): number {
  const ma = BigInt(a.metrics!.minBalanceMinor), mb = BigInt(b.metrics!.minBalanceMinor);
  const ga = grp(ma, reserve), gb = grp(mb, reserve);
  if (ga !== gb) return ga - gb;
  if (ga === 2 && ma !== mb) return ma > mb ? -1 : 1;
  const ca = BigInt(a.metrics!.totalCostMinor), cb = BigInt(b.metrics!.totalCostMinor);
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.metrics!.counterpartiesNeeded !== b.metrics!.counterpartiesNeeded) return a.metrics!.counterpartiesNeeded - b.metrics!.counterpartiesNeeded;
  return a.id.localeCompare(b.id);
}

export interface NextStep { label: string; href: string | null }
export interface Adaptation {
  /** Report format; 2 = current. */
  v: 2;
  status: "recommended" | "best_available" | "no_feasible";
  round: number;
  maxRounds: number;
  responses: ResponseChange[];
  original: { minBalanceMinor: string; minBalanceWeek: number; totalCostMinor: string } | null;
  doNothing: { minBalanceMinor: string; minBalanceWeek: number; firstNegativeWeek: number | null };
  reserveMinor: string;
  candidates: Candidate[];
  selected: { id: string; label: string; cashImpact: string[]; cost: string; tradeoffs: string[]; risks: string[]; approval: string } | null;
  headline: string;
  /** Always present when nothing can be recommended (and useful otherwise): what the owner can do next, in order. */
  nextSteps: NextStep[];
}

/** Picks the best feasible candidate that is better than doing nothing, and writes the reasons from the numbers. */
export function decide(input: {
  currency: string; reserveMinor: string; round: number; maxRounds: number; responses: ResponseChange[]; candidates: Candidate[];
  original: Candidate | null; doNothing: Adaptation["doNothing"]; roundsLeft: boolean;
}): Adaptation {
  const cur = input.currency;
  const m = (v: string | bigint) => formatMoney(money(BigInt(v), cur), 2);
  const reserve = BigInt(input.reserveMinor);
  const dn = BigInt(input.doNothing.minBalanceMinor);
  const pool = input.candidates.filter(feasible).filter((c) => c.kind !== "do_nothing" && BigInt(c.metrics!.minBalanceMinor) > dn);
  pool.sort((a, b) => compareCandidates(a, b, reserve));
  const best = pool[0] ?? null;
  const orig = input.original?.metrics ?? null;
  const origNote = orig ? { minBalanceMinor: orig.minBalanceMinor, minBalanceWeek: orig.minBalanceWeek, totalCostMinor: orig.totalCostMinor } : null;

  const nextSteps: NextStep[] = [];
  const beyond = input.candidates.filter((c) => c.kind === "counter_offer" && c.rejectedBecause.length > 0 && c.ifAccepted);
  for (const c of beyond) nextSteps.push({ label: `Their counter-offer is outside your signed limits. If you widened the limit to allow it, your lowest balance would be ${m(c.ifAccepted!.minBalanceMinor)} at a cost of ${m(c.ifAccepted!.totalCostMinor)}. Limits are signed separately; I cannot change them.`, href: "/room/safety?tab=limits" });
  if (input.roundsLeft) nextSteps.push({ label: "Adjust the terms yourself (Adjust terms) and ask again within what they will accept.", href: null });
  nextSteps.push({ label: "Compare funding options for the gap.", href: "/room/funding" });
  nextSteps.push({ label: `Do nothing: your lowest balance would be ${m(input.doNothing.minBalanceMinor)} in week ${input.doNothing.minBalanceWeek}${input.doNothing.firstNegativeWeek ? `, going below zero in week ${input.doNothing.firstNegativeWeek}` : ""}.`, href: null });

  if (!best) {
    return {
      v: 2, status: "no_feasible", round: input.round, maxRounds: input.maxRounds, responses: input.responses, original: origNote, doNothing: input.doNothing, reserveMinor: input.reserveMinor,
      candidates: input.candidates, selected: null,
      headline: `No option inside your limits improves on doing nothing. ${input.responses.length ? "The replies above ruled out what was asked, " : ""}and nothing else the planner can try fits.`.replace(", and", " and"),
      nextSteps,
    };
  }
  const bm = best.metrics!;
  const keeps = BigInt(bm.minBalanceMinor) >= reserve;
  const cashImpact = [
    `Lowest balance ${m(bm.minBalanceMinor)} in week ${bm.minBalanceWeek}${orig ? ` (the original plan promised ${m(orig.minBalanceMinor)}; doing nothing gives ${m(input.doNothing.minBalanceMinor)})` : ` (doing nothing gives ${m(input.doNothing.minBalanceMinor)})`}.`,
    keeps ? `It keeps your safety cushion of ${m(reserve)}.` : `It does NOT restore your safety cushion of ${m(reserve)}: ${m(reserve - BigInt(bm.minBalanceMinor))} short at the lowest point.`,
    bm.firstNegativeWeek ? `Cash still goes below zero in week ${bm.firstNegativeWeek}.` : "Cash does not go below zero.",
  ];
  const tradeoffs: string[] = [];
  if (orig) {
    const d = BigInt(bm.totalCostMinor) - BigInt(orig.totalCostMinor);
    tradeoffs.push(d === 0n ? "Costs the same as the original plan." : d > 0n ? `Costs ${m(d)} more than the original plan.` : `Costs ${m(-d)} less than the original plan.`);
    const worse = BigInt(orig.minBalanceMinor) - BigInt(bm.minBalanceMinor);
    if (worse > 0n) tradeoffs.push(`Leaves ${m(worse)} less cash at the lowest point than the original plan promised.`);
  }
  const changed = best.levers.filter((l) => !input.original?.levers.some((o) => JSON.stringify(o) === JSON.stringify(l)));
  if (changed.length) tradeoffs.push(`Changes from the original: ${changed.map(leverTerms).join("; ")}.`);
  if (bm.counterpartiesNeeded > 0) tradeoffs.push(`${bm.counterpartiesNeeded} counterpart${bm.counterpartiesNeeded === 1 ? "y has" : "ies have"} to agree.`);
  const others = input.candidates.filter((c) => c.id !== best.id && c.kind !== "do_nothing");
  const rejected = others.filter((c) => !feasible(c));
  if (rejected.length) tradeoffs.push(`${rejected.length} other option${rejected.length === 1 ? " was" : "s were"} rejected (see the list).`);
  const risks = [
    "No one has agreed to these terms yet: each counterparty still has to say yes, and they may counter or refuse again.",
    ...(keeps ? [] : ["Even if everyone agrees, your cash cushion is not fully restored."]),
    ...(best.levers.some((l) => l.kind === "finance_invoice") ? ["It borrows against an invoice; the fee is only certain once the lender offers."] : []),
    ...(input.roundsLeft ? [] : ["This is the last automatic round: if it fails you decide what happens next."]),
    ...(best.assumptions ?? []).slice(0, 2),
  ];
  return {
    v: 2, status: keeps ? "recommended" : "best_available", round: input.round, maxRounds: input.maxRounds, responses: input.responses, original: origNote, doNothing: input.doNothing, reserveMinor: input.reserveMinor,
    candidates: input.candidates,
    selected: { id: best.id, label: best.label, cashImpact, cost: `Total cost ${m(bm.totalCostMinor)}.`, tradeoffs, risks, approval: "Nothing runs until you review and sign it. If a scheduled payment is above your threshold, a second approver is also required." },
    headline: `${keeps ? "Recommended next step" : "Best available next step"}: ${best.label}.`,
    nextSteps: keeps ? [] : nextSteps,
  };
}
