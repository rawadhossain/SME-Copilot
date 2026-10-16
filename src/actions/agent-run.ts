// THE ORCHESTRATOR for the planning agent (ADR-015). It lives OUTSIDE src/agent because it writes to the database and to
// the action log. The agent itself (src/agent) is read-only: tools, prompts and validation over a snapshot. This file:
//   1. builds the read-only snapshot from the database (confirmed extractions only, mandate, gate state, counterparties),
//   2. runs the bounded tool loop through the gateway, persisting every step,
//   3. persists the validated plans, or builds deterministic plans if the AI path fails or leaves no valid plan,
//   4. logs agent.run_started, agent.plans_submitted, agent.run_failed to the hash-chained action log.
// It never creates action proposals, approvals, payments, threads or applications. Execution is Batch 8.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { appendActionRecord } from "@/actionlog";
import { ACTION_EVENTS, ActionError, type Db } from "./types";
import { loadGateState, loadSignedMandate } from "./state";
import { guardRanking, demoteBlocked, buildAgentTools, buildMessages, deterministicPlans, AGENT_PURPOSE, collectNumbers, doNothingSummary, type AgentToolContext, type PendingEvent } from "@/agent";
import { getGateway, type Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { agentRuns, agentSteps, counterparties, documents, extractions, fundingOffers, plans as plansTable } from "@/db/schema";
import { financingOfferSchema } from "@/domain/financing-offer";
import type { PlanView } from "@/domain/plan";
import { assumedFeeBps, type Constraint } from "@/domain/constraints";
import { shortageReasonSchema } from "@/domain/shortage";
import { FINANCE_FEE_BPS_ASSUMPTION } from "@/engine/plans";
import { canonicalize } from "@/gate/canonical";
import { loadEngineInput } from "@/engine/loader";
import { resolveParties } from "@/engine/plans";
import { mapExtractionToEvents } from "@/ingest/documents/map";
import { getExtractionById } from "@/ingest/documents/store";
import type { ExtractionResult } from "@/ingest/documents/validate";
import { toJsonValue } from "@/sandbox/proposals";

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("commitment"), extractionId: z.string().uuid() }),
  z.object({ type: z.literal("shortage"), variant: z.enum(["baseline", "downside"]).default("baseline"), reason: shortageReasonSchema.optional() }),
]);
export type Trigger = z.output<typeof triggerSchema>;

export const PLANNING_HORIZON_WEEKS = 20;

/** Limits for the tool loop (environment-configurable). */
export function agentLimits(env: Record<string, string | undefined> = process.env) {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxSteps: n(env.AGENT_MAX_STEPS, 12),
    maxToolCallsPerStep: n(env.AGENT_MAX_TOOL_CALLS_PER_STEP, 8),
    timeoutMs: n(env.AGENT_TIMEOUT_MS, 60_000),
    tokenBudget: n(env.AGENT_TOKEN_BUDGET, 100_000),
  };
}

export interface RunOptions {
  gateway?: Gateway;
  /** Test hook: a different scripted agent (purpose id). */
  purposeId?: string;
  /** Skip the AI path and use the deterministic planner. */
  forceFallback?: boolean;
  limits?: Partial<ReturnType<typeof agentLimits>>;
  /** Re-planning (ADR-021): the run this one re-plans, its round, and the structured constraints it must respect. */
  replan?: { parentRunId: string; round: number; constraints: Constraint[] };
}

export interface RunSummary {
  runId: string;
  status: "completed" | "failed" | "refused";
  planSource: "ai" | "deterministic" | "none";
  plans: PlanView[];
  note: string | null;
  error: string | null;
}

/** Newest confirmed extraction per distinct document, as read-only events with stable refs. */
async function loadPending(db: Db, businessId: string, mustInclude: string | null): Promise<PendingEvent[]> {
  const rows = await db
    .select({ ex: extractions, doc: documents })
    .from(extractions)
    .innerJoin(documents, eq(documents.id, extractions.documentId))
    .where(and(eq(extractions.businessId, businessId), eq(extractions.status, "confirmed")))
    .orderBy(desc(extractions.confirmedAt), desc(extractions.createdAt));
  const seen = new Set<string>();
  const events: Omit<PendingEvent, "ref">[] = [];
  for (const { ex, doc } of rows) {
    if (seen.has(doc.sha256)) continue;
    seen.add(doc.sha256);
    for (const event of mapExtractionToEvents(ex.result as unknown as ExtractionResult, { status: "confirmed", filename: doc.filename })) events.push({ extractionId: ex.id, event });
  }
  if (mustInclude && !events.some((e) => e.extractionId === mustInclude)) throw new ActionError("conflict", "The triggering extraction is superseded by a newer confirmation of the same document");
  events.sort((a, b) => a.event.date.localeCompare(b.event.date) || a.event.kind.localeCompare(b.event.kind));
  return events.map((e, i) => ({ ...e, ref: `pc${i + 1}` }));
}

