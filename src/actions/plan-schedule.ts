// The payments and receipts an agreed plan implies (ADR-019). The expected schedule is derived by the deterministic engine
// (applyTermChanges) from the confirmed order events and the terms that were ACTUALLY agreed. The agreed terms are read from
// the hash-chained log (plan.branch_result records), not from anything an executor row can edit silently.
import { and, asc, eq } from "drizzle-orm";
import { actionRecords, sandboxPayees } from "@/db/schema";
import type { CommitmentEvent } from "@/domain/commitment-event";
import { applyTermChanges, type TermChanges } from "@/engine";
import type { GateRequestJson } from "@/gate/request";
import { requestSchema } from "@/gate/request";
import { buildContext } from "./agent-run";
import type { AuthorisationRow } from "./plan-authority";
import type { PlanTerms, TermsEntry } from "./plan-terms";
import { ACTION_EVENTS, type Db } from "./types";

export interface ScheduleItem {
  kind: "payment" | "receipt";
  eventKind: string;
  date: string;
  /** Positive minor units. */
  amountMinor: bigint;
  currency: string;
  counterpartyId: string;
  /** Receipts only: what backs the receipt. */
  backing?: { type: "thread" | "application"; id: string };
}

/** What a branch recorded when its counterparty agreed (structured fields only). */
export interface RecordedBranch {
  index: number;
  status: string;
  agreedTerms: Record<string, number> | null;
  offer: { advanceBps: number; feeBps: number } | null;
  threadId: string | null;
  applicationId: string | null;
}

/** Term changes from the recorded agreed terms of each lever. A lever with no recorded agreement contributes nothing. */
export function changesFromRecorded(entries: TermsEntry[], recorded: Map<number, RecordedBranch>): TermChanges {
  const changes: TermChanges = {};
  for (const e of entries) {
    const r = recorded.get(e.index);
    if (!r) continue;
    switch (e.lever.kind) {
      case "supplier_reduce_deposit": if (r.agreedTerms?.percentBps !== undefined) changes.supplierDepositBps = r.agreedTerms.percentBps; break;
      case "supplier_defer_balance": if (r.agreedTerms?.daysAfterShipment !== undefined) changes.supplierBalanceDeferralDays = r.agreedTerms.daysAfterShipment; break;
      case "buyer_request_deposit": if (r.agreedTerms?.percentBps !== undefined) changes.buyerDepositBps = r.agreedTerms.percentBps; break;
      case "finance_invoice": if (r.offer) changes.invoiceFinance = { advanceBps: r.offer.advanceBps, feeBps: r.offer.feeBps }; break;
      case "chase_overdue": if (r.agreedTerms?.payWithinDays !== undefined) changes.chase = { counterpartyId: e.lever.counterpartyId, payWithinDays: r.agreedTerms.payWithinDays }; break;
      case "early_payment_discount": if (r.agreedTerms?.discountBps !== undefined && r.agreedTerms.daysEarly !== undefined) changes.earlyPayment = { counterpartyId: e.lever.counterpartyId, daysEarly: r.agreedTerms.daysEarly, discountBps: r.agreedTerms.discountBps }; break;
    }
  }
  return changes;
}

const sameEvent = (a: CommitmentEvent, b: CommitmentEvent) => a.kind === b.kind && a.date === b.date && a.amountMinor === b.amountMinor;

/** The events that exist only because of the agreed changes, as scheduled payments and receipts. Pure. */
export function expectedSchedule(
  base: CommitmentEvent[], changes: TermChanges, who: { supplierId: string | null; buyerId: string | null; lenderId: string | null },
  backing: { buyerThreadId: string | null; applicationId: string | null },
): ScheduleItem[] {
  if (Object.keys(changes).length === 0) return [];
  const events = applyTermChanges(base, changes);
  const unmatched = [...base];
  const added: CommitmentEvent[] = [];
  for (const e of events) {
    const i = unmatched.findIndex((b) => sameEvent(b, e));
    if (i >= 0) unmatched.splice(i, 1);
    else added.push(e);
  }
  const items: ScheduleItem[] = [];
  for (const e of added) {
    if ((e.kind === "supplier_deposit" || e.kind === "supplier_balance") && e.amountMinor < 0n && who.supplierId) {
      items.push({ kind: "payment", eventKind: e.kind, date: e.date, amountMinor: -e.amountMinor, currency: e.currency, counterpartyId: who.supplierId });
    } else if (e.kind === "financing" && e.amountMinor > 0n && who.lenderId && backing.applicationId) {
      items.push({ kind: "receipt", eventKind: e.kind, date: e.date, amountMinor: e.amountMinor, currency: e.currency, counterpartyId: who.lenderId, backing: { type: "application", id: backing.applicationId } });
    } else if (e.kind === "customer_receipt" && e.amountMinor > 0n && who.buyerId) {
      const b = backing.buyerThreadId ? { type: "thread" as const, id: backing.buyerThreadId } : backing.applicationId ? { type: "application" as const, id: backing.applicationId } : null;
      if (b) items.push({ kind: "receipt", eventKind: e.kind, date: e.date, amountMinor: e.amountMinor, currency: e.currency, counterpartyId: who.buyerId, backing: b });
    }
  }
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.date.localeCompare(b.date) || a.eventKind.localeCompare(b.eventKind));
}

