// A counter-offer inside the owner's signed TOLERANCE is not automatically affordable. Before the executor accepts one, the whole plan is recomputed with the
// counter's terms (and any terms already agreed) through the same deterministic checks as a proposed plan: the signed limits and bounds (leverProblems),
// the gate dry-run, payments the terms imply, and the cash cushion. Anything that fails makes the counter out of terms, so it is learned as a
// constraint and the adaptation step handles it; the executor never accepts it. No model, no new engine.
import { dryRun, leverProblems } from "@/agent";
import { baseEventsOf, impliedPaymentBlockers } from "@/agent/plan-builder";
import type { Lever } from "@/domain/plan";
import { simulateLevers } from "@/engine";
import { withTheirTerms } from "@/engine/plans/adapt";
import { formatMoney, money } from "@/lib/money";
import { buildContext } from "./agent-run";
import type { Branch } from "./plan-exec";
import type { TermsEntry } from "./plan-terms";
import type { Db } from "./types";

export async function counterProblems(db: Db, businessId: string, entries: TermsEntry[], branches: Branch[], counterIndex: number, counterTerms: Record<string, number>): Promise<string[]> {
  const ctx = await buildContext(db, businessId, null);
  const asked = entries.map((e) => e.lever);
  const levers: Lever[] = entries.map((e) => {
    const agreed = e.index === counterIndex ? counterTerms : branches.find((b) => b.index === e.index)?.agreedTerms;
    return (agreed && withTheirTerms(e.lever, undefined, agreed)) || e.lever;
  });
  const problems = [...leverProblems(ctx, levers)];
  try {
    const opts = { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps };
    const counter = simulateLevers(ctx.input, baseEventsOf(ctx), levers, opts);
    const plan = simulateLevers(ctx.input, baseEventsOf(ctx), asked, opts);
    problems.push(...impliedPaymentBlockers(ctx, counter.events));
    problems.push(...dryRun(ctx, levers).filter((c) => c.decision === "deny").map((c) => `the gate would deny it: ${c.reasons.join("; ")}`));
    // The cushion: the counter may not leave less cash than the lower of what the signed plan promised and the safety cushion.
    const m = (v: bigint) => formatMoney(money(v, ctx.currency), 2);
    const floor = plan.minBalance < ctx.input.reserve ? plan.minBalance : ctx.input.reserve;
    if (counter.minBalance < floor) problems.push(`the counter would leave a lowest balance of ${m(counter.minBalance)}, below ${plan.minBalance < ctx.input.reserve ? "what the signed plan promised" : "your safety cushion"} of ${m(floor)}`);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : "the counter cannot be simulated");
  }
  return problems;
}
