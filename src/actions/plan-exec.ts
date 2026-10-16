// THE PLAN EXECUTOR (ADR-016, ADR-017). Runs one owner-signed plan authorisation through the existing action pipeline:
// every step is a proposal that the gate evaluates, that the signed authorisation covers, that executeAction runs and that
// verifyAction checks. Single round: one proposal per counterparty (plus one acceptance of an in-bound counter). Reject or
// out-of-terms means "needs re-plan" and nothing is committed (re-planning is Batch 8b). Any failure or denial rolls back
// by compensation, so the sandbox is never left half-applied. It never signs anything and never reads the owner key.
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, planAuthorisations, planExecutions, sandboxApplications, sandboxThreads } from "@/db/schema";
import { financedInvoiceMinor } from "@/engine/plans";
import { canonicalize } from "@/gate/canonical";
import { buildContext } from "./agent-run";
import type { Constraint } from "@/domain/constraints";
import type { GateRequestJson } from "@/gate/request";
import { requestSchema } from "@/gate";
import { toJsonValue } from "@/sandbox/proposals";
import { actionProposals } from "@/db/schema";
import { executeAction } from "./execute";
import { appendRecord } from "./log";
import { authorisationCovers, checkAuthorisationCurrent } from "./plan-authority";
import type { PlanTerms } from "./plan-terms";
import { expectedScheduleFor, itemToRequest, payeeFor } from "./plan-schedule";
import { classifyOffer, classifyProposalReply, constraintFrom, type BranchVerdict, type TermsEntry } from "./plan-terms";
import { verifyPlanExecution, type PlanVerification } from "./plan-verify";
import { proposeAction } from "./propose";
import { verifyAction } from "./verify";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export type BranchStatus = "pending" | "agreed" | "offered" | "committed" | "needs_replan" | "failed";

export interface Branch {
  index: number;
  kind: string;
  counterpartyId: string;
  status: BranchStatus;
  /** Structured reason only (written by this code, never copied from a counterparty). */
  reason?: string;
  proposalIds: string[];
  threadId?: string;
  applicationId?: string;
  agreedTerms?: Record<string, number>;
  offer?: { advanceBps: number; feeBps: number };
  withdrawn?: boolean;
  /** Batch 13: set on the OLD attempt's branch when a later round of the same deal took the agreement over (it is not withdrawn). */
  adopted?: string;
  /** Batch 13: set on a branch that was taken over from an earlier round instead of being asked again (that round's authorisation id). */
  carriedFrom?: string;
}

export interface ExecutionOutcome {
  branches: Branch[];
  /** Batch 13: true while agreements reached before a counterparty pushed back are kept on hold (not withdrawn). */
  held?: boolean;
  /** True once every branch is committed (the finance advance taken up, every agreement in place). */
  committed: boolean;
  /** Payments and receipts scheduled in the sandbox after the commit (ADR-019). */
  scheduled: { kind: "payment" | "receipt"; id: string; eventKind: string; amountMinor: string; date: string; withdrawn?: boolean }[];
  compensated: { target: "thread" | "application" | "payment" | "receipt"; id: string; ok: boolean }[];
  /** Structured constraints learned from refused or out-of-terms replies (ADR-021). Never counterparty free text. */
  constraints: Constraint[];
  failure?: { step: string; reason: string };
}

export interface ExecutionResult {
  authorisationId: string;
  executionId: string;
  status: "completed" | "verification_failed" | "needs_replan" | "rolled_back" | "failed";
  outcome: ExecutionOutcome;
  verification: PlanVerification | null;
}

export interface ExecuteOptions {
  /** TEST HOOK: called before each pipeline step; throw to simulate a failure at that step. Never set in production code. */
  beforeStep?: (step: string) => Promise<void> | void;
}

class StepError extends Error {
  constructor(public step: string, message: string) {
    super(message);
  }
}

const response = (result: unknown) => (result ?? {}) as { outcome?: string; terms?: Record<string, unknown> | null; threadId?: string; applicationId?: string; paymentId?: string; receiptId?: string };

