// ALERT MONITOR. Runs the EXISTING detectors (shortage, insights, recovery), hands one snapshot to the pure rules (src/engine/alerts.ts), and keeps the
// alerts table in step: new situations are raised, still-true ones are updated (severity may go up or down), cleared ones are resolved. One transaction
// per business under an advisory lock, so concurrent runs cannot duplicate anything. The monitor never signs, approves, executes, sends or changes the
// books; its only writes are alert rows and hash-chained log records (ids and figures, no free text). No model is involved.
//
// Recovery trigger: when a strategy has gone off track and MONITOR_AUTO_RECOVER=on, the existing recovery start is called once (its own single-flight
// guard applies) and the case id is stored on the alert. Off by default; without it the alert says what was found and offers the existing action.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alerts, businesses, recoveryCases } from "@/db/schema";
import { evaluateAlerts, SEVERITY_RANK, type AlertSeverity, type CandidateAlert } from "@/engine";
import { toJsonValue } from "@/sandbox/proposals";
import { buildContext } from "./agent-run";
import { runAutomationsAfterMonitor, type AutoSnapshot } from "./automations";
import { getInsights } from "./insights";
import { appendRecord } from "./log";
import { assessRecovery, runRecovery } from "./recovery";
import { detectShortage } from "./shortage";
import { ACTION_EVENTS, ActionError, type Db } from "./types";
import { actionRecords } from "@/db/schema";

export const MONITOR_MIN_INTERVAL_MS = 30_000; // POST /monitor/run answers from the last run if it is newer than this
export const MONITOR_STALE_MS = 10 * 60_000; // GET /alerts runs the monitor when the last run is older than this

export interface MonitorCounts { raised: number; escalated: number; updated: number; resolved: number; open: number; acknowledged: number }
export interface MonitorResult { asOf: string; counts: MonitorCounts; recoveryCaseId: string | null; recoveryStarted: boolean; reason: string; ranAt: string; fromCache?: boolean }

export const autoRecoverOn = (): boolean => (process.env.MONITOR_AUTO_RECOVER ?? "").toLowerCase() === "on";

async function snapshotCandidates(db: Db, businessId: string) {
  const ctx = await buildContext(db, businessId, null);
  const shortage = await detectShortage(db, businessId);
  const insights = await getInsights(db, businessId);
  const recovery = await assessRecovery(db, businessId);
  const material = recovery.events.filter((e) => e.material);
  const [existingCase] = recovery.fingerprint
    ? await db.select({ id: recoveryCases.id }).from(recoveryCases).where(and(eq(recoveryCases.businessId, businessId), eq(recoveryCases.fingerprint, recovery.fingerprint), ne(recoveryCases.status, "superseded"))).limit(1)
    : [];
  const candidates = evaluateAlerts({
    asOf: ctx.asOf, currency: ctx.currency, reserveMinor: ctx.input.reserve, weekly: shortage.weekly,
    shortage: { shortage: shortage.shortage, belowZero: shortage.reason?.kind === "below_zero", minBalanceMinor: BigInt(shortage.checked.minBalanceMinor), minBalanceWeek: shortage.checked.minBalanceWeek },
    invoices: ctx.input.invoices, bills: ctx.input.bills, insights: insights.findings,
    recovery: { strategyId: recovery.strategy?.authorisationId ?? null, events: material.map((e) => ({ kind: e.kind, key: e.key, text: e.text, counterpartyId: e.counterpartyId })), caseId: existingCase?.id ?? null },
  });
  const snap: Omit<AutoSnapshot, "raised" | "reason"> = { asOf: ctx.asOf, currency: ctx.currency, reserveMinor: ctx.input.reserve, weekly: shortage.weekly, invoices: ctx.input.invoices, bills: ctx.input.bills, candidates };
  return { asOf: ctx.asOf, candidates, snap };
}

/** What the automations read, for a dry run: the same snapshot the monitor pass builds, with nothing raised. Read-only. */
export async function loadAutomationSnapshot(db: Db, businessId: string): Promise<AutoSnapshot> {
  const { snap } = await snapshotCandidates(db, businessId);
  return { ...snap, raised: [], reason: "dry_run" };
}

