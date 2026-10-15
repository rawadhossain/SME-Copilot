// Step 1 of the pipeline: validate, run the gate, store the proposal, log it.
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { actionProposals, actionRecords } from "@/db/schema";
import { canonicalize, evaluate, requestSchema, type GateRequest, type GateResult } from "@/gate";
import { toJsonValue } from "@/sandbox/proposals";
import { appendRecord } from "./log";
import { loadGateState, loadSignedMandate, needsProjection } from "./state";
import { ACTION_EVENTS, ActionError, type Db, type ProposalStatus } from "./types";

/** Proposal and approval lifetime in world-time hours (config: PROPOSAL_TTL_HOURS, default 24). */
export const proposalTtlHours = (): number => {
  const n = Number(process.env.PROPOSAL_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
};

/** An action expires when the world date (midnight UTC) reaches its expiry time. */
export const isExpired = (asOf: string, expiresAt: Date): boolean => new Date(`${asOf}T00:00:00Z`).getTime() >= expiresAt.getTime();
const keySchema = z.string().trim().min(1).max(100);

export const payloadHashOf = (payload: unknown): string => createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");

/** Gate result as stored (money-free except limitsChecked strings), JSON-safe. */
export const gateJson = (g: GateResult) => toJsonValue(g) as Record<string, unknown>;

export async function proposeAction(db: Db, businessId: string, requestInput: unknown, idempotencyKeyInput: string, createdBy: "agent" | "owner", opts: { authorisationId?: string } = {}) {
  const idempotencyKey = keySchema.parse(idempotencyKeyInput);
  const parsed = requestSchema.safeParse(requestInput);
  if (!parsed.success) throw new ActionError("invalid", "Invalid action request", parsed.error.issues);
  let request: GateRequest = parsed.data;

  return db.transaction(async (tx) => {
    const state = await loadGateState(tx, businessId, { projection: needsProjection(request.kind) });
    // Bind the payee's current bank details to the payment, so a later change invalidates the approval.
    if (request.kind === "sandbox.schedule_payment" && !request.payeeBankDetailsHash) {
      const payee = state.payees[request.payeeId];
      if (payee) request = { ...request, payeeBankDetailsHash: payee.bankDetailsHash };
    }
    const payload = toJsonValue(request) as Record<string, unknown>;
    const payloadHash = payloadHashOf(payload);

    const [existing] = await tx.select().from(actionProposals).where(and(eq(actionProposals.businessId, businessId), eq(actionProposals.idempotencyKey, idempotencyKey)));
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new ActionError("conflict", "Idempotency key already used with a different action");
      return { proposal: existing, gate: existing.gateResult as unknown as GateResult, duplicate: true };
    }

    const mandate = await loadSignedMandate(tx, businessId);
    const gate = evaluate(mandate, state, request);
    const status: ProposalStatus = gate.decision === "deny" ? "denied" : gate.decision === "allow" ? "approved" : "proposed";
    const [proposal] = await tx
      .insert(actionProposals)
      .values({
        businessId, kind: request.kind, payload, payloadHash, status, gateResult: gateJson(gate), idempotencyKey, createdBy, authorisationId: opts.authorisationId ?? null,
        expiresAt: new Date(new Date(`${state.asOf}T00:00:00Z`).getTime() + proposalTtlHours() * 3_600_000),
      })
      .returning();

    await appendRecord(tx, { businessId, proposalId: proposal.id, event: ACTION_EVENTS.PROPOSED, actor: createdBy, detail: { kind: request.kind, payloadHash, payload, idempotencyKey } });
    await appendRecord(tx, { businessId, proposalId: proposal.id, event: ACTION_EVENTS.GATE_DECISION, actor: "gate", detail: { decision: gate.decision, tier: gate.tier, reasons: gate.reasons, limitsChecked: gate.limitsChecked, requiresSecondConfirmation: gate.requiresSecondConfirmation } });
    return { proposal, gate, duplicate: false };
  });
}

/** Timeline of log records for one proposal, in chain order. */
export async function timelineFor(db: Db, businessId: string, proposalId: string) {
  return db.select().from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.proposalId, proposalId))).orderBy(asc(actionRecords.chainSeq));
}
