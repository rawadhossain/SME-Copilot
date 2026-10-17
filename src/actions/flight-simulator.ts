// FINANCIAL FLIGHT SIMULATOR (orchestrator). Reads the business as it is now (books, confirmed orders, agreements in force, what counterparties have
// already said, signed limits), applies the owner's hypothetical events to an in-memory COPY, recomputes the whole forecast and every candidate
// strategy with the existing engine and planner, and reports. It is read-only by construction: it calls no write operation on the books, the
// sandbox, the gate, approvals or executions; the only write is one log record (a fingerprint of the scenario and the headline outcome).
// Everything it returns is HYPOTHETICAL. It is never stored as a plan, never carries a verification, and cannot be signed: acting on a
// strategy means running the real planner, then the owner's signed review (Review and sign), the gate, the sandbox and the independent check.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appendRecord } from "./log";
import { evaluateFlight, coordinateForContext, type FlightEvaluation } from "@/agent";
import { formatMinor } from "@/agent/plan-builder";
import type { AgentToolContext } from "@/agent";
import { sandboxReceipts } from "@/db/schema";
import { mergeConstraints } from "@/domain/constraints";
import type { Lever } from "@/domain/plan";
import { adjustmentsOf, applyShocks, applyTermChanges, attributeShocks, buildForecast, changedItems, MAX_LATE_DAYS, MAX_SHOCKS, ShockError, viewOf, type Forecast, type ForecastView, type Shock } from "@/engine";
import { parseDecimalToMinor, MoneyParseError } from "@/lib/money";
import { buildContext } from "./agent-run";
import { loadKnownConstraints } from "./negotiation-memory";
import { currentAgreedChanges } from "./shortage";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };

// ---------------------------------------------------------------- input

const id = z.string().uuid();
const shockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("customer_late"), counterpartyId: id, days: z.number().int().min(1).max(MAX_LATE_DAYS) }),
  z.object({ kind: z.literal("customer_short"), counterpartyId: id, shortBps: z.number().int().min(1).max(10000) }),
  z.object({ kind: z.literal("supplier_refuses"), counterpartyId: id, lever: z.enum(["supplier_defer_balance", "supplier_reduce_deposit", "both"]) }),
  z.object({ kind: z.literal("unexpected_expense"), amount: z.string().trim().min(1).max(20), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().trim().max(60).default("Unexpected expense") }),
]);
export const scenarioSchema = z.object({ name: z.string().trim().max(80).optional(), shocks: z.array(shockSchema).min(1).max(MAX_SHOCKS) });
export const simulateInputSchema = z.object({ scenario: scenarioSchema, /** A scenario to compare with (typically the previous run, before an assumption was changed). */ compareWith: scenarioSchema.optional() });
export type ScenarioInput = z.output<typeof scenarioSchema>;

// ---------------------------------------------------------------- the live world, as a context

/** Everything a simulation starts from, read once. Nothing here is modified afterwards. */
export async function liveContext(db: Db, businessId: string): Promise<AgentToolContext> {
  const known = await loadKnownConstraints(db, businessId);
  const raw = await buildContext(db, businessId, null, known);
  const changes = await currentAgreedChanges(db, businessId);
  const { chase, earlyPayment, ...orderChanges } = changes;
  let events = raw.pending.map((p) => p.event);
  try {
    if (Object.keys(orderChanges).length > 0) events = applyTermChanges(events, orderChanges);
  } catch {
    events = raw.pending.map((p) => p.event); // an agreed term that no longer fits the order is ignored rather than guessed
  }
  // Agreements already in force lock the levers they cover, exactly as in recovery planning: a second proposal on the same term would double up.
  const receipts = await db.select({ id: sandboxReceipts.id }).from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), eq(sandboxReceipts.status, "scheduled")));
  const unavailable: NonNullable<AgentToolContext["unavailable"]> = [];
  if (Object.keys(orderChanges).length > 0 || receipts.length > 0) {
    const why = "an earlier strategy still has this order's terms in force";
    for (const [kind, cp] of [["supplier_reduce_deposit", raw.parties.supplierId], ["supplier_defer_balance", raw.parties.supplierId], ["buyer_request_deposit", raw.parties.buyerId], ["finance_invoice", raw.parties.lenderId]] as const) unavailable.push({ kind, counterpartyId: cp, why });
  }
  if (chase) unavailable.push({ kind: "chase_overdue", counterpartyId: chase.counterpartyId, why: "this term is already agreed" });
  if (earlyPayment) unavailable.push({ kind: "early_payment_discount", counterpartyId: earlyPayment.counterpartyId, why: "this term is already agreed" });
  const ctx: AgentToolContext = {
    ...raw,
    input: { ...raw.input, adjustments: adjustmentsOf({ ...(chase ? { chase } : {}), ...(earlyPayment ? { earlyPayment } : {}) }) },
    pending: events.map((event, i) => ({ ref: raw.pending[i]?.ref ?? `pc${i + 1}`, extractionId: raw.pending[i]?.extractionId ?? raw.pending[0]?.extractionId ?? "", event })),
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
  return ctx;
}

