// AUTONOMOUS CASH-FLOW RECOVERY. An approved, executed strategy is a set of promises (a customer pays by a date, a supplier accepts terms, a lender
// advances). This module notices when the world stops matching them, recomputes the cash position from the books and the sandbox as they are NOW,
// and proposes a recovery. It reuses the planner (which includes invoice finance as a lever), the replanner and the permission gate; it adds no execution path.
//
//   detects  late receipts, broken invoice promises, a refusal, an agreement withdrawn behind our back, a failed execution, a forecast that
//            fell below the cushion or got materially worse than the strategy promised;
//   decides  automatically: whether the change is material, which promises failed, how the cash moved, the single-flight claim, which signed but
//            unexecuted approvals are now stale, and what the recovery run is given;
//   never    signs, approves, executes, sends, schedules or withdraws anything. A recovery is a PROPOSAL: the owner signs it (and a second approver
//            when the signed limits ask), exactly as for any plan. This file imports no approval, signing, execution or sandbox-write code except the
//            existing replanner, which only proposes (its withdrawals of held agreements are the gate-checked ones that already existed).
//
// The stored strategy and its explanation are never used as financial truth. They provide the PROMISE to compare against and the dates it was made.
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, agentSteps, planAuthorisations, planExecutions, plans as plansTable, recoveryCases, sandboxApplications, sandboxReceipts, sandboxThreads } from "@/db/schema";
import { appendRecord } from "./log";
import { buildContext, PLANNING_HORIZON_WEEKS, startRun, type RunOptions } from "./agent-run";
import { TOPIC, loadKnownConstraints } from "./negotiation-memory";
import { liveLeftovers, replanFromExecution } from "./replan";
import { currentAgreedChanges } from "./shortage";
import { agreedAdjustments } from "./state";
import { sha256Hex, type PlanTerms } from "./plan-terms";
import { changesFromRecorded, recordedBranches } from "./plan-schedule";
import type { ExecutionOutcome } from "./plan-exec";
import { ACTION_EVENTS, ActionError, type Db } from "./types";
import { theySaid, type AgentToolContext } from "@/agent";
import { formatMinor } from "@/agent/plan-builder";
import type { Constraint } from "@/domain/constraints";
import type { LeverKind, PlanView } from "@/domain/plan";
import type { ShortageReason } from "@/domain/shortage";
import {
  ASSUMED_LATE_DELAY_DAYS, applyTermChanges, brokenInvoicePromises, buildForecast, delayReceipts, lateReceipts, positionChange,
  type BrokenPromise, type Forecast, type InvoiceAdjustments, type LateReceipt, type TermChanges,
} from "@/engine";
import { toJsonValue } from "@/sandbox/proposals";

/** How long a claimed case may stay "open" before another trigger may take it over (a crashed run). */
const CLAIM_TIMEOUT_MS = 10 * 60_000;
/** Older stated limits are reported separately: counterparties change their minds. */
const OLDER_LIMIT_DAYS = 365;

export type RecoveryEventKind = "payment_late" | "invoice_promise_broken" | "counterparty_refused" | "agreement_withdrawn" | "execution_failed" | "forecast_below_reserve" | "forecast_worsened";

export interface RecoveryEvent {
  kind: RecoveryEventKind;
  /** Stable identity of the thing that changed (a receipt id, a branch, a forecast), used for the fingerprint. */
  key: string;
  /** Immaterial changes are listed ("watch") but start nothing. */
  material: boolean;
  counterpartyId?: string;
  amountMinor?: string;
  daysLate?: number;
  /** Words written by code from structured fields. */
  text: string;
}

interface Strategy {
  authorisationId: string;
  runId: string;
  planId: string;
  planDate: string | null;
  terms: PlanTerms;
  execStatus: string;
  outcome: ExecutionOutcome;
  plan: PlanView | null;
}

/** The world as it is now: what the forecast is rebuilt from. */
interface World {
  ctx: AgentToolContext;
  /** Order events with the agreements in force applied and late receipts moved (the expected case). */
  events: AgentToolContext["pending"][number]["event"][];
  adjustments: InvoiceAdjustments;
  unavailable: NonNullable<AgentToolContext["unavailable"]>;
  late: LateReceipt[];
  unmatchedLate: LateReceipt[];
  broken: BrokenPromise[];
  /** What the strategy should be delivering if every promise were kept, on today's records. */
  onTime: Forecast;
  expected: Forecast;
  worst: Forecast;
  inForce: string[];
  liveScheduled: number;
}

export interface RecoveryAssessment {
  strategy: Strategy | null;
  world: World | null;
  events: RecoveryEvent[];
  fingerprint: string | null;
}

const names = (ctx: AgentToolContext) => (id: string) => ctx.counterparties.find((c) => c.id === id)?.name ?? "a counterparty";
/** Plan titles may already start with their label ("Best available: ..."); the report adds its own. */
const plain = (title: string) => title.replace(/^(Recommended|Best available|Alternative):\s*/i, "");
const pctOf = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;