export async function runMonitor(db: Db, businessId: string, opts: { reason: string; recovery?: Parameters<typeof runRecovery>[2] } = { reason: "manual" }): Promise<MonitorResult> {
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const { asOf, candidates, snap } = await snapshotCandidates(db, businessId);
  const raisedNow: AutoSnapshot["raised"] = [];

  // Off-track strategy + the flag: start the existing recovery once. Its single-flight guard makes a repeat harmless.
  let recoveryCaseId: string | null = null;
  let recoveryStarted = false;
  const off = candidates.find((c) => c.kind === "strategy_off_track");
  if (off && autoRecoverOn()) {
    try {
      const r = await runRecovery(db, businessId, opts.recovery ?? {});
      recoveryCaseId = r.caseId;
      recoveryStarted = r.status !== "duplicate" && r.caseId !== null;
    } catch {
      recoveryCaseId = null;
    }
  }
  if (off && recoveryCaseId) off.refs = { ...off.refs, caseId: recoveryCaseId };

  const counts: MonitorCounts = { raised: 0, escalated: 0, updated: 0, resolved: 0, open: 0, acknowledged: 0 };
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`alerts:${businessId}`}))`);
    const current = await tx.select().from(alerts).where(and(eq(alerts.businessId, businessId), ne(alerts.status, "resolved")));
    const byKey = new Map(current.map((a) => [a.dedupeKey, a]));
    const now = new Date();
    for (const c of candidates) {
      const a = byKey.get(c.dedupeKey);
      if (!a) {
        const [row] = await tx.insert(alerts).values({
          businessId, kind: c.kind, severity: c.severity, dedupeKey: c.dedupeKey, title: c.title, detail: c.detail, figures: toJsonValue(c.figures) as Record<string, unknown>, refs: toJsonValue(c.refs) as Record<string, unknown>,
          status: "open", firstSeenAsOf: asOf, lastSeenAsOf: asOf,
        }).returning({ id: alerts.id });
        await appendRecord(tx, { businessId, event: ACTION_EVENTS.ALERT_RAISED, actor: "system", detail: { alertId: row.id, kind: c.kind, severity: c.severity, dedupeKey: c.dedupeKey, asOf } });
        counts.raised++;
        raisedNow.push({ kind: c.kind, severity: c.severity, dedupeKey: c.dedupeKey, title: c.title, detail: c.detail, route: c.refs.route });
        continue;
      }
      byKey.delete(c.dedupeKey);
      const up = SEVERITY_RANK[c.severity] > SEVERITY_RANK[a.severity as AlertSeverity];
      // An acknowledged alert stays acknowledged unless it gets more serious; then it is open again.
      const status = up && a.status === "acknowledged" ? "open" : a.status;
      const refs = { ...(a.refs as Record<string, unknown>), ...c.refs, ...(c.refs.caseId == null && (a.refs as { caseId?: string }).caseId ? { caseId: (a.refs as { caseId?: string }).caseId } : {}) };
      await tx.update(alerts).set({
        severity: c.severity, title: c.title, detail: c.detail, figures: toJsonValue(c.figures) as Record<string, unknown>, refs: toJsonValue(refs) as Record<string, unknown>,
        lastSeenAsOf: asOf, lastSeenAt: now, status,
      }).where(eq(alerts.id, a.id));
      if (up) {
        await appendRecord(tx, { businessId, event: ACTION_EVENTS.ALERT_ESCALATED, actor: "system", detail: { alertId: a.id, kind: c.kind, from: a.severity, to: c.severity, dedupeKey: c.dedupeKey, reopened: status !== a.status } });
        counts.escalated++;
        raisedNow.push({ kind: c.kind, severity: c.severity, dedupeKey: c.dedupeKey, title: c.title, detail: c.detail, route: c.refs.route });
      } else counts.updated++;
    }
    // Whatever is left was open or acknowledged and is no longer true: resolved.
    const gone = [...byKey.values()];
    if (gone.length > 0) {
      await tx.update(alerts).set({ status: "resolved", resolvedAt: now }).where(inArray(alerts.id, gone.map((g) => g.id)));
      for (const g of gone) await appendRecord(tx, { businessId, event: ACTION_EVENTS.ALERT_RESOLVED, actor: "system", detail: { alertId: g.id, kind: g.kind, dedupeKey: g.dedupeKey, asOf } });
      counts.resolved = gone.length;
    }
    const now2 = await tx.select({ status: alerts.status }).from(alerts).where(and(eq(alerts.businessId, businessId), ne(alerts.status, "resolved")));
    counts.open = now2.filter((x) => x.status === "open").length;
    counts.acknowledged = now2.filter((x) => x.status === "acknowledged").length;
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.MONITOR_RUN, actor: "system", detail: { reason: opts.reason, asOf, ...counts, recoveryCaseId, recoveryStarted } });
  });
  // Owner automations run after the monitor has evaluated. They can only notify, prepare or draft, and a failure here never fails the monitor.
  try {
    await runAutomationsAfterMonitor(db, businessId, { ...snap, raised: raisedNow, reason: opts.reason });
  } catch { /* best effort */ }
  return { asOf, counts, recoveryCaseId, recoveryStarted, reason: opts.reason, ranAt: new Date().toISOString() };
}

/** After an event that changes the picture: best-effort, never throws, a failure is logged and the original action is untouched. */
export async function watchAfter(db: Db, businessId: string, reason: string): Promise<void> {
  try {
    await runMonitor(db, businessId, { reason });
  } catch (e) {
    try {
      await appendRecord(db, { businessId, event: ACTION_EVENTS.MONITOR_FAILED, actor: "system", detail: { reason, error: e instanceof Error ? e.name : "error" } });
    } catch { /* nothing more can be done */ }
  }
}

async function lastRun(db: Db, businessId: string): Promise<{ at: Date; detail: Record<string, unknown> } | null> {
  const [r] = await db.select({ at: actionRecords.createdAt, detail: actionRecords.detail }).from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.MONITOR_RUN))).orderBy(desc(actionRecords.createdAt)).limit(1);
  return r ? { at: r.at, detail: r.detail as Record<string, unknown> } : null;
}

/** The manual trigger: at most once per 30 seconds per business (real time); sooner calls get the stored result. */
export async function requestMonitorRun(db: Db, businessId: string, reason = "manual"): Promise<MonitorResult> {
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const last = await lastRun(db, businessId);
  if (last && Date.now() - last.at.getTime() < MONITOR_MIN_INTERVAL_MS) {
    const d = last.detail as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      asOf: String(d.asOf), counts: { raised: d.raised, escalated: d.escalated, updated: d.updated, resolved: d.resolved, open: d.open, acknowledged: d.acknowledged },
      recoveryCaseId: d.recoveryCaseId ?? null, recoveryStarted: !!d.recoveryStarted, reason: String(d.reason), ranAt: last.at.toISOString(), fromCache: true,
    };
  }
  return runMonitor(db, businessId, { reason });
}

export interface AlertView { id: string; kind: string; severity: string; title: string; detail: string; figures: unknown; refs: unknown; status: string; firstSeenAt: string; lastSeenAt: string; firstSeenAsOf: string; lastSeenAsOf: string; acknowledgedBy: string | null; acknowledgedAt: string | null }

/** Open and acknowledged alerts, and when the monitor last ran. Runs the monitor first when the last run is older than 10 minutes (real time). */
export async function listAlerts(db: Db, businessId: string): Promise<{ alerts: AlertView[]; lastRunAt: string | null; counts: { urgent: number; watch: number; info: number; open: number; acknowledged: number } }> {
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  let last = await lastRun(db, businessId);
  if (!last || Date.now() - last.at.getTime() > MONITOR_STALE_MS) {
    await watchAfter(db, businessId, "page_view");
    last = await lastRun(db, businessId);
  }
  const rows = await db.select().from(alerts).where(and(eq(alerts.businessId, businessId), ne(alerts.status, "resolved")));
  const view: AlertView[] = rows
    .map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, title: a.title, detail: a.detail, figures: a.figures, refs: a.refs, status: a.status, firstSeenAt: a.firstSeenAt.toISOString(), lastSeenAt: a.lastSeenAt.toISOString(), firstSeenAsOf: a.firstSeenAsOf, lastSeenAsOf: a.lastSeenAsOf, acknowledgedBy: a.acknowledgedBy, acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null }))
    .sort((x, y) => SEVERITY_RANK[y.severity as AlertSeverity] - SEVERITY_RANK[x.severity as AlertSeverity] || (x.firstSeenAt < y.firstSeenAt ? -1 : 1));
  const openOnes = view.filter((a) => a.status === "open");
  return {
    alerts: view, lastRunAt: last?.at.toISOString() ?? null,
    counts: { urgent: openOnes.filter((a) => a.severity === "urgent").length, watch: openOnes.filter((a) => a.severity === "watch").length, info: openOnes.filter((a) => a.severity === "info").length, open: openOnes.length, acknowledged: view.length - openOnes.length },
  };
}

/** "Got it": the alert stays visible under Seen. Only an open alert changes; the person is recorded by display name. */
export async function acknowledgeAlert(db: Db, alertId: string, businessId: string, by: string): Promise<{ id: string; status: string }> {
  const [a] = await db.select().from(alerts).where(and(eq(alerts.id, alertId), eq(alerts.businessId, businessId)));
  if (!a) throw new ActionError("not_found", "Alert not found");
  if (a.status === "resolved") throw new ActionError("conflict", "That alert has already cleared.");
  if (a.status === "acknowledged") return { id: a.id, status: a.status };
  await db.transaction(async (tx) => {
    await tx.update(alerts).set({ status: "acknowledged", acknowledgedBy: by, acknowledgedAt: new Date() }).where(and(eq(alerts.id, a.id), eq(alerts.status, "open")));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.ALERT_ACKNOWLEDGED, actor: "owner", detail: { alertId: a.id, kind: a.kind, severity: a.severity, by } });
  });
  return { id: a.id, status: "acknowledged" };
}

export type { CandidateAlert };