// ---------------------------------------------------------------- the scenario, as a context

function toShocks(ctx: AgentToolContext, s: ScenarioInput): Shock[] {
  const role = (cp: string) => ctx.counterparties.find((c) => c.id === cp)?.role;
  return s.shocks.map((x): Shock => {
    if (x.kind === "unexpected_expense") {
      const exp = EXPONENTS[ctx.currency];
      if (exp === undefined) throw new ActionError("invalid", `Unsupported currency ${ctx.currency}`);
      try {
        return { kind: x.kind, amountMinor: parseDecimalToMinor(x.amount, exp), dueOn: x.dueOn, label: x.label };
      } catch (e) {
        throw new ActionError("invalid", `Expense amount: ${e instanceof MoneyParseError ? e.message : "not a valid amount"}`);
      }
    }
    if (x.kind === "supplier_refuses") {
      if (role(x.counterpartyId) !== "supplier") throw new ActionError("invalid", "A refusal must come from one of your suppliers");
    } else if (role(x.counterpartyId) !== "customer") throw new ActionError("invalid", "This event needs one of your customers");
    return x;
  });
}

const forecastOf = (ctx: AgentToolContext, input = ctx.input, events = ctx.pending.map((p) => p.event)): Forecast => buildForecast(input, { events, horizonWeeks: ctx.horizonWeeks });

interface Summary extends Omit<ForecastView, "minBalanceMinor" | "gapMinor" | "weeklyClosing"> {
  minBalanceMinor: string; gapMinor: string; minBalanceWeekStart: string; weekStarts: string[]; weeklyClosing: string[]; belowReserve: boolean; belowZero: boolean;
}
function summarise(f: Forecast): Summary {
  const v = viewOf(f);
  return { ...v, minBalanceMinor: v.minBalanceMinor.toString(), gapMinor: v.gapMinor.toString(), minBalanceWeekStart: f.minimum.weekStart, weekStarts: f.weeks.map((w) => w.start), weeklyClosing: v.weeklyClosing.map(String), belowReserve: f.minimum.amount < f.reserve, belowZero: f.minimum.amount < 0n };
}

export interface SimulationReport {
  hypothetical: true;
  /** Never true: a simulation is not an execution and has nothing to verify. */
  verified: false;
  notices: string[];
  asOf: string;
  currency: string;
  reserveMinor: string;
  scenario: { name: string; assumptions: string[]; shocks: ScenarioInput["shocks"] };
  /** The books as they are now (actual), with agreements in force. */
  live: Summary;
  /** The same books with the events applied (hypothetical). */
  simulated: Summary;
  /** What today's best strategy reaches in the live books, for contrast. */
  todaysStrategy: { levers: string[]; minBalanceMinor: string; closesGap: boolean } | null;
  causes: { rows: { text: string; aloneMinBalanceMinor: string; aloneDeltaMinor: string; changesOptionsOnly: boolean }[]; combinedDeltaMinor: string; interactionMinor: string; changedItems: { label: string; before: { date: string; amountMinor: string } | null; after: { date: string; amountMinor: string } | null }[]; lines: string[] };
  /** Id of the log record of this run (the server-side basis a handoff into Plans is checked against). */
  simulationId?: string;
  evaluation: Omit<FlightEvaluation, "nothing" | "candidates"> & { nothing: unknown; candidates: unknown[] };
  limits: string[];
}