function agreedWords(topic: string, t: Record<string, number | string>): string {
  switch (topic) {
    case "supplier.reduce_deposit": return `deposit ${pctOf(Number(t.percentBps))}`;
    case "supplier.defer_balance": return `balance paid ${t.daysAfterShipment} days after shipment`;
    case "buyer.request_deposit": return `customer deposit ${pctOf(Number(t.percentBps))}`;
    case "buyer.chase_payment": return `pays overdue invoices within ${t.payWithinDays} days`;
    case "buyer.request_early_payment": return `pays ${t.daysEarly} days early for a ${pctOf(Number(t.discountBps))} discount`;
    default: return topic;
  }
}

// ---------------------------------------------------------------- the strategy that is being checked

/** The most recent plan the owner signed and the executor ran. Its stored promise is compared with the world; it is never trusted as the world. */
async function loadStrategy(db: Db, businessId: string): Promise<Strategy | null> {
  const auths = await db.select().from(planAuthorisations).where(and(eq(planAuthorisations.businessId, businessId), eq(planAuthorisations.status, "used"))).orderBy(desc(planAuthorisations.createdAt)).limit(1);
  const auth = auths[0];
  if (!auth) return null;
  const [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, auth.id));
  if (!exec || exec.status === "running") return null;
  const [planRow] = await db.select().from(plansTable).where(and(eq(plansTable.businessId, businessId), eq(plansTable.runId, auth.runId), eq(plansTable.planHash, auth.planId)));
  const [ctxStep] = (await db.select().from(agentSteps).where(and(eq(agentSteps.runId, auth.runId), eq(agentSteps.kind, "note"))).orderBy(asc(agentSteps.seq)).limit(3)).filter((s) => (s.payload as { type?: string }).type === "context");
  return {
    authorisationId: auth.id, runId: auth.runId, planId: auth.planId, terms: auth.terms as PlanTerms, execStatus: exec.status, outcome: exec.outcome as ExecutionOutcome,
    planDate: ((ctxStep?.payload ?? {}) as { asOf?: string }).asOf ?? null, plan: (planRow?.plan ?? null) as PlanView | null,
  };
}

// ---------------------------------------------------------------- the world now

async function readWorld(db: Db, businessId: string, strategy: Strategy | null): Promise<World> {
  const ctx = await buildContext(db, businessId, null);
  const nameOf = names(ctx);
  const threads = await db.select().from(sandboxThreads).where(and(eq(sandboxThreads.businessId, businessId), eq(sandboxThreads.status, "agreed")));
  const apps = await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.businessId, businessId), inArray(sandboxApplications.status, ["offered", "accepted"])));
  const receipts = await db.select().from(sandboxReceipts).where(eq(sandboxReceipts.businessId, businessId));

  // Agreements in force, from the sandbox. Invoice-level ones become adjustments; order-level ones rewrite the order's events.
  const all = await currentAgreedChanges(db, businessId);
  const { chase: _c, earlyPayment: _e, ...orderChanges } = all;
  void _c; void _e;
  const inForceAdj = agreedAdjustments(threads);
  const late = lateReceipts(receipts.map((r) => ({ id: r.id, counterpartyId: r.counterpartyId, amountMinor: r.amountMinor, expectedOn: r.expectedOn, status: r.status })), ctx.asOf);

  // Promises the STRATEGY made about invoices, judged against dates fixed when it was planned (not against a date that moves with the forecast).
  const recorded = strategy ? changesFromRecorded(strategy.terms.entries, await recordedBranches(db, businessId, strategy.authorisationId)) : ({} as TermChanges);
  const broken = strategy?.planDate
    ? brokenInvoicePromises({ invoices: ctx.input.invoices, planDate: strategy.planDate, asOf: ctx.asOf, chase: recorded.chase ? [recorded.chase] : [], early: recorded.earlyPayment ? [recorded.earlyPayment] : [] })
    : [];
  const brokenKey = (kind: string, cp: string) => broken.some((b) => b.kind === kind && b.counterpartyId === cp);
  // A promise that was not kept is no longer assumed: the invoice falls back to the engine's ordinary overdue rule.
  const adjustments: InvoiceAdjustments = {
    chase: inForceAdj.chase.filter((c) => !brokenKey("chase", c.counterpartyId)),
    early: inForceAdj.early.filter((c) => !brokenKey("early_payment", c.counterpartyId)),
  };

  const raw = ctx.pending.map((p) => p.event);
  let inForceEvents = raw;
  try {
    inForceEvents = Object.keys(orderChanges).length > 0 ? applyTermChanges(raw, orderChanges) : raw; // an agreed term that no longer fits the order is ignored, not guessed
  } catch {
    inForceEvents = raw;
  }
  const expectedMove = delayReceipts(inForceEvents, late, ctx.asOf, { arrives: ASSUMED_LATE_DELAY_DAYS });
  const worstMove = delayReceipts(inForceEvents, late, ctx.asOf, "never");
  const run = (events: typeof raw, adj: InvoiceAdjustments) => buildForecast({ ...ctx.input, adjustments: adj }, { events, horizonWeeks: PLANNING_HORIZON_WEEKS });
  const onTime = run(inForceEvents, inForceAdj);
  const expected = run(expectedMove.events, adjustments);
  const worst = run(worstMove.events, adjustments);

  // What is already in force. Order-level terms (and anything scheduled for the order) lock the order-level levers: a second plan on the same order
  // would schedule its receipts and payments again on top of the ones that exist. Invoice-level terms lock only that customer.
  const liveScheduled = receipts.filter((r) => r.status === "scheduled").length;
  const unavailable: NonNullable<AgentToolContext["unavailable"]> = [];
  const orderTopics = new Set(["supplier.reduce_deposit", "supplier.defer_balance", "buyer.request_deposit"]);
  const orderLocked = threads.some((t) => orderTopics.has(t.topic)) || apps.some((a) => a.status === "accepted") || liveScheduled > 0;
  if (orderLocked) {
    const why = "an earlier strategy still has this order's terms in force; replacing them is not part of an automatic recovery";
    for (const [kind, cp] of [["supplier_reduce_deposit", ctx.parties.supplierId], ["supplier_defer_balance", ctx.parties.supplierId], ["buyer_request_deposit", ctx.parties.buyerId], ["finance_invoice", ctx.parties.lenderId]] as const) unavailable.push({ kind, counterpartyId: cp, why });
  }
  for (const t of threads) {
    const kind = (Object.entries(TOPIC) as [LeverKind, string][]).find(([, topic]) => topic === t.topic)?.[0];
    if (kind === "chase_overdue" || kind === "early_payment_discount") unavailable.push({ kind, counterpartyId: t.counterpartyId, why: `${nameOf(t.counterpartyId)} already has this term agreed` });
  }

  const inForce: string[] = [
    ...threads.map((t) => `${nameOf(t.counterpartyId)}: ${agreedWords(t.topic, (t.agreedTerms ?? {}) as Record<string, number | string>)}`),
    ...apps.filter((a) => a.status === "accepted").map((a) => {
      const o = (a.offer ?? null) as { response?: { terms?: { advanceBps?: number; feeBps?: number } | null } } | null;
      const t = o?.response?.terms;
      return `${nameOf(a.lenderId)}: invoice finance accepted${t ? ` (advance ${pctOf(Number(t.advanceBps))}, fee ${pctOf(Number(t.feeBps))})` : ""}`;
    }),
  ];
  return { ctx, events: expectedMove.events, adjustments, unavailable, late, unmatchedLate: expectedMove.unmatched, broken, onTime, expected, worst, inForce, liveScheduled };
}

