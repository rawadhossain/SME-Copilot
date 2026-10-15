// Read-only view of a plan authorisation: status, the execution outcome, every action it caused (with its log timeline),
// the plan-level log records and the verification. Nothing here writes. Counterparty free text is not included.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { actionProposals, actionRecords, agentRuns, planAuthorisations, planExecutions } from "@/db/schema";
import { toJsonValue } from "@/sandbox/proposals";
import { checkAuthorisationIntegrity } from "./plan-authority";
import type { Db } from "./types";

export async function getPlanAuthorisation(db: Db, idInput: string) {
  const id = z.string().uuid().parse(idInput);
  const [auth] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, id));
  if (!auth) return null;
  const [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, id));
  const actions = await db.select().from(actionProposals).where(and(eq(actionProposals.businessId, auth.businessId), eq(actionProposals.authorisationId, id))).orderBy(asc(actionProposals.createdAt));
  const records = await db.select().from(actionRecords).where(eq(actionRecords.businessId, auth.businessId)).orderBy(asc(actionRecords.chainSeq));
  const actionIds = new Set(actions.map((a) => a.id));
  const trail = records.filter((r) => (r.proposalId && actionIds.has(r.proposalId)) || (r.event.startsWith("plan.") && (r.detail as { authorisationId?: string } | null)?.authorisationId === id));
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, auth.runId));
  const integrity = await checkAuthorisationIntegrity(db, id);
  const { signature, ...authView } = auth;
  return toJsonValue({
    // Run status: planned | needs_replan | replanned (successorRunId) | exhausted | executed | verification_failed
    run: run ? { id: run.id, lifecycle: run.lifecycle, round: run.round, parentRunId: run.parentRunId, successorRunId: run.successorRunId, constraints: run.constraints } : null,
    authorisation: { ...authView, signed: !!signature, integrity: integrity.ok ? "ok" : integrity.reason },
    execution: exec ?? null,
    actions: actions.map((a) => ({ id: a.id, kind: a.kind, status: a.status, payload: a.payload, gateResult: a.gateResult, result: a.result, idempotencyKey: a.idempotencyKey })),
    trail: trail.map((r) => ({ chainSeq: r.chainSeq, event: r.event, actor: r.actor, proposalId: r.proposalId, verification: r.verification, detail: r.detail, createdAt: r.createdAt })),
  });
}
