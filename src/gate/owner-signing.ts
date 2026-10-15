// OWNER SIGNING. The only module that reads the owner private key. It signs mandates and approvals.
// src/agent must never import this module (ESLint enforces it). Dev keys live in .env: see docs/security-model.md.
import { createPrivateKey, sign } from "node:crypto";
import { canonicalize } from "./canonical";
import { approvalMessage, planAuthorisationMessage, type ApprovalMessage, type PlanAuthorisationMessage } from "./owner-signing-types";
import { mandateSchema, type MandateWire, type SignedMandate } from "./mandate";

function privateKey() {
  const b64 = process.env.OWNER_SIGNING_PRIVATE_KEY;
  if (!b64) throw new Error("OWNER_SIGNING_PRIVATE_KEY is not set (run bun run mandate:keygen, dev keys only)");
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

const signText = (text: string): string => sign(null, Buffer.from(text, "utf8"), privateKey()).toString("base64");

/** Validates the mandate, canonicalises its wire form (stable key order) and signs it. */
export function signMandate(wire: MandateWire): SignedMandate {
  mandateSchema.parse(wire);
  const canonical = canonicalize(wire);
  return { canonical, signature: signText(canonical) };
}

export function signApproval(m: ApprovalMessage): string {
  return signText(approvalMessage(m));
}

export function signPlanAuthorisation(m: PlanAuthorisationMessage): string {
  return signText(planAuthorisationMessage(m));
}