export async function buildContext(db: Db, businessId: string, mustInclude: string | null, constraints: Constraint[] = []): Promise<AgentToolContext> {
  const input = await loadEngineInput(db, businessId, undefined, PLANNING_HORIZON_WEEKS);
  if (!input) throw new ActionError("not_found", "Business not found");
  const pending = await loadPending(db, businessId, mustInclude);
  const cps = await db.select({ id: counterparties.id, name: counterparties.name, role: counterparties.role }).from(counterparties).where(eq(counterparties.businessId, businessId)).orderBy(asc(counterparties.name));
  const events = pending.map((p) => p.event);
  // Funding offers the owner saved (validated again on the way in; a row that no longer validates is left out).
  const offerRows = await db.select({ offer: fundingOffers.offer }).from(fundingOffers).where(and(eq(fundingOffers.businessId, businessId), isNull(fundingOffers.archivedAt))).orderBy(asc(fundingOffers.createdAt), asc(fundingOffers.label));
  const savedOffers = offerRows.flatMap((r) => { const p = financingOfferSchema.safeParse(r.offer); return p.success ? [p.data] : []; });
  const seen = new Set<string>();
  collectNumbers(pending.map((p) => ({ amountMinor: p.event.amountMinor.toString(), date: p.event.date })), seen);
  return {
    businessId, asOf: input.asOf, currency: input.currency, horizonWeeks: PLANNING_HORIZON_WEEKS, input, pending,
    counterparties: cps, parties: resolveParties(events, cps), mandate: await loadSignedMandate(db, businessId), gateState: await loadGateState(db, businessId),
    constraints, financeFeeBps: assumedFeeBps(constraints, FINANCE_FEE_BPS_ASSUMPTION), shortage: null,
    ...(savedOffers.length > 0 ? { fundingOffers: savedOffers } : {}),
    seen, notes: [], submitted: null,
  };
}

