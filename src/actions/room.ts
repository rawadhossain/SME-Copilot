// READ MODELS for the decision-room UI (Batch 10). Everything the screens show is computed here from the engine, the sandbox and the
// hash-chained log; no model prose supplies a number. Writes nothing.
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, agentSteps, businesses, counterparties, plans, planAuthorisations, sandboxBankAccounts } from "@/db/schema";
import type { Lever, PlanView } from "@/domain/plan";
import { adjustmentsOf, applyTermChanges, attributeDrivers, buildForecast, FINANCE_FEE_BPS_ASSUMPTION, isForecast, owedOf, simulateLevers, addDays, type Forecast } from "@/engine";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext } from "./agent-run";
import { getMandateInfo } from "./read";
import { getPlanAuthorisation } from "./plan-read";
import { changesFromRecorded, recordedBranches } from "./plan-schedule";
import { currentAgreedChanges, detectShortage } from "./shortage";
import type { PlanTerms } from "./plan-terms";
import { ActionError, type Db } from "./types";

const weeksOf = (f: Forecast) => f.weeks.map((w) => ({ index: w.index + 1, start: w.start, end: w.end, opening: w.opening.toString(), inflow: w.inflow.toString(), outflow: w.outflow.toString(), closing: w.closing.toString(), belowReserve: w.belowReserve }));
const lineOf = (f: Forecast) => ({
  weeks: weeksOf(f), minBalanceMinor: f.minimum.amount.toString(), minBalanceWeek: f.minimum.weekIndex + 1,
  firstNegativeWeek: f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null, weeksBelowZero: f.weeksBelowZero.length, closingMinor: f.weeks[f.weeks.length - 1].closing.toString(),
});

/** What the owner could do to make the forecast firmer: plain facts from the records, nothing guessed. Pure. */
export function dataGapsOf(i: { reserveMinor: bigint; bankMinor: bigint | null; booksMinor: bigint; lowConfidence: number }): string[] {
  const gaps: string[] = [];
  if (i.reserveMinor === 0n) gaps.push("No safety cushion is set, so you are only warned when cash would go below zero.");
  if (i.bankMinor !== null && i.bankMinor !== i.booksMinor) gaps.push("The practice bank and your books show different balances. The forecast starts from your books.");
  if (i.lowConfidence > 0) gaps.push(`${i.lowConfidence} confirmed order${i.lowConfidence === 1 ? " is" : "s are"} marked low confidence. Check its dates and amounts.`);
  return gaps;
}

/** Invoices and bills at a glance for the Today page: what is overdue and what falls due soon. Only what the forecast still waits for. Pure. */
export function ledgerGlance(input: { asOf: string; currency: string; invoices: Parameters<typeof isForecast>[0][]; bills: Parameters<typeof isForecast>[0][] }) {
  const sum = (rows: Parameters<typeof owedOf>[0][]) => rows.reduce((a, r) => a + owedOf(r), 0n);
  const inv = input.invoices.filter(isForecast);
  const overdue = inv.filter((i) => i.dueOn < input.asOf);
  const soon = input.bills.filter(isForecast).filter((b) => b.dueOn <= addDays(input.asOf, 14));
  return { overdueCount: overdue.length, overdueMinor: sum(overdue), billsDueSoonCount: soon.length, billsDueSoonMinor: sum(soon), openInvoiceCount: inv.length, openInvoiceMinor: sum(inv) };
}

/** The cash desk: balance, shortage state, commitments, mandate, and the do-nothing forecast with the confirmed commitments. */
export interface RoomOptions {
  /** "What if customers pay this many days late": adds a downside line to the same picture (1 to 90 days). */
  lateDays?: number;
}

