// WHAT COUNTERPARTIES HAVE ALREADY TOLD US. Constraints are learned from structured replies (a refusal, a cap, a floor, a longest deferral, a quoted
// fee) and until now lived only along one re-plan chain, so a fresh shortage run could propose exactly what was refused last week. This reads them
// back from the stored runs and executions (the same records, no second store) and returns the ones still worth trusting.
//
// A constraint is dropped when it is older than the window (counterparties change their minds; the planner then asks again) or when a live
// agreement for the same kind of term now exists with that counterparty. Everything here is a fact the counterparty stated; nothing is inferred.
import { and, eq, gte, inArray } from "drizzle-orm";
import { agentRuns, planAuthorisations, planExecutions, sandboxThreads } from "@/db/schema";
import { constraintSchema, mergeConstraints, type Constraint } from "@/domain/constraints";
import type { LeverKind } from "@/domain/plan";
import type { Db } from "./types";

/** How long a stated limit or refusal is trusted (days). Overridable for tests and operations. */
export const KNOWN_CONSTRAINT_DAYS = Number(process.env.KNOWN_CONSTRAINT_DAYS ?? 30);

export const TOPIC: Partial<Record<LeverKind, string>> = {
  supplier_reduce_deposit: "supplier.reduce_deposit",
  supplier_defer_balance: "supplier.defer_balance",
  buyer_request_deposit: "buyer.request_deposit",
  chase_overdue: "buyer.chase_payment",
  early_payment_discount: "buyer.request_early_payment",
};

export async function loadKnownConstraints(db: Db, businessId: string, nowMs: number = Date.now(), days: number = KNOWN_CONSTRAINT_DAYS): Promise<Constraint[]> {
  const cutoff = new Date(nowMs - days * 86_400_000);
  const runs = await db.select().from(agentRuns).where(and(eq(agentRuns.businessId, businessId), gte(agentRuns.startedAt, cutoff)));
  if (runs.length === 0) return [];
  const lists: unknown[][] = runs.map((r) => (Array.isArray(r.constraints) ? (r.constraints as unknown[]) : []));
  const auths = await db.select({ id: planAuthorisations.id }).from(planAuthorisations).where(inArray(planAuthorisations.runId, runs.map((r) => r.id)));
  if (auths.length > 0) {
    const execs = await db.select({ outcome: planExecutions.outcome }).from(planExecutions).where(inArray(planExecutions.authorisationId, auths.map((a) => a.id)));
    for (const e of execs) {
      const c = (e.outcome as { constraints?: unknown } | null)?.constraints;
      if (Array.isArray(c)) lists.push(c);
    }
  }
  const valid: Constraint[][] = lists.map((l) => l.flatMap((x) => { const p = constraintSchema.safeParse(x); return p.success ? [p.data] : []; }));
  const merged = mergeConstraints(...valid);
  if (merged.length === 0) return [];
  const live = await db.select().from(sandboxThreads).where(and(eq(sandboxThreads.businessId, businessId), eq(sandboxThreads.status, "agreed")));
  return merged.filter((c) => !live.some((t) => t.counterpartyId === c.counterpartyId && t.topic === TOPIC[c.kind]));
}
