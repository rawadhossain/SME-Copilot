// ADAPTIVE NEGOTIATION orchestrator. After a counterparty refused or countered, this reads what the executor recorded (structured fields only),
// puts the counter-offer itself through the same validators as any plan (signed limits, learned refusals, gate dry-run), recomputes every
// candidate with the engine, and records WHICH next step is best and why. It never executes anything and never signs: the chosen plan is stored
// as a proposal and the owner still goes through Review and sign (with a second approver where required). No model is called here.
import { and, eq } from "drizzle-orm";
import { doNothingSummary, buildPlanView } from "@/agent";
import { baseEventsOf, isRunnable } from "@/agent/plan-builder";
import type { AgentToolContext } from "@/agent/context";
import { agentSteps, plans, type agentRuns, type planAuthorisations } from "@/db/schema";
import { constraintProblems, MAX_REPLAN_ROUNDS, type Constraint } from "@/domain/constraints";
import { planId, type Lever, type PlanView } from "@/domain/plan";
import { simulateLevers } from "@/engine";
import { decide, feasible, interpretResponses, leverTerms, withTheirTerms, type Adaptation, type Candidate } from "@/engine/plans/adapt";
import { toJsonValue } from "@/sandbox/proposals";
import { appendRecord } from "./log";
import type { ExecutionOutcome } from "./plan-exec";
import type { PlanTerms } from "./plan-terms";
import { ACTION_EVENTS, type Db } from "./types";

type Run = typeof agentRuns.$inferSelect;
type Auth = typeof planAuthorisations.$inferSelect;

export interface AdaptInput {
  auth: Auth;
  /** The run whose plan was just refused or countered. */
  run: Run;
  outcome: ExecutionOutcome;
  /** Everything learned so far in this rescue attempt (earlier rounds included). */
  constraints: Constraint[];
  ctx: AgentToolContext;
  /** The new round's run and its plans; null when no new round was started (the round limit was reached). */
  childRunId: string | null;
  childPlans: PlanView[];
}

const metricsOf = (v: PlanView) => ({ minBalanceMinor: v.metrics.minBalanceMinor, minBalanceWeek: v.metrics.minBalanceWeek, firstNegativeWeek: v.metrics.firstNegativeWeek, totalCostMinor: v.metrics.totalCostMinor, counterpartiesNeeded: v.metrics.counterpartiesNeeded });

