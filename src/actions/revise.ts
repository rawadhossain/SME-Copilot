// OWNER REVISION after a counterparty countered or refused (Batch 13, step 3). The executor already withdrew everything the failed attempt
// made live and stored the STRUCTURED constraints it learned. Here the OWNER, not the agent, decides what to ask next: the revised terms
// are validated against the signed limits and those learned constraints, recomputed by the engine, and stored as the only plan of a new
// round. No model is called. The owner must still sign the new plan; nothing executes here.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { doNothingSummary } from "@/agent";
import { agentRuns, agentSteps, planAuthorisations, planExecutions, plans } from "@/db/schema";
import { MAX_OWNER_REVISIONS, mergeConstraints, type Constraint } from "@/domain/constraints";
import { leverSchema, type PlanView } from "@/domain/plan";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext } from "./agent-run";
import { appendRecord } from "./log";
import { makeOwnerView } from "./plan-edit";
import { releaseHeld, type ExecutionOutcome } from "./plan-exec";
import type { PlanTerms } from "./plan-terms";
import { canonicalize } from "@/gate/canonical";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

/** A term (by kind and counterparty) the revision keeps as already agreed, or asks again. */
export interface Kept { kind: string; counterpartyId: string }

export const reviseInputSchema = z.object({
  levers: z.array(leverSchema).min(1).max(6),
  notes: z.record(z.string().uuid(), z.string().max(300)).default({}),
  /** false (default): check only, write nothing. true: open the new round with the revised plan. */
  commit: z.boolean().default(false),
});

export type ReviseResult =
  | { ok: true; committed: boolean; plan: PlanView; newRunId: string | null; round: number; constraints: Constraint[]; kept: Kept[]; askedAgain: Kept[] }
  | { ok: false; reasons: string[] };

export async function reviseFromExecution(db: Db, authorisationIdInput: string, input: unknown): Promise<ReviseResult> {
  const authorisationId = z.string().uuid().parse(authorisationIdInput);
  const { levers, notes, commit } = reviseInputSchema.parse(input);
  const [auth] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, authorisationId));
  if (!auth) throw new ActionError("not_found", "Unknown plan authorisation");
  const [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, authorisationId));
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, auth.runId));
  if (!exec || !run) throw new ActionError("not_found", "Nothing was executed for this authorisation");
  const businessId = auth.businessId;
  if (run.lifecycle === "replanned" && run.successorRunId) throw new ActionError("conflict", "This attempt already has a newer round; revise from there", { successorRunId: run.successorRunId });
  if (exec.status !== "needs_replan") throw new ActionError("conflict", `The execution is ${exec.status}; only an attempt that a counterparty turned down can be revised`);
  if (run.round >= MAX_OWNER_REVISIONS) throw new ActionError("refused", `The limit of ${MAX_OWNER_REVISIONS} rounds is reached; decide whether to accept different terms or do nothing`);
  const outcome = exec.outcome as ExecutionOutcome;

  const constraints = mergeConstraints((run.constraints ?? []) as Constraint[], outcome.constraints ?? []);
  const ctx = await buildContext(db, businessId, null, constraints);
  const [base] = await db.select().from(plans).where(eq(plans.runId, run.id)).then((rows) => rows.filter((p) => p.planHash === auth.planId));
  const made = makeOwnerView(ctx, base?.plan ?? {}, auth.planId, levers, notes);
  if (!made.ok) return { ok: false, reasons: made.reasons };
  const round = run.round + 1;

  // Agreements the attempt kept on hold stay when the owner leaves that term unchanged; changed or dropped ones are asked again (and the old one withdrawn).
  // A finance offer is also kept only if the buyer term it depends on is unchanged (the executor re-checks the invoice amount before it takes the offer over).
  const entries = (auth.terms as PlanTerms).entries;
  const newKeys = new Set(made.view.levers.map((l) => canonicalize(l)));
  const buyerSame = (() => {
    const oldBuyer = entries.find((e) => e.lever.kind === "buyer_request_deposit")?.lever;
    const newBuyer = made.view.levers.find((l) => l.kind === "buyer_request_deposit");
    return (oldBuyer ? canonicalize(oldBuyer) : null) === (newBuyer ? canonicalize(newBuyer) : null);
  })();
  const heldBranches = (outcome.branches ?? []).filter((b) => (b.status === "agreed" || b.status === "offered") && !b.withdrawn && !b.adopted);
  const keepIndexes: number[] = [];
  const kept: Kept[] = [];
  for (const b of heldBranches) {
    const lever = entries.find((e) => e.index === b.index)?.lever;
    if (!lever || !newKeys.has(canonicalize(lever))) continue;
    if (lever.kind === "finance_invoice" && !buyerSame) continue;
    keepIndexes.push(b.index);
    kept.push({ kind: lever.kind, counterpartyId: lever.counterpartyId });
  }
  const keptKeys = new Set(kept.map((k) => `${k.kind}:${k.counterpartyId}`));
  const askedAgain: Kept[] = made.view.levers.filter((l) => !keptKeys.has(`${l.kind}:${l.counterpartyId}`)).map((l) => ({ kind: l.kind, counterpartyId: l.counterpartyId }));
  if (!commit) return { ok: true, committed: false, plan: made.view, newRunId: null, round, constraints, kept, askedAgain };

  const released = await releaseHeld(db, authorisationId, { keepIndexes });
  if (!released.ok) throw new ActionError("refused", "A held agreement that you changed could not be withdrawn; nothing was revised");

  const [child] = await db.insert(agentRuns).values({
    businessId, trigger: run.trigger, status: "completed", model: "owner", mode: "owner", planSource: "owner", finishedAt: new Date(),
    parentRunId: run.id, round, constraints: JSON.parse(JSON.stringify(constraints)),
  }).returning({ id: agentRuns.id });
  await db.insert(agentSteps).values([
    { businessId, runId: child.id, seq: 1, kind: "note", payload: { type: "do_nothing", metrics: toJsonValue(doNothingSummary(ctx)) } },
    { businessId, runId: child.id, seq: 2, kind: "note", payload: { type: "owner_revision", round } },
  ]);
  await db.insert(plans).values({ businessId, runId: child.id, planHash: made.view.id, rank: 1, plan: toJsonValue(made.view) as Record<string, unknown> });
  await db.update(agentRuns).set({ lifecycle: "replanned", successorRunId: child.id }).where(eq(agentRuns.id, run.id));
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.PLAN_REPLANNED, actor: "owner",
    detail: { authorisationId, parentRunId: run.id, newRunId: child.id, round, by: "owner", constraints, planIds: [made.view.id], editedLevers: made.view.levers, metrics: made.view.metrics, noteLengths: Object.fromEntries(Object.entries(made.ownerNotes).map(([k, v]) => [k, v.length])), kept, askedAgain },
  });
  return { ok: true, committed: true, plan: made.view, newRunId: child.id, round, constraints, kept, askedAgain };
}
