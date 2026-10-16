// The shape and exact text of an approval signature. No key material here: safe to import anywhere.
import { canonicalize } from "./canonical";

export interface ApprovalMessage {
  proposalId: string;
  payloadHash: string;
  confirmations: 1 | 2;
}

/** The exact text an approval signature covers. */
export const approvalMessage = (m: ApprovalMessage): string => canonicalize({ confirmations: m.confirmations, payloadHash: m.payloadHash, proposalId: m.proposalId });

/** What the owner signs to authorise a plan (ADR-016). Every field is bound; changing any one breaks the signature. */
export interface PlanAuthorisationMessage {
  authorisationId: string;
  businessId: string;
  runId: string;
  planId: string;
  leversHash: string;
  termsHash: string;
  expiresAt: string; // ISO timestamp
  mandateVersion: number;
  mandateHash: string;
  /** Batch 14: SHA-256 of the proposal letters the owner approved, and of the drawn signature image. Absent on authorisations signed before. */
  lettersHash?: string;
  signatureHash?: string;
}

/** The exact text a plan-authorisation signature covers. The purpose tag keeps it from being valid as any other signature. */
export const planAuthorisationMessage = (m: PlanAuthorisationMessage): string => canonicalize({ purpose: "plan.authorisation.v1", ...m });
