// READ MODELS for the decision-room UI (Batch 10). Everything the screens show is computed here from the engine, the sandbox and the
// hash-chained log; no model prose supplies a number. Writes nothing.
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, agentSteps, businesses, counterparties, plans, planAuthorisations, sandboxBankAccounts } from "@/db/schema";
import type { Lever, PlanView } from "@/domain/plan";
import { adjustmentsOf, applyTermChanges, attributeDrivers, buildForecast, FINANCE_FEE_BPS_ASSUMPTION, simulateLevers, type Forecast } from "@/engine";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext } from "./agent-run";
import { getMandateInfo } from "./read";
import { getPlanAuthorisation } from "./plan-read";
import { changesFromRecorded, recordedBranches } from "./plan-schedule";
import { detectShortage } from "./shortage";
import type { PlanTerms } from "./plan-terms";
import { ActionError, type Db } from "./types";

const weeksOf = (f: Forecast) => f.weeks.map((w) => ({ index: w.index + 1, start: w.start, end: w.end, opening: w.opening.toString(), inflow: w.inflow.toString(), outflow: w.outflow.toString(), closing: w.closing.toString(), belowReserve: w.belowReserve }));
const lineOf = (f: Forecast) => ({
  weeks: weeksOf(f), minBalanceMinor: f.minimum.amount.toString(), minBalanceWeek: f.minimum.weekIndex + 1,
  firstNegativeWeek: f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null, weeksBelowZero: f.weeksBelowZero.length, closingMinor: f.weeks[f.weeks.length - 1].closing.toString(),
});

/** The cash desk: balance, shortage state, commitments, mandate, and the do-nothing forecast with the confirmed commitments. */
export async function getRoom(db: Db, businessId: string) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const ctx = await buildContext(db, businessId, null);
  const [bank] = await db.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.businessId, businessId)).orderBy(asc(sandboxBankAccounts.name)).limit(1);
  const f = buildForecast(ctx.input, { events: ctx.pending.map((p) => p.event), horizonWeeks: ctx.horizonWeeks });
  const booksOnly = buildForecast(ctx.input, { events: [], horizonWeeks: ctx.horizonWeeks });
  const detection = await detectShortage(db, businessId);
  const mandate = await getMandateInfo(db, businessId).catch(() => null);
  // What is causing the gap: each driver removed on its own, ranked (deterministic; same engine as the forecast).
  const drivers = detection.shortage
    ? attributeDrivers(ctx.input, { events: ctx.pending.map((p) => p.event), horizonWeeks: ctx.horizonWeeks }).drivers
        .slice(0, 4).map((d) => ({ kind: d.kind, label: d.label, effectMinor: d.effectOnMinimum.toString() }))
    : [];
  return toJsonValue({
    drivers,
    business: { id: biz.id, name: biz.name, currency: biz.baseCurrency, isSynthetic: biz.isSynthetic, isTest: biz.isTest },
    asOf: ctx.asOf, reserveMinor: biz.reserveMinor,
    balances: { booksMinor: ctx.input.openingBalance, sandboxBankMinor: bank?.balanceMinor ?? null },
    forecast: lineOf(f), booksOnly: lineOf(booksOnly), horizonWeeks: ctx.horizonWeeks,
    shortage: detection,
    commitments: ctx.pending.map((p) => ({ ref: p.ref, kind: p.event.kind, date: p.event.date, amountMinor: p.event.amountMinor, confidence: p.event.confidence, label: p.event.label, extractionId: p.extractionId })),
    mandate,
  });
}

/** Weekly lines for the chart: do nothing, the selected plan (what the engine says it promises), and the executed outcome of the AGREED terms. */
export async function getRoomForecast(db: Db, businessId: string, q: { runId?: string; planId?: string; authorisationId?: string }) {
  let constraints: never[] = [];
  let run;
  if (q.runId) {
    [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, z.string().uuid().parse(q.runId)), eq(agentRuns.businessId, businessId)));
    constraints = ((run?.constraints ?? []) as never[]);
  }
  const ctx = await buildContext(db, businessId, null, constraints);
  const base = ctx.pending.map((p) => p.event);
  const out: Record<string, unknown> = {
    reserveMinor: ctx.input.reserve, asOf: ctx.asOf, currency: ctx.currency,
    doNothing: lineOf(buildForecast(ctx.input, { events: base, horizonWeeks: ctx.horizonWeeks })),
  };
  if (q.runId && q.planId) {
    const [row] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, q.runId), eq(plans.planHash, q.planId)));
    if (row) {
      const view = row.plan as unknown as PlanView;
      const sim = simulateLevers(ctx.input, base, view.levers as Lever[], { horizonWeeks: ctx.horizonWeeks, financeFeeBps: view.financeFeeBps ?? FINANCE_FEE_BPS_ASSUMPTION });
      out.plan = lineOf(sim.forecast);
    }
  }
  if (q.authorisationId) {
    const [auth] = await db.select().from(planAuthorisations).where(and(eq(planAuthorisations.id, q.authorisationId), eq(planAuthorisations.businessId, businessId)));
    if (auth) {
      const terms = auth.terms as PlanTerms;
      const changes = changesFromRecorded(terms.entries, await recordedBranches(db, businessId, auth.id));
      const events = Object.keys(changes).length > 0 ? applyTermChanges(base, changes) : base;
      out.agreed = lineOf(buildForecast(ctx.input, { events, horizonWeeks: ctx.horizonWeeks, adjustments: adjustmentsOf(changes) }));
    }
  }
  return toJsonValue(out);
}

