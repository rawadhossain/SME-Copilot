// INDEPENDENT PLAN VERIFIER (ADR-018, ADR-020). Does not import the executor and does not reuse the planner's numbers.
// Three separate questions, each answered from a different source:
//   1. EXPECTED: what the AGREED terms should give. The agreed terms come from the hash-chained log (plan.branch_result records),
//      so nothing an executor row can silently edit changes the expectation. The deterministic engine computes the outcome.
//   2. ACTUAL: what the resulting sandbox state gives (agreed thread terms, the accepted application with the lender's real fee,
//      the scheduled payments and receipts), recomputed with the same engine.
//      Expected must equal actual (tolerance) and the scheduled items must be exactly the implied ones. Otherwise verification FAILS loudly.
//   3. PROMISE vs AGREED: the difference between the plan's promise and the agreed outcome, labelled for the owner. This is shown,
//      not a failure: the owner signed the tolerance that allowed the counter.
import { and, eq, inArray } from "drizzle-orm";
import { agentRuns, planExecutions, plans, sandboxApplications, sandboxPayments, sandboxReceipts, sandboxThreads } from "@/db/schema";
import { adjustmentsOf, applyTermChanges, buildForecast, FINANCE_FEE_BPS_ASSUMPTION, type TermChanges } from "@/engine";
import { formatMoney, money } from "@/lib/money";
import { requestSchema } from "@/gate/request";
import { buildContext } from "./agent-run";
import { appendRecord } from "./log";
import { checkAuthorisationIntegrity } from "./plan-authority";
import { changesFromRecorded, expectedSchedule, type RecordedBranch, type ScheduleItem } from "./plan-schedule";
import { ACTION_EVENTS, ActionError, type Db } from "./types";
import { recordedBranches } from "./plan-schedule";

/** Money metrics may differ by at most max(floor, bps of the reference value); week numbers must match exactly (ADR-018). */
export function verifyTolerance(env: Record<string, string | undefined> = process.env) {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== undefined && v !== "" ? Number(v) : d);
  return { floorMinor: BigInt(Math.floor(n(env.VERIFY_TOLERANCE_MINOR, 100))), bps: Math.floor(n(env.VERIFY_TOLERANCE_BPS, 10)) };
}

export interface MetricComparison {
  name: string;
  kind: "money" | "week";
  promised: string | null;
  actual: string | null;
  difference: string | null;
  tolerance: string;
  ok: boolean;
}

export interface PromiseVsAgreed {
  /** Plain label for the owner, written by code from the numbers. */
  label: string;
  direction: "same" | "better" | "worse";
  stillAboveZero: boolean;
  metrics: MetricComparison[];
}

export interface PlanVerification {
  ok: boolean;
  authorisationId: string;
  tolerance: { floorMinor: string; bps: number };
  /** Expected (from the recorded agreed terms) against actual (recomputed from the sandbox state). This decides pass or fail. */
  metrics: MetricComparison[];
  /** The plan's promise against the agreed-terms outcome. Informational. */
  promiseVsAgreed: PromiseVsAgreed;
  /** The outcome of the agreed terms (engine, from the log-recorded terms), for the scoreboard. */
  agreedOutcome: { minBalanceMinor: string; minBalanceWeek: number; firstNegativeWeek: number | null; closingAtHorizonMinor: string; totalCostMinor: string; weeksBelowZero: number };
  /** What the sandbox says was actually agreed, per lever, against what the plan asked and what the log recorded. */
  actualTerms: { index: number; kind: string; asked: Record<string, number>; recorded: Record<string, number> | null; actual: Record<string, number> | null }[];
  schedule: { expected: number; found: number; ok: boolean; problems: string[] };
  explanation: string[];
}

const abs = (x: bigint) => (x < 0n ? -x : x);

interface Metrics { minBalanceMinor: string; minBalanceWeek: number; firstNegativeWeek: number | null; closingAtHorizonMinor: string; totalCostMinor: string; weeksBelowZero: number }

