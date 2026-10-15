// OWNER CONSOLE: the manual console acts as the owner with a pre-approval. It uses the same pipeline: propose, gate,
// approve (owner), execute, verify. It bypasses nothing: a denied action stays denied. Imports approve.ts, so only
// owner-facing API routes may import this file.
import { executeAction } from "./execute";
import { approveAction } from "./approve";
import { proposeAction } from "./propose";
import { verifyAction } from "./verify";
import { ActionError, type Db } from "./types";

export async function runAsOwner(db: Db, businessId: string, request: unknown, idempotencyKey: string) {
  const proposed = await proposeAction(db, businessId, request, idempotencyKey, "owner");
  const steps: string[] = ["proposed"];
  const gate = proposed.gate;
  if (gate.decision === "deny") return { proposalId: proposed.proposal.id, status: proposed.proposal.status, gate, steps, result: null, verification: null };
  if (proposed.duplicate && proposed.proposal.status !== "proposed" && proposed.proposal.status !== "approved") {
    return { proposalId: proposed.proposal.id, status: proposed.proposal.status, gate, steps: ["already processed"], result: proposed.proposal.result, verification: null };
  }
  if (proposed.proposal.status === "proposed") {
    const approved = await approveAction(db, proposed.proposal.id, "owner (manual console)", gate.requiresSecondConfirmation ? 2 : 1);
    if (approved.expired) throw new ActionError("conflict", "Action expired");
    steps.push("approved");
  }
  const executed = await executeAction(db, proposed.proposal.id);
  steps.push("executed");
  const verification = await verifyAction(db, proposed.proposal.id);
  steps.push(verification.ok ? "verified" : "verification_failed");
  return { proposalId: proposed.proposal.id, status: verification.status, gate, steps, result: executed.result, verification };
}
