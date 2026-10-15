// Cancel an action. Reversible only: an action that has not executed, or a payment that is scheduled but not yet
// executed. An executed payment is irreversible (it needs the second confirmation above the threshold for that reason).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { actionProposals, sandboxPayments } from "@/db/schema";
import { cancelPayment } from "@/sandbox";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export async function cancelAction(db: Db, proposalIdInput: string, cancelledBy: string) {
  const proposalId = z.string().uuid().parse(proposalIdInput);
  const [proposal] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
  if (!proposal) throw new ActionError("not_found", "Unknown action");
  const businessId = proposal.businessId;

  if (proposal.status === "proposed" || proposal.status === "approved") {
    await db.update(actionProposals).set({ status: "cancelled" }).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.status, proposal.status)));
    await appendRecord(db, { businessId, proposalId, event: ACTION_EVENTS.CANCELLED, actor: "owner", detail: { cancelledBy, was: proposal.status, note: "cancelled before execution" } });
    return { proposalId, status: "cancelled" as const, reversed: false };
  }

  if (proposal.kind === "sandbox.schedule_payment" && (proposal.status === "executed" || proposal.status === "verified" || proposal.status === "verification_failed")) {
    const [pay] = await db.select().from(sandboxPayments).where(and(eq(sandboxPayments.businessId, businessId), eq(sandboxPayments.idempotencyKey, `act-${proposalId}`)));
    if (!pay) throw new ActionError("not_found", "No payment found for this action");
    if (pay.status !== "scheduled") throw new ActionError("conflict", `Payment is ${pay.status}; an executed payment is irreversible and cannot be cancelled`);
    await cancelPayment(db, businessId, pay.id);
    await db.update(actionProposals).set({ status: "cancelled" }).where(eq(actionProposals.id, proposalId));
    await appendRecord(db, { businessId, proposalId, event: ACTION_EVENTS.CANCELLED, actor: "owner", detail: { cancelledBy, paymentId: pay.id, note: "scheduled payment cancelled before it executed" } });
    return { proposalId, status: "cancelled" as const, reversed: true };
  }

  throw new ActionError("conflict", `Action is ${proposal.status}; it cannot be cancelled (only unexecuted actions and scheduled payments are reversible)`);
}
