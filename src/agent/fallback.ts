// Deterministic fallback (ADR-015): when no AI provider is available, or the AI run errors, times out, or leaves no valid
// plan, build the plans from the deterministic search with templated rationale. The product works with no AI at all.
import { sortLevers, type Lever, type PlanSubmission, type PlanView } from "@/domain/plan";
import { searchPlans, type SearchedPlan } from "@/engine/plans";
import { assumptionsFor, buildPlanView, baseEventsOf, describeLever, formatMinor, leverBounds } from "./plan-builder";
import type { AgentToolContext } from "./context";
import { LEVER_KINDS } from "@/domain/plan";

const kindSet = (l: Lever[]) => l.map((x) => x.kind).sort().join("+");

function rationaleFor(ctx: AgentToolContext, p: SearchedPlan): string {
  const m = p.metrics;
  const cur = ctx.currency;
  const parts = [
    `Lowest balance ${formatMinor(m.minBalanceMinor, cur)} in week ${m.minBalanceWeek}.`,
    m.firstNegativeWeek ? `The balance first goes below zero in week ${m.firstNegativeWeek}.` : "The balance never goes below zero.",
    `Closing balance at week ${m.horizonWeeks} is ${formatMinor(m.closingAtHorizonMinor, cur)}.`,
    `Total cost ${formatMinor(m.totalCostMinor, cur)}; ${m.counterpartiesNeeded} counterpart${m.counterpartiesNeeded === 1 ? "y" : "ies"} must agree.`,
  ];
  return parts.join(" ");
}

/** Up to 3 distinct plans from the search: the top-ranked, then plans with a different set of lever kinds. */
export function deterministicPlans(ctx: AgentToolContext): { plans: PlanView[]; note: string } {
  const b = leverBounds(ctx);
  if (!b.mandateValid) return { plans: [], note: `No plans: the signed mandate is invalid (${b.mandateProblem}).` };
  const allowedKinds = LEVER_KINDS.filter((k) => b[k].available);
  const r = searchPlans(ctx.input, baseEventsOf(ctx), ctx.parties, {
    horizonWeeks: ctx.horizonWeeks, financeCapBps: b.finance_invoice.available ? b.finance_invoice.advanceBps.max : null, allowedKinds, topN: 40,
    constraints: ctx.constraints, financeFeeBps: ctx.financeFeeBps, earlyDiscountCapBps: b.early_payment_discount.available ? b.early_payment_discount.discountBps.max : null,
  });
  const pool = [...r.ranked, ...r.pareto];
  const chosen: SearchedPlan[] = [];
  for (const p of pool) {
    if (chosen.length >= 3) break;
    if (chosen.some((c) => c.id === p.id || kindSet(c.levers) === kindSet(p.levers))) continue;
    chosen.push(p);
  }
  // Keep one plan that uses a books-level lever (chase / early payment) among the three when one is as safe as the best plan.
  const usesBooks = (p: SearchedPlan) => p.levers.some((l) => l.kind === "chase_overdue" || l.kind === "early_payment_discount");
  if (chosen.length === 3 && !chosen.some(usesBooks)) {
    const best = chosen[0];
    const cand = pool.find((p) => usesBooks(p) && (p.minBalance >= ctx.input.reserve ? 0 : p.minBalance >= 0n ? 1 : 2) === (best.minBalance >= ctx.input.reserve ? 0 : best.minBalance >= 0n ? 1 : 2));
    if (cand && !chosen.some((c) => c.id === cand.id)) chosen[2] = cand;
  }
  const withoutFinance = r.ranked.find((p) => !p.levers.some((l) => l.kind === "finance_invoice"));
  const financeLever = r.ranked.flatMap((p) => p.levers).find((l) => l.kind === "finance_invoice");
  const plans: PlanView[] = [];
  for (const p of chosen) {
    const levers = sortLevers(p.levers);
    const finIdx = levers.findIndex((l) => l.kind === "finance_invoice");
    const contingencies: PlanSubmission["contingencies"] = [];
    if (finIdx >= 0 && withoutFinance) contingencies.push({ ifRefusedLeverIndex: finIdx, useLevers: withoutFinance.levers });
    else if (finIdx < 0 && financeLever) contingencies.push({ ifRefusedLeverIndex: 0, useLevers: [...levers, financeLever].slice(0, 4) });
    const sub: PlanSubmission = { title: levers.map((l) => describeLever(l, ctx)).join("; ").slice(0, 120), levers, contingencies, rationale: rationaleFor(ctx, p) };
    const built = buildPlanView(ctx, sub, "deterministic");
    if (built.ok) plans.push(built.view);
    else {
      // A contingency may not validate (for example a duplicate lever kind); drop contingencies rather than the plan.
      const retry = buildPlanView(ctx, { ...sub, contingencies: [] }, "deterministic");
      if (retry.ok) plans.push({ ...retry.view, assumptions: [...assumptionsFor(ctx, levers), "A fallback contingency was dropped because it did not validate."] });
    }
  }
  return { plans, note: `Deterministic search evaluated ${r.evaluated} lever combinations; ${plans.length} plan(s) selected.` };
}
