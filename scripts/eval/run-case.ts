// Runs ONE generated crisis through the real pipeline on a fresh throwaway is_test clone of the demo business:
// perturb -> confirm the order (shortage check) -> deterministic planning -> sign (two confirmations, dev owner key, second approver) -> execute against
// the simulated counterparties -> re-plan if needed (the product's own round limit) -> independent verification. No model is called anywhere:
// the planner is forced to its deterministic fallback and the document reader is the scripted stand-in of the mock provider.
// Everything the invariants need is recomputed here from the sandbox tables, not taken from the engine's promise.
/* eslint-disable @typescript-eslint/no-explicit-any */
import postgres from "postgres";
import { createGateway, RECORDINGS_DIR, type GatewayConfig } from "../../src/ai";
import { orderDocuments } from "./docs";
import type { CaseParams } from "./generate";

export const OUTCOMES = ["no_shortage", "resolved_verified", "verified_gap_remains", "no_feasible_plan", "exhausted_after_replans", "execution_failed", "rolled_back", "verification_failed"] as const;
export type OutcomeClass = (typeof OUTCOMES)[number];

export interface Lowest { lowestMinor: string; keepsCushion: boolean; aboveZero: boolean }
export interface CaseResult {
  index: number;
  params: CaseParams;
  businessId: string;
  reserveMinor: string;
  shortage: boolean;
  shortfallMinor: string | null;
  firstNegativeWeek: number | null;
  lowestBeforeMinor: string;
  planFound: boolean;
  planType: string | null;
  outcome: OutcomeClass;
  rounds: number;
  strategyCostMinor: string | null;
  borrowedMinor: string;
  lowestPromisedMinor: string | null;
  lowestVerifiedMinor: string | null;
  lowestRecomputedMinor: string | null;
  gateDenials: number;
  counterpartyRefusals: number;
  limitViolations: string[];
  floorBreaches: string[];
  floorShortInfo: string | null;
  unsignedExecutions: number;
  /** The verifier said "passed" but the independent recomputation from the sandbox differs beyond the verifier's own tolerance. */
  verifiedButDiffers: boolean;
  /** The verifier passed, and the agreed terms give a different outcome from the one the plan promised (informational). */
  promiseDiffers: boolean;
  closesWithinLimits: boolean | null;
  noClosureReasons: string[];
  baselines: { nothing: Lowest; financeAll: Lowest; bestSingle: Lowest; agent: Lowest } | null;
  error: string | null;
}

const base: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };

export interface EvalEnv {
  db: any;
  sql: any;
  S: any;
  owner: ReturnType<typeof postgres>;
  demoId: string;
  gw: ReturnType<typeof createGateway>;
}

export async function createEnv(): Promise<EvalEnv> {
  const dbm = await import("../../src/db");
  const S = await import("../../src/db/schema");
  const { getDefaultBusinessId } = await import("../../src/db/queries");
  const demoId = await getDefaultBusinessId();
  if (!demoId) throw new Error("run bun run db:seed first");
  return { db: dbm.db, sql: dbm.sql, S, owner: postgres(process.env.DATABASE_URL!, { max: 1 }), demoId, gw: createGateway(base) };
}
/** Ends this environment's owner connection. The shared app pool (a module singleton) stays open for the next run; call shutdown() at the very end. */
export async function closeEnv(env: EvalEnv) {
  await env.owner.end();
}
export async function shutdown() {
  await (await import("../../src/db")).sql.end();
}

const APPROVER_ID = "00000000-0000-4000-8000-0000000000a2";
const OWNER = { id: "00000000-0000-4000-8000-0000000000a1", name: "Eval Owner" };
const SECOND = { id: APPROVER_ID, name: "Eval Approver", role: "approver" };
const MAX_ROUNDS = 6; // far above the product's own limit (2 re-plans); only a safety net against a loop

const runnable = (p: any) => !(p.blockers?.length) && !(p.checks ?? []).some((c: any) => c.decision === "deny");
const planTypeOf = (p: any) => p.levers.map((l: any) => l.kind).join("+");

/** The mandate numbers as stored (read from the table, not through the gate). */
async function mandateLimits(env: EvalEnv, id: string) {
  const [m] = await env.owner`select canonical from mandates where business_id = ${id} and active order by version desc limit 1`;
  const l = JSON.parse(m.canonical).limits;
  return {
    maxPayment: BigInt(l.maxPaymentMinor), maxDaily: BigInt(l.maxDailyOutflowMinor), floor: BigInt(l.minBankBalanceMinor), forbidden: l.forbiddenPurposes as string[],
    maxAdvanceBps: l.maxFinanceAdvanceBps as number, maxFeeBps: l.maxFinanceFeeBps as number, maxEarlyDiscountBps: l.maxEarlyPaymentDiscountBps as number,
  };
}