export async function startRun(db: Db, businessId: string, triggerInput: unknown, opts: RunOptions = {}): Promise<RunSummary> {
  const trigger = triggerSchema.parse(triggerInput);
  const gw = opts.gateway ?? getGateway();
  const [run] = await db.insert(agentRuns).values({ businessId, trigger, status: "running", model: gw.config.model || "mock", mode: `${gw.config.provider}/${gw.config.mode}`, parentRunId: opts.replan?.parentRunId ?? null, round: opts.replan?.round ?? 0, constraints: JSON.parse(JSON.stringify(opts.replan?.constraints ?? [])) }).returning();
  let seq = 0;
  const step = async (kind: "llm_message" | "tool_call" | "tool_result" | "validation" | "note", payload: unknown) => {
    await db.insert(agentSteps).values({ businessId, runId: run.id, seq: ++seq, kind, payload: toJsonValue(payload) as Record<string, unknown> });
  };
  await appendActionRecord(db, { businessId, event: ACTION_EVENTS.AGENT_RUN_STARTED, actor: "agent", detail: { runId: run.id, trigger, parentRunId: opts.replan?.parentRunId ?? null, round: opts.replan?.round ?? 0, constraints: opts.replan?.constraints ?? [] } });

  const finish = async (status: "completed" | "failed" | "refused", planSource: "ai" | "deterministic" | "none", error: string | null) => {
    await db.update(agentRuns).set({ status, planSource, finishedAt: new Date(), error }).where(eq(agentRuns.id, run.id));
  };

  try {
    // A commitment trigger needs a confirmed extraction; a shortage trigger plans around whatever is confirmed now (ADR-026).
    let mustInclude: string | null = null;
    if (trigger.type === "commitment") {
      const { row } = await getExtractionById(db, trigger.extractionId).catch(() => ({ row: null }));
      if (!row || row.businessId !== businessId) {
        const error = "The extraction does not exist for this business";
        await step("note", { type: "refused", reason: error });
        await finish("refused", "none", error);
        return { runId: run.id, status: "refused", planSource: "none", plans: [], note: null, error };
      }
      if (row.status !== "confirmed") {
        const error = `The extraction is ${row.status}; only a confirmed extraction can start a plan. Ask the owner to confirm it first.`;
        await step("note", { type: "refused", reason: error });
        await finish("refused", "none", error);
        return { runId: run.id, status: "refused", planSource: "none", plans: [], note: null, error };
      }
      mustInclude = row.id;
    }

    const ctx = await buildContext(db, businessId, mustInclude, opts.replan?.constraints ?? []);
    if (trigger.type === "shortage") ctx.shortage = trigger.reason ?? null;
    await step("note", { type: "context", asOf: ctx.asOf, horizonWeeks: ctx.horizonWeeks, pending: ctx.pending.map((p) => ({ ref: p.ref, kind: p.event.kind, date: p.event.date, amountMinor: p.event.amountMinor.toString() })), mandateSigned: ctx.mandate !== null });

    // 1. The AI path (bounded tool loop through the gateway).
    let aiError: string | null = null;
    if (!opts.forceFallback) {
      const limits = { ...agentLimits(), ...opts.limits };
      try {
        const result = await gw.generateAgentLoop(buildMessages(ctx), buildAgentTools(ctx), {
          purposeId: opts.purposeId ?? AGENT_PURPOSE, businessId, logger: dbCallLogger, stopWhenToolOk: "submit_plans", ...limits,
          idAliases: Object.fromEntries(ctx.counterparties.map((c) => [c.id, c.name])),
          onEvent: (e) => step(e.kind, e),
        });
        await step("note", { type: "loop_finished", steps: result.steps, toolCalls: result.toolCalls, stopped: result.stopped });
      } catch (e) {
        aiError = e instanceof Error ? `${e.name}` : "error";
        await step("note", { type: "ai_unavailable", error: aiError, detail: e instanceof Error && e.name === "LlmRecordingMissingError" ? "no recording for this request" : undefined });
      }
      for (const n of ctx.notes) await step("validation", n);
    }

    // 2. Persist the plans: the AI plans if any were valid, else the deterministic fallback.
    let plans: PlanView[] = ctx.submitted ?? [];
    let source: "ai" | "deterministic" | "none" = plans.length > 0 ? "ai" : "none";
    let note: string | null = null;
    if (plans.length === 0) {
      const fb = deterministicPlans(ctx);
      plans = fb.plans;
      source = plans.length > 0 ? "deterministic" : "none";
      note = `${opts.forceFallback ? "Deterministic planner used." : aiError ? "The AI path was unavailable; the deterministic planner was used." : "The AI path left no valid plan; the deterministic planner was used."} ${fb.note}`;
      await step("note", { type: "fallback", note });
    }
    if (source === "ai") {
      const g = guardRanking(ctx, plans);
      plans = g.plans;
      for (const n of g.notes) await step("validation", n);
    }
    plans = demoteBlocked(plans); // either source: a plan that cannot run is never ranked above one that can
    await step("note", { type: "do_nothing", metrics: doNothingSummary(ctx) });
    if (plans.length > 0) {
      await db.insert(plansTable).values(plans.map((p, i) => ({ businessId, runId: run.id, planHash: p.id, rank: i + 1, plan: toJsonValue(p) as Record<string, unknown> })));
      await appendActionRecord(db, {
        businessId, event: ACTION_EVENTS.AGENT_PLANS_SUBMITTED, actor: "agent",
        detail: { runId: run.id, source, planIds: plans.map((p) => p.id), plansHash: createHash("sha256").update(canonicalize(toJsonValue(plans)), "utf8").digest("hex"), count: plans.length },
      });
    }
    await finish("completed", source, null);
    return { runId: run.id, status: "completed", planSource: source, plans, note, error: null };
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "Run failed";
    await step("note", { type: "failed", error: e instanceof Error ? e.name : "error" }).catch(() => undefined);
    await finish("failed", "none", message).catch(() => undefined);
    await appendActionRecord(db, { businessId, event: ACTION_EVENTS.AGENT_RUN_FAILED, actor: "agent", detail: { runId: run.id, error: e instanceof Error ? e.name : "error" } }).catch(() => undefined);
    return { runId: run.id, status: "failed", planSource: "none", plans: [], note: null, error: message };
  }
}

// ---------------------------------------------------------------- reads

export async function getRun(db: Db, runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, z.string().uuid().parse(runId)));
  if (!run) return null;
  const steps = await db.select().from(agentSteps).where(and(eq(agentSteps.businessId, run.businessId), eq(agentSteps.runId, run.id))).orderBy(asc(agentSteps.seq));
  const planRows = await db.select().from(plansTable).where(and(eq(plansTable.businessId, run.businessId), eq(plansTable.runId, run.id))).orderBy(asc(plansTable.rank));
  return toJsonValue({ run, steps, plans: planRows.map((p) => ({ id: p.id, rank: p.rank, status: p.status, plan: p.plan })) });
}

export async function listRuns(db: Db, businessId: string) {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.businessId, businessId)).orderBy(desc(agentRuns.startedAt)).limit(30);
  return toJsonValue(rows);
}
