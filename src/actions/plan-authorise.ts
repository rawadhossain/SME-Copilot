// OWNER-ONLY PATH (ADR-016). Authorises one stored plan: propose (the gate checks every lever against the signed mandate),
// then approve (the gate checks again, then the owner key signs). Imports the owner-signing module, so only owner-facing API
// routes may import this file (src/agent must never: ESLint enforces it). The dev owner key stands in for owner login (Batch 10).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { leverProblems } from "@/agent";
import { agentRuns, businesses, counterparties, planAuthorisations, plans } from "@/db/schema";
import type { Constraint } from "@/domain/constraints";
import { leverSchema, planId, type Lever } from "@/domain/plan";
import { checkSignedMandate, evaluate, requestSchema, type GateResult } from "@/gate";
import { signPlanAuthorisation } from "@/gate/owner-signing";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext } from "./agent-run";
import { lettersSchema, type Letters } from "@/domain/letter-text";
import { draftLetters, lettersHashOf, parseSignatureImage, termLinesFor } from "./plan-letters";
import { appendRecord } from "./log";
import { mandateHashOf, messageOf } from "./plan-authority";
import { describeTerms } from "./plan-describe";
import { buildTerms, leversHashOf, termsHashOf, tolerancesSchema, type PlanTerms } from "./plan-terms";
import { isExpired } from "./propose";
import { loadGateState, loadSignedMandate, worldDate } from "./state";
import { ACTION_EVENTS, ActionError, type Db, type Q } from "./types";