/** The structured terms a proposal lever asks for, as numbers (to compare with what a counterparty agreed). */
function proposalTerms(e: TermsEntry): Record<string, number> {
  const r = requestSchema.parse(e.request);
  if (r.kind !== "sandbox.send_proposal") return {};
  const { kind: _kind, ...rest } = r.proposal as Record<string, unknown>;
  void _kind;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === "number")) as Record<string, number>;
}

interface Carry { authId: string; execId: string; outcome: ExecutionOutcome; branch: Branch; lever: TermsEntry["lever"]; taken: boolean; released: boolean }

/** Held (still live, not yet taken over) branches of the run this one revises. Only the immediate parent round matters. */
async function loadCarry(db: Db, row: typeof planAuthorisations.$inferSelect, runRow: typeof agentRuns.$inferSelect | undefined): Promise<Carry[]> {
  if (!runRow?.parentRunId) return [];
  const auths = await db.select().from(planAuthorisations).where(and(eq(planAuthorisations.businessId, row.businessId), eq(planAuthorisations.runId, runRow.parentRunId)));
  const out: Carry[] = [];
  for (const a of auths) {
    const [ex] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, a.id));
    if (!ex || ex.status !== "needs_replan") continue;
    const outcome = ex.outcome as ExecutionOutcome;
    if (!outcome.held) continue;
    const entries = (a.terms as PlanTerms).entries;
    for (const b of outcome.branches ?? []) {
      if ((b.status !== "agreed" && b.status !== "offered") || b.withdrawn || b.adopted) continue;
      const lever = entries.find((x) => x.index === b.index)?.lever;
      if (lever) out.push({ authId: a.id, execId: ex.id, outcome, branch: b, lever, taken: false, released: false });
    }
  }
  return out;
}

/**
 * Withdraws what an attempt kept on hold after a counterparty pushed back (Batch 13): agreed threads and finance offers that no later round took over.
 * `keepLevers` lists levers (by index in this authorisation's terms) that must stay. Each withdrawal goes through the same pipeline and gate as any other
 * compensation and is covered by the authorisation that created it. Safe to call again.
 */
export async function releaseHeld(db: Db, authorisationIdInput: string, o: { keepIndexes?: number[] } = {}): Promise<{ released: number; ok: boolean }> {
  const authorisationId = z.string().uuid().parse(authorisationIdInput);
  const [a] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, authorisationId));
  if (!a) throw new ActionError("not_found", "Unknown plan authorisation");
  const [ex] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, authorisationId));
  if (!ex || ex.status !== "needs_replan") return { released: 0, ok: true };
  const outcome = ex.outcome as ExecutionOutcome;
  let released = 0;
  let ok = true;
  const results: { target: "thread" | "application"; id: string; ok: boolean }[] = [];
  for (const b of [...(outcome.branches ?? [])].reverse()) {
    if ((b.status !== "agreed" && b.status !== "offered") || b.withdrawn || b.adopted || o.keepIndexes?.includes(b.index)) continue;
    const target = b.applicationId && b.status === "offered" ? ({ target: "application", id: b.applicationId } as const) : b.threadId ? ({ target: "thread", id: b.threadId } as const) : null;
    if (!target) continue;
    try {
      const proposed = await proposeAction(db, a.businessId, { kind: "sandbox.withdraw", target: target.target, id: target.id }, `plan:${authorisationId}:release:${target.target}:${target.id}`, "agent", { authorisationId });
      if (proposed.gate.decision === "deny") throw new Error(proposed.gate.reasons.join("; "));
      const p = proposed.proposal;
      if (p.status !== "executed" && p.status !== "verified") {
        if (p.status !== "approved") throw new Error(`the withdrawal is ${p.status}`);
        await executeAction(db, p.id);
      }
      b.withdrawn = true;
      released++;
      results.push({ ...target, ok: true });
    } catch {
      ok = false;
      results.push({ ...target, ok: false });
    }
  }
  outcome.held = outcome.branches.some((b) => (b.status === "agreed" || b.status === "offered") && !b.withdrawn && !b.adopted);
  if (results.length > 0) {
    await db.update(planExecutions).set({ outcome: toJsonValue(outcome) as Record<string, unknown> }).where(eq(planExecutions.id, ex.id));
    await appendRecord(db, { businessId: a.businessId, event: ACTION_EVENTS.PLAN_COMPENSATED, actor: "executor", detail: { authorisationId, why: "held agreements released", released: results, allOk: ok } });
  }
  return { released, ok };
}

