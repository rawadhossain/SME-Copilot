// HANDOFF FROM THE FLIGHT SIMULATOR INTO PLANS. The owner picks a strategy the simulator showed; this turns it into an UNSIGNED plan in the existing
// Plans workflow, and nothing else. It never signs, authorises, approves, executes, schedules or sends, and it never reuses a simulation as proof of
// anything: signing (fresh password, signature, second approver where the limits ask), the permission gate, the sandbox and the independent check all
// happen later, unchanged, exactly as for any plan.
//
// Nothing the browser sends is trusted for substance. The request carries only ids and the scenario the owner typed; the server
//   1. finds its own log record of that simulation (business-scoped, hash-chained) and checks the scenario matches its hash and the record is not stale,
//   2. re-runs the scenario NOW on the current books and finds the strategy by id among the strategies it computed (the terms come from there),
//   3. refuses anything that is not resolves/reduces and permitted (rejected, blocked, unacceptable, no help),
//   4. rebuilds the plan on the REAL books through the same owner-plan path as "Adjust terms" (signed limits, learned refusals, gate dry-run, runnable),
//   5. says what changed since the simulation; changed books or a pre-emptive plan (no shortage today) need an explicit acknowledgement to proceed.
// The only writes (commit): one plan row (and, if there is no open case, one run row that only holds it) and one `simulation.handed_off` log record.
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { doNothingSummary } from "@/agent";
import { actionRecords, agentRuns, agentSteps, plans } from "@/db/schema";
import { planId, type PlanView } from "@/domain/plan";
import { toJsonValue } from "@/sandbox/proposals";
import { formatMinor } from "@/agent/plan-builder";
import { buildContext } from "./agent-run";
import { hashShocks, liveContext, runOne, scenarioSchema } from "./flight-simulator";
import { appendRecord } from "./log";
import { loadKnownConstraints } from "./negotiation-memory";
import { makeOwnerView } from "./plan-edit";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

/** A simulation older than this is refused: simulate again so the owner sees fresh figures. */
export const HANDOFF_MAX_AGE_HOURS = 12;
const maxAgeHours = (): number => { const n = Number(process.env.HANDOFF_MAX_AGE_HOURS); return Number.isFinite(n) && n >= 0 ? n : HANDOFF_MAX_AGE_HOURS; };
const FALLBACK = "You can still open Plans and use the planner's own options, or its Adjust terms, with your real books.";

export const handoffInputSchema = z.object({
  simulationId: z.string().uuid(),
  scenario: scenarioSchema,
  strategyId: z.string().regex(/^[0-9a-f]{16}$/),
  /** false (default): check and explain, write nothing. true: add the unsigned plan to Plans. */
  commit: z.boolean().default(false),
  /** The owner has read what changed / that this is pre-emptive. */
  acknowledge: z.boolean().default(false),
});

interface Basis { asOf: string; scenarioName: string; lowestBalanceMinor: string; candidates: { id: string; outcome: string; minBalanceMinor: string; costMinor: string }[] }

export interface HandoffReview {
  strategy: { id: string; title: string; leverText: string[] };
  /** What the simulation said when the owner saw it, and what the same scenario says now. */
  simulated: { seenLowestMinor: string; nowLowestMinor: string; seenStrategyLowestMinor: string; nowStrategyLowestMinor: string; seenCostMinor: string; nowCostMinor: string };
  changes: string[];
  material: boolean;
  /** The recalculation on today's real books (no hypothetical event applied). */
  realBooks: { shortageToday: boolean; doNothingLowestMinor: string; planLowestMinor: string; planLowestWeek: number; costMinor: string; keepsCushion: boolean; reserveMinor: string; checks: { lever: string; decision: string; reasons: string[] }[]; warnings: string[] };
  /** Why the owner must tick a box before the plan is added. */
  mustAcknowledge: string[];
  notes: string[];
}

export type HandoffResult =
  | { ok: false; reasons: string[]; fallback: string }
  | { ok: true; committed: false; review: HandoffReview }
  | { ok: true; committed: true; unchanged: boolean; runId: string; planId: string; caseUrl: string; review: HandoffReview };

