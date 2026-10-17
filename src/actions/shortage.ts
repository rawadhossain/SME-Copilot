// SHORTAGE TRIGGER (ADR-026). A deterministic detector runs the forecast for a business, with the confirmed commitments and the
// terms that are currently agreed in the sandbox, and flags a projected shortage inside the planning horizon: a weekly closing
// balance below zero, or below the owner's reserve. A flagged shortage starts the same read-only planning run as a commitment
// does (it only PROPOSES plans; the owner still signs). No model is involved in detection.
//
// Called from: POST /api/business/[id]/shortage-check (explicit), and after an extraction is confirmed (a new or changed commitment).
// Idempotent: the same forecast hash returns the existing run; a different forecast supersedes the old unexecuted shortage runs.
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, sandboxApplications, sandboxThreads } from "@/db/schema";
import { appendActionRecord } from "@/actionlog";
import type { CommitmentEvent } from "@/domain/commitment-event";
import type { ShortageReason } from "@/domain/shortage";
import { adjustmentsOf, applyTermChanges, buildForecast, type TermChanges } from "@/engine";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext, PLANNING_HORIZON_WEEKS, startRun, type RunOptions, type RunSummary } from "./agent-run";
import { sha256Hex } from "./plan-terms";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export const shortageInputSchema = z.object({ variant: z.enum(["baseline", "downside"]).default("baseline"), source: z.enum(["commitment_confirmed", "api"]).default("api") });

/** The terms currently agreed in the sandbox (latest agreed thread per topic and counterparty, accepted application), as term changes. */
export async function currentAgreedChanges(db: Db, businessId: string): Promise<TermChanges> {
  const threads = await db.select().from(sandboxThreads).where(and(eq(sandboxThreads.businessId, businessId), eq(sandboxThreads.status, "agreed"))).orderBy(sandboxThreads.createdAt);
  const apps = await db.select().from(sandboxApplications).where(and(eq(sandboxApplications.businessId, businessId), eq(sandboxApplications.status, "accepted"))).orderBy(sandboxApplications.createdAt);
  const changes: TermChanges = {};
  for (const t of threads) {
    const a = (t.agreedTerms ?? {}) as Record<string, number | string>;
    switch (t.topic) {
      case "supplier.reduce_deposit": if (a.percentBps !== undefined) changes.supplierDepositBps = Number(a.percentBps); break;
      case "supplier.defer_balance": if (a.daysAfterShipment !== undefined) changes.supplierBalanceDeferralDays = Number(a.daysAfterShipment); break;
      case "buyer.request_deposit": if (a.percentBps !== undefined) changes.buyerDepositBps = Number(a.percentBps); break;
      case "buyer.chase_payment": if (a.payWithinDays !== undefined) changes.chase = { counterpartyId: t.counterpartyId, payWithinDays: Number(a.payWithinDays) }; break;
      case "buyer.request_early_payment": if (a.discountBps !== undefined && a.daysEarly !== undefined) changes.earlyPayment = { counterpartyId: t.counterpartyId, daysEarly: Number(a.daysEarly), discountBps: Number(a.discountBps) }; break;
    }
  }
  const app = apps[apps.length - 1];
  const o = (app?.offer ?? null) as { response?: { outcome?: string; terms?: { advanceBps?: number | string; feeBps?: number | string } | null } } | null;
  if (app && o?.response?.outcome === "offer" && o.response.terms) changes.invoiceFinance = { advanceBps: Number(o.response.terms.advanceBps), feeBps: Number(o.response.terms.feeBps) };
  return changes;
}

export interface ShortageDetection {
  shortage: boolean;
  reason: ShortageReason | null;
  /** Always present: the numbers of the forecast that was checked. */
  checked: { variant: "baseline" | "downside"; horizonWeeks: number; minBalanceMinor: string; minBalanceWeek: number; reserveMinor: string; forecastHash: string };
  /** The forecast that was checked, week by week (1-based), for the alert monitor. */
  weekly: { index: number; start: string; closingMinor: bigint }[];
}