/** Authorisation lifetime in world-time hours (config: PLAN_AUTH_TTL_HOURS, default 24). */
export const planAuthTtlHours = (): number => {
  const n = Number(process.env.PLAN_AUTH_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
};

export const authoriseInputSchema = z.object({
  runId: z.string().uuid(),
  planId: z.string().min(1).max(64),
  tolerances: tolerancesSchema.partial().optional(),
  ttlHours: z.number().positive().max(24 * 14).optional(),
  /** 2 when the owner gives the second confirmation that large payments need (the plan schedules supplier payments). */
  confirmations: z.union([z.literal(1), z.literal(2)]).default(1),
  /** Batch 14: the proposal letters the owner approved (one per counterparty in the terms) and the drawn signature (PNG data URL). Both are bound by the signature. */
  letters: lettersSchema.optional(),
  signatureImage: z.string().max(400_000).optional(),
});
export type AuthoriseInput = z.input<typeof authoriseInputSchema>;

interface RequestGate {
  index: number;
  kind: string;
  decision: GateResult["decision"];
  reasons: string[];
  limitsChecked: GateResult["limitsChecked"];
}

async function evaluateTerms(q: Q, businessId: string, terms: PlanTerms) {
  const state = await loadGateState(q, businessId);
  const mandate = await loadSignedMandate(q, businessId);
  const gates: RequestGate[] = terms.entries.map((e) => {
    const r = evaluate(mandate, state, requestSchema.parse(e.request));
    return { index: e.index, kind: e.lever.kind, decision: r.decision, reasons: r.reasons, limitsChecked: r.limitsChecked };
  });
  return { gates, mandate };
}

/** Step 1: store a proposed authorisation after the gate checks every lever. A plan beyond the mandate is stored as denied. */
export async function proposeAuthorisation(db: Db, businessId: string, input: unknown, opts: { preview?: boolean } = {}) {
  const { runId, planId: planHash, tolerances, ttlHours, confirmations, letters, signatureImage } = authoriseInputSchema.parse(input);
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.businessId, businessId)));
  if (!run) throw new ActionError("not_found", "Unknown agent run for this business");
  const [plan] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId), eq(plans.planHash, planHash)));
  if (!plan) throw new ActionError("not_found", "Unknown plan in this run");
  const parsedLevers = z.array(leverSchema).safeParse((plan.plan as { levers?: unknown }).levers);
  if (!parsedLevers.success || parsedLevers.data.length === 0) throw new ActionError("refused", "The stored plan has no valid levers");
  const levers = parsedLevers.data;
  if (planId(levers) !== plan.planHash) throw new ActionError("refused", "The stored plan was edited: its levers no longer match its hash");

  const ctx = await buildContext(db, businessId, null, (run.constraints ?? []) as Constraint[]);
  const mandateCheck = checkSignedMandate(ctx.mandate);
  const feeCap = mandateCheck.ok ? mandateCheck.mandate.limits.maxFinanceFeeBps : 0;
  const tol = tolerancesSchema.parse(tolerances ?? {});
  const baseEvents = ctx.pending.map((p) => p.event);
  let terms: PlanTerms;
  let needsSecond = false;
  const problems: string[] = [];
  try {
    terms = buildTerms(levers, baseEvents, tol, feeCap, (plan.plan as { financeFeeBps?: number }).financeFeeBps, confirmations);
    // A plan with a supplier lever schedules supplier payments; the largest could be the whole quote. If that is above the
    // mandate second-confirmation threshold, the owner must give two confirmations (the mandate rule is not bypassed by a plan).
    if (mandateCheck.ok && levers.some((l) => l.kind === "supplier_reduce_deposit" || l.kind === "supplier_defer_balance")) {
      const quote = baseEvents.filter((e) => e.kind === "supplier_deposit" || e.kind === "supplier_balance").reduce((a, e) => a + (e.amountMinor < 0n ? -e.amountMinor : 0n), 0n);
      needsSecond = quote > mandateCheck.mandate.limits.requireSecondConfirmationAboveMinor;
      if (needsSecond && confirmations !== 2 && !opts.preview) {
        throw new ActionError("refused", "This plan schedules supplier payments above the mandate second-confirmation threshold; sign it with confirmations: 2");
      }
    }
  } catch (e) {
    throw new ActionError("refused", e instanceof Error ? e.message : "The plan cannot be turned into requests");
  }
  problems.push(...leverProblems(ctx, levers));
  // Letters and signature (Batch 14). Every counterparty in the terms needs a letter, and nobody else may get one.
  let lettersJson: Letters | null = null;
  let signatureHash: string | null = null;
  if (!opts.preview) {
    if (letters) {
      const need = Object.keys(termLinesFor(terms, ctx.currency)).sort();
      const have = Object.keys(letters).sort();
      if (need.join() !== have.join()) throw new ActionError("refused", "There must be exactly one letter for each counterparty in the plan");
      lettersJson = letters;
    }
    if (signatureImage) {
      const sig = parseSignatureImage(signatureImage);
      if (!sig.ok) throw new ActionError("refused", sig.reason);
      signatureHash = sig.hash;
    }
  }
  const { gates, mandate } = await evaluateTerms(db, businessId, terms);
  const denied = problems.length > 0 || !mandateCheck.ok || gates.some((g) => g.decision === "deny");

  const asOf = await worldDate(db, businessId);
  const ttl = ttlHours ?? planAuthTtlHours();
  if (opts.preview) {
    // Nothing is stored. The same terms that would be hashed and signed, described in plain language.
    const names = Object.fromEntries(ctx.counterparties.map((c) => [c.id, c.name]));
    return {
      preview: {
        denied, problems, gates, needsSecondConfirmation: needsSecond, confirmations, runId, planId: plan.planHash,
        summary: describeTerms(terms, names, ctx.currency, { baseEvents, parties: ctx.parties }), termsHash: termsHashOf(terms), leversHash: leversHashOf(levers),
        mandateVersion: mandateCheck.ok ? mandateCheck.mandate.version : null, mandateHash: mandate ? mandateHashOf(mandate.canonical) : null,
        expiresAt: new Date(new Date(`${asOf}T00:00:00Z`).getTime() + ttl * 3_600_000).toISOString(), mandateProblem: mandateCheck.ok ? null : mandateCheck.reason,
      },
    };
  }
  const authId = randomUUID();
  const [auth] = await db
    .insert(planAuthorisations)
    .values({
      id: authId, businessId, runId, planId: plan.planHash, leversHash: leversHashOf(levers), terms: toJsonValue(terms) as Record<string, unknown>, termsHash: termsHashOf(terms),
      mandateVersion: mandateCheck.ok ? mandateCheck.mandate.version : 0, mandateHash: mandate ? mandateHashOf(mandate.canonical) : "",
      status: denied ? "denied" : "proposed",
      letters: lettersJson ? (toJsonValue(lettersJson) as Record<string, unknown>) : null, lettersHash: lettersJson ? lettersHashOf(lettersJson) : null,
      signatureImage: signatureHash ? signatureImage! : null, signatureHash,
      gateResult: toJsonValue({ problems, requests: gates, mandateProblem: mandateCheck.ok ? null : mandateCheck.reason }) as Record<string, unknown>,
      expiresAt: new Date(new Date(`${asOf}T00:00:00Z`).getTime() + ttl * 3_600_000),
    })
    .returning();
  await appendRecord(db, {
    businessId, event: denied ? ACTION_EVENTS.PLAN_AUTHORISATION_DENIED : ACTION_EVENTS.PLAN_AUTHORISATION_PROPOSED, actor: denied ? "gate" : "system",
    detail: { authorisationId: auth.id, runId, planId: plan.planHash, leversHash: auth.leversHash, termsHash: auth.termsHash, mandateVersion: auth.mandateVersion, expiresAt: auth.expiresAt, tolerances: tol, problems, gates: gates.map((g) => ({ index: g.index, kind: g.kind, decision: g.decision, reasons: g.reasons })) },
  });
  return { authorisation: auth, denied, problems, gates };
}

