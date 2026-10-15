// SCOREBOARD (ADR-027). Per commitment or shortage (one root planning run and its re-plans): do nothing against the executed plan.
// Every number is computed by the engine (stored at plan and verification time) or counted from the hash-chained action log.
// No model prose appears here; labels are written by code from the numbers.
import { asc, eq, inArray } from "drizzle-orm";
import { actionProposals, actionRecords, agentRuns, agentSteps, businesses, planAuthorisations, planExecutions } from "@/db/schema";
import { formatMoney, money } from "@/lib/money";
import { toJsonValue } from "@/sandbox/proposals";
import { ACTION_EVENTS, type Db } from "./types";

type Outcome = { minBalanceMinor: string; minBalanceWeek: number; firstNegativeWeek: number | null; closingAtHorizonMinor: string; totalCostMinor?: string; weeksBelowZero: number };

export interface ScoreEntry {
  runId: string;
  trigger: { type: string; reason?: unknown };
  startedAt: string;
  rounds: number;
  /** planned | executed | verification_failed | needs_replan | replanned | exhausted | superseded (of the last run in the chain) */
  status: string;
  doNothing: Outcome | null;
  executedPlan: (Outcome & { authorisationId: string; verification: "verified" | "failed" }) | null;
  /** Executed minus do nothing, in minor units (positive is better), or null when nothing was executed. */
  lowestBalanceImprovementMinor: string | null;
  weeksBelowZeroAvoided: number | null;
  ownerApprovals: number;
  ownerConfirmations: number;
  deniedOrBlocked: number;
  label: string;
}