// ---------------------------------------------------------------- detection

export async function assessRecovery(db: Db, businessId: string): Promise<RecoveryAssessment> {
  const strategy = await loadStrategy(db, businessId);
  if (!strategy) return { strategy: null, world: null, events: [], fingerprint: null };
  const w = await readWorld(db, businessId, strategy);
  const { ctx } = w;
  const nameOf = names(ctx);
  const cur = ctx.currency;
  const m = (v: bigint) => formatMinor(v.toString(), cur);
  const reserve = ctx.input.reserve;
  const events: RecoveryEvent[] = [];

  // Is the lateness itself material? Judged on the whole picture: the strategy's promises kept on today's records versus the same records with the late items moved.
  const lateImpact = positionChange({ minBalanceMinor: w.onTime.minimum.amount, minBalanceWeek: w.onTime.minimum.weekIndex + 1, reserveMinor: reserve }, { minBalanceMinor: w.expected.minimum.amount, minBalanceWeek: w.expected.minimum.weekIndex + 1, reserveMinor: reserve });
  for (const r of w.late) {
    events.push({ kind: "payment_late", key: `receipt:${r.id}`, material: lateImpact.material, counterpartyId: r.counterpartyId, amountMinor: r.amountMinor.toString(), daysLate: r.daysLate, text: `${nameOf(r.counterpartyId)}'s payment of ${m(r.amountMinor)} was due ${r.expectedOn} and has not arrived (${r.daysLate} days late).` });
  }
  for (const b of w.broken) {
    events.push({ kind: "invoice_promise_broken", key: `${b.kind}:${b.counterpartyId}`, material: lateImpact.material, counterpartyId: b.counterpartyId, amountMinor: b.amountMinor.toString(), daysLate: b.daysLate, text: `${nameOf(b.counterpartyId)} agreed to ${b.kind === "chase" ? "pay its overdue invoices" : "pay early"} by ${b.promisedBy}; ${m(b.amountMinor)} is still unpaid (${b.daysLate} days past that).` });
  }
  for (const br of strategy.outcome.branches ?? []) {
    if (strategy.execStatus === "needs_replan" && br.status === "needs_replan") {
      events.push({ kind: "counterparty_refused", key: `${strategy.authorisationId}:${br.index}`, material: true, counterpartyId: br.counterpartyId, text: `${nameOf(br.counterpartyId)} did not accept the ${br.kind.replaceAll("_", " ")} terms the owner signed${br.reason ? ` (${br.reason})` : ""}.` });
    } else if ((br.status === "committed" || br.status === "agreed") && !br.withdrawn && br.threadId) {
      const [t] = await db.select({ status: sandboxThreads.status }).from(sandboxThreads).where(and(eq(sandboxThreads.id, br.threadId), eq(sandboxThreads.businessId, businessId)));
      if (t && t.status !== "agreed") events.push({ kind: "agreement_withdrawn", key: `${strategy.authorisationId}:${br.index}:${t.status}`, material: true, counterpartyId: br.counterpartyId, text: `The agreement with ${nameOf(br.counterpartyId)} (${br.kind.replaceAll("_", " ")}) is now ${t.status}; the strategy counted on it.` });
    }
  }
  if (["failed", "rolled_back", "verification_failed"].includes(strategy.execStatus)) {
    const why = strategy.outcome.failure ? ` at step ${strategy.outcome.failure.step}` : "";
    events.push({ kind: "execution_failed", key: `${strategy.authorisationId}:${strategy.execStatus}`, material: true, text: strategy.execStatus === "verification_failed" ? "The independent check of the executed strategy failed." : `The strategy's execution ${strategy.execStatus === "rolled_back" ? "failed and was rolled back" : "failed and could not be rolled back cleanly"}${why}.` });
  }

  // The forecast itself, against what the strategy promised the owner. The promise is only a number to compare with; the new figure is recomputed.
  const promisedMin = strategy.plan ? BigInt(strategy.plan.metrics.minBalanceMinor) : null;
  const now = { minBalanceMinor: w.expected.minimum.amount, minBalanceWeek: w.expected.minimum.weekIndex + 1, reserveMinor: reserve };
  const chg = positionChange({ minBalanceMinor: promisedMin ?? reserve, minBalanceWeek: strategy.plan?.metrics.minBalanceWeek ?? 1, reserveMinor: reserve }, now);
  if (chg.nowBelowReserve && (promisedMin === null || chg.material)) {
    events.push({ kind: "forecast_below_reserve", key: "forecast", material: true, text: `The forecast from today's records falls to ${m(now.minBalanceMinor)} in week ${now.minBalanceWeek}, below the ${m(reserve)} cushion${promisedMin !== null ? ` (the strategy promised ${m(promisedMin)})` : ""}.` });
  } else if (promisedMin !== null && chg.material) {
    events.push({ kind: "forecast_worsened", key: "forecast", material: true, text: `The lowest balance is now ${m(now.minBalanceMinor)}, ${m(-chg.deltaMinor)} lower than the ${m(promisedMin)} the strategy promised.` });
  }

  const material = events.filter((e) => e.material);
  const fingerprint = material.length === 0 ? null : sha256Hex({
    strategy: strategy.authorisationId, asOf: ctx.asOf, events: material.map((e) => `${e.kind}:${e.key}`).sort(),
    expectedMin: w.expected.minimum.amount.toString(), expectedWeek: w.expected.minimum.weekIndex, reserve: reserve.toString(),
  });
  return { strategy, world: w, events, fingerprint };
}

