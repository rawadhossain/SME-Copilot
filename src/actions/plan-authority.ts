// Is this plan authorisation genuine, current and does it cover this action? (ADR-016.) Uses the PUBLIC key only, so the
// executor and the verifier can both call it; it can check a signature, never make one.
import { and, eq } from "drizzle-orm";
import { actionProposals, agentRuns, planAuthorisations, plans, sandboxApplications } from "@/db/schema";
import { planId, type Lever } from "@/domain/plan";
import { checkSignedMandate, verifyPlanAuthorisationSignature, type GateRequest, type PlanAuthorisationMessage } from "@/gate";
import { lettersSchema } from "@/domain/letter-text";
import { lettersHashOf, parseSignatureImage } from "./plan-letters";
import { expectedScheduleFor, scheduleCovers } from "./plan-schedule";
import { leversHashOf, permits, permitsAcceptOffer, sha256Hex, termsHashOf, type PlanTerms } from "./plan-terms";
import { isExpired } from "./propose";
import { loadSignedMandate, worldDate } from "./state";
import type { Db } from "./types";

export type AuthorisationRow = typeof planAuthorisations.$inferSelect;

export const mandateHashOf = (canonical: string): string => sha256Hex(canonical);

export const messageOf = (a: AuthorisationRow): PlanAuthorisationMessage => ({
  authorisationId: a.id, businessId: a.businessId, runId: a.runId, planId: a.planId, leversHash: a.leversHash, termsHash: a.termsHash,
  expiresAt: a.expiresAt.toISOString(), mandateVersion: a.mandateVersion, mandateHash: a.mandateHash,
  ...(a.lettersHash ? { lettersHash: a.lettersHash } : {}), ...(a.signatureHash ? { signatureHash: a.signatureHash } : {}),
});

export type AuthorityCheck = { ok: true; auth: AuthorisationRow; terms: PlanTerms } | { ok: false; reason: string };

/** Integrity only: signature, terms hash, and the stored plan still hashing to what was signed. No expiry, no mandate. */
export async function checkAuthorisationIntegrity(db: Db, authorisationId: string): Promise<AuthorityCheck> {
  const [auth] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, authorisationId));
  if (!auth) return { ok: false, reason: "Unknown plan authorisation" };
  if (!auth.signature) return { ok: false, reason: "The plan authorisation was never signed by the owner" };
  if (!verifyPlanAuthorisationSignature(messageOf(auth), auth.signature)) return { ok: false, reason: "The plan authorisation signature is invalid (a signed field was changed)" };
  const terms = auth.terms as PlanTerms;
  // Batch 14: the signature binds the fingerprints of the letters and the drawn signature; the stored text and image must still hash to them.
  if (auth.lettersHash) {
    const parsed = lettersSchema.safeParse(auth.letters);
    if (!parsed.success || lettersHashOf(parsed.data) !== auth.lettersHash) return { ok: false, reason: "The proposal letters were edited after they were signed" };
  }
  if (auth.signatureHash) {
    const sig = auth.signatureImage ? parseSignatureImage(auth.signatureImage) : null;
    if (!sig || !sig.ok || sig.hash !== auth.signatureHash) return { ok: false, reason: "The drawn signature image was changed after it was signed" };
  }
  if (termsHashOf(terms) !== auth.termsHash) return { ok: false, reason: "The authorised requests and bounds no longer match the signed hash" };
  const [plan] = await db.select().from(plans).where(and(eq(plans.businessId, auth.businessId), eq(plans.runId, auth.runId), eq(plans.planHash, auth.planId)));
  if (!plan) return { ok: false, reason: "The authorised plan no longer exists" };
  const levers = ((plan.plan as { levers?: Lever[] }).levers ?? []) as Lever[];
  if (leversHashOf(levers) !== auth.leversHash || planId(levers) !== plan.planHash) return { ok: false, reason: "The plan was edited after it was signed (its levers no longer match the signed hash)" };
  return { ok: true, auth, terms };
}