/** The detector. Pure given the database state; deterministic; no model. */
export async function detectShortage(db: Db, businessId: string, input: unknown = {}): Promise<ShortageDetection> {
  const { variant, source } = shortageInputSchema.parse(input);
  const ctx = await buildContext(db, businessId, null);
  const base: CommitmentEvent[] = ctx.pending.map((p) => p.event);
  const changes = await currentAgreedChanges(db, businessId);
  let events = base;
  try {
    events = Object.keys(changes).length > 0 ? applyTermChanges(base, changes) : base;
  } catch {
    events = base; // an agreed term that no longer fits the confirmed order is ignored rather than guessed
  }
  const f = buildForecast(ctx.input, { events, horizonWeeks: PLANNING_HORIZON_WEEKS, adjustments: adjustmentsOf(changes), ...(variant === "downside" ? { downsideDelayDays: 14 } : {}) });
  const forecastHash = sha256Hex({ asOf: f.asOf, variant, reserve: f.reserve, closings: f.weeks.map((w) => w.closing), items: f.items.length });
  const firstNeg = f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null;
  const firstReserve = f.firstBreach ? f.firstBreach.weekIndex + 1 : null;
  const checked = { variant, horizonWeeks: f.horizonWeeks, minBalanceMinor: f.minimum.amount.toString(), minBalanceWeek: f.minimum.weekIndex + 1, reserveMinor: f.reserve.toString(), forecastHash };
  const kind = firstNeg !== null ? ("below_zero" as const) : firstReserve !== null ? ("below_reserve" as const) : null;
  const weekly = f.weeks.map((w) => ({ index: w.index + 1, start: w.start, closingMinor: w.closing }));
  if (!kind) return { shortage: false, reason: null, checked, weekly };
  const reason: ShortageReason = {
    kind, variant, horizonWeeks: f.horizonWeeks, minBalanceMinor: checked.minBalanceMinor, minBalanceWeek: checked.minBalanceWeek,
    firstNegativeWeek: firstNeg, firstBelowReserveWeek: firstReserve, reserveMinor: checked.reserveMinor,
    shortfallMinor: (f.maxShortfall > 0n ? f.maxShortfall : 0n).toString(), forecastHash, source,
  };
  return { shortage: true, reason, checked, weekly };
}

export interface ShortageCheckResult {
  status: "no_shortage" | "existing_run" | "planned";
  detection: ShortageDetection;
  runId: string | null;
  /** Earlier unexecuted shortage runs that this one replaced. */
  superseded: string[];
  run: RunSummary | null;
}

/** Detect, and if there is a shortage plan for it (once per distinct forecast). Never executes anything. */
export async function checkShortage(db: Db, businessId: string, input: unknown = {}, opts: RunOptions = {}): Promise<ShortageCheckResult> {
  const detection = await detectShortage(db, businessId, input);
  if (!detection.shortage || !detection.reason) return { status: "no_shortage", detection, runId: null, superseded: [], run: null };
  const reason = detection.reason;

  const open = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.businessId, businessId), inArray(agentRuns.lifecycle, ["planned", "needs_replan", "replanned"]), eq(agentRuns.round, 0)))
    .orderBy(desc(agentRuns.startedAt));
  const shortageRuns = open.filter((r) => (r.trigger as { type?: string }).type === "shortage");
  const same = shortageRuns.find((r) => (r.trigger as { reason?: { forecastHash?: string } }).reason?.forecastHash === reason.forecastHash);
  if (same) return { status: "existing_run", detection, runId: same.id, superseded: [], run: null };

  // A changed forecast is a new shortage: plan again, and mark the old unexecuted shortage runs superseded (their plans no longer fit).
  const run = await startRun(db, businessId, { type: "shortage", variant: reason.variant, reason }, opts);
  const superseded: string[] = [];
  for (const old of shortageRuns) {
    await db.update(agentRuns).set({ lifecycle: "superseded", successorRunId: run.runId }).where(eq(agentRuns.id, old.id));
    superseded.push(old.id);
  }
  await appendActionRecord(db, { businessId, event: ACTION_EVENTS.SHORTAGE_DETECTED, actor: "system", detail: { runId: run.runId, reason: toJsonValue(reason), superseded, planCount: run.plans.length } });
  if (run.status !== "completed" && run.status !== "refused") throw new ActionError("refused", run.error ?? "The planning run failed");
  return { status: "planned", detection, runId: run.runId, superseded, run };
}