export async function executePlan(db: Db, authorisationIdInput: string, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
  const authorisationId = z.string().uuid().parse(authorisationIdInput);
  const [row] = await db.select().from(planAuthorisations).where(eq(planAuthorisations.id, authorisationId));
  if (!row) throw new ActionError("not_found", "Unknown plan authorisation");
  const businessId = row.businessId;

  const refuse = async (reason: string, extra: Record<string, unknown> = {}, code: "refused" | "conflict" = "refused"): Promise<never> => {
    await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_EXECUTION_REFUSED, actor: "executor", detail: { authorisationId, reason, ...extra } });
    throw new ActionError(code, reason, extra);
  };

  // 1. The authorisation must be genuine, current, unexpired and checked against the mandate that is active now.
  const cur = await checkAuthorisationCurrent(db, authorisationId);
  if (!cur.ok) {
    if (cur.reason.includes("expired") && row.status === "authorised") await db.update(planAuthorisations).set({ status: "expired" }).where(eq(planAuthorisations.id, authorisationId));
    return refuse(cur.reason);
  }
  const { terms } = cur;

  // 2. Claim it (single use). A second call finds it used: a finished execution is refused, an interrupted one resumes.
  let [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, authorisationId));
  if (row.status === "authorised") {
    const used = await db.update(planAuthorisations).set({ status: "used" }).where(and(eq(planAuthorisations.id, authorisationId), eq(planAuthorisations.status, "authorised"))).returning({ id: planAuthorisations.id });
    if (used.length === 1) {
      [exec] = await db.insert(planExecutions).values({ businessId, authorisationId, status: "running", outcome: { branches: [], committed: false, scheduled: [], compensated: [], constraints: [] } }).returning();
      await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_EXECUTION_STARTED, actor: "executor", detail: { authorisationId, executionId: exec.id, levers: terms.entries.map((e) => e.lever.kind) } });
    } else {
      [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, authorisationId));
    }
  }
  if (!exec || exec.status !== "running") return refuse("This plan authorisation was already used; an authorisation executes once", { executionStatus: exec?.status ?? null }, "conflict");

  const outcome = exec.outcome as ExecutionOutcome;
  outcome.branches ??= [];
  outcome.compensated ??= [];
  outcome.scheduled ??= [];
  outcome.constraints ??= [];
  const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, row.runId));
  const setLifecycle = async (lifecycle: "needs_replan" | "executed" | "verification_failed") => {
    await db.update(agentRuns).set({ lifecycle }).where(eq(agentRuns.id, row.runId));
  };
  const save = async (patch: Partial<{ status: ExecutionResult["status"] | "running"; error: string | null; finished: boolean }> = {}) => {
    await db
      .update(planExecutions)
      .set({ outcome: toJsonValue(outcome) as Record<string, unknown>, ...(patch.status ? { status: patch.status } : {}), ...(patch.error !== undefined ? { error: patch.error } : {}), ...(patch.finished ? { finishedAt: new Date() } : {}) })
      .where(eq(planExecutions.id, exec.id));
  };

  // One pipeline step: propose (gate), cover by the signed plan, execute (gate again), verify. Idempotent by key.
  const act = async (step: string, request: GateRequestJson, key: string, o: { compensation?: boolean } = {}) => {
    await opts.beforeStep?.(step);
    const proposed = await proposeAction(db, businessId, request, `plan:${authorisationId}:${key}`, "agent", { authorisationId });
    const p = proposed.proposal;
    if (proposed.gate.decision === "deny") throw new StepError(step, `The gate denied this action: ${proposed.gate.reasons.join("; ")}`);
    if (p.status === "executed" || p.status === "verified") return { proposalId: p.id, result: response(p.result), duplicate: true };
    if (p.status === "proposed") {
      const covered = await authorisationCovers(db, cur.auth, terms, requestSchema.parse(p.payload));
      if (covered) throw new StepError(step, covered);
      const moved = await db.update(actionProposals).set({ status: "approved" }).where(and(eq(actionProposals.id, p.id), eq(actionProposals.status, "proposed"))).returning({ id: actionProposals.id });
      if (moved.length === 1) await appendRecord(db, { businessId, proposalId: p.id, event: ACTION_EVENTS.APPROVED, actor: "executor", detail: { via: "plan_authorisation", authorisationId, payloadHash: p.payloadHash } });
    } else if (p.status !== "approved") {
      throw new StepError(step, `The action is ${p.status}`);
    }
    let executed;
    try {
      executed = await executeAction(db, p.id);
    } catch (e) {
      throw new StepError(step, e instanceof Error ? e.message : "execution failed");
    }
    if (!o.compensation) {
      const v = await verifyAction(db, p.id);
      if (!v.ok) throw new StepError(step, `Per-action verification failed: ${v.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
    }
    return { proposalId: p.id, result: response(executed.result), duplicate: false };
  };

  const branchFor = (e: TermsEntry): Branch => {
    let b = outcome.branches.find((x) => x.index === e.index);
    if (!b) {
      const r = requestSchema.parse(e.request);
      b = { index: e.index, kind: e.lever.kind, counterpartyId: "counterpartyId" in r ? r.counterpartyId : "lenderId" in r ? r.lenderId : "", status: "pending", proposalIds: [] };
      outcome.branches.push(b);
    }
    return b;
  };

  // Withdraw everything this execution made live, newest first. A failed withdrawal is recorded and fails the execution loudly.
  const compensate = async (why: string, o: { keepHeld?: boolean } = {}): Promise<boolean> => {
    let allOk = true;
    for (const sc of [...outcome.scheduled].reverse()) {
      if (sc.withdrawn) continue;
      try {
        await act(`compensate:${sc.kind}:${sc.id}`, { kind: "sandbox.withdraw", target: sc.kind, id: sc.id }, `comp:${sc.kind}:${sc.id}`, { compensation: true });
        sc.withdrawn = true;
        outcome.compensated.push({ target: sc.kind, id: sc.id, ok: true });
      } catch {
        allOk = false;
        outcome.compensated.push({ target: sc.kind, id: sc.id, ok: false });
      }
    }
    for (const b of [...outcome.branches].reverse()) {
      // Batch 13: when a counterparty pushed back, the agreements already reached stay on hold so the owner can keep them.
      if (o.keepHeld && (b.status === "agreed" || b.status === "offered") && !b.withdrawn) continue;
      const live: { target: "thread" | "application"; id: string }[] = [];
      if (b.applicationId && !b.withdrawn && (b.status === "offered" || b.status === "committed")) live.push({ target: "application", id: b.applicationId });
      if (b.threadId && !b.withdrawn && (b.status === "agreed" || b.status === "committed")) live.push({ target: "thread", id: b.threadId });
      for (const t of live) {
        try {
          await act(`compensate:${t.target}:${t.id}`, { kind: "sandbox.withdraw", target: t.target, id: t.id }, `comp:${t.target}:${t.id}`, { compensation: true });
          b.withdrawn = true;
          outcome.compensated.push({ ...t, ok: true });
        } catch {
          allOk = false;
          outcome.compensated.push({ ...t, ok: false });
        }
      }
    }
    await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_COMPENSATED, actor: "executor", detail: { authorisationId, why, compensated: outcome.compensated, allOk } });
    await save();
    return allOk;
  };

  const finish = async (status: ExecutionResult["status"], verification: PlanVerification | null = null): Promise<ExecutionResult> => {
    return { authorisationId, executionId: exec.id, status, outcome, verification };
  };

  try {
    // 3a. Batch 13: agreements an earlier round of this deal kept on hold are taken over, not asked again, when the owner left the term unchanged.
    const carry = await loadCarry(db, row, runRow);
    const adopt = async (e: TermsEntry, b: Branch, request: GateRequestJson): Promise<boolean> => {
      const cand = carry.find((c) => !c.taken && canonicalize(c.lever) === canonicalize(e.lever));
      if (!cand) return false;
      const cb = cand.branch;
      if (e.lever.kind === "finance_invoice") {
        if (!cb.applicationId || request.kind !== "sandbox.submit_application") return false;
        const [a] = await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.id, cb.applicationId), eq(sandboxApplications.businessId, businessId)));
        if (!a || a.status !== "offered" || !cb.offer || a.requestedAmountMinor.toString() !== request.invoiceAmountMinor) return false;
        if (classifyOffer(e, { status: a.status, advanceBps: cb.offer.advanceBps, feeBps: cb.offer.feeBps }).verdict !== "offer_in_terms") return false;
        b.applicationId = cb.applicationId; b.offer = cb.offer; b.status = "offered";
      } else {
        if (!cb.threadId || !cb.agreedTerms) return false;
        const [t] = await db.select().from(sandboxThreads).where(and(eq(sandboxThreads.id, cb.threadId), eq(sandboxThreads.businessId, businessId)));
        if (!t || t.status !== "agreed") return false;
        const same = canonicalize(cb.agreedTerms) === canonicalize(Object.fromEntries(Object.entries(proposalTerms(e)).map(([k, v]) => [k, Number(v)])));
        const v = classifyProposalReply(e, { outcome: same ? "accept" : "counter", terms: cb.agreedTerms });
        if (v.verdict !== "agreed" && v.verdict !== "counter_in_terms") return false;
        b.threadId = cb.threadId; b.agreedTerms = cb.agreedTerms; b.status = "agreed";
      }
      b.proposalIds = [...cb.proposalIds];
      b.carriedFrom = cand.authId;
      cand.taken = true;
      cb.adopted = authorisationId;
      await db.update(planExecutions).set({ outcome: toJsonValue(cand.outcome) as Record<string, unknown> }).where(eq(planExecutions.id, cand.execId));
      await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_BRANCH_RESULT, actor: "executor", detail: { authorisationId, index: e.index, kind: e.lever.kind, counterpartyId: b.counterpartyId, status: b.status, reason: null, agreedTerms: b.agreedTerms ?? null, offer: b.offer ?? null, threadId: b.threadId ?? null, applicationId: b.applicationId ?? null, carriedFrom: cand.authId } });
      await save();
      return true;
    };

    // 3. Negotiate: one structured proposal per counterparty. Replies are classified from structured fields only.
    for (const e of terms.entries) {
      const b = branchFor(e);
      if (b.status !== "pending") continue; // resumed: this branch is already settled
      const key = `${e.index}`;
      let request = e.request;
      if (e.lever.kind === "finance_invoice") {
        // ADR-025: the buyer answered first (buyer levers sort before finance). If the buyer agreed to a different deposit, the invoice to
        // finance changes: re-submit for the recomputed amount, which the signed maximum covers (the gate and the coverage check still apply).
        const buyerEntry = terms.entries.find((x) => x.lever.kind === "buyer_request_deposit");
        const buyerBranch = buyerEntry ? outcome.branches.find((x) => x.index === buyerEntry.index) : undefined;
        const agreedPct = buyerBranch?.status === "agreed" ? buyerBranch.agreedTerms?.percentBps : undefined;
        if (buyerEntry && buyerEntry.lever.kind === "buyer_request_deposit" && agreedPct !== undefined && agreedPct !== buyerEntry.lever.percentBps && request.kind === "sandbox.submit_application") {
          const ctx = await buildContext(db, businessId, null);
          const inv = financedInvoiceMinor(ctx.pending.map((p) => p.event), [{ ...buyerEntry.lever, percentBps: agreedPct }]);
          if (inv) request = { ...request, invoiceAmountMinor: inv.amountMinor.toString() };
        }
      }
      if (await adopt(e, b, request)) continue;
      const sent = await act(`send:${e.index}`, request, `${key}:send`);
      b.proposalIds.push(sent.proposalId);
      let verdict: BranchVerdict;
      if (e.lever.kind === "finance_invoice") {
        const applicationId = sent.result.applicationId;
        if (!applicationId) throw new StepError(`send:${e.index}`, "The application result has no application id");
        b.applicationId = applicationId;
        const [a] = await db.select().from(sandboxApplications).where(eq(sandboxApplications.id, applicationId));
        const off = (a?.offer ?? null) as { response?: { outcome?: string; terms?: { advanceBps?: number | string; feeBps?: number | string } | null } } | null;
        const t = off?.response?.outcome === "offer" ? off.response.terms : null;
        const adv = t?.advanceBps !== undefined ? Number(t.advanceBps) : null;
        const fee = t?.feeBps !== undefined ? Number(t.feeBps) : null;
        verdict = classifyOffer(e, { status: a?.status ?? "missing", advanceBps: adv, feeBps: fee });
        if (verdict.verdict === "offer_in_terms" && adv !== null && fee !== null) b.offer = { advanceBps: adv, feeBps: fee };
      } else {
        b.threadId = sent.result.threadId;
        verdict = classifyProposalReply(e, { outcome: sent.result.outcome ?? "", terms: (sent.result.terms ?? null) as Record<string, unknown> | null });
        if (verdict.verdict === "counter_in_terms") {
          // A counter inside the signed bound: accept it by proposing exactly the countered terms (open question 17).
          const again = await act(`accept_counter:${e.index}`, verdict.counterRequest, `${key}:counter`);
          b.proposalIds.push(again.proposalId);
          b.threadId = again.result.threadId ?? b.threadId;
          const second = classifyProposalReply({ ...e, request: verdict.counterRequest }, { outcome: again.result.outcome ?? "", terms: (again.result.terms ?? null) as Record<string, unknown> | null });
          verdict = second.verdict === "agreed" ? { verdict: "agreed" } : { verdict: "out_of_terms", reason: "the counterparty did not confirm its own counter" };
          if (verdict.verdict === "agreed") b.agreedTerms = Object.fromEntries(Object.entries(again.result.terms ?? {}).map(([k, v]) => [k, Number(v)]));
        } else if (verdict.verdict === "agreed") {
          b.agreedTerms = Object.fromEntries(Object.entries(sent.result.terms ?? {}).map(([k, v]) => [k, Number(v)]));
        }
      }
      if (verdict.verdict === "agreed") b.status = "agreed";
      else if (verdict.verdict === "offer_in_terms") b.status = "offered";
      else {
        b.status = "needs_replan";
        b.reason = verdict.verdict === "rejected" || verdict.verdict === "out_of_terms" ? verdict.reason : "unexpected reply";
        // Learn ONLY from the structured fields of the reply (ADR-021).
        const learned = constraintFrom(e, verdict, (runRow?.round ?? 0) + 1);
        if (learned) outcome.constraints.push(learned);
      }
      await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_BRANCH_RESULT, actor: "executor", detail: { authorisationId, index: e.index, kind: e.lever.kind, counterpartyId: b.counterpartyId, status: b.status, reason: b.reason ?? null, agreedTerms: b.agreedTerms ?? null, offer: b.offer ?? null, threadId: b.threadId ?? null, applicationId: b.applicationId ?? null } });
      await save();
    }

    // Held agreements of the earlier round that this round did not take over (the term changed or was dropped) are withdrawn now.
    for (const c of carry.filter((x) => !x.taken && !x.released)) {
      c.released = true;
      await releaseHeld(db, c.authId);
    }

    // 4. Any branch without agreement: the plan cannot be carried out as authorised. Withdraw what is live and stop (8b re-plans).
    const stuck = outcome.branches.filter((b) => b.status === "needs_replan");
    if (stuck.length > 0) {
      const clean = await compensate("needs_replan", { keepHeld: true });
      outcome.held = outcome.branches.some((b) => (b.status === "agreed" || b.status === "offered") && !b.withdrawn);
      await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_NEEDS_REPLAN, actor: "executor", detail: { authorisationId, branches: outcome.branches.map((b) => ({ index: b.index, kind: b.kind, status: b.status, reason: b.reason ?? null, held: (b.status === "agreed" || b.status === "offered") && !b.withdrawn })), cleanState: clean, held: outcome.held, constraints: outcome.constraints } });
      await setLifecycle("needs_replan");
      if (!clean) {
        outcome.failure = { step: "compensate", reason: "a withdrawal failed after a branch needed a re-plan" };
        await save({ status: "failed", error: outcome.failure.reason, finished: true });
        return finish("failed");
      }
      await save({ status: "needs_replan", finished: true });
      return finish("needs_replan");
    }

    // 5. Commit: take up the finance advance. Only reached when every branch agreed inside the authorised terms.
    for (const b of outcome.branches.filter((x) => x.status === "offered")) {
      if (!b.applicationId) throw new StepError(`commit:${b.index}`, "No application to take up");
      const done = await act(`accept_offer:${b.index}`, { kind: "sandbox.accept_offer", applicationId: b.applicationId }, `${b.index}:accept`);
      b.proposalIds.push(done.proposalId);
      b.status = "committed";
      await save();
    }
    for (const b of outcome.branches.filter((x) => x.status === "agreed")) b.status = "committed";
    await save();

    // 5b. Schedule the payments and receipts the agreed terms imply: receipts first, then payments, each through the gate.
    // The gate projects the balance on each payment date from the engine and the receipts already scheduled (ADR-019).
    const { items } = await expectedScheduleFor(db, cur.auth, terms);
    for (const [n, item] of [...items].sort((a, b) => (a.kind === b.kind ? a.date.localeCompare(b.date) : a.kind === "receipt" ? -1 : 1)).entries()) {
      const payeeId = item.kind === "payment" ? await payeeFor(db, businessId, item.counterpartyId) : null;
      const request = itemToRequest(item, payeeId);
      if (!request) throw new StepError(`schedule:${n}`, `No approved payee or backing for the ${item.eventKind} ${item.kind}`);
      if (outcome.scheduled.some((x) => x.eventKind === item.eventKind && x.date === item.date && x.kind === item.kind)) continue;
      const done = await act(`schedule:${n}`, request, `sched:${item.kind}:${item.eventKind}:${item.date}`);
      const id = (item.kind === "payment" ? done.result.paymentId : done.result.receiptId) as string | undefined;
      if (!id) throw new StepError(`schedule:${n}`, "The scheduling result has no id");
      outcome.scheduled.push({ kind: item.kind, id, eventKind: item.eventKind, amountMinor: item.amountMinor.toString(), date: item.date });
      await save();
    }
    outcome.committed = true;
    await save();
    await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_COMPLETED, actor: "executor", detail: { authorisationId, branches: outcome.branches.map((b) => ({ index: b.index, kind: b.kind, status: b.status })) } });
  } catch (e) {
    // Any denial or failure: compensate so nothing is half applied, and say so.
    const step = e instanceof StepError ? e.step : "unexpected";
    const reason = e instanceof Error ? e.message : "failed";
    const b = outcome.branches.find((x) => step.endsWith(`:${x.index}`) && x.status === "pending");
    if (b) { b.status = "failed"; b.reason = reason.slice(0, 300); }
    outcome.failure = { step, reason: reason.slice(0, 500) };
    outcome.committed = false;
    const clean = await compensate(`failure at ${step}`);
    await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_EXECUTION_FAILED, actor: "executor", detail: { authorisationId, step, reason: outcome.failure.reason, rolledBack: clean, compensated: outcome.compensated } });
    await save({ status: clean ? "rolled_back" : "failed", error: outcome.failure.reason, finished: true });
    return finish(clean ? "rolled_back" : "failed");
  }

  // 6. Independent verification (a separate module that does not import this one). A failure is recorded loudly, never hidden.
  await db.update(planExecutions).set({ finishedAt: new Date() }).where(and(eq(planExecutions.id, exec.id), isNull(planExecutions.finishedAt)));
  const verification = await verifyPlanExecution(db, authorisationId);
  await setLifecycle(verification.ok ? "executed" : "verification_failed");
  return finish(verification.ok ? "completed" : "verification_failed", verification);
}
