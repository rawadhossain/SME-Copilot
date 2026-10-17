// COORDINATED STRATEGY for the planner. The pure search lives in src/engine/plans/coordinate.ts; this file gives it the planning context (signed
// limits, learned refusals, the gate dry-run), turns the result into a plan the owner can review, and writes the explanation. Every sentence is
// a template filled with engine figures: no model text, no arithmetic here beyond formatting. Read-only: it proposes, the owner signs.
import { LEVER_KINDS, sortLevers, type Lever, type PlanView, type StrategyView } from "@/domain/plan";
import type { Constraint } from "@/domain/constraints";
import { coordinate, DOWNSIDE_DELAY_DAYS, type Coordination, type StrategyOption } from "@/engine/plans";
import { leverTerms } from "@/engine/plans/adapt";
import type { AgentToolContext } from "./context";
import { baseEventsOf, buildPlanView, describeLever, dryRun, formatMinor, isRunnable, leverBounds, leverProblems } from "./plan-builder";

const constraintFor = (ctx: AgentToolContext, l: Lever): Constraint | undefined => ctx.constraints.find((c) => c.kind === l.kind && c.counterpartyId === l.counterpartyId);

/** True when a counterparty's own structured reply bounds this ask and the ask respects it (so it is not a blind guess). Not a prediction of acceptance. */
function backedByTheirWords(ctx: AgentToolContext, l: Lever): boolean {
  const c = constraintFor(ctx, l);
  if (!c || c.excluded) return false;
  switch (l.kind) {
    case "supplier_reduce_deposit": return c.minPercentBps !== undefined && l.percentBps >= c.minPercentBps;
    case "supplier_defer_balance": return c.maxDays !== undefined && l.daysAfterShipment <= c.maxDays;
    case "buyer_request_deposit": return c.maxPercentBps !== undefined && l.percentBps <= c.maxPercentBps;
    case "chase_overdue": return c.minDays !== undefined && l.payWithinDays >= c.minDays;
    case "early_payment_discount": return c.minDiscountBps !== undefined && l.discountBps >= c.minDiscountBps;
    case "finance_invoice": return c.assumedFeeBps !== undefined;
  }
}

/** What a counterparty said, in words (numbers only come from the stored structured reply). */
export function theySaid(c: Constraint): string {
  if (c.excluded) return "refused this";
  const parts: string[] = [];
  if (c.minPercentBps !== undefined) parts.push(`will not go below a ${pct(c.minPercentBps)} deposit`);
  if (c.maxPercentBps !== undefined) parts.push(`will not pay more than a ${pct(c.maxPercentBps)} deposit`);
  if (c.maxDays !== undefined) parts.push(`allows at most ${c.maxDays} days`);
  if (c.minDays !== undefined) parts.push(`will not pay sooner than ${c.minDays} days`);
  if (c.minDiscountBps !== undefined) parts.push(`wants at least a ${pct(c.minDiscountBps)} discount`);
  if (c.assumedFeeBps !== undefined) parts.push(`charges a fee of ${pct(c.assumedFeeBps)} of the invoice`);
  return parts.join(" and ") || "replied";
}