const NOTICES = [
  "SIMULATION. Nothing here has happened, nothing was sent to anyone, and no payment, agreement or approval was created. Your books and the sandbox were not changed.",
  "Whether a customer or supplier would agree to anything is unknown until they are asked. No likelihood is given.",
  "A strategy shown here is not verified. Only a plan you review and sign through the normal process, run in the sandbox and checked independently, can be called verified.",
];
const LIMITS = [
  "Counterparty terms are tried as asked; a real answer may be a counter-offer, which starts a re-plan that you sign again.",
  "A customer paying less than expected is applied to open invoices and the order payment; expected-but-not-yet-issued invoices from that customer are not reduced.",
  "A customer paying late is applied to every receipt from them, including any earlier payment they might promise in a rescue action.",
  "Only the rescue actions in your signed limits and not refused earlier are considered; widening a limit is your decision and is not simulated.",
];

export function runOne(liveCtx: AgentToolContext, input: ScenarioInput): SimulationReport {
  const fmt = (v: bigint) => formatMinor(v.toString(), liveCtx.currency);
  const shocks = toShocks(liveCtx, input);
  const liveEvents = liveCtx.pending.map((p) => p.event);
  let world;
  try {
    world = applyShocks(liveCtx.input, liveEvents, liveCtx.parties, shocks, fmt);
  } catch (e) {
    if (e instanceof ShockError) throw new ActionError("invalid", e.message);
    throw e;
  }
  // The simulated context: the same snapshot shape the planner uses, over the copies. The live context is never mutated (checked in check:flight).
  const simCtx: AgentToolContext = {
    ...liveCtx,
    input: world.input,
    pending: world.events.map((event, i) => ({ ...liveCtx.pending[i], event })),
    constraints: mergeConstraints(liveCtx.constraints, world.refusals),
  };
  const liveF = forecastOf(liveCtx);
  const simF = forecastOf(simCtx);

  const todays = coordinateForContext(liveCtx);
  const todaysLevers: Lever[] = todays?.selected?.levers ?? [];
  const lateCustomerIds = shocks.flatMap((s) => (s.kind === "customer_late" ? [s.counterpartyId] : []));
  const ev = evaluateFlight(simCtx, { todaysLevers, lateCustomerIds });

  const nameOf = (cp: string) => liveCtx.counterparties.find((c) => c.id === cp)?.name ?? "A customer";
  const describe = (s: Shock): string =>
    s.kind === "customer_late" ? `${nameOf(s.counterpartyId)} pays ${s.days} days late`
    : s.kind === "customer_short" ? `${nameOf(s.counterpartyId)} pays ${s.shortBps / 100}% less than expected`
    : s.kind === "supplier_refuses" ? `${nameOf(s.counterpartyId)} refuses ${s.lever === "both" ? "a deferral and a lower deposit" : s.lever === "supplier_defer_balance" ? "a payment deferral" : "a lower deposit"}`
    : `${s.label}: ${fmt(s.amountMinor)} due ${s.dueOn}`;
  const parts = { buyerId: liveCtx.parties.buyerId };
  const attr = attributeShocks(liveCtx.input, liveEvents, parts, shocks, { horizonWeeks: liveCtx.horizonWeeks, changes: {} });
  const causeRows = attr.rows.map((r) => ({
    text: describe(shocks[r.shockIndex]), aloneMinBalanceMinor: r.aloneMinBalanceMinor.toString(), aloneDeltaMinor: r.aloneDeltaMinor.toString(),
    changesOptionsOnly: shocks[r.shockIndex].kind === "supplier_refuses",
  }));
  const changed = changedItems(liveF, simF).map((c) => ({ label: c.label, before: c.before && { date: c.before.date, amountMinor: c.before.amountMinor.toString() }, after: c.after && { date: c.after.date, amountMinor: c.after.amountMinor.toString() } }));

  const v = viewOf(simF);
  const lv = viewOf(liveF);
  const lines: string[] = [];
  if (v.minBalanceMinor >= liveF.reserve) lines.push(`In this scenario every week stays at or above your ${fmt(liveF.reserve)} cushion (lowest balance ${fmt(v.minBalanceMinor)} in week ${v.minBalanceWeek}).`);
  else {
    lines.push(`In this scenario the balance falls below your ${fmt(liveF.reserve)} cushion in week ${v.firstBelowReserveWeek}${v.firstNegativeWeek ? ` and below zero in week ${v.firstNegativeWeek}` : ""}. The deepest point is ${fmt(v.minBalanceMinor)} in the week of ${simF.minimum.weekStart} (week ${v.minBalanceWeek}), ${fmt(v.gapMinor)} short of the cushion.`);
    lines.push(lv.minBalanceMinor >= liveF.reserve ? "On today's books there is no shortage: the scenario creates it." : `On today's books the lowest balance is ${fmt(lv.minBalanceMinor)}; the scenario makes it ${fmt(lv.minBalanceMinor - v.minBalanceMinor)} lower.`);
  }
  for (const r of attr.rows.filter((x) => !(shocks[x.shockIndex].kind === "supplier_refuses"))) lines.push(`${describe(shocks[r.shockIndex])}: on its own it moves the lowest balance by ${fmt(r.aloneDeltaMinor)}.`);
  if (shocks.some((s) => s.kind === "supplier_refuses")) lines.push("A supplier refusal does not change cash by itself; it removes rescue actions, so its effect appears in the strategy comparison.");
  if (shocks.filter((s) => s.kind !== "supplier_refuses").length > 1) lines.push(attr.interactionMinor === 0n ? "The events hit different weeks, so their effects simply add." : `Together they move the lowest balance by ${fmt(attr.combinedDeltaMinor)}, ${attr.interactionMinor > 0n ? "less" : "more"} than the separate effects added up, because they hit the same weeks.`);

  return {
    hypothetical: true, verified: false, notices: NOTICES, asOf: liveCtx.asOf, currency: liveCtx.currency, reserveMinor: liveF.reserve.toString(),
    scenario: { name: input.name ?? "Scenario", assumptions: world.assumptions, shocks: input.shocks },
    live: summarise(liveF), simulated: summarise(simF),
    todaysStrategy: todays?.selected ? { levers: ev.candidates.find((c) => c.role === "todays_plan")?.leverText ?? todays.selected.levers.map((l) => l.kind), minBalanceMinor: todays.selected.minBalanceMinor.toString(), closesGap: todays.selected.closesGap } : null,
    causes: { rows: causeRows, combinedDeltaMinor: attr.combinedDeltaMinor.toString(), interactionMinor: attr.interactionMinor.toString(), changedItems: changed, lines },
    evaluation: ev, limits: LIMITS,
  };
}