// ---------------------------------------------------------------- cases (a root planning run and its re-plans)

const TOOL_LABEL: Record<string, string> = {
  get_business_overview: "Read the business overview", get_forecast: "Read the forecast", get_pending_commitments: "Read the confirmed commitments",
  run_scenario: "Ran a scenario", explain_gap: "Explained the gap", get_counterparties: "Looked up counterparties", list_levers: "Listed the levers and your limits",
  simulate_levers: "Simulated a set of levers", search_plans: "Searched the lever combinations", check_plan_feasibility: "Checked a plan against your mandate", submit_plans: "Submitted plans",
};

function stepLabel(kind: string, p: Record<string, unknown>): { label: string; tone: "neutral" | "good" | "caution" | "danger" } {
  if (kind === "tool_call") return { label: TOOL_LABEL[String(p.toolName)] ?? `Used ${String(p.toolName)}`, tone: "neutral" };
  if (kind === "tool_result") return { label: p.ok === false || (p.output as { ok?: boolean } | undefined)?.ok === false ? "A tool reported a problem (returned to the planner as data)" : "Tool result received", tone: "neutral" };
  if (kind === "validation") return { label: (p as { accepted?: boolean }).accepted === false ? "A draft plan failed a validation check; the planner revised it" : "Plans validated", tone: (p as { accepted?: boolean }).accepted === false ? "caution" : "good" };
  if (kind === "llm_message") return { label: "The planner reasoned", tone: "neutral" };
  const t = String(p.type);
  const note: Record<string, [string, "neutral" | "good" | "caution" | "danger"]> = {
    context: ["Read the confirmed commitments and your limits", "neutral"], loop_finished: ["Planner finished", "good"], fallback: ["The deterministic planner was used", "caution"],
    ai_unavailable: ["The AI planner was unavailable; fallback used", "caution"], do_nothing: ["Computed the do-nothing baseline", "neutral"], shortage_trigger: ["Shortage trigger", "neutral"], owner_revision: ["You revised the terms after a counterparty pushed back", "good"],
    refused: ["The run was refused", "danger"], failed: ["The run failed", "danger"],
  };
  const [label, tone] = note[t] ?? [t, "neutral"];
  return { label, tone };
}

export async function listCases(db: Db, businessId: string) {
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.businessId, businessId)).orderBy(asc(agentRuns.startedAt));
  return toJsonValue(runs.map((r) => ({ runId: r.id, parentRunId: r.parentRunId, round: r.round, status: r.status, lifecycle: r.lifecycle, startedAt: r.startedAt, trigger: { type: (r.trigger as { type: string }).type } })));
}

export async function getCase(db: Db, businessId: string, rootInput: string) {
  const rootId = z.string().uuid().parse(rootInput);
  const all = await db.select().from(agentRuns).where(eq(agentRuns.businessId, businessId)).orderBy(asc(agentRuns.startedAt));
  const root = all.find((r) => r.id === rootId);
  if (!root) throw new ActionError("not_found", "Unknown case");
  const chain: typeof all = [];
  const walk = (id: string) => { const r = all.find((x) => x.id === id); if (r) { chain.push(r); all.filter((c) => c.parentRunId === id).forEach((c) => walk(c.id)); } };
  walk(rootId);
  const ids = chain.map((r) => r.id);
  const steps = await db.select().from(agentSteps).where(inArray(agentSteps.runId, ids)).orderBy(asc(agentSteps.seq));
  const planRows = await db.select().from(plans).where(inArray(plans.runId, ids)).orderBy(asc(plans.rank));
  const auths = await db.select().from(planAuthorisations).where(inArray(planAuthorisations.runId, ids)).orderBy(asc(planAuthorisations.createdAt));
  const authViews = await Promise.all(auths.map((a) => getPlanAuthorisation(db, a.id)));
  const runs = chain.map((r) => {
    const mySteps = steps.filter((s) => s.runId === r.id);
    const doNothing = mySteps.find((s) => s.kind === "note" && (s.payload as { type?: string }).type === "do_nothing");
    const fallback = mySteps.some((s) => s.kind === "note" && ["fallback", "ai_unavailable"].includes(String((s.payload as { type?: string }).type)));
    return {
      id: r.id, parentRunId: r.parentRunId, successorRunId: r.successorRunId, round: r.round, status: r.status, lifecycle: r.lifecycle, planSource: r.planSource, model: r.model, mode: r.mode,
      startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error, constraints: r.constraints, trigger: r.trigger, fallbackUsed: fallback,
      doNothing: (doNothing?.payload as { metrics?: unknown } | undefined)?.metrics ?? null,
      timeline: mySteps.map((s) => ({ seq: s.seq, kind: s.kind, ...stepLabel(s.kind, s.payload as Record<string, unknown>), at: s.createdAt })),
      plans: planRows.filter((p) => p.runId === r.id).map((p) => ({ id: p.planHash, rank: p.rank, plan: p.plan })),
    };
  });
  const cps = await db.select({ id: counterparties.id, name: counterparties.name, role: counterparties.role }).from(counterparties).where(eq(counterparties.businessId, businessId));
  return toJsonValue({ rootRunId: rootId, runs, authorisations: authViews.filter(Boolean), counterparties: cps });
}