export async function verifyPlanExecution(db: Db, authorisationId: string): Promise<PlanVerification> {
  const integrity = await checkAuthorisationIntegrity(db, authorisationId);
  if (!integrity.ok) throw new ActionError("refused", integrity.reason);
  const { auth, terms } = integrity;
  const businessId = auth.businessId;
  const [exec] = await db.select().from(planExecutions).where(eq(planExecutions.authorisationId, authorisationId));
  if (!exec) throw new ActionError("not_found", "This authorisation has not been executed");
  const outcome = exec.outcome as { committed?: boolean; branches?: { index: number; threadId?: string; applicationId?: string }[]; scheduled?: { kind: "payment" | "receipt"; id: string }[] };
  if (!outcome.committed) throw new ActionError("conflict", "Only a committed execution can be verified");
  const [planRow] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, auth.runId), eq(plans.planHash, auth.planId)));
  const promised = (planRow.plan as { metrics: Record<string, string | number | null> }).metrics;
  const horizonWeeks = Number(promised.horizonWeeks);

  // 1. Recorded (trusted: the hash-chained log) and 2. actual (the sandbox tables) terms, per lever.
  const recorded = await recordedBranches(db, businessId, authorisationId);
  const recordedChanges = changesFromRecorded(terms.entries, recorded);
  const actualChanges: TermChanges = {};
  const explanation: string[] = [];
  const actualTerms: PlanVerification["actualTerms"] = [];
  const sameTerms = (a: Record<string, number> | null, b: Record<string, number> | null) => a !== null && b !== null && Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
  for (const e of terms.entries) {
    const req = requestSchema.parse(e.request);
    const pointer = outcome.branches?.find((b) => b.index === e.index);
    const rec: RecordedBranch | undefined = recorded.get(e.index);
    let actual: Record<string, number> | null = null;
    let asked: Record<string, number> = {};
    const recordedTerms: Record<string, number> | null = rec?.agreedTerms ?? (rec?.offer ? { advanceBps: rec.offer.advanceBps, feeBps: rec.offer.feeBps } : null);
    if (req.kind === "sandbox.send_proposal") {
      const threads = await db.select().from(sandboxThreads).where(and(eq(sandboxThreads.businessId, businessId), eq(sandboxThreads.counterpartyId, req.counterpartyId), eq(sandboxThreads.topic, req.proposal.kind), eq(sandboxThreads.status, "agreed")));
      const t = threads.find((x) => x.id === (rec?.threadId ?? pointer?.threadId)) ?? null;
      const agreed = (t?.agreedTerms ?? null) as Record<string, number | string> | null;
      switch (e.lever.kind) {
        case "supplier_reduce_deposit": asked = { percentBps: e.lever.percentBps }; if (agreed?.percentBps !== undefined) { actual = { percentBps: Number(agreed.percentBps) }; actualChanges.supplierDepositBps = actual.percentBps; } break;
        case "supplier_defer_balance": asked = { daysAfterShipment: e.lever.daysAfterShipment }; if (agreed?.daysAfterShipment !== undefined) { actual = { daysAfterShipment: Number(agreed.daysAfterShipment) }; actualChanges.supplierBalanceDeferralDays = actual.daysAfterShipment; } break;
        case "buyer_request_deposit": asked = { percentBps: e.lever.percentBps }; if (agreed?.percentBps !== undefined) { actual = { percentBps: Number(agreed.percentBps) }; actualChanges.buyerDepositBps = actual.percentBps; } break;
        case "chase_overdue": asked = { payWithinDays: e.lever.payWithinDays }; if (agreed?.payWithinDays !== undefined) { actual = { payWithinDays: Number(agreed.payWithinDays) }; actualChanges.chase = { counterpartyId: e.lever.counterpartyId, payWithinDays: actual.payWithinDays }; } break;
        case "early_payment_discount": asked = { daysEarly: e.lever.daysEarly, discountBps: e.lever.discountBps }; if (agreed?.discountBps !== undefined && agreed.daysEarly !== undefined) { actual = { daysEarly: Number(agreed.daysEarly), discountBps: Number(agreed.discountBps) }; actualChanges.earlyPayment = { counterpartyId: e.lever.counterpartyId, ...actual } as TermChanges["earlyPayment"]; } break;
        default: break;
      }
      if (!actual) explanation.push(`${e.lever.kind}: no agreed thread with this counterparty in the sandbox (the agreement is missing or was withdrawn)`);
    } else if (req.kind === "sandbox.submit_application" && e.lever.kind === "finance_invoice") {
      asked = { advanceBps: e.lever.advanceBps };
      const id = rec?.applicationId ?? pointer?.applicationId;
      const [a] = id ? await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.id, id), eq(sandboxApplications.businessId, businessId))) : [];
      const o = (a?.offer ?? null) as { response?: { outcome?: string; terms?: { advanceBps?: number | string; feeBps?: number | string } | null } } | null;
      if (a && a.status === "accepted" && a.lenderId === req.lenderId && o?.response?.outcome === "offer" && o.response.terms) {
        actual = { advanceBps: Number(o.response.terms.advanceBps), feeBps: Number(o.response.terms.feeBps) };
        actualChanges.invoiceFinance = { advanceBps: actual.advanceBps, feeBps: actual.feeBps };
      } else explanation.push(`finance_invoice: no accepted application from this lender in the sandbox (status ${a?.status ?? "missing"})`);
    }
    actualTerms.push({ index: e.index, kind: e.lever.kind, asked, recorded: recordedTerms, actual });
    if (actual && !sameTerms(recordedTerms, actual)) explanation.push(`${e.lever.kind}: the sandbox now shows ${JSON.stringify(actual)} but the log recorded ${JSON.stringify(recordedTerms)} when the counterparty agreed (the sandbox state was changed after agreement)`);
    if (recordedTerms) for (const [k, v] of Object.entries(recordedTerms)) if (asked[k] !== undefined && asked[k] !== v) explanation.push(`${e.lever.kind}: ${k} was agreed as ${v}; the plan asked for ${asked[k]}`);
    if (e.lever.kind === "finance_invoice" && recordedTerms?.feeBps !== undefined && recordedTerms.feeBps !== FINANCE_FEE_BPS_ASSUMPTION) explanation.push(`finance_invoice: the lender's fee is ${recordedTerms.feeBps / 100}% of the invoice (the default planning assumption is ${FINANCE_FEE_BPS_ASSUMPTION / 100}%)`);
  }

  // 3. Recompute with the deterministic engine: expected (recorded terms) and actual (sandbox terms).
  const ctx = await buildContext(db, businessId, null);
  const base = ctx.pending.map((p) => p.event);
  const sum = (xs: typeof base) => xs.reduce((a, e) => a + e.amountMinor, 0n);
  const metricsFor = (changes: TermChanges): Metrics => {
    const events = Object.keys(changes).length === 0 ? base : applyTermChanges(base, changes);
    const f = buildForecast(ctx.input, { events, horizonWeeks, adjustments: adjustmentsOf(changes) });
    const cost = sum(base) - sum(events) + f.adjustmentCostMinor;
    return {
      minBalanceMinor: f.minimum.amount.toString(), minBalanceWeek: f.minimum.weekIndex + 1, firstNegativeWeek: f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null,
      closingAtHorizonMinor: f.weeks[f.weeks.length - 1].closing.toString(), totalCostMinor: (cost > 0n ? cost : 0n).toString(), weeksBelowZero: f.weeksBelowZero.length,
    };
  };
  const expected = metricsFor(recordedChanges);
  const actual = metricsFor(actualChanges);

  const tol = verifyTolerance();
  const cmpMoney = (name: string, ref: string | number | null, a: string): MetricComparison => {
    const P = BigInt(String(ref ?? "0"));
    const A = BigInt(a);
    const allowed = [tol.floorMinor, (abs(P) * BigInt(tol.bps)) / 10000n].reduce((x, y) => (x > y ? x : y));
    const diff = A - P;
    return { name, kind: "money", promised: P.toString(), actual: a, difference: diff.toString(), tolerance: allowed.toString(), ok: abs(diff) <= allowed };
  };
  const cmpWeek = (name: string, ref: string | number | null, a: number | null): MetricComparison => {
    const P = ref === null || ref === undefined ? null : Number(ref);
    return { name, kind: "week", promised: P === null ? null : String(P), actual: a === null ? null : String(a), difference: P === null || a === null ? (P === a ? "0" : null) : String(a - P), tolerance: "0", ok: P === a };
  };
  const compare = (ref: Record<string, string | number | null>, got: Metrics): MetricComparison[] => [
    cmpMoney("minBalanceMinor", ref.minBalanceMinor, got.minBalanceMinor),
    cmpWeek("minBalanceWeek", ref.minBalanceWeek, got.minBalanceWeek),
    cmpWeek("firstNegativeWeek", ref.firstNegativeWeek, got.firstNegativeWeek),
    cmpMoney("closingAtHorizonMinor", ref.closingAtHorizonMinor, got.closingAtHorizonMinor),
    cmpMoney("totalCostMinor", ref.totalCostMinor, got.totalCostMinor),
  ];
  const fmt = (m: string | null) => (m === null ? "none" : formatMoney(money(BigInt(m), ctx.currency), 2));

  // PASS/FAIL: expected-from-agreed-terms against the recomputation from the sandbox state.
  const metrics = compare(expected as unknown as Record<string, string | number | null>, actual);
  for (const m of metrics.filter((x) => !x.ok)) {
    explanation.unshift(m.kind === "money"
      ? `${m.name}: expected ${fmt(m.promised)} from the agreed terms, recomputed ${fmt(m.actual)} from the sandbox (difference ${fmt(m.difference)}, tolerance ${fmt(m.tolerance)})`
      : `${m.name}: expected week ${m.promised ?? "none"} from the agreed terms, recomputed week ${m.actual ?? "none"} from the sandbox`);
  }

  // The scheduled payments and receipts must be exactly the ones the agreed terms imply.
  const buyerEntry = terms.entries.find((e) => e.lever.kind === "buyer_request_deposit");
  const finEntry = terms.entries.find((e) => e.lever.kind === "finance_invoice");
  const supEntry = terms.entries.find((e) => e.lever.kind === "supplier_reduce_deposit" || e.lever.kind === "supplier_defer_balance");
  const wanted: ScheduleItem[] = expectedSchedule(
    base, recordedChanges,
    { supplierId: supEntry?.lever.counterpartyId ?? ctx.parties.supplierId, buyerId: buyerEntry?.lever.counterpartyId ?? ctx.parties.buyerId, lenderId: finEntry?.lever.counterpartyId ?? ctx.parties.lenderId },
    { buyerThreadId: buyerEntry ? recorded.get(buyerEntry.index)?.threadId ?? null : null, applicationId: finEntry ? recorded.get(finEntry.index)?.applicationId ?? null : null },
  );
  const payIds = (outcome.scheduled ?? []).filter((x) => x.kind === "payment").map((x) => x.id);
  const rctIds = (outcome.scheduled ?? []).filter((x) => x.kind === "receipt").map((x) => x.id);
  const pays = payIds.length ? await db.select().from(sandboxPayments).where(and(eq(sandboxPayments.businessId, businessId), inArray(sandboxPayments.id, payIds))) : [];
  const rcts = rctIds.length ? await db.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), inArray(sandboxReceipts.id, rctIds))) : [];
  const scheduleProblems: string[] = [];
  const unmatched = [...wanted];
  const take = (pred: (i: ScheduleItem) => boolean, label: string) => {
    const k = unmatched.findIndex(pred);
    if (k < 0) scheduleProblems.push(`unexpected ${label} in the sandbox`);
    else unmatched.splice(k, 1);
  };
  for (const p of pays) {
    if (p.status !== "scheduled" && p.status !== "executed") scheduleProblems.push(`payment ${p.reference} is ${p.status}`);
    take((i) => i.kind === "payment" && i.amountMinor === p.amountMinor && i.date === p.scheduledFor, `payment ${p.reference} of ${p.amountMinor} on ${p.scheduledFor}`);
  }
  for (const r of rcts) {
    if (r.status !== "scheduled" && r.status !== "received") scheduleProblems.push(`receipt ${r.reference} is ${r.status}`);
    take((i) => i.kind === "receipt" && i.counterpartyId === r.counterpartyId && i.amountMinor === r.amountMinor && i.date === r.expectedOn, `receipt ${r.reference} of ${r.amountMinor} on ${r.expectedOn}`);
  }
  for (const i of unmatched) scheduleProblems.push(`missing ${i.kind} for ${i.eventKind}: ${i.amountMinor} on ${i.date}`);
  const schedule = { expected: wanted.length, found: pays.length + rcts.length, ok: scheduleProblems.length === 0, problems: scheduleProblems };
  explanation.push(...scheduleProblems.map((x) => `schedule: ${x}`));

  // Promise against the agreed-terms outcome (informational, labelled).
  const pv = compare(promised, expected);
  const pm = Object.fromEntries(pv.map((m) => [m.name, m]));
  const dMin = BigInt(pm.minBalanceMinor.difference ?? "0");
  const dCost = BigInt(pm.totalCostMinor.difference ?? "0");
  const dClose = BigInt(pm.closingAtHorizonMinor.difference ?? "0");
  const worse = (!pm.minBalanceMinor.ok && dMin < 0n) || (!pm.totalCostMinor.ok && dCost > 0n) || (!pm.closingAtHorizonMinor.ok && dClose < 0n) || (pm.firstNegativeWeek.promised === null && pm.firstNegativeWeek.actual !== null);
  const better = !worse && ((!pm.minBalanceMinor.ok && dMin > 0n) || (!pm.totalCostMinor.ok && dCost < 0n) || (!pm.closingAtHorizonMinor.ok && dClose > 0n));
  const stillAboveZero = BigInt(expected.minBalanceMinor) >= 0n;
  const direction: PromiseVsAgreed["direction"] = worse ? "worse" : better ? "better" : "same";
  const bits: string[] = [];
  if (!pm.minBalanceMinor.ok) bits.push(`lowest balance ${fmt(expected.minBalanceMinor)} instead of ${fmt(String(promised.minBalanceMinor))}`);
  if (!pm.totalCostMinor.ok) bits.push(`cost ${fmt(expected.totalCostMinor)} instead of ${fmt(String(promised.totalCostMinor))}`);
  if (!pm.firstNegativeWeek.ok) bits.push(expected.firstNegativeWeek === null ? "no negative week" : `first negative week ${expected.firstNegativeWeek}`);
  const label = direction === "same" ? "The agreed terms give the outcome the plan promised."
    : `The agreed terms are ${direction} than planned (${bits.join("; ")}); ${stillAboveZero ? "the balance stays above zero" : `the balance goes below zero in week ${expected.firstNegativeWeek ?? expected.minBalanceWeek}`}.`;
  const promiseVsAgreed: PromiseVsAgreed = { label, direction, stillAboveZero, metrics: pv };

  const ok = metrics.every((m) => m.ok) && schedule.ok && actualTerms.every((t) => t.actual !== null && sameTerms(t.recorded, t.actual));
  if (!ok && explanation.length === 0) explanation.push("The recomputed forecast does not match the outcome of the agreed terms.");

  const result: PlanVerification = { ok, authorisationId, tolerance: { floorMinor: tol.floorMinor.toString(), bps: tol.bps }, metrics, promiseVsAgreed, agreedOutcome: expected, actualTerms, schedule, explanation };
  await db.update(planExecutions).set({ verification: JSON.parse(JSON.stringify(result)), status: ok ? "completed" : "verification_failed" }).where(eq(planExecutions.id, exec.id));
  await db.update(agentRuns).set({ lifecycle: ok ? "executed" : "verification_failed" }).where(eq(agentRuns.id, auth.runId));
  await appendRecord(db, {
    businessId, event: ok ? ACTION_EVENTS.PLAN_VERIFIED : ACTION_EVENTS.PLAN_VERIFICATION_FAILED, actor: "verifier",
    detail: { authorisationId, ok, tolerance: result.tolerance, metrics, promiseVsAgreed, agreedOutcome: expected, actualTerms, schedule, explanation }, verification: ok ? "verified" : "failed",
  });
  return result;
}
