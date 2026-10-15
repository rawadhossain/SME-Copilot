// Builds the plain GateState the pure gate needs, and loads the active signed mandate.
import { and, asc, desc, eq } from "drizzle-orm";
import { businesses, counterparties, financialAccounts, mandates, sandboxApplications, sandboxBankAccounts, sandboxPayees, sandboxPayments, sandboxReceipts, sandboxThreads } from "@/db/schema";
import { buildForecast, type InvoiceAdjustments } from "@/engine";
import { loadEngineInput } from "@/engine/loader";
import type { GateState, SignedMandate } from "@/gate";
import { ActionError, type Q } from "./types";

/** The world date: the latest balance date of the business accounts (never the wall clock). */
export async function worldDate(q: Q, businessId: string): Promise<string> {
  const [row] = await q.select({ asOf: financialAccounts.balanceAsOf }).from(financialAccounts).where(eq(financialAccounts.businessId, businessId)).orderBy(desc(financialAccounts.balanceAsOf)).limit(1);
  if (!row) throw new ActionError("not_found", "Business has no account, so no world date");
  return row.asOf.toISOString().slice(0, 10);
}

export async function loadSignedMandate(q: Q, businessId: string): Promise<SignedMandate | null> {
  const [row] = await q.select().from(mandates).where(and(eq(mandates.businessId, businessId), eq(mandates.active, true))).orderBy(desc(mandates.version)).limit(1);
  return row ? { canonical: row.canonical, signature: row.signature } : null;
}

/** Weeks of books-only flows used for the gate projection. */
export const PROJECTION_WEEKS = 20;

/** Does evaluating this request need the forecast projection? (Only payments do; it costs an engine run.) */
export const needsProjection = (kind: string): boolean => kind === "sandbox.schedule_payment";

export async function loadGateState(q: Q, businessId: string, opts: { projection?: boolean } = {}): Promise<GateState> {
  const [biz] = await q.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new ActionError("not_found", "Business not found");
  const asOf = await worldDate(q, businessId);
  const [bank] = await q.select().from(sandboxBankAccounts).where(and(eq(sandboxBankAccounts.businessId, businessId), eq(sandboxBankAccounts.currency, biz.baseCurrency))).orderBy(asc(sandboxBankAccounts.name)).limit(1);
  const payments = await q.select().from(sandboxPayments).where(eq(sandboxPayments.businessId, businessId));
  const payees = await q.select().from(sandboxPayees).where(eq(sandboxPayees.businessId, businessId));
  const cps = await q.select({ id: counterparties.id, role: counterparties.role }).from(counterparties).where(eq(counterparties.businessId, businessId));

  const apps = await q.select().from(sandboxApplications).where(eq(sandboxApplications.businessId, businessId));
  const threads = await q.select({ id: sandboxThreads.id, status: sandboxThreads.status, counterpartyId: sandboxThreads.counterpartyId, topic: sandboxThreads.topic, agreedTerms: sandboxThreads.agreedTerms }).from(sandboxThreads).where(eq(sandboxThreads.businessId, businessId));
  const receipts = await q.select().from(sandboxReceipts).where(eq(sandboxReceipts.businessId, businessId));

  let pending = 0n;
  const byDate: Record<string, bigint> = {};
  for (const p of payments) {
    if (p.status === "scheduled") pending += p.amountMinor;
    if (p.status === "scheduled" || p.status === "executed") byDate[p.scheduledFor] = (byDate[p.scheduledFor] ?? 0n) + p.amountMinor;
  }
  const state: GateState = {
    businessId,
    asOf,
    currency: biz.baseCurrency,
    bankBalanceMinor: bank?.balanceMinor ?? 0n,
    pendingScheduledMinor: pending,
    outflowByDate: byDate,
    payees: Object.fromEntries(payees.map((p) => [p.id, { approved: p.approved, name: p.name, accountRef: p.accountRef, bankDetailsHash: p.bankDetailsHash }])),
    payments: Object.fromEntries(payments.map((p) => [p.id, { status: p.status }])),
    counterparties: Object.fromEntries(cps.map((c) => [c.id, { role: c.role }])),
    applications: Object.fromEntries(apps.map((a) => {
      const o = a.offer as { request?: { advanceBps?: number }; response?: { outcome?: string; terms?: { feeBps?: number; advanceBps?: number; advanceAmountMinor?: string | number } | null } } | null;
      const offered = o?.response?.outcome === "offer" ? o.response.terms : null;
      return [a.id, { status: a.status, lenderId: a.lenderId, advanceBps: offered?.advanceBps ?? null, feeBps: offered?.feeBps ?? null, requestedAmountMinor: a.requestedAmountMinor, advanceAmountMinor: offered?.advanceAmountMinor !== undefined ? BigInt(offered.advanceAmountMinor) : undefined }];
    })),
    threads: Object.fromEntries(threads.map((t) => [t.id, { status: t.status, counterpartyId: t.counterpartyId, topic: t.topic }])),
    receipts: Object.fromEntries(receipts.map((r) => [r.id, { status: r.status }])),
  };
  if (opts.projection) state.projection = await buildProjection(q, businessId, state, payments, receipts, apps, threads);
  return state;
}