export async function getScoreboard(db: Db, businessId: string) {
  const [biz] = await db.select({ currency: businesses.baseCurrency }).from(businesses).where(eq(businesses.id, businessId));
  const gbp = (minor: string) => formatMoney(money(BigInt(minor), biz?.currency ?? "GBP"), 2);
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.businessId, businessId)).orderBy(asc(agentRuns.startedAt));
  const records = await db.select().from(actionRecords).where(eq(actionRecords.businessId, businessId)).orderBy(asc(actionRecords.chainSeq));
  const auths = await db.select().from(planAuthorisations).where(eq(planAuthorisations.businessId, businessId));
  const execs = auths.length ? await db.select().from(planExecutions).where(inArray(planExecutions.authorisationId, auths.map((a) => a.id))) : [];
  const proposals = await db.select({ id: actionProposals.id, authorisationId: actionProposals.authorisationId }).from(actionProposals).where(eq(actionProposals.businessId, businessId));
  const notes = runs.length ? await db.select().from(agentSteps).where(inArray(agentSteps.runId, runs.map((r) => r.id))) : [];

  const children = new Map<string, string[]>();
  for (const r of runs) if (r.parentRunId) children.set(r.parentRunId, [...(children.get(r.parentRunId) ?? []), r.id]);
  const roots = runs.filter((r) => !r.parentRunId);
  const entries: ScoreEntry[] = [];

  for (const root of roots) {
    // The chain: the root and every re-plan descended from it.
    const chain: string[] = [];
    const walk = (id: string) => { chain.push(id); for (const c of children.get(id) ?? []) walk(c); };
    walk(root.id);
    const chainRuns = runs.filter((r) => chain.includes(r.id));
    const last = chainRuns[chainRuns.length - 1];
    const chainAuths = auths.filter((a) => chain.includes(a.runId));
    const authIds = new Set(chainAuths.map((a) => a.id));
    const propIds = new Set(proposals.filter((p) => p.authorisationId && authIds.has(p.authorisationId)).map((p) => p.id));

    const dn = notes.find((n) => n.runId === root.id && n.kind === "note" && (n.payload as { type?: string }).type === "do_nothing");
    const dnMetrics = dn ? ((dn.payload as { metrics: Record<string, unknown> }).metrics as Record<string, unknown>) : null;
    const doNothing: Outcome | null = dnMetrics
      ? { minBalanceMinor: String(dnMetrics.minBalanceMinor), minBalanceWeek: Number(dnMetrics.minBalanceWeek), firstNegativeWeek: (dnMetrics.firstNegativeWeek as number | null) ?? null, closingAtHorizonMinor: String(dnMetrics.closingAtHorizonMinor), totalCostMinor: "0", weeksBelowZero: Number(dnMetrics.weeksBelowZero ?? (dnMetrics.firstNegativeWeek ? 1 : 0)) }
      : null;

    // Executed plan: the last committed execution of the chain, with its verification record from the LOG (not the execution row).
    const committed = execs.filter((x) => authIds.has(x.authorisationId) && (x.status === "completed" || x.status === "verification_failed")).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const ex = committed[committed.length - 1];
    let executedPlan: ScoreEntry["executedPlan"] = null;
    if (ex) {
      const rec = [...records].reverse().find((r) => (r.event === ACTION_EVENTS.PLAN_VERIFIED || r.event === ACTION_EVENTS.PLAN_VERIFICATION_FAILED) && (r.detail as { authorisationId?: string }).authorisationId === ex.authorisationId);
      const out = (rec?.detail as { agreedOutcome?: Outcome } | undefined)?.agreedOutcome;
      if (out && rec) executedPlan = { ...out, authorisationId: ex.authorisationId, verification: rec.event === ACTION_EVENTS.PLAN_VERIFIED ? "verified" : "failed" };
    }

    const inChain = (d: unknown) => authIds.has(String((d as { authorisationId?: string })?.authorisationId));
    const ownerApprovals = records.filter((r) => r.event === ACTION_EVENTS.PLAN_AUTHORISED && r.actor === "owner" && inChain(r.detail)).length;
    const ownerConfirmations = chainAuths.filter((a) => a.signature).reduce((n, a) => n + Number((a.terms as { confirmations?: number }).confirmations ?? 1), 0);
    const deniedOrBlocked = records.filter((r) =>
      (r.event === ACTION_EVENTS.GATE_DECISION && r.proposalId && propIds.has(r.proposalId) && (r.detail as { decision?: string }).decision === "deny") ||
      (r.event === ACTION_EVENTS.PLAN_AUTHORISATION_DENIED && chain.includes(String((r.detail as { runId?: string }).runId))) ||
      ((r.event === ACTION_EVENTS.PLAN_EXECUTION_REFUSED || r.event === ACTION_EVENTS.EXECUTION_REFUSED) && (inChain(r.detail) || (r.proposalId && propIds.has(r.proposalId)))),
    ).length;

    const improvement = executedPlan && doNothing ? (BigInt(executedPlan.minBalanceMinor) - BigInt(doNothing.minBalanceMinor)).toString() : null;
    const avoided = executedPlan && doNothing ? doNothing.weeksBelowZero - executedPlan.weeksBelowZero : null;
    const status = last.lifecycle;
    const label = executedPlan
      ? `${executedPlan.verification === "verified" ? "Executed and verified" : "Executed, VERIFICATION FAILED"}: the lowest balance is ${improvement === null ? "" : BigInt(improvement) >= 0n ? `${gbp(improvement)} better` : `${gbp((-BigInt(improvement)).toString())} worse`} than doing nothing.`
      : status === "exhausted" ? "No feasible plan inside the owner's constraints."
      : status === "needs_replan" ? "The counterparties did not agree; a re-plan is needed."
      : status === "superseded" ? "Replaced by a newer plan for a changed forecast."
      : "Plans proposed; nothing executed yet.";
    entries.push({
      runId: root.id, trigger: { type: (root.trigger as { type: string }).type, reason: (root.trigger as { reason?: unknown }).reason },
      startedAt: root.startedAt.toISOString(), rounds: chainRuns.length - 1, status, doNothing, executedPlan,
      lowestBalanceImprovementMinor: improvement, weeksBelowZeroAvoided: avoided, ownerApprovals, ownerConfirmations, deniedOrBlocked, label,
    });
  }

  const executed = entries.filter((e) => e.executedPlan);
  return toJsonValue({
    businessId,
    summary: {
      commitmentsAndShortages: entries.length,
      executed: executed.length,
      verified: executed.filter((e) => e.executedPlan!.verification === "verified").length,
      verificationFailed: executed.filter((e) => e.executedPlan!.verification === "failed").length,
      ownerApprovals: entries.reduce((n, e) => n + e.ownerApprovals, 0),
      deniedOrBlocked: entries.reduce((n, e) => n + e.deniedOrBlocked, 0),
    },
    entries,
  });
}
