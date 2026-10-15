// Step 4: independent verification. This module does NOT import the executor. It reads the sandbox tables and the
// log, and re-checks what happened against what the owner approved and against the mandate. It trusts nothing the
// executor said except as a claim to compare with the facts.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  actionProposals, actionRecords, approvals, sandboxApplications, sandboxMessages, sandboxPayees, sandboxPayments, sandboxReceipts, sandboxThreads,
} from "@/db/schema";
import { canonicalize, checkSignedMandate, requestSchema, verifyApprovalSignature } from "@/gate";
import { toJsonValue } from "@/sandbox/proposals";
import { appendRecord } from "./log";
import { authorisationCovers, checkAuthorisationIntegrity } from "./plan-authority";
import { loadSignedMandate } from "./state";
import { ACTION_EVENTS, ActionError, type Db } from "./types";
import { createHash } from "node:crypto";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const hashOf = (payload: unknown) => createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");

export async function verifyAction(db: Db, proposalIdInput: string) {
  const proposalId = z.string().uuid().parse(proposalIdInput);
  const [proposal] = await db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
  if (!proposal) throw new ActionError("not_found", "Unknown action");
  if (!["executed", "verified", "verification_failed"].includes(proposal.status)) {
    throw new ActionError("conflict", `Action is ${proposal.status}; only an executed action can be verified`);
  }
  const businessId = proposal.businessId;
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const request = requestSchema.parse(proposal.payload);

  // Common: payload intact, approval valid and used, exactly one execution record.
  check("payload_hash", hashOf(proposal.payload) === proposal.payloadHash, "stored payload still matches its hash");
  if (request.kind !== "read.state" && request.kind !== "draft.message" && request.kind !== "sandbox.withdraw" && proposal.authorisationId) {
    // Authorised by a signed plan (ADR-016): signature and hashes must hold, and the action must be covered by the signed terms.
    const integrity = await checkAuthorisationIntegrity(db, proposal.authorisationId);
    check("plan_authorisation_integrity", integrity.ok, integrity.ok ? "plan authorisation signature, terms and plan hashes verify" : integrity.reason);
    if (integrity.ok) {
      const notCovered = await authorisationCovers(db, integrity.auth, integrity.terms, request);
      check("action_covered_by_authorisation", notCovered === null, notCovered ?? "the action is covered by the signed plan terms");
    }
  } else if (request.kind !== "read.state" && request.kind !== "draft.message" && request.kind !== "sandbox.withdraw") {
    const [approval] = await db.select().from(approvals).where(and(eq(approvals.businessId, businessId), eq(approvals.proposalId, proposalId))).orderBy(asc(approvals.createdAt)).limit(1);
    check("approval_present", !!approval, "an owner approval exists");
    if (approval) {
      check("approval_binding", approval.payloadHash === proposal.payloadHash, "approval covers exactly this payload");
      check("approval_signature", verifyApprovalSignature({ proposalId, payloadHash: approval.payloadHash, confirmations: approval.confirmations as 1 | 2 }, approval.signed), "approval signature verifies with the owner public key");
      check("approval_used_once", approval.usedAt !== null, "approval was consumed by the execution");
    }
  }
  const records = await db.select().from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.proposalId, proposalId), eq(actionRecords.event, ACTION_EVENTS.EXECUTED)));
  check("single_execution_record", records.length === 1, `${records.length} execution record(s) in the log (expected 1)`);
  const claim = (records[0]?.detail ?? {}) as Record<string, unknown>;

  const mandate = checkSignedMandate(await loadSignedMandate(db, businessId));
  if (request.kind !== "sandbox.withdraw") check("mandate_valid", mandate.ok, mandate.ok ? "active mandate signature verifies" : mandate.reason);
  const L = mandate.ok ? mandate.mandate.limits : null;
  const key = `act-${proposalId}`;

  switch (request.kind) {
    case "sandbox.schedule_payment": {
      const rows = await db.select().from(sandboxPayments).where(and(eq(sandboxPayments.businessId, businessId), eq(sandboxPayments.idempotencyKey, key)));
      check("payment_exists_once", rows.length === 1, `${rows.length} payment(s) with this action's key (expected 1)`);
      const p = rows[0];
      if (p) {
        check("payment_payee", p.payeeId === request.payeeId, "paid the approved payee");
        check("payment_amount", p.amountMinor === request.amountMinor, `payment amount ${p.amountMinor} equals approved amount ${request.amountMinor}`);
        check("payment_currency_date", p.currency === request.currency && p.scheduledFor === request.scheduledFor, "currency and date match the approval");
        check("payment_status", p.status === "executed" || p.status === "scheduled", `payment status is ${p.status}`);
        if (p.status === "executed") {
          const before = BigInt((claim.bankBalanceBeforeMinor as string | undefined) ?? "0");
          const after = BigInt((claim.bankBalanceAfterMinor as string | undefined) ?? "0");
          check("bank_debited_exactly_once", before - after === request.amountMinor, `bank went from ${before} to ${after} (debit ${before - after}, approved ${request.amountMinor})`);
        }
        const [payee] = await db.select().from(sandboxPayees).where(eq(sandboxPayees.id, p.payeeId));
        check("payee_known", !!payee && payee.counterpartyId !== null, "payee is a known counterparty");
      }
      if (L) {
        check("within_max_payment", request.amountMinor <= L.maxPaymentMinor, "amount within the per-payment limit");
        check("purpose_not_forbidden", !(L.forbiddenPurposes as string[]).includes(request.purpose), `purpose ${request.purpose} is not forbidden`);
      }
      break;
    }
    case "sandbox.send_proposal": {
      const out = claim.outboundMessageId as string | undefined;
      const inn = claim.inboundMessageId as string | undefined;
      const [o] = out ? await db.select().from(sandboxMessages).where(eq(sandboxMessages.id, out)) : [];
      const [i] = inn ? await db.select().from(sandboxMessages).where(eq(sandboxMessages.id, inn)) : [];
      check("outbound_message_exists", !!o, "outbound message was stored");
      if (o) {
        check("outbound_matches_approval", canonicalize(o.structured) === canonicalize(toJsonValue(request.proposal)), "stored outbound terms equal the approved structured terms");
        check("outbound_counterparty", o.counterpartyId === request.counterpartyId, "sent to the approved counterparty");
      }
      check("inbound_untrusted", !!i && i.untrusted === true && i.direction === "inbound", "the reply is stored as untrusted");
      if (o) {
        const [t] = await db.select().from(sandboxThreads).where(eq(sandboxThreads.id, o.threadId));
        const outcome = ((i?.structured ?? {}) as { outcome?: string }).outcome;
        const expected = outcome === "accept" ? "agreed" : outcome === "reject" || outcome === "decline" ? "rejected" : "countered";
        check("thread_status_consistent", !!t && t.status === expected, `thread status ${t?.status} matches reply outcome ${outcome}`);
      }
      if (L) {
        check("kind_allowed", (L.allowedProposalKinds as string[]).includes(request.proposal.kind), "proposal kind is allowed by the mandate");
        if (request.proposal.kind === "buyer.request_early_payment") check("discount_within_limit", request.proposal.discountBps <= L.maxEarlyPaymentDiscountBps, "discount within the mandate limit");
      }
      break;
    }
    case "sandbox.submit_application": {
      const rows = await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.businessId, businessId), eq(sandboxApplications.idempotencyKey, key)));
      check("application_exists_once", rows.length === 1, `${rows.length} application(s) with this action's key (expected 1)`);
      const a = rows[0];
      if (a) {
        const offer = a.offer as { request?: { advanceBps?: number; invoiceAmountMinor?: string }; response?: { outcome?: string; terms?: { feeBps?: number; advanceBps?: number } | null } } | null;
        check("application_amount", a.requestedAmountMinor === request.invoiceAmountMinor, "requested amount equals the approved amount");
        check("application_advance", offer?.request?.advanceBps === request.advanceBps, "requested advance equals the approved advance");
        check("application_lender", a.lenderId === request.lenderId, "sent to the approved lender");
        check("application_status_consistent", (a.status === "offered") === (offer?.response?.outcome === "offer"), `status ${a.status} matches the lender's ${offer?.response?.outcome}`);
        if (L && offer?.response?.terms) {
          check("offer_fee_within_limit", (offer.response.terms.feeBps ?? 0) <= L.maxFinanceFeeBps, `lender fee ${(offer.response.terms.feeBps ?? 0) / 100}% within the mandate maximum`);
          check("offer_advance_within_limit", (offer.response.terms.advanceBps ?? 0) <= L.maxFinanceAdvanceBps, "offered advance within the mandate maximum");
        }
      }
      break;
    }
    case "sandbox.accept_offer": {
      const [a] = await db.select().from(sandboxApplications).where(eq(sandboxApplications.id, request.applicationId));
      check("offer_taken_up", !!a && a.status === "accepted", `application status is ${a?.status}`);
      if (a && L) {
        const offer = a.offer as { response?: { outcome?: string; terms?: { feeBps?: number; advanceBps?: number } | null } } | null;
        check("offer_fee_within_limit", (offer?.response?.terms?.feeBps ?? 0) <= L.maxFinanceFeeBps, "the lender's fee is within the mandate maximum");
        check("offer_was_an_offer", offer?.response?.outcome === "offer", `the lender's reply was ${offer?.response?.outcome}`);
      }
      break;
    }
    case "sandbox.withdraw": {
      if (request.target === "thread") {
        const [t] = await db.select().from(sandboxThreads).where(eq(sandboxThreads.id, request.id));
        check("thread_withdrawn", !!t && t.status === "withdrawn", `thread status is ${t?.status}`);
      } else if (request.target === "application") {
        const [a] = await db.select().from(sandboxApplications).where(eq(sandboxApplications.id, request.id));
        check("application_withdrawn", !!a && a.status === "withdrawn", `application status is ${a?.status}`);
      } else if (request.target === "payment") {
        const [p] = await db.select().from(sandboxPayments).where(eq(sandboxPayments.id, request.id));
        check("payment_cancelled", !!p && p.status === "cancelled", `payment status is ${p?.status}`);
      } else {
        const [r] = await db.select().from(sandboxReceipts).where(eq(sandboxReceipts.id, request.id));
        check("receipt_cancelled", !!r && r.status === "cancelled", `receipt status is ${r?.status}`);
      }
      break;
    }
    case "sandbox.schedule_receipt": {
      const rows = await db.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), eq(sandboxReceipts.idempotencyKey, key)));
      check("receipt_exists_once", rows.length === 1, `${rows.length} receipt(s) with this action's key (expected 1)`);
      const r = rows[0];
      if (r) {
        check("receipt_counterparty", r.counterpartyId === request.counterpartyId, "expected from the approved counterparty");
        check("receipt_amount", r.amountMinor === request.amountMinor, `receipt amount ${r.amountMinor} equals the authorised amount ${request.amountMinor}`);
        check("receipt_currency_date", r.currency === request.currency && r.expectedOn === request.expectedOn, "currency and date match the request");
        check("receipt_backing", r.backingType === request.backingType && r.backingId === request.backingId, "backed by the agreement named in the request");
        check("receipt_status", r.status === "scheduled" || r.status === "received", `receipt status is ${r.status}`);
      }
      break;
    }
    case "sandbox.cancel_payment": {
      const [p] = await db.select().from(sandboxPayments).where(eq(sandboxPayments.id, request.paymentId));
      check("payment_cancelled", !!p && p.status === "cancelled", `payment status is ${p?.status}`);
      break;
    }
    default:
      break;
  }

  const ok = checks.every((c) => c.ok);
  await db.update(actionProposals).set({ status: ok ? "verified" : "verification_failed" }).where(eq(actionProposals.id, proposalId));
  await appendRecord(db, {
    businessId, proposalId, event: ok ? ACTION_EVENTS.VERIFIED : ACTION_EVENTS.VERIFICATION_FAILED, actor: "verifier",
    detail: { ok, failed: checks.filter((c) => !c.ok).map((c) => c.name), checks }, verification: ok ? "verified" : "failed",
  });
  return { proposalId, ok, status: ok ? "verified" : "verification_failed", checks };
}