// ---------------------------------------------------------------- comparison of two runs (change one assumption, see what moved)

export interface ScenarioComparison { previousName: string; lines: string[]; changed: boolean }

function compareRuns(prev: SimulationReport, next: SimulationReport): ScenarioComparison {
  const m = (v: string) => formatMinor(v, next.currency);
  const lines: string[] = [];
  const dMin = BigInt(next.simulated.minBalanceMinor) - BigInt(prev.simulated.minBalanceMinor);
  lines.push(dMin === 0n ? `The lowest balance is unchanged at ${m(next.simulated.minBalanceMinor)}.` : `The lowest balance goes from ${m(prev.simulated.minBalanceMinor)} to ${m(next.simulated.minBalanceMinor)} (${dMin > 0n ? "+" : "-"}${m((dMin < 0n ? -dMin : dMin).toString())}).`);
  if (prev.simulated.gapMinor !== next.simulated.gapMinor) lines.push(`The shortfall against the cushion goes from ${m(prev.simulated.gapMinor)} to ${m(next.simulated.gapMinor)}.`);
  const rec = (r: SimulationReport) => r.evaluation.candidates.map((c) => c as { id: string; title: string; leverText: string[]; outcome: string }).find((c) => c.id === r.evaluation.recommendedId) ?? null;
  const a = rec(prev);
  const b = rec(next);
  const lbl = (r: SimulationReport, c: { leverText: string[] } | null) => (c ? c.leverText.join("; ") : r.evaluation.verdict === "no_shortage" ? "no action needed" : "no permitted action");
  if (!a && !b) lines.push(prev.evaluation.verdict === "no_shortage" && next.evaluation.verdict === "no_shortage" ? "In neither run is any action needed." : "In neither run is there a permitted action that helps.");
  else if (a?.id === b?.id) lines.push(`The recommended response is the same: ${b!.leverText.join("; ")}.`);
  else lines.push(`The recommended response changed (recomputed from scratch, not adjusted): ${lbl(prev, a)} became ${lbl(next, b)}.`);
  const outcomes = (r: SimulationReport) => new Map(r.evaluation.candidates.map((c) => [(c as { id: string }).id, (c as { outcome: string }).outcome]));
  const pa = outcomes(prev);
  for (const c of next.evaluation.candidates as { id: string; title: string; outcome: string }[]) {
    const was = pa.get(c.id);
    if (was && was !== c.outcome) lines.push(`${c.title}: ${was} became ${c.outcome}.`);
  }
  return { previousName: prev.scenario.name, lines, changed: dMin !== 0n || a?.id !== b?.id };
}