export async function adaptNegotiation(db: Db, i: AdaptInput): Promise<{ report: Adaptation; addedPlan: PlanView | null }> {
  const { auth, run, outcome, constraints, ctx } = i;
  const entries = (auth.terms as PlanTerms).entries;
  const [origRow] = await db.select().from(plans).where(and(eq(plans.runId, run.id), eq(plans.planHash, auth.planId)));
  const origView = (origRow?.plan ?? null) as PlanView | null;
  const origLevers = origView?.levers ?? entries.map((e) => e.lever);
  const responses = interpretResponses(entries, outcome.branches, constraints);
  const reserve = ctx.input.reserve;
  const dn = doNothingSummary(ctx);

  const candidates: Candidate[] = [];
  // 1. Repeating the original proposal: the learned refusals and limits rule it out; shown so the owner can see it was not simply asked again.
  if (origView) candidates.push({ id: "original", label: "Ask for the original terms again", kind: "original", levers: origLevers, metrics: metricsOf(origView), rejectedBecause: constraintProblems(origLevers, constraints) });

  // 2. Their counter-offer as stated: their number in place of ours, everything else unchanged, run through the same checks as any plan.
  const counterLevers: Lever[] = [];
  let replaced = 0;
  for (const l of origLevers) {
    const c = constraints.find((x) => x.kind === l.kind && x.counterpartyId === l.counterpartyId);
    const theirs = c ? withTheirTerms(l, c) : null;
    if (!c) counterLevers.push(l);
    else if (theirs) { counterLevers.push(theirs); replaced += 1; }
  }
  const counterId = counterLevers.length > 0 ? planId(counterLevers) : null;
  if (replaced > 0 && counterId && !i.childPlans.some((p) => p.id === counterId)) {
    const changed = counterLevers.filter((l) => !origLevers.some((o) => JSON.stringify(o) === JSON.stringify(l)));
    const built = buildPlanView(ctx, { title: `Take their counter-offer: ${changed.map(leverTerms).join("; ")}`.slice(0, 120), levers: counterLevers, contingencies: [], rationale: "This is the counterparty's own counter-offer, recomputed by the engine." }, "deterministic");
    let rejected: string[] = built.ok ? [] : built.reasons;
    if (built.ok && !isRunnable(ctx, counterLevers)) rejected = ["a payment this implies would break a signed limit"];
    let ifAccepted: Candidate["ifAccepted"] = null;
    if (!built.ok) {
      try { const s = simulateLevers(ctx.input, baseEventsOf(ctx), counterLevers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps }); ifAccepted = { minBalanceMinor: s.metrics.minBalanceMinor, totalCostMinor: s.metrics.totalCostMinor }; } catch { ifAccepted = null; }
    }
    candidates.push({
      id: "counter", label: `Take their counter-offer: ${changed.map(leverTerms).join("; ")}`, kind: "counter_offer", levers: counterLevers,
      metrics: built.ok ? metricsOf(built.view) : null, rejectedBecause: rejected, ifAccepted, ...(built.ok ? { assumptions: built.view.assumptions } : {}),
    });
    if (built.ok && rejected.length === 0) (candidates[candidates.length - 1] as Candidate & { view?: PlanView }).view = built.view;
  }

  // 3. The new round's plans (planner search narrowed by everything learned): re-checked against the learned refusals before they count.
  for (const p of i.childPlans) {
    const problems = [...constraintProblems(p.levers, constraints), ...(p.blockers ?? [])];
    candidates.push({ id: `plan:${p.id}`, label: p.title, kind: "revised_plan", levers: p.levers, metrics: metricsOf(p), rejectedBecause: problems, assumptions: p.assumptions });
  }

  // 4. Cash reserve: when some option keeps the safety cushion, one that does not is not proposed.
  const keeps = (c: Candidate) => c.metrics !== null && BigInt(c.metrics.minBalanceMinor) >= reserve;
  if (candidates.some((c) => c.kind !== "original" && feasible(c) && keeps(c))) {
    for (const c of candidates) if (c.kind !== "original" && feasible(c) && !keeps(c)) c.rejectedBecause.push("it does not keep your safety cushion while another option does");
  }
  candidates.push({ id: "do_nothing", label: "Do nothing", kind: "do_nothing", levers: [], metrics: { minBalanceMinor: dn.minBalanceMinor, minBalanceWeek: dn.minBalanceWeek, firstNegativeWeek: dn.firstNegativeWeek, totalCostMinor: "0", counterpartiesNeeded: 0 }, rejectedBecause: [] });

  const round = i.childRunId ? run.round + 1 : run.round; // the round limit was reached when no new round was started
  const report = decide({
    currency: ctx.currency, reserveMinor: reserve.toString(), round, maxRounds: MAX_REPLAN_ROUNDS, responses, candidates,
    original: candidates.find((c) => c.id === "original") ?? null, doNothing: { minBalanceMinor: dn.minBalanceMinor, minBalanceWeek: dn.minBalanceWeek, firstNegativeWeek: dn.firstNegativeWeek },
    roundsLeft: run.round + 1 < MAX_REPLAN_ROUNDS,
  });
  // the view is kept only for storing the plan; it is not part of the report
  const counterView = (candidates.find((c) => c.id === "counter") as (Candidate & { view?: PlanView }) | undefined)?.view ?? null;
  for (const c of candidates) delete (c as Candidate & { view?: PlanView }).view;

  // The plans table is append-only (the app role cannot update it), so stored ranks are never rewritten. A chosen counter-offer is added as one more
  // proposal of the new round, ranked ahead of the others; any other choice is a plan the search already stored and is named in the report.
  let addedPlan: PlanView | null = null;
  const targetRun = i.childRunId ?? run.id;
  if (i.childRunId && report.selected?.id === "counter" && counterView) {
    const existing = await db.select({ rank: plans.rank }).from(plans).where(eq(plans.runId, i.childRunId));
    await db.insert(plans).values({ businessId: auth.businessId, runId: i.childRunId, planHash: counterView.id, rank: existing.reduce((m, r) => Math.min(m, r.rank), 1) - 1, plan: toJsonValue(counterView) as Record<string, unknown> });
    addedPlan = counterView;
  }
  const rows = await db.select({ seq: agentSteps.seq }).from(agentSteps).where(eq(agentSteps.runId, targetRun));
  const seq = rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  await db.insert(agentSteps).values({ businessId: auth.businessId, runId: targetRun, seq, kind: "note", payload: { type: "adaptation", report: toJsonValue(report) } });
  await appendRecord(db, {
    businessId: auth.businessId, event: ACTION_EVENTS.NEGOTIATION_ADAPTED, actor: "executor",
    detail: {
      authorisationId: auth.id, runId: run.id, newRunId: i.childRunId, round, status: report.status, selected: report.selected?.id ?? null,
      responses: responses.map((r) => ({ index: r.index, kind: r.kind, outcome: r.outcome })),
      candidates: candidates.map((c) => ({ id: c.id, kind: c.kind, feasible: feasible(c), rejectedCount: c.rejectedBecause.length })),
    },
  });
  return { report, addedPlan };
}
