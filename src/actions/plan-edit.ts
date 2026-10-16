// OWNER PLAN EDITS (Batch 13, step 1). The owner changes the lever parameters of a stored plan; NO model is involved. The edited levers
// go through the same pure path as every other plan (buildPlanView: catalogue and mandate bounds, learned constraints, engine metrics,
// gate dry-run), so every number the owner sees is recomputed by code. Preview writes nothing; commit stores the result as a new plan in
// the SAME run (source "owner", editedFrom = the base plan) and logs plan.edited. Signing and execution then work unchanged.
// This file never signs anything and never imports the owner-signing module.
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import { buildPlanView, type AgentToolContext } from "@/agent";
import { agentRuns, plans } from "@/db/schema";
import type { Constraint } from "@/domain/constraints";
import { contingencySchema, leverSchema, planId, type Contingency, type Lever, type PlanView } from "@/domain/plan";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext } from "./agent-run";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export const editPlanInputSchema = z.object({
  runId: z.string().uuid(),
  /** The plan the owner started from (its id in this run). */
  basePlanId: z.string().min(1).max(64),
  /** The complete lever set after the edit (1 to 6, one per kind). */
  levers: z.array(leverSchema).min(1).max(6),
  /** The owner's own notes per counterparty id (plain text, up to 300 characters). Kept with the plan; counterparties get structured terms only. */
  notes: z.record(z.string().uuid(), z.string().max(300)).default({}),
  /** false (default): preview only, nothing written. true: store the plan so it can be signed. */
  commit: z.boolean().default(false),
});
export type EditPlanInput = z.input<typeof editPlanInputSchema>;

export type EditPlanResult =
  | { ok: true; committed: boolean; plan: PlanView; unchanged: boolean }
  | { ok: false; reasons: string[] };

const EDIT_TITLE = "Your adjusted plan";
const EDIT_RATIONALE = "You adjusted the terms of another plan. Every figure on this card was recomputed by the engine and every term was checked against your signed limits.";

export type OwnerViewResult = { ok: true; view: PlanView; ownerNotes: Record<string, string> } | { ok: false; reasons: string[] };

/** Validates owner-chosen levers against the context (limits, learned constraints) and recomputes the plan. Pure with respect to ctx. */
export function makeOwnerView(ctx: AgentToolContext, basePlan: unknown, basePlanId: string, levers: Lever[], notes: Record<string, string>): OwnerViewResult {
  // Contingencies of the base plan are kept where they still make sense: "if lever X is refused" survives when a lever of the same
  // kind is still in the edited set, and its fallback levers are still valid. Anything else is dropped (flagged on the plan).
  const baseLevers = ((basePlan as { levers?: { kind: string }[] }).levers ?? []);
  const baseContingencies = z.array(contingencySchema).safeParse((basePlan as { contingencies?: unknown }).contingencies);
  const carried: Contingency[] = [];
  if (baseContingencies.success) {
    for (const c of baseContingencies.data) {
      const idx = levers.findIndex((l) => l.kind === baseLevers[c.ifRefusedLeverIndex]?.kind);
      if (idx >= 0) carried.push({ ...c, ifRefusedLeverIndex: idx });
    }
  }
  const mk = (contingencies: Contingency[]) => buildPlanView(ctx, { title: EDIT_TITLE, levers, contingencies, rationale: EDIT_RATIONALE }, "owner");
  let built = mk(carried);
  if (!built.ok && carried.length > 0) built = mk([]);
  if (!built.ok) return { ok: false, reasons: built.reasons };
  if (built.view.blockers?.length) return { ok: false, reasons: built.view.blockers };
  const known = new Set(ctx.counterparties.map((c) => c.id));
  const ownerNotes: Record<string, string> = {};
  for (const [cpId, text] of Object.entries(notes)) {
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!clean) continue;
    if (!known.has(cpId)) throw new ActionError("invalid", "A note refers to an unknown counterparty");
    ownerNotes[cpId] = clean;
  }
  const view: PlanView = {
    ...built.view, editedFrom: basePlanId,
    ...(Object.keys(ownerNotes).length ? { ownerNotes } : {}),
    ...(baseContingencies.success && baseContingencies.data.length > 0 && built.view.contingencies.length < baseContingencies.data.length ? { contingenciesDropped: true } : {}),
  };

  return { ok: true, view, ownerNotes };
}

export async function editPlan(db: Db, businessId: string, input: unknown): Promise<EditPlanResult> {
  const { runId, basePlanId, levers, notes, commit } = editPlanInputSchema.parse(input);
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.businessId, businessId)));
  if (!run) throw new ActionError("not_found", "Unknown agent run for this business");
  const [base] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId), eq(plans.planHash, basePlanId)));
  if (!base) throw new ActionError("not_found", "Unknown base plan in this run");
  if (run.lifecycle === "replanned" || run.lifecycle === "executed") throw new ActionError("conflict", "This run was already replaced or executed; edit a plan from the latest run");

  const ctx = await buildContext(db, businessId, null, (run.constraints ?? []) as Constraint[]);
  const made = makeOwnerView(ctx, base.plan, basePlanId, levers, notes);
  if (!made.ok) return { ok: false, reasons: made.reasons };
  const { view, ownerNotes } = made;

  // The same levers as an existing plan in this run is not a new plan: return that one.
  const [existing] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId), eq(plans.planHash, view.id)));
  if (existing) {
    const ex = existing.plan as unknown as PlanView;
    if (Object.keys(ownerNotes).length > 0 && ex.source !== "owner") return { ok: false, reasons: [`These terms are the same as one of the original plans, which cannot carry your notes. Change a term, or sign that plan as it is.`] };
    if (commit && ex.source === "owner" && JSON.stringify(ex.ownerNotes ?? {}) !== JSON.stringify(ownerNotes)) {
      await db.update(plans).set({ plan: toJsonValue({ ...ex, ...(Object.keys(ownerNotes).length ? { ownerNotes } : { ownerNotes: undefined }) }) as Record<string, unknown> }).where(eq(plans.id, existing.id));
      await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_EDITED, actor: "owner", detail: { runId, basePlanId, planId: view.id, notesChanged: true, noteLengths: Object.fromEntries(Object.entries(ownerNotes).map(([k, v]) => [k, v.length])) } });
      return { ok: true, committed: true, plan: { ...ex, ownerNotes }, unchanged: false };
    }
    return { ok: true, committed: false, plan: ex, unchanged: true };
  }
  if (!commit) return { ok: true, committed: false, plan: view, unchanged: false };

  if (planId(view.levers) !== view.id) throw new ActionError("refused", "The edited plan id does not match its levers");
  const [{ top }] = await db.select({ top: max(plans.rank) }).from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId)));
  await db.insert(plans).values({ businessId, runId, planHash: view.id, rank: (top ?? 0) + 1, plan: toJsonValue(view) as Record<string, unknown> });
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.PLAN_EDITED, actor: "owner",
    detail: { runId, basePlanId, planId: view.id, baseLevers: (base.plan as { levers?: unknown }).levers, editedLevers: view.levers, metrics: view.metrics, contingenciesDropped: view.contingenciesDropped ?? false, noteLengths: Object.fromEntries(Object.entries(ownerNotes).map(([k, v]) => [k, v.length])) },
  });
  return { ok: true, committed: true, plan: view, unchanged: false };
}