// ---------------------------------------------------------------- the report (every figure from code; every sentence a template)

export interface RecoveryOption { id: string; title: string; kind: "continue" | "plan"; lowestBalanceMinor: string; lowestWeek: number; costMinor: string | null; borrows: boolean; keepsCushion: boolean; runnable: boolean; blockers: string[]; rank: number | null }

export interface RecoveryReport {
  v: 1;
  asOf: string;
  currency: string;
  headline: string;
  whatChanged: string[];
  failedAssumptions: { assumption: string; observed: string }[];
  cash: { promisedLowestMinor: string | null; nowLowestMinor: string; nowLowestWeek: number; ifNeverArrivesMinor: string; cushionMinor: string; changeMinor: string | null; belowCushion: boolean; lines: string[] };
  consequence: string;
  inForce: string[];
  statedLimits: string[];
  olderLimits: string[];
  assumed: string[];
  options: RecoveryOption[];
  recommended: { kind: "recommended" | "best_available" | "none"; planId: string | null; text: string };
  alternatives: string[];
  /** Whether borrowing is part of the picture, judged on the same frame as the options. */
  financing: string;
  uncertainty: string[];
  approval: string;
}

const APPROVAL = "Nothing has been signed, sent or scheduled. This is a proposal: it needs your fresh signature (and a second approver where your signed limits ask), then it goes through the permission gate, the sandbox and the independent check like any plan. Earlier approvals for the old plans no longer apply.";

function financingNote(w: World, options: RecoveryOption[]): string {
  if (w.unavailable.some((u) => u.kind === "finance_invoice")) return "Invoice finance is already part of the strategy in force (or the order is locked by it), so no new advance is proposed automatically. If you want to look at a loan, use the Funding page: it compares offers you enter.";
  const borrowing = options.filter((o) => o.kind === "plan" && o.borrows);
  if (borrowing.length === 0) return "None of the proposed options borrows.";
  return `${borrowing.length} of the options uses invoice finance; the others do not borrow. Its fee is a planning assumption until the lender answers.`;
}