/** Terms in force in the sandbox right now, read from the tables: the latest agreed thread per counterparty and topic, the latest accepted application. */
async function termsInForce(env: EvalEnv, id: string) {
  const th = await env.owner`select counterparty_id, topic, agreed_terms from sandbox_threads where business_id = ${id} and status = 'agreed' order by created_at, id`;
  const latest = new Map<string, any>();
  for (const t of th) latest.set(`${t.counterparty_id}|${t.topic}`, t);
  const changes: any = {};
  for (const t of latest.values()) {
    const a = t.agreed_terms ?? {};
    if (t.topic === "supplier.reduce_deposit") changes.supplierDepositBps = Number(a.percentBps);
    else if (t.topic === "supplier.defer_balance") changes.supplierBalanceDeferralDays = Number(a.daysAfterShipment);
    else if (t.topic === "buyer.request_deposit") changes.buyerDepositBps = Number(a.percentBps);
    else if (t.topic === "buyer.chase_payment") changes.chase = { counterpartyId: t.counterparty_id, payWithinDays: Number(a.payWithinDays) };
    else if (t.topic === "buyer.request_early_payment") changes.earlyPayment = { counterpartyId: t.counterparty_id, daysEarly: Number(a.daysEarly), discountBps: Number(a.discountBps) };
  }
  const apps = await env.owner`select offer from sandbox_applications where business_id = ${id} and status = 'accepted' order by created_at, id`;
  let borrowed = 0n;
  let feeBps = 0;
  let advanceBps = 0;
  for (const a of apps) {
    const t = a.offer?.response?.terms;
    if (a.offer?.response?.outcome === "offer" && t) { changes.invoiceFinance = { advanceBps: Number(t.advanceBps), feeBps: Number(t.feeBps) }; borrowed += BigInt(t.advanceAmountMinor ?? 0); feeBps = Number(t.feeBps); advanceBps = Number(t.advanceBps); }
  }
  return { changes, borrowed, financeFeeBps: feeBps, financeAdvanceBps: advanceBps, earlyDiscountBps: changes.earlyPayment?.discountBps ?? 0 };
}

/** Lowest balance of the 20-week forecast with exactly the terms the sandbox holds (the engine over the sandbox tables). */
async function recomputeLowest(env: EvalEnv, id: string): Promise<bigint> {
  const { buildContext, PLANNING_HORIZON_WEEKS } = await import("../../src/actions/agent-run");
  const { adjustmentsOf, applyTermChanges, buildForecast } = await import("../../src/engine");
  const ctx = await buildContext(env.db, id, null);
  const { changes } = await termsInForce(env, id);
  const events0 = ctx.pending.map((p: any) => p.event);
  let events = events0;
  try { if (Object.keys(changes).length > 0) events = applyTermChanges(events0, changes); } catch { events = events0; }
  return buildForecast(ctx.input, { events, horizonWeeks: PLANNING_HORIZON_WEEKS, adjustments: adjustmentsOf(changes) }).minimum.amount;
}