export async function handoffStrategy(db: Db, businessId: string, input: unknown): Promise<HandoffResult> {
  const p = handoffInputSchema.parse(input);

  // 1. The server's own record of that simulation.
  const [rec] = await db.select().from(actionRecords).where(and(eq(actionRecords.id, p.simulationId), eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.SIMULATION_RUN)));
  const detail = (rec?.detail ?? null) as { scenarioSha256?: string; handoffBasis?: Basis } | null;
  if (!rec || !detail?.handoffBasis) throw new ActionError("not_found", "That simulation is not on record for this company. Run it again.");
  if (detail.scenarioSha256 !== hashShocks(p.scenario.shocks)) throw new ActionError("refused", "The scenario does not match the simulation that was recorded, so it was not used. Run it again.");
  if (Date.now() - new Date(rec.createdAt).getTime() > maxAgeHours() * 3_600_000) throw new ActionError("refused", `That simulation is more than ${maxAgeHours()} hours old. Run it again so you see current figures.`);
  const seen = detail.handoffBasis.candidates.find((c) => c.id === p.strategyId);
  if (!seen) throw new ActionError("refused", "That strategy was not one of the strategies this simulation showed.");

  // 2. The same scenario, recomputed now on the current books. The terms come from here, never from the request.
  const sim = runOne(await liveContext(db, businessId), p.scenario);
  const now = (sim.evaluation.candidates as { id: string; title: string; outcome: string; leverText: string[]; levers: PlanView["levers"]; blockers: string[]; minBalanceMinor: bigint; costMinor: bigint; role: string }[]).find((c) => c.id === p.strategyId);
  if (!now) return { ok: false, reasons: ["The books changed and this strategy is no longer one of the strategies for that scenario. Run the simulation again."], fallback: FALLBACK };

  // 3. Eligibility: only a strategy that helps and is permitted.
  const why: Record<string, string> = {
    blocked: `It cannot be used: ${now.blockers.slice(0, 2).join("; ")}.`, unacceptable: "It was rejected as an unacceptable cost or risk.", no_help: "It does not improve the lowest balance in this scenario.",
  };
  if (now.role === "nothing" || (now.outcome !== "resolves" && now.outcome !== "reduces") || now.blockers.length > 0) return { ok: false, reasons: [why[now.outcome] ?? "It is not a strategy that can be proposed."], fallback: FALLBACK };

  // 4. The real books, through the same path as the owner's "Adjust terms".
  const known = await loadKnownConstraints(db, businessId);
  const ctx = await buildContext(db, businessId, null, known);
  const made = makeOwnerView(ctx, {}, "simulation", now.levers, {});
  if (!made.ok) return { ok: false, reasons: [`On your real books today these terms cannot be proposed: ${made.reasons.slice(0, 3).join("; ")}.`], fallback: FALLBACK };
  const view = made.view;
  if (planId(view.levers) !== p.strategyId) throw new ActionError("refused", "The plan built from these terms does not match the strategy that was selected");
  const dn = doNothingSummary(ctx);
  const reserve = ctx.input.reserve;
  const m = (v: bigint | string) => formatMinor(v.toString(), ctx.currency);
  const shortageToday = BigInt(dn.minBalanceMinor) < reserve;

  const changes: string[] = [];
  const b = detail.handoffBasis;
  if (b.asOf !== ctx.asOf) changes.push(`The books moved on from ${b.asOf} to ${ctx.asOf}.`);
  if (b.lowestBalanceMinor !== sim.simulated.minBalanceMinor) changes.push(`The scenario's lowest balance was ${m(b.lowestBalanceMinor)} when you ran it; it is ${m(sim.simulated.minBalanceMinor)} now.`);
  if (seen.minBalanceMinor !== now.minBalanceMinor.toString()) changes.push(`This strategy reached a lowest balance of ${m(seen.minBalanceMinor)} in the simulation you saw; it reaches ${m(now.minBalanceMinor)} now.`);
  if (seen.costMinor !== now.costMinor.toString()) changes.push(`Its cost was ${m(seen.costMinor)}; it is ${m(now.costMinor)} now.`);
  if (seen.outcome !== now.outcome) changes.push(`It used to be classed "${seen.outcome}"; it is now "${now.outcome}".`);
  const material = changes.length > 0;
  const mustAcknowledge: string[] = [];
  if (material) mustAcknowledge.push("The figures differ from the simulation you saw (listed above). Review the revised outcome.");
  if (!shortageToday) mustAcknowledge.push("Your real books show no shortage today. This plan is pre-emptive: it prepares for the scenario you simulated, which has not happened.");

  const review: HandoffReview = {
    strategy: { id: p.strategyId, title: now.title, leverText: now.leverText },
    simulated: { seenLowestMinor: b.lowestBalanceMinor, nowLowestMinor: sim.simulated.minBalanceMinor, seenStrategyLowestMinor: seen.minBalanceMinor, nowStrategyLowestMinor: now.minBalanceMinor.toString(), seenCostMinor: seen.costMinor, nowCostMinor: now.costMinor.toString() },
    changes, material,
    realBooks: {
      shortageToday, doNothingLowestMinor: dn.minBalanceMinor, planLowestMinor: view.metrics.minBalanceMinor, planLowestWeek: view.metrics.minBalanceWeek, costMinor: view.metrics.totalCostMinor,
      keepsCushion: BigInt(view.metrics.minBalanceMinor) >= reserve, reserveMinor: reserve.toString(),
      checks: view.checks.map((c) => ({ lever: c.lever.kind, decision: c.decision, reasons: c.reasons })), warnings: view.warnings ?? [],
    },
    mustAcknowledge,
    notes: [
      "These terms are re-checked here against your real books, your signed limits and the permission gate. Counterparties have not been contacted and may refuse.",
      "Adding the plan creates an unsigned proposal only. You still review and sign it with your password, a second approver signs where your limits require it, and only then is anything sent to the sandbox and independently checked.",
    ],
  };
  if (!p.commit) return { ok: true, committed: false, review };
  if (mustAcknowledge.length > 0 && !p.acknowledge) throw new ActionError("conflict", "Read what changed and confirm before the plan is added.", { review });

  // 5. Write: one unsigned plan in a case, one log record. Serialised per company so a double click or a second tab adds it once.
  const stored: PlanView = {
    ...view, title: `Simulator strategy: ${now.leverText.join("; ")}`.slice(0, 120),
    rationale: `Taken from a simulation of "${b.scenarioName}". It is not an approval or a verified result. Every figure on this card was recomputed on your real books and every term was checked against your signed limits.`,
    fromSimulation: { simulationId: p.simulationId, scenario: b.scenarioName.slice(0, 80), simulatedLowestMinor: sim.simulated.minBalanceMinor },
  };
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`handoff:${businessId}`}))`);
    const runs = await tx.select().from(agentRuns).where(eq(agentRuns.businessId, businessId)).orderBy(desc(agentRuns.startedAt));
    const trig = (r: (typeof runs)[number]) => r.trigger as { type?: string; simulationId?: string };
    // The open shortage case if the real books are short; otherwise the case that already holds plans from this simulation; otherwise a new case.
    const target = (shortageToday ? runs.find((r) => r.lifecycle === "planned" && r.parentRunId === null && trig(r).type === "shortage" && r.status === "completed") : undefined) ?? runs.find((r) => r.lifecycle === "planned" && trig(r).simulationId === p.simulationId);
    let runId = target?.id;
    if (!runId) {
      const [run] = await tx.insert(agentRuns).values({
        businessId, trigger: { type: "shortage", variant: "baseline", origin: "simulation", simulationId: p.simulationId }, status: "completed", model: "owner", mode: "owner", planSource: "owner",
        finishedAt: new Date(), round: 0, constraints: JSON.parse(JSON.stringify(known)),
      }).returning({ id: agentRuns.id });
      runId = run.id;
      await tx.insert(agentSteps).values([
        { businessId, runId, seq: 1, kind: "note", payload: { type: "do_nothing", metrics: toJsonValue(dn) as Record<string, unknown> } },
        { businessId, runId, seq: 2, kind: "note", payload: { type: "simulation_handoff", simulationId: p.simulationId } },
      ]);
    }
    const [dup] = await tx.select({ id: plans.id }).from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId), eq(plans.planHash, stored.id)));
    if (dup) return { runId, unchanged: true };
    const [{ top }] = await tx.select({ top: sql<number | null>`max(${plans.rank})` }).from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId)));
    await tx.insert(plans).values({ businessId, runId, planHash: stored.id, rank: (top ?? 0) + 1, plan: toJsonValue(stored) as Record<string, unknown> });
    await appendRecord(tx, {
      businessId, event: ACTION_EVENTS.SIMULATION_HANDED_OFF, actor: "owner",
      detail: { simulationId: p.simulationId, runId, planId: stored.id, levers: stored.levers, realMetrics: stored.metrics, simulatedLowestMinor: sim.simulated.minBalanceMinor, materialChange: material, preemptive: !shortageToday, acknowledged: p.acknowledge, signed: false },
    });
    return { runId, unchanged: false };
  });
  return { ok: true, committed: true, unchanged: out.unchanged, runId: out.runId, planId: stored.id, caseUrl: `/room/case?run=${out.runId}`, review };
}