async function limitsSections(db: Db, ctx: AgentToolContext): Promise<{ stated: string[]; older: string[] }> {
  const nameOf = names(ctx);
  const fresh = await loadKnownConstraints(db, ctx.businessId);
  const everything = await loadKnownConstraints(db, ctx.businessId, Date.now(), OLDER_LIMIT_DAYS);
  const line = (c: Constraint) => `${nameOf(c.counterpartyId)} ${theySaid(c)} (${c.kind.replaceAll("_", " ")})`;
  const isFresh = (c: Constraint) => fresh.some((f) => f.kind === c.kind && f.counterpartyId === c.counterpartyId);
  return { stated: fresh.map(line), older: everything.filter((c) => !isFresh(c)).map((c) => `${line(c)}; older than the trust window, so it may have changed and could be asked again`) };
}

function buildReport(a: RecoveryAssessment, limits: { stated: string[]; older: string[] }, plans: PlanView[], extra: { blockedReason?: string } = {}): RecoveryReport {
  const w = a.world!;
  const s = a.strategy!;
  const { ctx } = w;
  const cur = ctx.currency;
  const m = (v: bigint | string) => formatMinor(v.toString(), cur);
  const reserve = ctx.input.reserve;
  const nowMin = w.expected.minimum.amount;
  const promised = s.plan ? BigInt(s.plan.metrics.minBalanceMinor) : null;
  const material = a.events.filter((e) => e.material);
  const below = nowMin < reserve;

  const failed: RecoveryReport["failedAssumptions"] = [];
  for (const r of w.late) failed.push({ assumption: `${names(ctx)(r.counterpartyId)} pays ${m(r.amountMinor)} on ${r.expectedOn}`, observed: `not received after ${r.daysLate} days` });
  for (const b of w.broken) failed.push({ assumption: `${names(ctx)(b.counterpartyId)} keeps the ${b.kind === "chase" ? "chase" : "early-payment"} agreement by ${b.promisedBy}`, observed: `${m(b.amountMinor)} still unpaid` });
  for (const e of material.filter((x) => x.kind === "counterparty_refused" || x.kind === "agreement_withdrawn" || x.kind === "execution_failed")) failed.push({ assumption: e.kind === "counterparty_refused" ? "the counterparty accepts the signed terms" : e.kind === "agreement_withdrawn" ? "the agreement stays in place" : "the plan executes and verifies", observed: e.text });

  const lines = [`Lowest balance from today's records: ${m(nowMin)} in week ${w.expected.minimum.weekIndex + 1} (cushion ${m(reserve)}).`];
  if (promised !== null) lines.push(`The strategy promised ${m(promised)}; that is ${m(nowMin - promised < 0n ? promised - nowMin : nowMin - promised)} ${nowMin < promised ? "lower" : "higher"}.`);
  if (w.late.length > 0) {
    lines.push(`Late items are assumed to arrive ${ASSUMED_LATE_DELAY_DAYS} days from today (an assumption). If they do not arrive inside the ${ctx.horizonWeeks}-week horizon the lowest balance is ${m(w.worst.minimum.amount)}.`);
    if (w.unmatchedLate.length > 0) lines.push(`${w.unmatchedLate.length} late receipt(s) do not match any forecast item, so they change nothing here.`);
  }

  const cont: RecoveryOption = {
    id: "continue", title: "Keep the strategy as it is (do nothing more)", kind: "continue", lowestBalanceMinor: nowMin.toString(), lowestWeek: w.expected.minimum.weekIndex + 1, costMinor: null,
    borrows: false, keepsCushion: !below, runnable: true, blockers: [], rank: null,
  };
  const options: RecoveryOption[] = [cont, ...plans.map((p, i): RecoveryOption => {
    const blockers = [...(p.blockers ?? []), ...p.checks.filter((c) => c.decision === "deny").map((c) => `the permission gate would deny ${c.lever.kind.replaceAll("_", " ")}`)];
    return {
      id: p.id, title: p.title, kind: "plan", lowestBalanceMinor: p.metrics.minBalanceMinor, lowestWeek: p.metrics.minBalanceWeek, costMinor: p.metrics.totalCostMinor,
      borrows: p.levers.some((l) => l.kind === "finance_invoice"), keepsCushion: BigInt(p.metrics.minBalanceMinor) >= reserve, runnable: blockers.length === 0, blockers, rank: i + 1,
    };
  })];
  const improves = (o: RecoveryOption) => BigInt(o.lowestBalanceMinor) > nowMin;
  const best = options.find((o) => o.kind === "plan" && o.runnable && o.keepsCushion) ?? options.find((o) => o.kind === "plan" && o.runnable && improves(o));
  const recommended: RecoveryReport["recommended"] = best
    ? { kind: best.keepsCushion ? "recommended" : "best_available", planId: best.id, text: best.keepsCushion ? `Recommended: ${plain(best.title)}. It keeps the lowest balance at ${m(best.lowestBalanceMinor)} (cushion ${m(reserve)})${best.borrows ? " and uses invoice finance" : " without borrowing"}${best.costMinor && BigInt(best.costMinor) > 0n ? `, at a cost of ${m(best.costMinor)}` : ""}.` : `Best available: ${plain(best.title)}. It lifts the lowest balance to ${m(best.lowestBalanceMinor)} but does not reach the ${m(reserve)} cushion${BigInt(best.lowestBalanceMinor) < 0n ? ` and cash still goes below zero in week ${best.lowestWeek}` : ""}.` }
    : { kind: "none", planId: null, text: extra.blockedReason ?? (below ? "No runnable option improves the position inside your signed limits and what is already in force. Decide whether to widen a limit, talk to the counterparties yourself, or accept the lower balance." : "No change is needed to keep the cushion; the listed events are worth watching.") };
  const alternatives = options.filter((o) => o.kind === "plan" && o.id !== best?.id).slice(0, 3).map((o) => `${plain(o.title)}: lowest balance ${m(o.lowestBalanceMinor)}${o.runnable ? "" : `; cannot run (${o.blockers[0]})`}.`);

  const consequence = below
    ? `If nothing changes, cash falls ${m(reserve - nowMin)} below the cushion in week ${w.expected.minimum.weekIndex + 1}${nowMin < 0n ? " and goes below zero" : ""}.`
    : `The cushion still holds on today's records (lowest ${m(nowMin)}), but the strategy has less room than it promised.`;
  const uncertainty = [
    "The forecast is recomputed from the books and the sandbox as they are now; it is an estimate, not a bank statement.",
    ...(w.late.length > 0 ? [`How late the missing payments will be is unknown; ${ASSUMED_LATE_DELAY_DAYS} days is an assumption.`] : []),
    "Nobody can promise that a counterparty will accept: asks that nobody has answered are assumptions, not predictions.",
  ];
  return {
    v: 1, asOf: ctx.asOf, currency: cur,
    headline: material.length === 0 ? "The strategy is on track." : `${material.length === 1 ? "The strategy" : "The strategy"} is off track: ${material.map((e) => e.kind.replaceAll("_", " ")).filter((x, i, arr) => arr.indexOf(x) === i).join(", ")}.`,
    whatChanged: a.events.map((e) => (e.material ? e.text : `${e.text} (small; watching)`)),
    failedAssumptions: failed,
    cash: { promisedLowestMinor: promised?.toString() ?? null, nowLowestMinor: nowMin.toString(), nowLowestWeek: w.expected.minimum.weekIndex + 1, ifNeverArrivesMinor: w.worst.minimum.amount.toString(), cushionMinor: reserve.toString(), changeMinor: promised === null ? null : (nowMin - promised).toString(), belowCushion: below, lines },
    consequence, inForce: w.inForce, statedLimits: limits.stated, olderLimits: limits.older,
    assumed: [...new Set(plans.flatMap((p) => p.strategy?.untested ?? []))].slice(0, 8),
    options, recommended, alternatives, financing: financingNote(w, options), uncertainty, approval: APPROVAL,
  };
}