/** Step 2: re-check everything, then the owner key signs. Refuses an expired, denied or already signed proposal. */
export async function approveAuthorisation(db: Db, authorisationId: string, approvedByInput: string, expect: "proposed" | "awaiting_second" = "proposed") {
  const approvedBy = z.string().trim().min(1).max(100).parse(approvedByInput);
  return db.transaction(async (tx) => {
    const [auth] = await tx.select().from(planAuthorisations).where(eq(planAuthorisations.id, z.string().uuid().parse(authorisationId))).for("update");
    if (!auth) throw new ActionError("not_found", "Unknown plan authorisation");
    if (auth.status !== expect) throw new ActionError("conflict", `The authorisation is ${auth.status}; only ${expect === "proposed" ? "a proposed one" : "one waiting for its second approval"} can be signed`);
    const terms = auth.terms as PlanTerms;
    if (termsHashOf(terms) !== auth.termsHash) throw new ActionError("refused", "Stored terms do not match their hash; refusing to sign");
    const [plan] = await tx.select().from(plans).where(and(eq(plans.businessId, auth.businessId), eq(plans.runId, auth.runId), eq(plans.planHash, auth.planId)));
    const levers = ((plan?.plan as { levers?: Lever[] } | undefined)?.levers ?? []) as Lever[];
    if (!plan || leversHashOf(levers) !== auth.leversHash || planId(levers) !== plan.planHash) throw new ActionError("refused", "The plan was edited after it was proposed; refusing to sign");
    const asOf = await worldDate(tx, auth.businessId);
    if (isExpired(asOf, auth.expiresAt)) {
      await tx.update(planAuthorisations).set({ status: "expired" }).where(eq(planAuthorisations.id, auth.id));
      await appendRecord(tx, { businessId: auth.businessId, event: ACTION_EVENTS.PLAN_EXECUTION_REFUSED, actor: "system", detail: { authorisationId: auth.id, reason: "expired before it was signed" } });
      return { signed: false as const, reason: "expired" };
    }
    // The mandate must still be the one the proposal was checked against, and every request must still be allowed.
    const signedMandate = await loadSignedMandate(tx, auth.businessId);
    const m = checkSignedMandate(signedMandate);
    if (!m.ok || !signedMandate) throw new ActionError("refused", `Mandate check failed: ${m.ok ? "no mandate" : m.reason}`);
    if (m.mandate.version !== auth.mandateVersion || mandateHashOf(signedMandate.canonical) !== auth.mandateHash) throw new ActionError("refused", "The mandate changed since this authorisation was proposed");
    const { gates } = await evaluateTerms(tx, auth.businessId, terms);
    if (gates.some((g) => g.decision !== "needs_approval")) throw new ActionError("refused", `The gate no longer permits the plan: ${gates.filter((g) => g.decision !== "needs_approval").flatMap((g) => g.reasons).join("; ")}`, gates);

    const signature = signPlanAuthorisation(messageOf(auth));
    const [signed] = await tx
      .update(planAuthorisations)
      .set({ status: "authorised", signature, approvedBy, signedAt: new Date(), gateResult: toJsonValue({ ...(auth.gateResult as object), signingGates: gates }) as Record<string, unknown> })
      .where(eq(planAuthorisations.id, auth.id))
      .returning();
    await appendRecord(tx, {
      businessId: auth.businessId, event: ACTION_EVENTS.PLAN_AUTHORISED, actor: "owner",
      detail: { authorisationId: auth.id, approvedBy, runId: auth.runId, planId: auth.planId, leversHash: auth.leversHash, termsHash: auth.termsHash, mandateVersion: auth.mandateVersion, mandateHash: auth.mandateHash, expiresAt: auth.expiresAt, gates: gates.map((g) => ({ index: g.index, decision: g.decision })) },
    });
    return { signed: true as const, authorisation: signed };
  });
}