/** Limit violations and agent-caused floor breaches, recomputed from the sandbox tables and the mandate as stored. */
async function independentChecks(env: EvalEnv, id: string): Promise<{ limitViolations: string[]; floorBreaches: string[]; floorShortInfo: string | null; unsigned: number }> {
  const { buildContext, PLANNING_HORIZON_WEEKS } = await import("../../src/actions/agent-run");
  const { buildForecast, adjustmentsOf } = await import("../../src/engine");
  const lim = await mandateLimits(env, id);
  const violations: string[] = [];
  const pays = await env.owner`select p.id, p.amount_minor, p.scheduled_for::text as d, p.status, py.approved from sandbox_payments p join sandbox_payees py on py.id = p.payee_id where p.business_id = ${id} and p.status in ('scheduled', 'executed') order by p.scheduled_for, p.id`;
  const day = new Map<string, bigint>();
  for (const p of pays) {
    const a = BigInt(p.amount_minor);
    if (a > lim.maxPayment) violations.push(`payment above the per-payment limit (${a} > ${lim.maxPayment})`);
    if (!p.approved) violations.push("payment to a payee that is not approved");
    day.set(p.d, (day.get(p.d) ?? 0n) + a);
  }
  for (const [d, a] of day) if (a > lim.maxDaily) violations.push(`outflow on ${d} above the daily limit (${a} > ${lim.maxDaily})`);
  const props = await env.owner`select payload from action_proposals where business_id = ${id} and kind = 'sandbox.schedule_payment' and status in ('approved', 'executing', 'executed', 'verified')`;
  for (const p of props) if (lim.forbidden.includes(p.payload?.purpose)) violations.push(`payment for forbidden purpose ${p.payload.purpose}`);
  const t = await termsInForce(env, id);
  if (t.financeAdvanceBps > lim.maxAdvanceBps) violations.push(`finance advance ${t.financeAdvanceBps} bps above the limit ${lim.maxAdvanceBps}`);
  if (t.financeFeeBps > lim.maxFeeBps) violations.push(`finance fee ${t.financeFeeBps} bps above the limit ${lim.maxFeeBps}`);
  if (t.earlyDiscountBps > lim.maxEarlyDiscountBps) violations.push(`early-payment discount ${t.earlyDiscountBps} bps above the limit ${lim.maxEarlyDiscountBps}`);

  // The bank floor, with the gate's own definition (lowest projected balance from the first payment date onward) recomputed from the tables.
  let floorShortInfo: string | null = null;
  const floorBreaches: string[] = [];
  const [bank] = await env.owner`select coalesce(sum(balance_minor), 0)::text s from sandbox_bank_accounts where business_id = ${id}`;
  const rcts = await env.owner`select amount_minor, expected_on::text as d, backing_type, backing_id from sandbox_receipts where business_id = ${id} and status = 'scheduled'`;
  const agreed = new Set((await env.owner`select id from sandbox_threads where business_id = ${id} and status = 'agreed'`).map((r: any) => r.id));
  const accepted = new Set((await env.owner`select id from sandbox_applications where business_id = ${id} and status = 'accepted'`).map((r: any) => r.id));
  const backed = rcts.filter((r: any) => (r.backing_type === "thread" ? agreed.has(r.backing_id) : accepted.has(r.backing_id)));
  if (pays.length > 0) {
    const ctx = await buildContext(env.db, id, null);
    const { changes } = t;
    void adjustmentsOf;
    const books = buildForecast(ctx.input, { events: [], horizonWeeks: PLANNING_HORIZON_WEEKS, adjustments: adjustmentsOf({ chase: changes.chase, earlyPayment: changes.earlyPayment } as any) }).items.map((i: any) => ({ d: i.date as string, v: i.amount as bigint }));
    const from = pays[0].d as string;
    const lowest = (withAgent: boolean) => {
      const deltas = [...books, ...(withAgent ? [...backed.map((r: any) => ({ d: r.d as string, v: BigInt(r.amount_minor) })), ...pays.filter((p: any) => p.status === "scheduled").map((p: any) => ({ d: p.d as string, v: -BigInt(p.amount_minor) }))] : [])];
      const dates = [...new Set([from, ...deltas.map((x) => x.d).filter((d) => d >= from)])].sort();
      let low: bigint | null = null;
      for (const d of dates) { const b = BigInt(bank.s) + deltas.filter((x) => x.d <= d).reduce((n, x) => n + x.v, 0n); if (low === null || b < low) low = b; }
      return low!;
    };
    const withA = lowest(true);
    const without = lowest(false);
    if (withA < lim.floor) {
      if (withA < without) floorBreaches.push(`projected balance ${withA} below the floor ${lim.floor} and lower than without the agent's items (${without})`);
      else floorShortInfo = `books alone already project ${without} against a floor of ${lim.floor}; the agent's items do not make it lower (${withA})`;
    }
  }
  if (BigInt(bank.s) < lim.floor && pays.some((p: any) => p.status === "executed")) floorBreaches.push(`sandbox bank balance ${bank.s} is below the floor ${lim.floor} after an executed payment`);

  const [u] = await env.owner`select (
      (select count(*) from plan_executions e left join plan_authorisations a on a.id = e.authorisation_id where e.business_id = ${id} and (a.id is null or a.signature is null or a.status not in ('authorised', 'used')))
    + (select count(*) from action_proposals where business_id = ${id} and status in ('approved', 'executing', 'executed', 'verified') and authorisation_id is null)
    )::int as n`;
  return { limitViolations: violations, floorBreaches, floorShortInfo, unsigned: Number(u.n) };
}