// ---------------------------------------------------------------- orchestration

export interface RecoveryResult {
  status: "no_active_strategy" | "on_track" | "duplicate" | "planned" | "replanned" | "no_plan" | "blocked" | "failed";
  caseId: string | null;
  runId: string | null;
  events: RecoveryEvent[];
  report: RecoveryReport | null;
  /** Earlier cases and approvals this one made stale. */
  superseded: string[];
  expiredAuthorisations: string[];
  note?: string;
}

function shortageReason(f: Forecast, hash: string): ShortageReason | undefined {
  const firstNeg = f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null;
  const firstReserve = f.firstBreach ? f.firstBreach.weekIndex + 1 : null;
  const kind = firstNeg !== null ? ("below_zero" as const) : firstReserve !== null ? ("below_reserve" as const) : null;
  if (!kind) return undefined;
  return { kind, variant: "baseline", horizonWeeks: f.horizonWeeks, minBalanceMinor: f.minimum.amount.toString(), minBalanceWeek: f.minimum.weekIndex + 1, firstNegativeWeek: firstNeg, firstBelowReserveWeek: firstReserve, reserveMinor: f.reserve.toString(), shortfallMinor: (f.maxShortfall > 0n ? f.maxShortfall : 0n).toString(), forecastHash: hash, source: "api" };
}

