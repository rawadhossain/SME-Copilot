// Step 3: execute an approved action. The ONLY code (with the bank tick below) that calls sandbox write operations.
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { actionProposals, approvals, sandboxBankAccounts } from "@/db/schema";
import { evaluate, requestSchema, verifyApprovalSignature, type GateRequest } from "@/gate";
import { acceptApplicationOffer, cancelPayment, cancelReceipt, executeDuePayments, executeDueReceipts, schedulePayment, scheduleReceipt, sendProposal, submitApplication, withdrawApplication, withdrawThread } from "@/sandbox";
import { toJsonValue } from "@/sandbox/proposals";
import { appendRecord } from "./log";
import { authorisationCovers, checkAuthorisationCurrent, checkAuthorisationIntegrity, createdByAuthorisation } from "./plan-authority";
import { isExpired, payloadHashOf } from "./propose";
import { loadGateState, loadSignedMandate, needsProjection, worldDate } from "./state";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

async function refuse(db: Db, businessId: string, proposalId: string, reason: string, extra: Record<string, unknown> = {}): Promise<never> {
  await appendRecord(db, { businessId, proposalId, event: ACTION_EVENTS.EXECUTION_REFUSED, actor: "system", detail: { reason, ...extra } });
  throw new ActionError("refused", reason, extra);
}

async function bankBalance(db: Db, businessId: string): Promise<bigint> {
  const [b] = await db.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.businessId, businessId)).orderBy(asc(sandboxBankAccounts.name)).limit(1);
  return b?.balanceMinor ?? 0n;
}