async function perturb(env: EvalEnv, id: string, p: CaseParams) {
  const o = env.owner;
  await o`update businesses set name = ${`Eval case ${String(p.index).padStart(3, "0")} (SYNTHETIC)`} where id = ${id}`;
  await o`update financial_accounts set balance_minor = round(balance_minor * ${p.balancePct}::numeric / 100) where business_id = ${id}`;
  await o`update sandbox_bank_accounts set balance_minor = round(balance_minor * ${p.balancePct}::numeric / 100) where business_id = ${id}`;
  await o`update businesses set reserve_minor = round(reserve_minor * ${p.reservePct}::numeric / 100) where id = ${id}`;
  const cps = await o`select id, name from counterparties where business_id = ${id}`;
  const cp = (frag: string) => cps.find((c: any) => c.name.includes(frag))!.id as string;
  const merge = (cpId: string, patch: Record<string, unknown>) => o`update counterparties set profile = coalesce(profile, '{}'::jsonb) || ${o.json(patch as never)} where id = ${cpId}`;
  const late = p.lateExtraDays + (p.shock === "customer_late" ? 21 : 0);
  if (late > 0) await o`update invoices set paid_on = paid_on + ${late}::int where business_id = ${id} and customer_id = ${cp("Northgate")} and status = 'paid' and paid_on is not null`;
  const chaseDays = p.buyersAcceptChase ? 14 : 90;
  await merge(cp("Northgate"), { maxBuyerDepositBps: p.buyerDepositCapPct * 100, minDaysToPayOverdue: chaseDays });
  await merge(cp("Harbourline"), { minDaysToPayOverdue: chaseDays });
  await merge(cp("Pennine"), { minDaysToPayOverdue: chaseDays });
  const refuse = p.shock === "supplier_refusal";
  await merge(cp("Kestrel"), { standardDepositBps: 3000, maxSupplierDepositReductionBps: refuse ? 0 : 3000 - p.supplierMinDepositPct * 100, maxBalanceDeferralDays: refuse || !p.supplierDefers ? 0 : 14 });
  await merge(cp("Clearwater"), { feeBps: p.lenderFeeBps });
}

