// Recommendation guard (ADR-015 addendum, Batch 7.5): the AI proposes, code decides what may be recommended. If the
// deterministic search finds a plan whose lowest balance stays at or above zero, no AI plan that dips below zero may be
// ranked above it. Pure: no database, no clock, no model.
import type { PlanView } from "@/domain/plan";
import type { AgentToolContext } from "./context";
import { deterministicPlans } from "./fallback";

const negative = (p: PlanView) => BigInt(p.metrics.minBalanceMinor) < 0n;
const WARNING = "The lowest balance of this plan is below zero, although the deterministic search found a plan that stays at or above zero. It is not the recommendation.";

export function guardRanking(ctx: AgentToolContext, plans: PlanView[]): { plans: PlanView[]; notes: Record<string, unknown>[] } {
  if (!plans.some(negative)) return { plans, notes: [] };
  const feasible = deterministicPlans(ctx).plans.filter((p) => !negative(p));
  if (feasible.length === 0) return { plans, notes: [{ type: "guard", result: "no plan stays at or above zero; AI order kept" }] };

  const flagged = plans.map((p) => (negative(p) ? { ...p, title: p.title.replace(/^recommended:\s*/i, ""), warnings: [...(p.warnings ?? []), WARNING] } : p));
  const ok = flagged.filter((p) => !negative(p));
  const bad = flagged.filter(negative);
  const injected = ok.length === 0;
  const ordered = injected ? [feasible[0], ...bad] : [...ok, ...bad];
  const seen = new Set<string>();
  const out = ordered.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).slice(0, 3);
  return {
    plans: out,
    notes: [{ type: "guard", result: injected ? "no AI plan stays at or above zero; the best deterministic plan was put first" : "AI plans below zero were ranked after plans at or above zero", demotedPlanIds: bad.map((p) => p.id), injectedPlanId: injected ? feasible[0].id : null }],
  };
}