/** Run the coordinator with this context's signed limits and learned refusals. Null when the signed limits are not valid. */
export function coordinateForContext(ctx: AgentToolContext): Coordination | null {
  const b = leverBounds(ctx);
  if (!b.mandateValid) return null;
  const allowedKinds = LEVER_KINDS.filter((k) => b[k].available);
  if (allowedKinds.length === 0) return null;
  return coordinate(ctx.input, baseEventsOf(ctx), ctx.parties, {
    horizonWeeks: ctx.horizonWeeks, allowedKinds, constraints: ctx.constraints, financeFeeBps: ctx.financeFeeBps,
    financeCapBps: b.finance_invoice.available ? b.finance_invoice.advanceBps.max : null,
    earlyDiscountCapBps: b.early_payment_discount.available ? b.early_payment_discount.discountBps.max : null,
    known: (l: Lever) => backedByTheirWords(ctx, l),
    allow: (levers: Lever[]) => leverProblems(ctx, levers).length === 0 && isRunnable(ctx, levers) && dryRun(ctx, levers).every((c) => c.decision !== "deny"),
  });
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;

const KIND_LABEL: Record<Lever["kind"], string> = {
  supplier_reduce_deposit: "supplier deposit", supplier_defer_balance: "supplier balance terms", buyer_request_deposit: "customer deposit",
  finance_invoice: "invoice finance", chase_overdue: "paying overdue invoices", early_payment_discount: "early payment",
};

function explain(ctx: AgentToolContext, c: Coordination): StrategyView {
  const cur = ctx.currency;
  const m = (v: bigint) => formatMinor(v.toString(), cur);
  const sel = c.selected!;
  const base = c.baseline;
  const words = (levers: Lever[]) => levers.map((l) => describeLever(l, ctx)).join("; ");
  const week = (o: { minBalanceWeek: number }) => `week ${o.minBalanceWeek}`;
  const reach = (o: StrategyOption) => `lowest balance ${m(o.minBalanceMinor)} in ${week(o)}${o.closesGap ? ", cushion kept" : `, ${m(c.reserveMinor - o.minBalanceMinor)} under the cushion`}`;
  const vsNothing = `Doing nothing reaches a lowest balance of ${m(base.minBalance)} in week ${base.forecast.minimum.weekIndex + 1}${base.metrics.firstNegativeWeek ? `, going below zero in week ${base.metrics.firstNegativeWeek}` : ""}; your cushion is ${m(c.reserveMinor)}.`;

  const why: string[] = [vsNothing];
  const headline =
    c.verdict === "closes_without_borrowing"
      ? `This combination keeps every week at or above your cushion without borrowing: ${reach(sel)}.`
      : c.verdict === "closes_with_financing"
        ? `Nothing that avoids borrowing keeps every week above your cushion. The smallest invoice-finance advance that does, with the other actions below, is ${m(c.financing!.advanceMinor)} (${pct(c.financing!.advanceBps)} of the invoice): ${reach(sel)}.`
        : `Nothing available closes the gap. This is the best combination found: ${reach(sel)}.`;
  const costLine = sel.costMinor > 0n ? `Its total cost is ${m(sel.costMinor)}.` : "It has no direct cost.";
  why.push(`${costLine} ${sel.counterparties} ${sel.counterparties === 1 ? "party" : "parties"} must agree.`);

  const compared: string[] = [];
  for (const { role, option: o } of c.comparison) {
    const label = role === "single_lever" ? "Best single action" : role === "no_borrowing" ? "Best way without borrowing" : role === "finance_alone" ? "Invoice finance alone" : "The same actions without the finance part";
    const needs = role === "finance_alone" && !o.closesGap ? " even at your signed maximum advance" : "";
    compared.push(`${label}: ${words(o.levers)}. ${reach(o)}${needs}${o.costMinor > 0n ? `; cost ${m(o.costMinor)}` : ""}.`);
  }
  if (c.verdict === "closes_without_borrowing") {
    const single = c.comparison.find((x) => x.role === "single_lever")?.option;
    if (single && !single.closesGap) why.push("No single action is enough on its own, so the actions are combined; each was kept only because the cushion fails without it.");
    if (sel.levers.length === 1) why.push("One action is enough, so nothing more is asked of anyone.");
    why.push("Borrowing was not considered necessary because this combination already resolves the shortage; it was preferred over any plan that borrows.");
  }
  if (c.verdict === "closes_with_financing" && c.financing) {
    why.push(`Financing is used only because no combination without borrowing keeps every week above the cushion${c.comparison.some((x) => x.role === "no_borrowing") ? ` (the best of those reaches ${m(c.comparison.find((x) => x.role === "no_borrowing")!.option.minBalanceMinor)})` : ""}.`);
    why.push(c.financing.aloneAdvanceBps !== null && c.financing.aloneAdvanceBps > c.financing.advanceBps
      ? `The other actions reduce the borrowing needed from ${pct(c.financing.aloneAdvanceBps)} of the invoice (finance alone) to ${pct(c.financing.advanceBps)}.`
      : `The advance is the smallest step of ${pct(500)} that closes the gap with these actions, up to your signed maximum of ${pct(c.financing.capBps)}.`);
  }
  if (c.verdict === "partial") why.push("It still leaves a shortfall: more cash, a lower cushion or other action is needed. Nothing here claims the gap is closed.");

  const parts = c.contributions.map((x) => `${describeLever(x.lever, ctx)}: on its own the lowest balance would be ${m(x.aloneMinBalanceMinor)}; without it the plan would reach ${m(x.withoutItMinBalanceMinor)}${x.needed ? " (needed)" : " (not strictly needed)"}.`);
  if (c.interaction) {
    const i = c.interaction;
    why.push(`Each action was not simply added: their separate gains total ${m(i.sumOfOwnGainsMinor)} but the full forecast with all of them together raises the lowest balance by ${m(i.combinedGainMinor)}${i.combinedGainMinor === i.sumOfOwnGainsMinor ? "" : ", because they affect the same weeks and the lowest week can move"}.`);
  }

  const assumptions = [
    "Every counterparty accepts the terms exactly as asked; agreement is unknown until they answer and no likelihood is given.",
    `Cash is projected over ${ctx.horizonWeeks} weeks from ${ctx.asOf}, with the invoices and bills in your books and the confirmed orders, by the deterministic engine.`,
    "Overdue invoices that are not chased are assumed to arrive after the engine's usual delay.",
  ];
  if (sel.levers.some((l) => l.kind === "chase_overdue")) assumptions.push("Chasing assumes the customer pays within the days asked; 'within' is an upper bound, so it never makes cash later.");
  if (sel.levers.some((l) => l.kind === "early_payment_discount")) assumptions.push("An early-payment discount is cash given away; it is counted in the cost.");
  if (sel.borrows) assumptions.push(`The finance fee is assumed to be ${pct(ctx.financeFeeBps)} of the invoice; the lender sets the real terms when it answers, and the lender is repaid out of the customer's payment.`);

  const risks: string[] = [];
  risks.push(`${sel.counterparties} ${sel.counterparties === 1 ? "party" : "parties"} must agree. If one refuses or counters, nothing is committed and the planner replans with that answer.`);
  if (c.downside) risks.push(c.downside.holdsReserve ? `If estimated customer payments arrive ${DOWNSIDE_DELAY_DAYS} days late, the lowest balance would be ${m(c.downside.minBalanceMinor)}, still above your cushion.` : `If estimated customer payments arrive ${DOWNSIDE_DELAY_DAYS} days late, the lowest balance would be ${m(c.downside.minBalanceMinor)}, ${c.downside.minBalanceMinor < 0n ? "below zero" : "under your cushion"}.`);
  if (sel.borrows) risks.push("Borrowing adds a repayment: the lender is repaid first when the customer pays, so a late customer payment delays that too.");
  if (c.verdict !== "partial" && sel.minBalanceMinor - c.reserveMinor < c.reserveMinor / 10n) risks.push(`The margin over your cushion is small (${m(sel.minBalanceMinor - c.reserveMinor)}).`);
  if (c.audit.sameCustomerBothLevers) risks.push("The same customer is asked both to pay overdue invoices and to pay others early; these act on different invoices but are two asks of one customer.");
  if (c.verdict === "partial") risks.push(`A shortfall of ${m(c.reserveMinor - sel.minBalanceMinor)} against your cushion remains.`);

  const checks = [
    c.audit.duplicateSources.length === 0 ? "No invoice or bill is counted twice in the combined forecast." : `Counted more than once: ${c.audit.duplicateSources.join(", ")}.`,
    ...(c.audit.orderCashConserved === null ? [] : [c.audit.orderCashConserved ? "The customer order's cash (deposit, advance, later payment, fee) adds up to the original payment." : "The customer order's cash does not add up to the original payment."]),
    "Limits: this combination passed the signed-limit check and the permission gate dry-run for every action. The owner still reviews and signs it; a second approver is asked where your limits require one.",
  ];

  // Known versus assumed. Acceptance is never predicted: "known" means a counterparty's own structured reply bounds the ask and the ask respects it.
  const nameOf = (id: string) => ctx.counterparties.find((x) => x.id === id)?.name ?? "A counterparty";
  const known: string[] = [];
  const untested: string[] = [];
  for (const l of sel.levers) {
    const cn = constraintFor(ctx, l);
    if (backedByTheirWords(ctx, l) && cn) known.push(`${describeLever(l, ctx)}: ${nameOf(l.counterpartyId)} earlier ${theySaid(cn)}; this ask respects that.`);
    else untested.push(`${describeLever(l, ctx)}: nothing the counterparty has said covers this ask. Whether it accepts is an assumption, not a prediction.`);
  }
  for (const cn of ctx.constraints) {
    if (sel.levers.some((l) => l.kind === cn.kind && l.counterpartyId === cn.counterpartyId)) continue;
    known.push(`${nameOf(cn.counterpartyId)} earlier ${theySaid(cn)} (${KIND_LABEL[cn.kind]}), so ${cn.excluded ? "it is not asked again" : "asks stay inside that"}.`);
  }
  const room = c.room.flatMap((r) => (r.gentlest ? [r.gentlest.kind === r.lever.kind && JSON.stringify(r.gentlest) === JSON.stringify(r.lever) ? `${describeLever(r.lever, ctx)}: no room. A softer counter-offer would leave the gap open.` : `${describeLever(r.lever, ctx)}: a counter-offer as soft as ${leverTerms(r.gentlest)} would still keep the result above.`] : []));
  const ifRefused = c.fallbacks.map((f) => {
    const who = nameOf(f.lever.counterpartyId);
    if (f.levers.length === 0) return `If ${who} refuses: nothing available then improves on doing nothing.`;
    return `If ${who} refuses: ${f.closesGap ? "the gap can still be closed by" : "the best that remains is"} ${f.levers.map((l) => describeLever(l, ctx)).join("; ")}${f.closesGap ? "" : ` (lowest balance ${m(f.minBalanceMinor!)}, ${m(c.reserveMinor - f.minBalanceMinor!)} under the cushion)`}.`;
  });
  why.push("Acceptance is not predicted. Asks that respect something a counterparty already said are listed as known; the others are assumptions, and a refusal or counter-offer starts a replan that you sign again.");
  return { verdict: c.verdict as StrategyView["verdict"], headline, why, compared, parts, assumptions, risks, checks, known, untested, room, ifRefused };
}

/** The plan for a coordination result, or null when there is nothing to propose or the plan does not build. */
export function strategyPlan(ctx: AgentToolContext, c: Coordination): PlanView | null {
  if (!c.selected || c.verdict === "no_shortage" || c.verdict === "no_help" || !c.audit.ok) return null;
  const levers = sortLevers(c.selected.levers);
  const built = buildPlanView(ctx, { title: levers.map((l) => describeLever(l, ctx)).join("; ").slice(0, 120), levers, contingencies: [], rationale: "Coordinated strategy." }, "deterministic");
  if (!built.ok) return null;
  const strategy = explain(ctx, c);
  return { ...built.view, title: `${c.verdict === "partial" ? "Best available: " : ""}${built.view.title}`.slice(0, 120), rationale: `${strategy.headline} ${strategy.why[0]}`, proseFlagged: false, removedSentences: [], strategy };
}

const closes = (p: PlanView, reserve: bigint) => BigInt(p.metrics.minBalanceMinor) >= reserve;
const borrows = (p: PlanView) => p.levers.some((l) => l.kind === "finance_invoice");

/**
 * Put the coordinated strategy in front of the owner. It is placed first only when it is better than the plan that would otherwise lead:
 * it keeps the cushion where that one does not, or it keeps it without borrowing where that one borrows, or it keeps it with the same
 * borrowing posture at a lower cost. Otherwise AI plans are left as they are and deterministic plans get it as a further option. The same plan found twice is enriched with the explanation instead of
 * duplicated; other plans keep their own checks. Pure.
 */
export function applyStrategy(ctx: AgentToolContext, plans: PlanView[], source: "ai" | "deterministic" | "none" = "none"): { plans: PlanView[]; notes: Record<string, unknown>[] } {
  const c = coordinateForContext(ctx);
  if (!c) return { plans, notes: [] };
  const note = { type: "strategy", verdict: c.verdict, evaluated: c.evaluated, planId: c.selected?.id ?? null };
  const sp = strategyPlan(ctx, c);
  if (!sp) return { plans, notes: [{ ...note, result: "no combined plan proposed" }] };
  const reserve = c.reserveMinor;
  const same = plans.findIndex((p) => p.id === sp.id);
  if (same >= 0) {
    const out = plans.map((p, i) => (i === same ? { ...sp, source: p.source, ...(p.warnings ? { warnings: p.warnings } : {}) } : p));
    return { plans: out, notes: [{ ...note, result: "already among the plans; explanation attached" }] };
  }
  const top = plans[0];
  const better =
    !top ||
    (closes(sp, reserve) && !closes(top, reserve)) ||
    (closes(sp, reserve) && closes(top, reserve) && borrows(top) && !borrows(sp)) ||
    (closes(sp, reserve) && closes(top, reserve) && borrows(top) === borrows(sp) && BigInt(sp.metrics.totalCostMinor) < BigInt(top.metrics.totalCostMinor)) ||
    (!closes(sp, reserve) && !closes(top, reserve) && BigInt(sp.metrics.minBalanceMinor) > BigInt(top.metrics.minBalanceMinor));
  // AI-proposed plans are left alone unless the strategy is better; deterministic plans get it as an extra option so its explanation is visible.
  if (!better) {
    if (source === "ai" || plans.length === 0) return { plans, notes: [{ ...note, result: "the leading plan is as good; plans unchanged" }] };
    return { plans: [...plans.slice(0, 2), sp], notes: [{ ...note, result: "added as an option" }] };
  }
  return { plans: [sp, ...plans].slice(0, 3), notes: [{ ...note, result: "placed first: better than the leading plan" }] };
}
