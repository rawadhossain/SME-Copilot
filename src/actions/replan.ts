// RE-PLANNING after a plan needed a re-plan (ADR-021). The executor already withdrew everything the failed attempt made live and
// stored the STRUCTURED constraints it learned (never counterparty free text). This orchestrator checks the state is clean, runs the
// planning agent again with those constraints, and stops after MAX_REPLAN_ROUNDS. It only PROPOSES new plans: the owner must sign a
// new authorisation before anything executes. Lives outside src/agent (database and log access).
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { doNothingSummary } from "@/agent";
import { agentRuns, planExecutions, plans, sandboxApplications, sandboxPayments, sandboxReceipts, sandboxThreads } from "@/db/schema";
import { MAX_REPLAN_ROUNDS, mergeConstraints, type Constraint } from "@/domain/constraints";
import type { PlanView } from "@/domain/plan";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext, startRun, type RunOptions, type RunSummary } from "./agent-run";
import { appendRecord } from "./log";
import type { ExecutionOutcome } from "./plan-exec";
import { ACTION_EVENTS, ActionError, type Db } from "./types";
import { planAuthorisations } from "@/db/schema";

export interface ReplanResult {
  status: "replanned" | "exhausted";
  parentRunId: string;
  /** The new run (replanned), or the empty run that found nothing (exhausted after a search). */
  newRunId: string | null;
  round: number;
  constraints: Constraint[];
  plans: PlanView[];
  /** Exhausted only: a plain statement and the best documented option for the owner to decide. */
  message?: string;
  bestOption?: unknown;
  note?: string | null;
}

/** Anything the failed attempt left live in the sandbox? (It must be empty before a new plan is proposed.) */
async function liveLeftovers(db: Db, businessId: string, outcome: ExecutionOutcome): Promise<string[]> {
  const left: string[] = [];
  const threadIds = outcome.branches.map((b) => b.threadId).filter((x): x is string => !!x);
  const appIds = outcome.branches.map((b) => b.applicationId).filter((x): x is string => !!x);
  if (threadIds.length) for (const t of await db.select().from(sandboxThreads).where(and(eq(sandboxThreads.businessId, businessId), inArray(sandboxThreads.id, threadIds)))) if (t.status === "agreed") left.push(`thread ${t.id} is still agreed`);
  if (appIds.length) for (const a of await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.businessId, businessId), inArray(sandboxApplications.id, appIds)))) if (a.status === "offered" || a.status === "accepted") left.push(`application ${a.id} is still ${a.status}`);
  const pay = outcome.scheduled.filter((x) => x.kind === "payment").map((x) => x.id);
  const rct = outcome.scheduled.filter((x) => x.kind === "receipt").map((x) => x.id);
  if (pay.length) for (const p of await db.select().from(sandboxPayments).where(and(eq(sandboxPayments.businessId, businessId), inArray(sandboxPayments.id, pay)))) if (p.status === "scheduled") left.push(`payment ${p.id} is still scheduled`);
  if (rct.length) for (const r of await db.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), inArray(sandboxReceipts.id, rct)))) if (r.status === "scheduled") left.push(`receipt ${r.id} is still scheduled`);
  return left;
}

export async function replanFromExecution(db: Db, authorisationIdInput: string, opts: Pick<RunOptions, "gateway" | "limits" | "forceFallback" | "purposeId"> = {}): Promise<ReplanResult> {
  const authorisationId = z.string().uuid().parse(authorisationIdInput);
  const [auth] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, authorisationId));
  if (!auth) throw new ActionError("not_found", "Unknown plan authorisation");
  const [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, authorisationId));
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, auth.runId));
  if (!exec || !run) throw new ActionError("not_found", "Nothing was executed for this authorisation");
  const businessId = auth.businessId;
  const parentConstraints = (run.constraints ?? []) as Constraint[];

  // Idempotent: asking again returns the earlier answer.
  if (run.lifecycle === "replanned" && run.successorRunId) {
    const rows = await db.select().from(plans).where(eq(plans.runId, run.successorRunId));
    return { status: "replanned", parentRunId: run.id, newRunId: run.successorRunId, round: run.round + 1, constraints: parentConstraints, plans: rows.map((p) => p.plan as unknown as PlanView) };
  }
  if (exec.status !== "needs_replan") throw new ActionError("conflict", `The execution is ${exec.status}; only a plan that needs a re-plan can be re-planned`);
  const outcome = exec.outcome as ExecutionOutcome;
  const dirty = await liveLeftovers(db, businessId, outcome);
  if (dirty.length > 0) throw new ActionError("refused", "The failed attempt left state live; it must be withdrawn before a new plan is proposed", dirty);

  const constraints = mergeConstraints(parentConstraints, outcome.constraints ?? []);
  const ctx = await buildContext(db, businessId, null, constraints);
  const refusedBecause = outcome.branches.filter((b) => b.status === "needs_replan").map((b) => ({ index: b.index, kind: b.kind, reason: b.reason ?? null }));
  const exhausted = async (childRunId: string | null, why: string, note: string | null = null): Promise<ReplanResult> => {
    const [last] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, run.id), eq(plans.planHash, auth.planId)));
    const bestOption = {
      kind: "last_attempted_plan",
      plan: last?.plan ?? null,
      refusedBecause,
      doNothing: doNothingSummary(ctx),
      statement: "This is the closest documented option. The counterparties did not agree to it inside your limits; you decide whether to accept different terms, ask again or do nothing.",
    };
    const message = "No feasible plan inside the owner's constraints.";
    await db.update(agentRuns).set({ lifecycle: "exhausted", ...(childRunId ? { successorRunId: childRunId } : {}) }).where(eq(agentRuns.id, run.id));
    await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_EXHAUSTED, actor: "executor", detail: { authorisationId, runId: run.id, childRunId, round: run.round, why, constraints, refusedBecause } });
    return { status: "exhausted", parentRunId: run.id, newRunId: childRunId, round: run.round, constraints, plans: [], message, bestOption: toJsonValue(bestOption), note };
  };

  if (run.round >= MAX_REPLAN_ROUNDS) return exhausted(null, `the limit of ${MAX_REPLAN_ROUNDS} re-plan rounds is reached`);

  const trigger = run.trigger;
  const child: RunSummary = await startRun(db, businessId, trigger, { ...opts, replan: { parentRunId: run.id, round: run.round + 1, constraints } });
  if (child.status !== "completed" || child.plans.length === 0) {
    await db.update(agentRuns).set({ lifecycle: "exhausted" }).where(eq(agentRuns.id, child.runId));
    return exhausted(child.runId, child.error ?? "the constrained search found no plan", child.note);
  }
  await db.update(agentRuns).set({ lifecycle: "replanned", successorRunId: child.runId }).where(eq(agentRuns.id, run.id));
  await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_REPLANNED, actor: "executor", detail: { authorisationId, parentRunId: run.id, newRunId: child.runId, round: run.round + 1, constraints, planIds: child.plans.map((p) => p.id) } });
  return { status: "replanned", parentRunId: run.id, newRunId: child.runId, round: run.round + 1, constraints, plans: child.plans, note: child.note };
}