export async function executeAction(db: Db, proposalIdInput: string): Promise<{ proposalId: string; result: Record<string, unknown> }> {
  const proposalId = z.string().uuid().parse(proposalIdInput);
  const [proposal] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
  if (!proposal) throw new ActionError("not_found", "Unknown action");
  const businessId = proposal.businessId;

  if (proposal.status === "executed" || proposal.status === "executing" || proposal.status === "verified" || proposal.status === "verification_failed") {
    return refuse(db, businessId, proposalId, `Action is already ${proposal.status}; an approval can be used once`);
  }
  if (proposal.status !== "approved") return refuse(db, businessId, proposalId, `Action is ${proposal.status}; only an approved action can be executed`);

  // Read and draft actions are allowed without an approval and have no side effects.
  const request: GateRequest = requestSchema.parse(proposal.payload);
  if (request.kind === "read.state" || request.kind === "draft.message") {
    await db.update(actionProposals).set({ status: "executed", result: { note: "no side effects" } }).where(eq(actionProposals.id, proposalId));
    await appendRecord(db, { businessId, proposalId, event: ACTION_EVENTS.EXECUTED, actor: "system", detail: { note: "read/draft action, no side effects" } });
    return { proposalId, result: { note: "no side effects" } };
  }

  const asOf = await worldDate(db, businessId);
  const payloadOk = payloadHashOf(proposal.payload) === proposal.payloadHash;
  if (!payloadOk) return refuse(db, businessId, proposalId, "The action payload no longer matches the payload that was approved or authorised", { currentHash: payloadHashOf(proposal.payload) });
  let approval: typeof approvals.$inferSelect | null = null;
  let authority: { authorisationId: string; confirmations: 1 | 2 } | null = null;

  if (request.kind === "sandbox.withdraw") {
    // Compensation (ADR-017): needs no approval and no mandate, but may only undo what this plan authorisation's own actions created.
    if (!proposal.authorisationId || !(await createdByAuthorisation(db, proposal.authorisationId, request.target, request.id))) {
      return refuse(db, businessId, proposalId, "A withdrawal is only available as compensation for something a plan authorisation created");
    }
    const integrity = await checkAuthorisationIntegrity(db, proposal.authorisationId);
    if (!integrity.ok) return refuse(db, businessId, proposalId, integrity.reason);
    const g = evaluate(await loadSignedMandate(db, businessId), await loadGateState(db, businessId), request);
    if (g.decision !== "allow") return refuse(db, businessId, proposalId, `The gate does not permit this withdrawal: ${g.reasons.join("; ")}`, { gate: g });
    authority = { authorisationId: proposal.authorisationId, confirmations: 1 };
  } else if (proposal.authorisationId) {
    // Authority from the owner-signed plan authorisation (ADR-016): signature, expiry, mandate version and hash, coverage.
    const cur = await checkAuthorisationCurrent(db, proposal.authorisationId);
    if (!cur.ok) return refuse(db, businessId, proposalId, cur.reason);
    const notCovered = await authorisationCovers(db, cur.auth, cur.terms, request);
    if (notCovered) return refuse(db, businessId, proposalId, notCovered);
    authority = { authorisationId: cur.auth.id, confirmations: cur.terms.confirmations ?? 1 };
  } else {
    // Approval binding: exact payload, owner signature, single use, not expired.
    const [found] = await db.select().from(approvals).where(and(eq(approvals.businessId, businessId), eq(approvals.proposalId, proposalId))).orderBy(desc(approvals.createdAt)).limit(1);
    if (!found) return refuse(db, businessId, proposalId, "No approval exists for this action");
    approval = found;
    if (approval.usedAt) return refuse(db, businessId, proposalId, "This approval was already used");
    if (isExpired(asOf, approval.expiresAt)) {
      await db.update(actionProposals).set({ status: "expired" }).where(eq(actionProposals.id, proposalId));
      return refuse(db, businessId, proposalId, "The approval expired");
    }
    if (approval.payloadHash !== proposal.payloadHash) {
      return refuse(db, businessId, proposalId, "The action payload no longer matches the payload the owner approved", { approvedHash: approval.payloadHash, currentHash: payloadHashOf(proposal.payload) });
    }
    if (!verifyApprovalSignature({ proposalId, payloadHash: approval.payloadHash, confirmations: approval.confirmations as 1 | 2 }, approval.signed)) {
      return refuse(db, businessId, proposalId, "The approval signature is invalid");
    }
  }

  // Re-run the gate against the situation right now (withdrawals were checked above).
  if (request.kind !== "sandbox.withdraw") {
    const gate = evaluate(await loadSignedMandate(db, businessId), await loadGateState(db, businessId, { projection: needsProjection(request.kind) }), request);
    if (gate.decision !== "needs_approval") return refuse(db, businessId, proposalId, `The gate no longer permits this action: ${gate.reasons.join("; ")}`, { gate });
    if (gate.requiresSecondConfirmation && (approval ? approval.confirmations : authority?.confirmations) !== 2) return refuse(db, businessId, proposalId, "This amount needs two confirmations");
  }

  // Claim the approval (single use) and the action atomically.
  const claimed = await db.transaction(async (tx) => {
    if (approval) {
      const used = await tx.update(approvals).set({ usedAt: sql`now()` }).where(and(eq(approvals.id, approval.id), isNull(approvals.usedAt))).returning({ id: approvals.id });
      if (used.length === 0) return false;
    }
    const moved = await tx.update(actionProposals).set({ status: "executing" }).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.status, "approved"))).returning({ id: actionProposals.id });
    return moved.length === 1;
  });
  if (!claimed) return refuse(db, businessId, proposalId, "This approval was already used");

  const before = await bankBalance(db, businessId);
  try {
    let result: Record<string, unknown>;
    const key = `act-${proposalId}`;
    switch (request.kind) {
      case "sandbox.send_proposal": {
        const r = await sendProposal(db, businessId, request.counterpartyId, toJsonValue(request.proposal));
        result = { outboundMessageId: r.outboundMessageId, inboundMessageId: r.inboundMessageId, threadId: r.threadId, threadStatus: r.threadStatus, outcome: r.response.outcome, terms: r.response.terms };
        break;
      }
      case "sandbox.schedule_payment": {
        const r = await schedulePayment(db, businessId, request.payeeId, request.amountMinor, request.currency, request.scheduledFor, key);
        // A plan-authorised payment stays scheduled until the bank's own end-of-day job, so that it can still be withdrawn (ADR-019).
        const exec = request.scheduledFor <= asOf && !authority?.authorisationId ? await executeDuePayments(db, businessId, asOf) : null;
        result = { paymentId: r.payment.id, reference: r.payment.reference, scheduledFor: request.scheduledFor, executedNow: exec ? exec.executed.map((e) => e.id).includes(r.payment.id) : false, failures: exec ? exec.failed : [] };
        break;
      }
      case "sandbox.submit_application": {
        const r = await submitApplication(db, businessId, request.lenderId, request.invoiceAmountMinor, request.advanceBps, key);
        result = { applicationId: r.application.id, reference: r.application.reference, status: r.application.status };
        break;
      }
      case "sandbox.cancel_payment": {
        const r = await cancelPayment(db, businessId, request.paymentId);
        result = { paymentId: r.payment.id, status: r.payment.status };
        break;
      }
      case "sandbox.schedule_receipt": {
        const r = await scheduleReceipt(db, businessId, request.counterpartyId, request.amountMinor, request.currency, request.expectedOn, request.backingType, request.backingId, key);
        result = { receiptId: r.receipt.id, reference: r.receipt.reference, expectedOn: request.expectedOn, status: r.receipt.status };
        break;
      }
      case "sandbox.accept_offer": {
        const r = await acceptApplicationOffer(db, businessId, request.applicationId);
        result = { applicationId: r.application.id, reference: r.application.reference, status: r.application.status };
        break;
      }
      case "sandbox.withdraw": {
        if (request.target === "thread") {
          const r = await withdrawThread(db, businessId, request.id);
          result = { target: "thread", threadId: r.thread.id, status: r.thread.status };
        } else if (request.target === "application") {
          const r = await withdrawApplication(db, businessId, request.id);
          result = { target: "application", applicationId: r.application.id, status: r.application.status };
        } else if (request.target === "payment") {
          const r = await cancelPayment(db, businessId, request.id);
          result = { target: "payment", paymentId: r.payment.id, status: r.payment.status };
        } else {
          const r = await cancelReceipt(db, businessId, request.id);
          result = { target: "receipt", receiptId: r.receipt.id, status: r.receipt.status };
        }
        break;
      }
      default:
        throw new ActionError("invalid", "Unsupported action kind");
    }
    const after = await bankBalance(db, businessId);
    const full = { ...result, bankBalanceBeforeMinor: before.toString(), bankBalanceAfterMinor: after.toString() };
    await db.update(actionProposals).set({ status: "executed", result: toJsonValue(full) as Record<string, unknown> }).where(eq(actionProposals.id, proposalId));
    await appendRecord(db, { businessId, proposalId, event: ACTION_EVENTS.EXECUTED, actor: "system", detail: { approvalId: approval?.id ?? null, authorisationId: authority?.authorisationId ?? null, ...full } });
    return { proposalId, result: full };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Execution failed";
    await db.update(actionProposals).set({ status: "failed", result: { error: message } }).where(eq(actionProposals.id, proposalId));
    await appendRecord(db, { businessId, proposalId, event: ACTION_EVENTS.EXECUTION_FAILED, actor: "system", detail: { error: message } });
    throw new ActionError("refused", `Execution failed: ${message}`);
  }
}

/**
 * The bank's own end-of-day run: executes payments that already passed the pipeline (they are only ever scheduled by
 * executeAction) and are due on or before asOf. Not an agent action.
 */
export async function runBankTick(db: Db, businessId: string, asOf: string) {
  // Money in first (the bank credits what is due), then money out, so a payment can use a receipt of the same day.
  const incoming = await executeDueReceipts(db, businessId, asOf);
  const summary = await executeDuePayments(db, businessId, asOf);
  await appendRecord(db, { businessId, event: ACTION_EVENTS.BANK_TICK, actor: "system", detail: { asOf, received: incoming.received.length, executed: summary.executed.length, failed: summary.failed.length, balanceMinor: summary.balanceMinor } });
  return summary;
}
