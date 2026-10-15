// Signature verification with the PUBLIC key only. Safe to use anywhere (the gate, the executor, the verifier).
import { createPublicKey, verify } from "node:crypto";
import { approvalMessage, planAuthorisationMessage, type ApprovalMessage, type PlanAuthorisationMessage } from "./owner-signing-types";
import { mandateSchema, type Mandate, type SignedMandate } from "./mandate";

function publicKey(override?: string) {
  const b64 = override ?? process.env.OWNER_SIGNING_PUBLIC_KEY;
  if (!b64) return null;
  try {
    return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export function verifyText(text: string, signatureB64: string, publicKeyB64?: string): boolean {
  const key = publicKey(publicKeyB64);
  if (!key) return false;
  try {
    return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export type MandateCheck = { ok: true; mandate: Mandate } | { ok: false; reason: string };

/** Signature first, then schema. A mandate whose canonical text was edited by one character fails here. */
export function checkSignedMandate(signed: SignedMandate | null, publicKeyB64?: string): MandateCheck {
  if (!signed) return { ok: false, reason: "No active mandate" };
  if (!verifyText(signed.canonical, signed.signature, publicKeyB64)) return { ok: false, reason: "Mandate signature is invalid" };
  try {
    const parsed = mandateSchema.safeParse(JSON.parse(signed.canonical));
    if (!parsed.success) return { ok: false, reason: "Mandate content is malformed" };
    return { ok: true, mandate: parsed.data };
  } catch {
    return { ok: false, reason: "Mandate content is malformed" };
  }
}

export function verifyApprovalSignature(m: ApprovalMessage, signatureB64: string, publicKeyB64?: string): boolean {
  return verifyText(approvalMessage(m), signatureB64, publicKeyB64);
}

export function verifyPlanAuthorisationSignature(m: PlanAuthorisationMessage, signatureB64: string, publicKeyB64?: string): boolean {
  return verifyText(planAuthorisationMessage(m), signatureB64, publicKeyB64);
}