/** Current validity: integrity, status, expiry (world time) and the mandate version and hash it was checked against. */
export async function checkAuthorisationCurrent(db: Db, authorisationId: string): Promise<AuthorityCheck> {
  const base = await checkAuthorisationIntegrity(db, authorisationId);
  if (!base.ok) return base;
  const { auth } = base;
  if (auth.status !== "authorised" && auth.status !== "used") return { ok: false, reason: `The plan authorisation is ${auth.status}` };
  if (auth.status === "authorised") {
    // An approval is for the facts it was given on. A newer plan that replaced this run (recovery, shortage) makes it stale; a run already underway (used) is not stopped.
    const [run] = await db.select({ lifecycle: agentRuns.lifecycle }).from(agentRuns).where(eq(agentRuns.id, auth.runId));
    if (run?.lifecycle === "superseded") return { ok: false, reason: "The plan was replaced by a newer plan after the facts changed; this approval can no longer be used" };
  }
  const asOf = await worldDate(db, auth.businessId);
  if (isExpired(asOf, auth.expiresAt)) return { ok: false, reason: `The plan authorisation expired at ${auth.expiresAt.toISOString()}` };
  const signed = await loadSignedMandate(db, auth.businessId);
  const m = checkSignedMandate(signed);
  if (!m.ok || !signed) return { ok: false, reason: `Mandate check failed: ${m.ok ? "no mandate" : m.reason}` };
  if (m.mandate.version !== auth.mandateVersion) return { ok: false, reason: `The mandate changed after signing (version ${auth.mandateVersion} authorised, version ${m.mandate.version} is active)` };
  if (mandateHashOf(signed.canonical) !== auth.mandateHash) return { ok: false, reason: "The mandate content differs from the one the authorisation was checked against" };
  return base;
}

/** Does the signed terms cover this exact action, given the sandbox facts it depends on? */
export async function authorisationCovers(db: Db, auth: AuthorisationRow, terms: PlanTerms, request: GateRequest): Promise<string | null> {
  switch (request.kind) {
    case "sandbox.send_proposal":
    case "sandbox.submit_application":
      return permits(terms, request) ? null : "The action is not covered by the signed plan terms";
    case "sandbox.accept_offer": {
      const [a] = await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.id, request.applicationId), eq(sandboxApplications.businessId, auth.businessId)));
      if (!a) return "Unknown application";
      const o = a.offer as { response?: { outcome?: string; terms?: { advanceBps?: number; feeBps?: number } | null } } | null;
      const t = o?.response?.outcome === "offer" ? o.response.terms : null;
      return permitsAcceptOffer(terms, { lenderId: a.lenderId, requestedAmountMinor: a.requestedAmountMinor, status: a.status, advanceBps: t?.advanceBps ?? null, feeBps: t?.feeBps ?? null })
        ? null
        : "The offer is not within the signed plan terms (lender, amount, advance or fee)";
    }
    case "sandbox.schedule_payment":
    case "sandbox.schedule_receipt": {
      // Payments and receipts must be exactly the ones the AGREED terms imply (computed by the engine from the recorded agreement).
      const { items } = await expectedScheduleFor(db, auth, terms);
      return scheduleCovers(db, auth.businessId, items, request);
    }
    default:
      return "This kind of action cannot be covered by a plan authorisation";
  }
}

/**
 * Compensation provenance: a withdrawal may only undo a thread or application that an action of this authorisation, or of the earlier round
 * it revises (Batch 13: agreements kept on hold and taken over), created.
 */
export async function createdByAuthorisation(db: Db, authorisationId: string, target: "thread" | "application" | "payment" | "receipt", id: string): Promise<boolean> {
  const ids = [authorisationId];
  const [auth] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, authorisationId));
  let runId: string | null = auth?.runId ?? null;
  for (let hops = 0; runId && hops < 10; hops++) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    runId = run?.parentRunId ?? null;
    if (runId) for (const a of await db.select({ id: planAuthorisations.id }).from(planAuthorisations).where(eq(planAuthorisations.runId, runId))) ids.push(a.id);
  }
  const field = { thread: "threadId", application: "applicationId", payment: "paymentId", receipt: "receiptId" }[target];
  for (const aid of ids) {
    const rows = await db.select({ result: actionProposals.result }).from(actionProposals).where(eq(actionProposals.authorisationId, aid));
    if (rows.some((r) => (r.result as Record<string, unknown> | null)?.[field] === id)) return true;
  }
  return false;
}