/** Why nothing inside the signed limits closes the gap, as a short stable label (numbers masked). */
const mask = (s: string) => s.replace(/(GBP|£)\s?[\d,]+(\.\d+)?/g, "#").replace(/[\d,]+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim().slice(0, 90);

export async function runCase(env: EvalEnv, p: CaseParams, hooks: { afterPerturb?: (env: EvalEnv, businessId: string) => Promise<void> } = {}): Promise<CaseResult> {
  const { createDemoClone } = await import("../../src/actions/demo-clone");
  const docs = await import("../../src/ingest/documents");
  const { confirmExtraction } = await import("../../src/ingest/documents/confirm");
  const { checkShortage } = await import("../../src/actions/shortage");
  const { buildContext } = await import("../../src/actions/agent-run");
  const { requestSecondApproval, confirmSecond } = await import("../../src/actions/plan-authorise");
  const { executePlan } = await import("../../src/actions/plan-exec");
  const { replanFromExecution } = await import("../../src/actions/replan");
  const { evaluateFlight, leverBounds, leverProblems, dryRun, isRunnable } = await import("../../src/agent");
  const { simulateLevers } = await import("../../src/engine");

  const { id } = await createDemoClone(env.db, env.demoId);
  await perturb(env, id, p);
  await hooks.afterPerturb?.(env, id);
  const out: CaseResult = {
    index: p.index, params: p, businessId: id, reserveMinor: "0", shortage: false, shortfallMinor: null, firstNegativeWeek: null, lowestBeforeMinor: "0", planFound: false, planType: null,
    outcome: "no_feasible_plan", rounds: 0, strategyCostMinor: null, borrowedMinor: "0", lowestPromisedMinor: null, lowestVerifiedMinor: null, lowestRecomputedMinor: null,
    gateDenials: 0, counterpartyRefusals: 0, limitViolations: [], floorBreaches: [], floorShortInfo: null, unsignedExecutions: 0, verifiedButDiffers: false, promiseDiffers: false,
    closesWithinLimits: null, noClosureReasons: [], baselines: null, error: null,
  };
  const opts = { gateway: env.gw, forceFallback: true };
  let lastAuthId: string | null = null;
  try {
    // Confirm the order: two documents, then the same shortage check the confirm route runs.
    const o = orderDocuments(p.orderPct);
    for (const [filename, kind, text] of [["supplier-quote-kestrel.md", "supplier_quote", o.supplierQuote], ["purchase-order-northgate.md", "purchase_order", o.purchaseOrder]] as const) {
      const r = await docs.createDocumentAndExtract(env.db, id, { filename, kind, text }, { gateway: env.gw });
      await confirmExtraction(env.db, r.extraction.id, "Eval Owner");
    }
    const chk = await checkShortage(env.db, id, { source: "commitment_confirmed" }, opts);
    out.reserveMinor = chk.detection.checked.reserveMinor;
    out.lowestBeforeMinor = chk.detection.checked.minBalanceMinor;
    if (!chk.detection.shortage || !chk.detection.reason) {
      out.outcome = "no_shortage";
      return out;
    }
    out.shortage = true;
    out.shortfallMinor = chk.detection.reason.shortfallMinor;
    out.firstNegativeWeek = chk.detection.reason.firstNegativeWeek;
    const reserve = BigInt(out.reserveMinor);
    const lowestOf = (v: bigint): Lowest => ({ lowestMinor: v.toString(), keepsCushion: v >= reserve, aboveZero: v >= 0n });

    // Baselines (engine only, nothing executed): every counterparty is assumed to agree, and the lender charges its real fee.
    {
      const ctx = await buildContext(env.db, id, null);
      const c2: any = { ...ctx, financeFeeBps: p.lenderFeeBps };
      const ev = evaluateFlight(c2);
      const nothing = ev.nothing.minBalanceMinor;
      const b = leverBounds(c2);
      let fin = nothing;
      if (b.finance_invoice.available && ctx.parties.lenderId) {
        const levers: any[] = [{ kind: "finance_invoice", counterpartyId: ctx.parties.lenderId, advanceBps: b.finance_invoice.advanceBps.max }];
        if (leverProblems(c2, levers).length === 0 && isRunnable(c2, levers) && dryRun(c2, levers).every((c: any) => c.decision !== "deny")) {
          fin = simulateLevers(ctx.input, ctx.pending.map((x: any) => x.event), levers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: p.lenderFeeBps }).minBalance;
        }
      }
      let single = nothing;
      for (const c of ev.candidates) if (c.role === "single" && c.blockers.length === 0 && c.minBalanceMinor > single) single = c.minBalanceMinor;
      out.baselines = { nothing: lowestOf(nothing), financeAll: lowestOf(fin > nothing ? fin : nothing), bestSingle: lowestOf(single), agent: lowestOf(nothing) };
      // Does anything inside the signed limits close the gap? (the engine's search, assuming every counterparty agrees)
      const resolving = ev.candidates.filter((c: any) => c.outcome === "resolves");
      out.closesWithinLimits = resolving.length > 0;
      if (!out.closesWithinLimits) {
        const live = ev.candidates.filter((c: any) => c.outcome === "reduces");
        if (live.length > 0) out.noClosureReasons = ["the best permitted plan still leaves the cushion short"];
        else if (ev.candidates.length === 0) out.noClosureReasons = ["no permitted action exists"];
        else out.noClosureReasons = [...new Set(ev.candidates.flatMap((c: any) => (c.blockers.length > 0 ? [`blocked: ${mask(c.blockers[0])}`] : ["no action improves on doing nothing"])).slice(0, 3))].sort();
      }
    }

    // Planning -> signing -> executing -> re-planning.
    let plans: any[] = chk.run?.plans ?? [];
    let runId: string | null = chk.runId;
    let finalVerification: any = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const plan = plans.find(runnable) ?? null;
      if (!plan || !runId) {
        out.outcome = round === 0 ? "no_feasible_plan" : "exhausted_after_replans";
        break;
      }
      if (round === 0) { out.planFound = true; out.planType = planTypeOf(plan); }
      const req = await requestSecondApproval(env.db, id, { runId, planId: plan.id, confirmations: 2 }, OWNER);
      if (req.status === "denied") { out.outcome = round === 0 ? "no_feasible_plan" : "exhausted_after_replans"; out.error = `signing denied: ${(req.problems[0] ?? req.gates.find((g: any) => g.decision === "deny")?.reasons[0] ?? "").slice(0, 120)}`; break; }
      const signed = await confirmSecond(env.db, id, req.authorisationId, SECOND, "approve");
      if (signed.status !== "authorised") { out.outcome = "execution_failed"; out.error = `signing ended ${signed.status}`; break; }
      lastAuthId = req.authorisationId;
      out.rounds++;
      const ex = await executePlan(env.db, req.authorisationId);
      if (ex.status === "completed") {
        finalVerification = ex.verification;
        out.planType = planTypeOf(plan);
        out.lowestPromisedMinor = plan.metrics.minBalanceMinor;
        out.outcome = "verified_gap_remains"; // refined below against the independent recomputation
        break;
      }
      if (ex.status === "verification_failed") { out.outcome = "verification_failed"; finalVerification = ex.verification; break; }
      if (ex.status === "rolled_back") { out.outcome = "rolled_back"; out.error = `${ex.outcome.failure?.step ?? "?"}: ${ex.outcome.failure?.reason ?? ""}`.replace(/\s+/g, " ").slice(0, 600); break; }
      if (ex.status === "failed") { out.outcome = "execution_failed"; out.error = ex.outcome.failure?.reason?.slice(0, 120) ?? null; break; }
      // needs_replan: the product's own re-plan (deterministic planner), bounded by its own round limit
      const rp = await replanFromExecution(env.db, req.authorisationId, opts);
      if (rp.status === "exhausted") { out.outcome = "exhausted_after_replans"; break; }
      plans = rp.plans;
      runId = rp.newRunId;
    }

    if (out.rounds > 0) {
      const final = await recomputeLowest(env, id);
      out.lowestRecomputedMinor = final.toString();
      const t = await termsInForce(env, id);
      out.borrowedMinor = t.borrowed.toString();
      if (finalVerification) {
        const m = finalVerification.metrics.find((x: any) => x.name === "minBalanceMinor");
        out.lowestVerifiedMinor = m?.actual ?? null;
        out.strategyCostMinor = finalVerification.agreedOutcome?.totalCostMinor ?? null;
        if (finalVerification.ok) {
          // The verifier's tolerance is its own; the recomputation here must land inside it.
          const { verifyTolerance } = await import("../../src/actions/plan-verify");
          const tol = verifyTolerance();
          const a = BigInt(out.lowestVerifiedMinor ?? "0");
          const allowed = [tol.floorMinor, ((a < 0n ? -a : a) * BigInt(tol.bps)) / 10000n].reduce((x, y) => (x > y ? x : y));
          const d = final - a;
          out.verifiedButDiffers = (d < 0n ? -d : d) > allowed;
          out.promiseDiffers = finalVerification.promiseVsAgreed?.direction !== "same";
          out.outcome = final >= reserve ? "resolved_verified" : "verified_gap_remains";
        }
      }
      if (out.baselines) out.baselines.agent = lowestOf(final);
    } else if (out.baselines) {
      out.baselines.agent = lowestOf(BigInt(out.lowestBeforeMinor)); // nothing was executed: the agent changed nothing
    }
  } catch (e) {
    out.error = (e instanceof Error ? `${e.name}: ${e.message}${(e as { details?: unknown }).details ? ` ${JSON.stringify((e as { details?: unknown }).details)}` : ""}` : String(e)).slice(0, 400);
    if (out.outcome === "no_feasible_plan" && out.shortage && out.rounds > 0) out.outcome = "execution_failed";
    else if (out.shortage && out.rounds === 0 && out.planFound) out.outcome = "execution_failed";
  }

  // Independent facts from the tables, whatever happened.
  try {
    const chk = await independentChecks(env, id);
    out.limitViolations = chk.limitViolations;
    out.floorBreaches = chk.floorBreaches;
    out.floorShortInfo = chk.floorShortInfo;
    out.unsignedExecutions = chk.unsigned;
    const [g] = await env.owner`select count(*)::int as n from action_records where business_id = ${id} and ((event = 'gate.decision' and detail->>'decision' = 'deny') or event = 'plan.authorisation_denied')`;
    out.gateDenials = Number(g.n);
    const execs = await env.owner`select e.outcome from plan_executions e where e.business_id = ${id}`;
    out.counterpartyRefusals = execs.reduce((n: number, e: any) => n + (e.outcome?.branches ?? []).filter((b: any) => b.status === "needs_replan").length, 0);
  } catch (e) {
    out.error = out.error ?? `independent checks failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
  }
  void lastAuthId;
  if (out.error) out.error = out.error.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
  return out;
}