export async function getRoom(db: Db, businessId: string, opts: RoomOptions = {}) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const ctx = await buildContext(db, businessId, null);
  const [bank] = await db.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.businessId, businessId)).orderBy(asc(sandboxBankAccounts.name)).limit(1);
  const f = buildForecast(ctx.input, { events: ctx.pending.map((p) => p.event), horizonWeeks: ctx.horizonWeeks });
  const booksOnly = buildForecast(ctx.input, { events: [], horizonWeeks: ctx.horizonWeeks });
  const detection = await detectShortage(db, businessId);
  // The terms already agreed with customers, suppliers and lenders change the picture (the same view the shortage check uses): when there are
  // any, the screen leads with this forecast and keeps "do nothing" as a comparison.
  const pendingEvents = ctx.pending.map((p) => p.event);
  const agreedChanges = await currentAgreedChanges(db, businessId);
  let agreed: ReturnType<typeof lineOf> | null = null;
  let headlineEvents = pendingEvents; // what the headline forecast is built from
  let headlineAdjustments = undefined as ReturnType<typeof adjustmentsOf> | undefined;
  if (Object.keys(agreedChanges).length > 0) {
    try {
      headlineEvents = applyTermChanges(pendingEvents, agreedChanges);
      headlineAdjustments = adjustmentsOf(agreedChanges);
      agreed = lineOf(buildForecast(ctx.input, { events: headlineEvents, horizonWeeks: ctx.horizonWeeks, adjustments: headlineAdjustments }));
    } catch {
      agreed = null; // an agreed term that no longer fits the confirmed order is ignored rather than guessed
      headlineEvents = pendingEvents;
      headlineAdjustments = undefined;
    }
  }
  // Downside: every customer payment that is an estimate arrives later by this many days (the engine's downside variant).
  const lateDays = opts.lateDays && opts.lateDays >= 1 && opts.lateDays <= 90 ? Math.floor(opts.lateDays) : null;
  const downside = lateDays === null ? null : { days: lateDays, ...lineOf(buildForecast(ctx.input, { events: headlineEvents, horizonWeeks: ctx.horizonWeeks, adjustments: headlineAdjustments, downsideDelayDays: lateDays })) };
  const mandate = await getMandateInfo(db, businessId).catch(() => null);
  // The forecast the headline shows (the agreed terms when there are any). Drivers, the basis and the gaps all describe THIS forecast.
  const headlineOptions = { events: headlineEvents, horizonWeeks: ctx.horizonWeeks, adjustments: headlineAdjustments };
  const headline = buildForecast(ctx.input, headlineOptions);
  // What is causing the gap: each driver removed on its own, ranked (deterministic; same engine as the forecast). Each carries the record it
  // comes from (date and amount of the commitment, or how many invoices a late-paying customer holds back) so the owner can trace it.
  const drivers = detection.shortage
    ? attributeDrivers(ctx.input, headlineOptions).drivers.filter((d) => d.effectOnMinimum > 0n).slice(0, 4).map((d) => {
        const idx = d.kind === "event" ? Number(d.refs.find((r) => /^event:\d+$/.test(r))?.slice(6)) : NaN;
        const ev = Number.isInteger(idx) ? headlineEvents[idx] : undefined;
        return {
          kind: d.kind, label: d.label, effectMinor: d.effectOnMinimum.toString(), shareBps: d.shareOfShortfallBps,
          date: ev?.date ?? null, amountMinor: ev ? ev.amountMinor.toString() : null, confidence: ev?.confidence ?? null,
          invoiceCount: d.kind === "counterparty_delay" ? d.refs.length : null,
          // The invoices behind a late-paying customer, so the owner can open them.
          documents: d.kind === "counterparty_delay" ? d.refs.flatMap((r) => { const inv = ctx.input.invoices.find((i) => i.id === r); return inv ? [{ kind: "invoice" as const, id: inv.id, number: inv.number, counterpartyName: inv.counterpartyName }] : []; }).slice(0, 5) : [],
        };
      })
    : [];
  // What the forecast is built from, up to the week of the lowest balance, by how certain each figure is (the engine's own provenance tag).
  const upToLowest = headline.items.filter((it) => it.weekIndex <= headline.minimum.weekIndex);
  const basis = (["actual", "confirmed", "estimate", "assumption"] as const).map((k) => {
    const rows = upToLowest.filter((it) => it.kind === k);
    return { kind: k, count: rows.length, inMinor: rows.filter((r) => r.amount > 0n).reduce((a, r) => a + r.amount, 0n).toString(), outMinor: rows.filter((r) => r.amount < 0n).reduce((a, r) => a - r.amount, 0n).toString() };
  });
  const abs = (n: bigint) => (n < 0n ? -n : n);
  const documentRef = (it: { sourceType: string; sourceId: string }) => (it.sourceType === "invoice" || it.sourceType === "bill" ? { kind: it.sourceType as "invoice" | "bill", id: it.sourceId } : null);
  const lowestWeekItems = headline.items.filter((it) => it.weekIndex === headline.minimum.weekIndex)
    .sort((a, b) => (abs(a.amount) < abs(b.amount) ? 1 : abs(a.amount) > abs(b.amount) ? -1 : 0))
    .slice(0, 5).map((it) => ({ date: it.date, label: it.label, amountMinor: it.amount.toString(), kind: it.kind, note: it.note ?? null, document: documentRef(it) }));
  // The invoices and bills that make up the money in and out up to the lowest point, biggest first, each with a link to its record.
  const causeDocuments = upToLowest.filter((it) => it.sourceType === "invoice" || it.sourceType === "bill").sort((a, b) => (abs(a.amount) < abs(b.amount) ? 1 : abs(a.amount) > abs(b.amount) ? -1 : 0)).slice(0, 6)
    .map((it) => ({ date: it.date, label: it.label, amountMinor: it.amount.toString(), kind: it.kind, note: it.note ?? null, document: documentRef(it) }));
  // What the owner can do to make the forecast firmer. Plain facts from the records, nothing guessed.
  const gaps = dataGapsOf({ reserveMinor: BigInt(biz.reserveMinor), bankMinor: bank ? BigInt(bank.balanceMinor) : null, booksMinor: ctx.input.openingBalance, lowConfidence: ctx.pending.filter((p) => p.event.confidence === "low").length });
  const notes: string[] = [];
  if (basis[2].count > 0) notes.push("Some money is expected rather than confirmed, for example customers who usually pay after the due date. Those dates are estimates, not promises.");
  return toJsonValue({
    drivers, causeDocuments, ledger: ledgerGlance(ctx.input), basis: { throughWeek: headline.minimum.weekIndex + 1, rows: basis, lowestWeekItems }, gaps, notes,
    business: { id: biz.id, name: biz.name, currency: biz.baseCurrency, isSynthetic: biz.isSynthetic, isTest: biz.isTest },
    asOf: ctx.asOf, reserveMinor: biz.reserveMinor,
    balances: { booksMinor: ctx.input.openingBalance, sandboxBankMinor: bank?.balanceMinor ?? null },
    forecast: lineOf(f), agreed, downside, booksOnly: lineOf(booksOnly), horizonWeeks: ctx.horizonWeeks,
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
    adaptation: ["Weighed the replies and chose the next step", "good"], refused: ["The run was refused", "danger"], failed: ["The run failed", "danger"],
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
      adaptation: (mySteps.filter((s) => s.kind === "note" && (s.payload as { type?: string }).type === "adaptation").at(-1)?.payload as { report?: unknown } | undefined)?.report ?? null,
      timeline: mySteps.map((s) => ({ seq: s.seq, kind: s.kind, ...stepLabel(s.kind, s.payload as Record<string, unknown>), at: s.createdAt })),
      plans: planRows.filter((p) => p.runId === r.id).map((p) => ({ id: p.planHash, rank: p.rank, plan: p.plan })),
    };
  });
  const cps = await db.select({ id: counterparties.id, name: counterparties.name, role: counterparties.role }).from(counterparties).where(eq(counterparties.businessId, businessId));
  return toJsonValue({ rootRunId: rootId, runs, authorisations: authViews.filter(Boolean), counterparties: cps });
}