/** Both steps in order (the dev owner signs; owner login arrives in Batch 10). */
export async function authorisePlan(db: Db, businessId: string, input: unknown, approvedBy: string) {
  const proposed = (await proposeAuthorisation(db, businessId, input)) as { authorisation: typeof planAuthorisations.$inferSelect; denied: boolean; problems: string[]; gates: RequestGate[] };
  if (proposed.denied) return { status: "denied" as const, authorisationId: proposed.authorisation.id, problems: proposed.problems, gates: proposed.gates, authorisation: proposed.authorisation };
  const approved = await approveAuthorisation(db, proposed.authorisation.id, approvedBy);
  if (!approved.signed) return { status: "expired" as const, authorisationId: proposed.authorisation.id, problems: [], gates: proposed.gates, authorisation: proposed.authorisation };
  return { status: "authorised" as const, authorisationId: approved.authorisation.id, problems: [], gates: proposed.gates, authorisation: approved.authorisation };
}

/**
 * Two-person control, step 1. The owner has confirmed (password re-entered by the route); the plan is proposed and checked, then it WAITS. The
 * system does not sign it yet: a different approver account must confirm from their own sign-in (confirmSecond). Nothing is sent to anyone.
 */
export async function requestSecondApproval(db: Db, businessId: string, input: unknown, first: { id: string; name: string }) {
  const proposed = (await proposeAuthorisation(db, businessId, input)) as { authorisation: typeof planAuthorisations.$inferSelect; denied: boolean; problems: string[]; gates: RequestGate[] };
  if (proposed.denied) return { status: "denied" as const, authorisationId: proposed.authorisation.id, problems: proposed.problems, gates: proposed.gates, authorisation: proposed.authorisation };
  const terms = proposed.authorisation.terms as PlanTerms;
  if (terms.confirmations !== 2) throw new ActionError("invalid", "This plan does not need a second approver");
  const [waiting] = await db.update(planAuthorisations).set({ status: "awaiting_second", firstConfirmedBy: first.id, firstConfirmedName: first.name, firstConfirmedAt: new Date() })
    .where(and(eq(planAuthorisations.id, proposed.authorisation.id), eq(planAuthorisations.status, "proposed"))).returning();
  if (!waiting) throw new ActionError("conflict", "The authorisation changed while it was being prepared");
  await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_AWAITING_SECOND, actor: "owner", detail: { authorisationId: waiting.id, runId: waiting.runId, planId: waiting.planId, termsHash: waiting.termsHash, firstConfirmedBy: first.name, expiresAt: waiting.expiresAt } });
  return { status: "awaiting_second" as const, authorisationId: waiting.id, problems: [], gates: proposed.gates, authorisation: waiting };
}

/**
 * Two-person control, step 2. A DIFFERENT approver, signed in as themselves, confirms or declines. The route has already re-checked their own
 * password. Same person twice, a non-approver, or another business are refused here as well. Approving signs the plan (the same signing step as
 * a single confirmation); declining ends it.
 */
export async function confirmSecond(db: Db, businessId: string, authorisationId: string, approver: { id: string; name: string; role: string }, decision: "approve" | "decline") {
  const [auth] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, z.string().uuid().parse(authorisationId)));
  if (!auth || auth.businessId !== businessId) throw new ActionError("not_found", "Unknown plan authorisation");
  if (auth.status !== "awaiting_second") throw new ActionError("conflict", `This plan is ${auth.status}, not waiting for a second approval`);
  const refuse = async (why: string) => {
    await appendRecord(db, { businessId, event: ACTION_EVENTS.AUTH_SECOND_APPROVAL_FAILED, actor: "owner", detail: { authorisationId: auth.id, approver: approver.name, reason: why } });
    throw new ActionError("refused", why);
  };
  if (approver.role !== "approver") await refuse("Only an approver account can give the second approval.");
  if (approver.id === auth.firstConfirmedBy) await refuse("The second approval must come from a different person than the first.");
  if (decision === "decline") {
    const [declined] = await db.update(planAuthorisations).set({ status: "declined" }).where(and(eq(planAuthorisations.id, auth.id), eq(planAuthorisations.status, "awaiting_second"))).returning();
    if (!declined) throw new ActionError("conflict", "The authorisation changed before it could be declined");
    await appendRecord(db, { businessId, event: ACTION_EVENTS.AUTH_SECOND_APPROVAL_DECLINED, actor: "owner", detail: { authorisationId: auth.id, approver: approver.name, firstConfirmedBy: auth.firstConfirmedName } });
    return { status: "declined" as const, authorisationId: auth.id };
  }
  const approved = await approveAuthorisation(db, auth.id, `${auth.firstConfirmedName ?? "Owner"} + ${approver.name}`, "awaiting_second");
  if (!approved.signed) return { status: "expired" as const, authorisationId: auth.id };
  await appendRecord(db, { businessId, event: ACTION_EVENTS.AUTH_SECOND_APPROVAL, actor: "owner", detail: { authorisationId: auth.id, approver: approver.name, firstConfirmedBy: auth.firstConfirmedName, termsHash: auth.termsHash } });
  return { status: "authorised" as const, authorisationId: auth.id, authorisation: approved.authorisation };
}