/** The latest recorded outcome of every lever, from the hash-chained log. */
export async function recordedBranches(db: Db, businessId: string, authorisationId: string): Promise<Map<number, RecordedBranch>> {
  const rows = await db.select().from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.PLAN_BRANCH_RESULT))).orderBy(asc(actionRecords.chainSeq));
  const out = new Map<number, RecordedBranch>();
  for (const r of rows) {
    const d = r.detail as { authorisationId?: string; index?: number; status?: string; agreedTerms?: Record<string, number> | null; offer?: { advanceBps: number; feeBps: number } | null; threadId?: string | null; applicationId?: string | null };
    if (d.authorisationId !== authorisationId || d.index === undefined) continue;
    out.set(d.index, { index: d.index, status: d.status ?? "", agreedTerms: d.agreedTerms ?? null, offer: d.offer ?? null, threadId: d.threadId ?? null, applicationId: d.applicationId ?? null });
  }
  return out;
}

/** The expected schedule for an authorisation, computed from the recorded agreed terms and the confirmed order events. */
export async function expectedScheduleFor(db: Db, auth: AuthorisationRow, terms: PlanTerms): Promise<{ items: ScheduleItem[]; changes: TermChanges; recorded: Map<number, RecordedBranch> }> {
  const recorded = await recordedBranches(db, auth.businessId, auth.id);
  const changes = changesFromRecorded(terms.entries, recorded);
  const ctx = await buildContext(db, auth.businessId, null);
  const base = ctx.pending.map((p) => p.event);
  const buyerEntry = terms.entries.find((e) => e.lever.kind === "buyer_request_deposit");
  const finEntry = terms.entries.find((e) => e.lever.kind === "finance_invoice");
  const supEntry = terms.entries.find((e) => e.lever.kind === "supplier_reduce_deposit" || e.lever.kind === "supplier_defer_balance");
  const items = expectedSchedule(
    base, changes,
    { supplierId: supEntry?.lever.counterpartyId ?? ctx.parties.supplierId, buyerId: buyerEntry?.lever.counterpartyId ?? ctx.parties.buyerId, lenderId: finEntry?.lever.counterpartyId ?? ctx.parties.lenderId },
    { buyerThreadId: buyerEntry ? recorded.get(buyerEntry.index)?.threadId ?? null : null, applicationId: finEntry ? recorded.get(finEntry.index)?.applicationId ?? null : null },
  );
  return { items, changes, recorded };
}

/** Does this request equal one of the expected items? (null = covered, else the reason it is not.) */
export async function scheduleCovers(db: Db, businessId: string, items: ScheduleItem[], request: ReturnType<typeof requestSchema.parse>): Promise<string | null> {
  if (request.kind === "sandbox.schedule_payment") {
    const [payee] = await db.select().from(sandboxPayees).where(and(eq(sandboxPayees.id, request.payeeId), eq(sandboxPayees.businessId, businessId)));
    const hit = items.find((i) => i.kind === "payment" && payee?.counterpartyId === i.counterpartyId && i.amountMinor === request.amountMinor && i.date === request.scheduledFor && i.currency === request.currency);
    return hit && request.purpose === "supplier" ? null : "The payment is not one the agreed terms imply (payee, amount, date or purpose differ)";
  }
  if (request.kind === "sandbox.schedule_receipt") {
    const hit = items.find((i) => i.kind === "receipt" && i.counterpartyId === request.counterpartyId && i.amountMinor === request.amountMinor && i.date === request.expectedOn && i.currency === request.currency && i.backing?.type === request.backingType && i.backing.id === request.backingId);
    return hit ? null : "The receipt is not one the agreed terms imply (counterparty, amount, date or backing differ)";
  }
  return "Not a schedule action";
}

export async function payeeFor(db: Db, businessId: string, counterpartyId: string): Promise<string | null> {
  const [p] = await db.select().from(sandboxPayees).where(and(eq(sandboxPayees.businessId, businessId), eq(sandboxPayees.counterpartyId, counterpartyId), eq(sandboxPayees.approved, true)));
  return p?.id ?? null;
}

export function itemToRequest(item: ScheduleItem, payeeId: string | null): GateRequestJson | null {
  if (item.kind === "payment") {
    if (!payeeId) return null;
    return { kind: "sandbox.schedule_payment", payeeId, amountMinor: item.amountMinor.toString(), currency: item.currency, scheduledFor: item.date, purpose: "supplier" };
  }
  return item.backing ? { kind: "sandbox.schedule_receipt", counterpartyId: item.counterpartyId, amountMinor: item.amountMinor.toString(), currency: item.currency, expectedOn: item.date, backingType: item.backing.type, backingId: item.backing.id } : null;
}
