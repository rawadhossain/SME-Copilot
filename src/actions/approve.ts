// OWNER-ONLY PATH. Signs an approval bound to the exact payload. Imports the owner-signing module, so only owner-facing
// API routes may import this file (src/agent must never: ESLint enforces it).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { actionProposals, approvals } from "@/db/schema";
import { evaluate, requestSchema, type GateResult } from "@/gate";
import { signApproval } from "@/gate/owner-signing";
import { appendRecord } from "./log";
import { gateJson, isExpired, payloadHashOf } from "./propose";
import { loadGateState, loadSignedMandate, needsProjection } from "./state";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

const approverSchema = z.string().trim().min(1).max(100);

export async function approveAction(db: Db, proposalId: string, approvedByInput: string, confirmationsInput: number) {
  const approvedBy = approverSchema.parse(approvedByInput);
  if (confirmationsInput !== 1 && confirmationsInput !== 2) throw new ActionError("invalid", "confirmations must be 1 or 2");
  const confirmations: 1 | 2 = confirmationsInput;

  return db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(actionProposals).where(eq(actionProposals.id, z.string().uuid().parse(proposalId))).for("update");
    if (!proposal) throw new ActionError("not_found", "Unknown action");
    if (proposal.status !== "proposed") throw new ActionError("conflict", `Action is ${proposal.status}; only a proposed action can be approved`);
    // The payload must still match its hash (nobody edited it after it was proposed).
    if (payloadHashOf(proposal.payload) !== proposal.payloadHash) throw new ActionError("refused", "Stored payload does not match its hash; refusing to approve");

    const state = await loadGateState(tx, proposal.businessId, { projection: needsProjection(String((proposal.payload as { kind?: string }).kind)) });
    if (isExpired(state.asOf, proposal.expiresAt)) {
      await tx.update(actionProposals).set({ status: "expired" }).where(eq(actionProposals.id, proposal.id));
      await appendRecord(tx, { businessId: proposal.businessId, proposalId: proposal.id, event: ACTION_EVENTS.EXPIRED, actor: "system", detail: { expiredOn: proposal.expiresAt } });
      return { expired: true as const };
    }
    // Re-run the gate: the situation may have changed since it was proposed.
    const gate: GateResult = evaluate(await loadSignedMandate(tx, proposal.businessId), state, requestSchema.parse(proposal.payload));
    if (gate.decision !== "needs_approval") throw new ActionError("refused", `The gate no longer permits this action: ${gate.reasons.join("; ")}`, gate);
    if (gate.requiresSecondConfirmation && confirmations !== 2) throw new ActionError("refused", "This amount needs two confirmations");

    const signed = signApproval({ proposalId: proposal.id, payloadHash: proposal.payloadHash, confirmations });
    const [approval] = await tx
      .insert(approvals)
      .values({ businessId: proposal.businessId, proposalId: proposal.id, payloadHash: proposal.payloadHash, confirmations, approvedBy, signed, expiresAt: proposal.expiresAt })
      .returning();
    await tx.update(actionProposals).set({ status: "approved", gateResult: gateJson(gate) }).where(eq(actionProposals.id, proposal.id));
    await appendRecord(tx, { businessId: proposal.businessId, proposalId: proposal.id, event: ACTION_EVENTS.APPROVED, actor: "owner", detail: { approvalId: approval.id, approvedBy, confirmations, payloadHash: proposal.payloadHash } });
    return { expired: false as const, approval, gate };
  });
}