/** Plans waiting for a second approval in this business, with the plain-language terms the approver is confirming. */
export async function listAwaitingSecond(db: Db, businessId: string, viewerUserId: string) {
  const rows = await db.select().from(planAuthorisations).where(and(eq(planAuthorisations.businessId, businessId), eq(planAuthorisations.status, "awaiting_second"))).orderBy(planAuthorisations.createdAt);
  const cps = await db.select({ id: counterparties.id, name: counterparties.name }).from(counterparties).where(eq(counterparties.businessId, businessId));
  const [biz] = await db.select({ c: businesses.baseCurrency }).from(businesses).where(eq(businesses.id, businessId));
  const names = Object.fromEntries(cps.map((c) => [c.id, c.name]));
  const pctx = rows.length > 0 ? await buildContext(db, businessId, null) : null;
  return rows.map((r) => ({
    id: r.id, runId: r.runId, planId: r.planId, termsHash: r.termsHash, createdAt: r.createdAt, expiresAt: r.expiresAt, mandateVersion: r.mandateVersion,
    firstConfirmedName: r.firstConfirmedName, firstConfirmedAt: r.firstConfirmedAt,
    /** The person who gave the first confirmation cannot give the second. */
    canConfirm: r.firstConfirmedBy !== viewerUserId,
    summary: describeTerms(r.terms as PlanTerms, names, biz?.c ?? "GBP", pctx ? { baseEvents: pctx.pending.map((p) => p.event), parties: pctx.parties } : undefined),
  }));
}

/** Preview of what a signature would cover. Writes nothing. */
export async function previewAuthorisation(db: Db, businessId: string, input: unknown, owner: { name: string } = { name: "The owner" }) {
  const r = await proposeAuthorisation(db, businessId, input, { preview: true });
  const preview = (r as unknown as { preview: Record<string, unknown> & { runId: string; planId: string; expiresAt: string } }).preview;
  // The first draft of each letter, written by code from the terms, and the locked terms block that goes under it (Batch 14).
  const { runId, planId: planHash } = authoriseInputSchema.pick({ runId: true, planId: true }).parse(input);
  const [plan] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId), eq(plans.planHash, planHash)));
  const ctx = await buildContext(db, businessId, null);
  const levers = z.array(leverSchema).parse((plan?.plan as { levers?: unknown } | undefined)?.levers ?? []);
  const feeCap = (() => { const m = checkSignedMandate(ctx.mandate); return m.ok ? m.mandate.limits.maxFinanceFeeBps : 0; })();
  const tol = tolerancesSchema.parse(((input ?? {}) as { tolerances?: unknown }).tolerances ?? {});
  const terms = buildTerms(levers, ctx.pending.map((p) => p.event), tol, feeCap, (plan?.plan as { financeFeeBps?: number } | undefined)?.financeFeeBps, preview.confirmations as 1 | 2);
  const [biz] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId));
  const letters = draftLetters({ terms, counterparties: ctx.counterparties, business: biz?.name ?? "", owner: owner.name, expiresAt: String(preview.expiresAt), currency: ctx.currency });
  // Notes the owner wrote per counterparty while adjusting the terms are added to that counterparty's letter, before the closing paragraph.
  const notes = ((plan?.plan as { ownerNotes?: Record<string, string> } | undefined)?.ownerNotes ?? {});
  for (const [cpId, note] of Object.entries(notes)) {
    const letter = letters[cpId];
    if (!letter || !note.trim()) continue;
    const at = letter.paragraphs.findIndex((p) => p.startsWith("The proposed terms are set out"));
    letter.paragraphs.splice(at >= 0 ? at : Math.max(1, letter.paragraphs.length - 2), 0, note.trim());
  }
  return { ...preview, letters, termLines: termLinesFor(terms, ctx.currency), counterparties: ctx.counterparties.filter((c) => c.id in letters).map((c) => ({ id: c.id, name: c.name, role: c.role })), business: biz?.name ?? "", owner: owner.name };
}