/** Single-flight: the unique fingerprint makes the claim atomic. A failed or superseded case with the same facts may be claimed again; an open or finished one may not. */
async function claim(db: Db, businessId: string, strategyAuthorisationId: string, fingerprint: string, events: RecoveryEvent[]) {
  const [row] = await db.insert(recoveryCases).values({ businessId, fingerprint, strategyAuthorisationId, status: "open", events: toJsonValue(events) as unknown as Record<string, unknown>, assessment: {} }).onConflictDoNothing().returning();
  if (row) return { row, fresh: true };
  const [existing] = await db.select().from(recoveryCases).where(and(eq(recoveryCases.businessId, businessId), eq(recoveryCases.fingerprint, fingerprint)));
  // A case left "open" by a process that died is reclaimable after a while; one that is genuinely in flight is not.
  const abandoned = existing?.status === "open" && Date.now() - existing.updatedAt.getTime() > CLAIM_TIMEOUT_MS;
  if (existing && (existing.status === "failed" || existing.status === "superseded" || abandoned)) {
    const [re] = await db.update(recoveryCases).set({ status: "open", supersededBy: null, updatedAt: new Date() }).where(and(eq(recoveryCases.id, existing.id), eq(recoveryCases.status, existing.status), eq(recoveryCases.updatedAt, existing.updatedAt))).returning();
    if (re) return { row: re, fresh: true };
  }
  return { row: existing, fresh: false };
}

const setCase = (db: Db, id: string, patch: Partial<{ status: string; runId: string | null; assessment: unknown }>) =>
  db.update(recoveryCases).set({ ...(patch.status ? { status: patch.status } : {}), ...(patch.runId !== undefined ? { runId: patch.runId } : {}), ...(patch.assessment !== undefined ? { assessment: toJsonValue(patch.assessment) as unknown as Record<string, unknown> } : {}), updatedAt: new Date() }).where(eq(recoveryCases.id, id));

/** Earlier unexecuted plans are stale once the facts changed: mark their cases and runs superseded and expire approvals that were never used. */
async function retireStale(db: Db, businessId: string, keepCaseId: string, keepRunIds: string[]): Promise<{ cases: string[]; authorisations: string[] }> {
  const cases: string[] = [];
  const old = await db.select().from(recoveryCases).where(and(eq(recoveryCases.businessId, businessId), ne(recoveryCases.id, keepCaseId), inArray(recoveryCases.status, ["planned", "replanned", "no_plan", "blocked"])));
  for (const c of old) {
    await db.update(recoveryCases).set({ status: "superseded", supersededBy: keepCaseId, updatedAt: new Date() }).where(and(eq(recoveryCases.id, c.id), eq(recoveryCases.status, c.status)));
    if (c.runId) await db.update(agentRuns).set({ lifecycle: "superseded", successorRunId: keepRunIds[0] ?? null }).where(and(eq(agentRuns.id, c.runId), eq(agentRuns.lifecycle, "planned")));
    cases.push(c.id);
  }
  const authorisations: string[] = [];
  const open = await db.select().from(planAuthorisations).where(and(eq(planAuthorisations.businessId, businessId), inArray(planAuthorisations.status, ["proposed", "awaiting_second", "authorised"])));
  for (const a of open) {
    if (keepRunIds.includes(a.runId)) continue;
    const [done] = await db.update(planAuthorisations).set({ status: "expired" }).where(and(eq(planAuthorisations.id, a.id), eq(planAuthorisations.status, a.status))).returning({ id: planAuthorisations.id });
    if (!done) continue;
    authorisations.push(a.id);
    await appendRecord(db, { businessId, event: ACTION_EVENTS.PLAN_AUTHORISATION_INVALIDATED, actor: "system", detail: { authorisationId: a.id, was: a.status, runId: a.runId, recoveryCaseId: keepCaseId, why: "the facts changed; an approval for an older plan cannot be used" } });
  }
  return { cases, authorisations };
}