/**
 * The gate projection (ADR-019): books-only flows from the deterministic engine (no pending-order events: those only count once they
 * are scheduled), plus scheduled receipts that are backed by an agreement, minus scheduled payments. Pure data out.
 */
async function buildProjection(
  q: Q, businessId: string, state: GateState,
  payments: (typeof sandboxPayments.$inferSelect)[], receipts: (typeof sandboxReceipts.$inferSelect)[],
  apps: (typeof sandboxApplications.$inferSelect)[], threads: { id: string; status: string; counterpartyId: string; topic: string; agreedTerms: unknown }[],
): Promise<NonNullable<GateState["projection"]>> {
  const input = await loadEngineInput(q as never, businessId, undefined, PROJECTION_WEEKS);
  // Agreed chase and early-payment terms move the books' invoices (ADR-024), so the projection follows what was agreed.
  const adjustments = agreedAdjustments(threads);
  const flows = input ? buildForecast(input, { events: [], horizonWeeks: PROJECTION_WEEKS, adjustments }).items.map((i) => ({ date: i.date, amountMinor: i.amount })) : [];
  const agreed = new Set(threads.filter((t) => t.status === "agreed").map((t) => t.id));
  const accepted = new Set(apps.filter((a) => a.status === "accepted").map((a) => a.id));
  return {
    booksFlows: flows,
    receipts: receipts.filter((r) => r.status === "scheduled" && (r.backingType === "thread" ? agreed.has(r.backingId) : accepted.has(r.backingId))).map((r) => ({ date: r.expectedOn, amountMinor: r.amountMinor })),
    payments: payments.filter((p) => p.status === "scheduled").map((p) => ({ date: p.scheduledFor, amountMinor: p.amountMinor })),
  };
}

/** Chase and early-payment adjustments from the currently agreed (not withdrawn) negotiation threads. */
export function agreedAdjustments(threads: { status: string; counterpartyId: string; topic: string; agreedTerms: unknown }[]): InvoiceAdjustments {
  const adj: InvoiceAdjustments = { chase: [], early: [] };
  for (const t of threads) {
    if (t.status !== "agreed") continue;
    const a = (t.agreedTerms ?? {}) as Record<string, number | string>;
    if (t.topic === "buyer.chase_payment" && a.payWithinDays !== undefined) adj.chase.push({ counterpartyId: t.counterpartyId, payWithinDays: Number(a.payWithinDays) });
    if (t.topic === "buyer.request_early_payment" && a.discountBps !== undefined && a.daysEarly !== undefined) adj.early.push({ counterpartyId: t.counterpartyId, daysEarly: Number(a.daysEarly), discountBps: Number(a.discountBps) });
  }
  return adj;
}