// ---------------------------------------------------------------- public

export interface SimulatorOptions {
  businessId: string;
  customers: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  /** The customer with the most cash expected in the horizon (invoices plus the order payment): the "major customer". */
  majorCustomerId: string | null;
  asOf: string;
  currency: string;
  reserveMinor: string;
}

export async function getSimulatorOptions(db: Db, businessId: string): Promise<SimulatorOptions> {
  const ctx = await liveContext(db, businessId);
  const f = forecastOf(ctx);
  const inflow = new Map<string, bigint>();
  for (const it of f.items) if (it.amount > 0n && it.counterpartyId) inflow.set(it.counterpartyId, (inflow.get(it.counterpartyId) ?? 0n) + it.amount);
  const rec = ctx.pending.map((p) => p.event).filter((e) => e.kind === "customer_receipt").reduce((n, e) => n + e.amountMinor, 0n);
  if (ctx.parties.buyerId) inflow.set(ctx.parties.buyerId, (inflow.get(ctx.parties.buyerId) ?? 0n) + rec);
  const customers = ctx.counterparties.filter((c) => c.role === "customer").map((c) => ({ id: c.id, name: c.name }));
  const major = [...inflow.entries()].filter(([cp]) => customers.some((c) => c.id === cp)).sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))[0]?.[0] ?? null;
  return { businessId, customers, suppliers: ctx.counterparties.filter((c) => c.role === "supplier").map((c) => ({ id: c.id, name: c.name })), majorCustomerId: major, asOf: ctx.asOf, currency: ctx.currency, reserveMinor: ctx.input.reserve.toString() };
}

export const hashShocks = (shocks: unknown): string => createHash("sha256").update(JSON.stringify(shocks), "utf8").digest("hex");

export type SimulateResult = { report: SimulationReport; comparison: ScenarioComparison | null };

/** Run a scenario (and optionally compare it with an earlier one). Read-only apart from one log record. */
export async function simulateScenario(db: Db, businessId: string, input: unknown): Promise<SimulateResult> {
  const parsed = simulateInputSchema.parse(input);
  const live = await liveContext(db, businessId);
  const report = runOne(live, parsed.scenario);
  const prev = parsed.compareWith ? runOne(live, parsed.compareWith) : null;
  const comparison = prev ? compareRuns(prev, report) : null;
  const logged = await appendRecord(db, {
    businessId, event: ACTION_EVENTS.SIMULATION_RUN, actor: "owner",
    detail: {
      hypothetical: true, scenarioSha256: hashShocks(parsed.scenario.shocks), asOf: report.asOf,
      handoffBasis: { asOf: report.asOf, scenarioName: report.scenario.name, lowestBalanceMinor: report.simulated.minBalanceMinor, candidates: (report.evaluation.candidates as { id: string; outcome: string; minBalanceMinor: bigint; costMinor: bigint }[]).map((c) => ({ id: c.id, outcome: c.outcome, minBalanceMinor: c.minBalanceMinor.toString(), costMinor: c.costMinor.toString() })) }, shockKinds: parsed.scenario.shocks.map((s) => s.kind),
      lowestBalanceMinor: report.simulated.minBalanceMinor, gapMinor: report.simulated.gapMinor, verdict: report.evaluation.verdict, recommended: report.evaluation.recommendedId,
      candidates: report.evaluation.candidates.length, compared: !!prev,
    },
  });
  report.simulationId = logged.id;
  return { report, comparison };
}