export async function runRecovery(db: Db, businessId: string, opts: Pick<RunOptions, "gateway" | "limits" | "forceFallback" | "purposeId"> = {}): Promise<RecoveryResult> {
  const a = await assessRecovery(db, businessId);
  const blank = { caseId: null, runId: null, report: null, superseded: [], expiredAuthorisations: [] };
  if (!a.strategy || !a.world) return { status: "no_active_strategy", events: [], ...blank };
  if (!a.fingerprint) return { status: "on_track", events: a.events, ...blank, report: buildReport(a, await limitsSections(db, a.world.ctx), []) };
  const { strategy: s, world: w } = a;
  const material = a.events.filter((e) => e.material);

  const { row, fresh } = await claim(db, businessId, s.authorisationId, a.fingerprint, a.events);
  if (!fresh) {
    await appendRecord(db, { businessId, event: ACTION_EVENTS.RECOVERY_DUPLICATE, actor: "system", detail: { caseId: row.id, status: row.status, fingerprint: a.fingerprint } });
    return { status: "duplicate", caseId: row.id, runId: row.runId, events: a.events, report: (row.assessment as RecoveryReport | null)?.v === 1 ? (row.assessment as RecoveryReport) : null, superseded: [], expiredAuthorisations: [], note: `A recovery for exactly this situation already exists (${row.status}); nothing was started again.` };
  }
  await appendRecord(db, { businessId, event: ACTION_EVENTS.RECOVERY_DETECTED, actor: "system", detail: { caseId: row.id, strategyAuthorisationId: s.authorisationId, fingerprint: a.fingerprint, events: material.map((e) => ({ kind: e.kind, key: e.key, amountMinor: e.amountMinor ?? null, daysLate: e.daysLate ?? null })), nowLowestMinor: w.expected.minimum.amount.toString(), cushionMinor: w.ctx.input.reserve.toString() } });

  const finish = async (status: RecoveryResult["status"], runIds: string[], planViews: PlanView[], note?: string): Promise<RecoveryResult> => {
    const limits = await limitsSections(db, w.ctx);
    const report = buildReport(a, limits, planViews, { blockedReason: note });
    const retired = await retireStale(db, businessId, row.id, runIds);
    await setCase(db, row.id, { status, runId: runIds[0] ?? null, assessment: report });
    await appendRecord(db, { businessId, event: status === "blocked" || status === "failed" || status === "no_plan" ? ACTION_EVENTS.RECOVERY_NO_PLAN : ACTION_EVENTS.RECOVERY_PLANNED, actor: "agent", detail: { caseId: row.id, status, runId: runIds[0] ?? null, planIds: planViews.map((p) => p.id), recommended: report.recommended.planId, recommendedKind: report.recommended.kind, supersededCases: retired.cases, expiredAuthorisations: retired.authorisations, reportHash: sha256Hex(report) } });
    return { status, caseId: row.id, runId: runIds[0] ?? null, events: a.events, report, superseded: retired.cases, expiredAuthorisations: retired.authorisations, ...(note ? { note } : {}) };
  };

  try {
    // An unclean rollback leaves the sandbox in a state nobody has verified. The product's rule is no automatic retry; the owner reviews it.
    if (s.execStatus === "failed") {
      const left = await liveLeftovers(db, businessId, s.outcome);
      return await finish("blocked", [], [], `The earlier execution could not be rolled back cleanly${left.length ? ` (${left.slice(0, 3).join("; ")})` : ""}. Nothing is proposed automatically; review what is still live first.`);
    }
    // A refusal is the replanner's job: it releases held agreements through the gate, learns the structured constraints and adapts. Reused as it is.
    if (s.execStatus === "needs_replan") {
      const rp = await replanFromExecution(db, s.authorisationId, opts);
      if (rp.status === "replanned" && rp.newRunId) return await finish("replanned", [rp.newRunId], rp.plans);
      return await finish("no_plan", rp.newRunId ? [rp.newRunId] : [], [], rp.message);
    }
    const reason = shortageReason(w.expected, sha256Hex({ asOf: w.ctx.asOf, min: w.expected.minimum.amount.toString(), closes: w.expected.weeks.map((x) => x.closing.toString()) }));
    const run = await startRun(db, businessId, { type: "recovery", caseId: row.id, ...(reason ? { reason } : {}) }, {
      ...opts,
      prepare: (ctx) => {
        ctx.input = { ...ctx.input, adjustments: w.adjustments };
        ctx.pending = w.events.map((event, i) => ({ ref: `fc${i + 1}`, extractionId: ctx.pending[0]?.extractionId ?? "current-records", event }));
        ctx.unavailable = w.unavailable;
      },
      refine: (plans) => plans.map((p) => ({
        ...p,
        assumptions: [...p.assumptions, `Planned on today's records: agreements already in force are counted, ${w.late.length > 0 ? `${w.late.length} late receipt(s) are assumed to arrive ${ASSUMED_LATE_DELAY_DAYS} days from today, ` : ""}and promises that were not kept are not assumed again.`],
      })),
    });
    if (run.status !== "completed") return await finish("failed", [], [], run.error ?? "The recovery run did not complete");
    if (run.plans.length === 0) return await finish("no_plan", [run.runId], [], "No feasible recovery plan exists inside your signed limits and what is already in force.");
    return await finish("planned", [run.runId], run.plans, run.note ?? undefined);
  } catch (e) {
    await setCase(db, row.id, { status: "failed" });
    await appendRecord(db, { businessId, event: ACTION_EVENTS.RECOVERY_NO_PLAN, actor: "agent", detail: { caseId: row.id, status: "failed", error: e instanceof Error ? e.name : "error" } });
    if (e instanceof ActionError) throw e;
    throw new ActionError("refused", e instanceof Error ? e.message : "Recovery failed");
  }
}

// ---------------------------------------------------------------- reads

export async function listRecoveryCases(db: Db, businessId: string) {
  const id = z.string().uuid().parse(businessId);
  const rows = await db.select().from(recoveryCases).where(eq(recoveryCases.businessId, id)).orderBy(desc(recoveryCases.createdAt)).limit(20);
  return toJsonValue(rows);
}

/** Read-only look: what would be detected right now. Writes nothing. */
export async function previewRecovery(db: Db, businessId: string) {
  const a = await assessRecovery(db, businessId);
  return { hasStrategy: !!a.strategy, events: a.events, wouldStart: a.fingerprint !== null, fingerprint: a.fingerprint, lowestBalanceMinor: a.world?.expected.minimum.amount.toString() ?? null };
}
