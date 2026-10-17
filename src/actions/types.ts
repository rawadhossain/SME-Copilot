// Shared definitions for the action pipeline. The action_record event strings live HERE and nowhere else.
import type { db as appDb } from "@/db";

export type Db = typeof appDb;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Q = Db | Tx;

/** Event names written to action_records.event. */
export const ACTION_EVENTS = {
  PROPOSED: "action.proposed",
  GATE_DECISION: "gate.decision",
  APPROVED: "action.approved",
  EXECUTION_REFUSED: "action.execution_refused",
  EXECUTED: "action.executed",
  EXECUTION_FAILED: "action.execution_failed",
  VERIFIED: "action.verified",
  VERIFICATION_FAILED: "action.verification_failed",
  CANCELLED: "action.cancelled",
  EXPIRED: "action.expired",
  PAYEE_BANK_DETAILS_CHANGED: "payee.bank_details_changed",
  PAYEE_REAPPROVED: "payee.reapproved",
  BANK_TICK: "bank.due_payments_processed",
  DOCUMENT_EXTRACTION_CONFIRMED: "document.extraction_confirmed",
  DOCUMENT_EXTRACTION_REJECTED: "document.extraction_rejected",
  SUSPICIOUS_TEXT_DETECTED: "security.suspicious_text_detected",
  AGENT_RUN_STARTED: "agent.run_started",
  AGENT_PLANS_SUBMITTED: "agent.plans_submitted",
  AGENT_RUN_FAILED: "agent.run_failed",
  PLAN_EDITED: "plan.edited",
  PLAN_EDIT_ASSISTED: "plan.edit_assisted",
  PLAN_LETTER_ASSISTED: "plan.letter_assisted",
  CASH_QUESTION_ASKED: "cash.question_asked",
  PLAN_AUTHORISATION_PROPOSED: "plan.authorisation_proposed",
  PLAN_AUTHORISATION_DENIED: "plan.authorisation_denied",
  PLAN_AUTHORISED: "plan.authorised",
  PLAN_EXECUTION_STARTED: "plan.execution_started",
  PLAN_EXECUTION_REFUSED: "plan.execution_refused",
  PLAN_BRANCH_RESULT: "plan.branch_result",
  PLAN_NEEDS_REPLAN: "plan.needs_replan",
  PLAN_COMPENSATED: "plan.compensated",
  PLAN_EXECUTION_FAILED: "plan.execution_failed",
  PLAN_COMPLETED: "plan.execution_completed",
  PLAN_VERIFIED: "plan.verified",
  PLAN_VERIFICATION_FAILED: "plan.verification_failed",
  PLAN_REPLANNED: "plan.replanned",
  PLAN_EXHAUSTED: "plan.exhausted",
  SHORTAGE_DETECTED: "shortage.detected",
  MANDATE_VERSION_SIGNED: "mandate.version_signed",
  AUTH_LOGIN: "auth.login",
  AUTH_LOGIN_FAILED: "auth.login_failed",
  AUTH_LOGOUT: "auth.logout",
  AUTH_STEP_UP: "auth.step_up",
  AUTH_STEP_UP_FAILED: "auth.step_up_failed",
  AUTH_SECOND_APPROVAL: "auth.second_approval",
  AUTH_SECOND_APPROVAL_FAILED: "auth.second_approval_failed",
  AUTH_SECOND_APPROVAL_DECLINED: "auth.second_approval_declined",
  PLAN_AWAITING_SECOND: "plan.awaiting_second_approval",
  DEMO_CLONE_CREATED: "demo.clone_created",
  EVIDENCE_EXPORTED: "evidence.exported",
  FUNDING_OFFERS_SAVED: "funding.offers_saved",
  LEDGER_DOCUMENT_CREATED: "ledger.document_created",
  LEDGER_DOCUMENT_UPDATED: "ledger.document_updated",
  LEDGER_DOCUMENT_VOIDED: "ledger.document_voided",
  LEDGER_PAYMENT_RECORDED: "ledger.payment_recorded",
  LEDGER_PAYMENT_VOIDED: "ledger.payment_voided",
} as const;

export type ActionEvent = (typeof ACTION_EVENTS)[keyof typeof ACTION_EVENTS];
export type Actor = "owner" | "agent" | "gate" | "verifier" | "system" | "executor";

export const STATUSES = ["proposed", "denied", "approved", "executing", "executed", "verified", "failed", "verification_failed", "cancelled", "expired"] as const;
export type ProposalStatus = (typeof STATUSES)[number];

/** Pipeline errors, mapped to HTTP statuses by the API layer. */
export class ActionError extends Error {
  constructor(public code: "not_found" | "conflict" | "refused" | "invalid", message: string, public details?: unknown) {
    super(message);
  }
}
