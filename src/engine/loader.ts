// Thin database loader: reads a business from Postgres and builds the plain EngineInput. Not part of the pure core.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { db as appDb } from "@/db";
import { bills, businesses, counterparties, documentPayments, extractions, financialAccounts, invoices, recurringCommitments, sandboxPayments, sandboxReceipts } from "@/db/schema";
import { balanceOf, type PaymentLite } from "@/domain/ledger";
import { DEFAULT_OVERDUE, type BillRecord, type CommitmentRecord, type EngineInput, type Frequency, type InvoiceRecord, type OverdueAssumption } from "./types";

type Db = typeof appDb;

const FREQUENCIES: Frequency[] = ["weekly", "fortnightly", "monthly", "quarterly", "annual"];

/**
 * asOf is taken from the data (the latest account balance date), not from a clock, unless given.
 * Opening balance = sum of the business's accounts in its base currency.
 */
/** Overdue assumption from configuration (ADR-023); invalid values fall back to the documented defaults. */
export function overdueFromEnv(env: Record<string, string | undefined> = process.env): OverdueAssumption {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 365 ? Number(v) : d);
  return {
    delayDays: n(env.OVERDUE_COLLECTION_DELAY_DAYS, DEFAULT_OVERDUE.delayDays),
    longAfterDays: n(env.OVERDUE_LONG_AFTER_DAYS, DEFAULT_OVERDUE.longAfterDays),
    longDelayDays: n(env.OVERDUE_LONG_DELAY_DAYS, DEFAULT_OVERDUE.longDelayDays),
  };
}

/**
 * A "counted elsewhere" marker only protects against double counting while the thing it points at still exists. If the confirmed order was
 * replaced, the commitment deleted or the scheduled payment cancelled, the document is counted again rather than silently dropped.
 */
export async function liveCountedRefs(db: Db, businessId: string, refs: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  const ids = (prefix: string) => [...new Set(refs.filter((r) => r.startsWith(prefix)).map((r) => r.split(":")[1]))].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const orderIds = ids("order:");
  if (orderIds.length > 0) for (const r of await db.select({ id: extractions.id }).from(extractions).where(and(eq(extractions.businessId, businessId), inArray(extractions.id, orderIds), eq(extractions.status, "confirmed")))) live.add(`order:${r.id}`);
  const recIds = ids("recurring:");
  if (recIds.length > 0) for (const r of await db.select({ id: recurringCommitments.id }).from(recurringCommitments).where(and(eq(recurringCommitments.businessId, businessId), inArray(recurringCommitments.id, recIds)))) live.add(`recurring:${r.id}`);
  const schIds = ids("scheduled:");
  if (schIds.length > 0) {
    for (const r of await db.select({ id: sandboxPayments.id }).from(sandboxPayments).where(and(eq(sandboxPayments.businessId, businessId), inArray(sandboxPayments.id, schIds), inArray(sandboxPayments.status, ["scheduled", "executed"])))) live.add(`scheduled:${r.id}`);
    for (const r of await db.select({ id: sandboxReceipts.id }).from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), inArray(sandboxReceipts.id, schIds), inArray(sandboxReceipts.status, ["scheduled", "received"])))) live.add(`scheduled:${r.id}`);
  }
  return live;
}

/** The marker only counts when its target is alive: refs look like "order:<id>[:detail]". */
export const isLiveRef = (live: Set<string>, ref: string): boolean => live.has(ref.split(":").slice(0, 2).join(":"));

export async function loadEngineInput(db: Db, businessId: string, asOfOverride?: string, horizonWeeks?: number): Promise<EngineInput | null> {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) return null;

  const [acc] = await db
    .select({
      total: sql<string>`coalesce(sum(${financialAccounts.balanceMinor}), 0)::text`, // numeric in Postgres: read as text, convert with BigInt
      asOf: sql<string | null>`to_char(max(${financialAccounts.balanceAsOf}) at time zone 'UTC', 'YYYY-MM-DD')`,
    })
    .from(financialAccounts)
    .where(and(eq(financialAccounts.businessId, businessId), eq(financialAccounts.currency, biz.baseCurrency)));
  const asOf = asOfOverride ?? acc.asOf;
  if (!asOf) throw new Error("Business has no account balance, so there is no as-of date");

  const invRows = await db
    .select({
      id: invoices.id, number: invoices.number, cpId: invoices.customerId, cpName: counterparties.name, countedIn: invoices.countedIn,
      issuedOn: invoices.issuedOn, dueOn: invoices.dueOn, amount: invoices.amountMinor, status: invoices.status, paidOn: invoices.paidOn,
    })
    .from(invoices)
    .innerJoin(counterparties, eq(counterparties.id, invoices.customerId))
    .where(and(eq(invoices.businessId, businessId), eq(invoices.currency, biz.baseCurrency), ne(invoices.status, "void"), ne(invoices.status, "draft")))
    .orderBy(invoices.issuedOn, invoices.number);
  const billRows = await db
    .select({
      id: bills.id, reference: bills.reference, cpId: bills.supplierId, cpName: counterparties.name, countedIn: bills.countedIn,
      issuedOn: bills.issuedOn, dueOn: bills.dueOn, amount: bills.amountMinor, status: bills.status, paidOn: bills.paidOn,
    })
    .from(bills)
    .innerJoin(counterparties, eq(counterparties.id, bills.supplierId))
    .where(and(eq(bills.businessId, businessId), eq(bills.currency, biz.baseCurrency), ne(bills.status, "void")))
    .orderBy(bills.issuedOn, bills.reference);

  // Payments recorded against invoices and bills. Only payments already in the opening balance (dated on or before asOf) reduce what the forecast waits for.
  const payRows = await db
    .select({ invoiceId: documentPayments.invoiceId, billId: documentPayments.billId, id: documentPayments.id, amount: documentPayments.amountMinor, paidOn: documentPayments.paidOn, voidedAt: documentPayments.voidedAt })
    .from(documentPayments)
    .where(eq(documentPayments.businessId, businessId));
  const paymentsOf = new Map<string, PaymentLite[]>();
  for (const p of payRows) {
    const key = (p.invoiceId ?? p.billId)!;
    paymentsOf.set(key, [...(paymentsOf.get(key) ?? []), { id: p.id, amountMinor: p.amount, paidOn: p.paidOn, voided: p.voidedAt !== null }]);
  }
  const liveRefs = await liveCountedRefs(db, businessId, [...invRows, ...billRows].flatMap((r) => (r.countedIn ? [r.countedIn] : [])));
  const invoiceRecords: InvoiceRecord[] = invRows.map((r) => {
    const b = balanceOf({ amountMinor: r.amount, status: r.status, paidOn: r.paidOn }, paymentsOf.get(r.id) ?? [], asOf);
    const paid = b.outstandingAtAsOfMinor === 0n;
    return {
      id: r.id, number: r.number, counterpartyId: r.cpId, counterpartyName: r.cpName, issuedOn: r.issuedOn, dueOn: r.dueOn,
      amount: r.amount, status: paid ? "paid" : "open", ...(paid && b.lastPaidOn ? { paidOn: b.lastPaidOn } : {}),
      ...(!paid && b.paidByAsOfMinor > 0n ? { outstanding: b.outstandingAtAsOfMinor } : {}), ...(r.countedIn && isLiveRef(liveRefs, r.countedIn) ? { countedIn: r.countedIn } : {}),
    };
  });

  const billRecords: BillRecord[] = billRows.map((r) => {
    const b = balanceOf({ amountMinor: r.amount, status: r.status, paidOn: r.paidOn }, paymentsOf.get(r.id) ?? [], asOf);
    const paid = b.outstandingAtAsOfMinor === 0n;
    return {
      id: r.id, reference: r.reference, counterpartyId: r.cpId, counterpartyName: r.cpName, issuedOn: r.issuedOn, dueOn: r.dueOn,
      amount: r.amount, status: paid ? "paid" : "open", ...(paid && b.lastPaidOn ? { paidOn: b.lastPaidOn } : {}),
      ...(!paid && b.paidByAsOfMinor > 0n ? { outstanding: b.outstandingAtAsOfMinor } : {}), ...(r.countedIn && isLiveRef(liveRefs, r.countedIn) ? { countedIn: r.countedIn } : {}),
    };
  });

  const comRows = await db
    .select()
    .from(recurringCommitments)
    .where(and(eq(recurringCommitments.businessId, businessId), eq(recurringCommitments.currency, biz.baseCurrency), inArray(recurringCommitments.kind, ["confirmed", "estimate"])))
    .orderBy(recurringCommitments.name);
  const commitments: CommitmentRecord[] = comRows.map((r) => {
    if (!FREQUENCIES.includes(r.frequency as Frequency)) throw new Error(`Unknown frequency "${r.frequency}" on commitment ${r.id}`);
    return { id: r.id, name: r.name, amount: r.amountMinor, frequency: r.frequency as Frequency, nextDueOn: r.nextDueOn, kind: r.kind as "confirmed" | "estimate" };
  });

  return {
    asOf,
    ...(horizonWeeks !== undefined ? { horizonWeeks } : {}),
    currency: biz.baseCurrency,
    openingBalance: BigInt(acc.total),
    reserve: biz.reserveMinor,
    overdue: overdueFromEnv(),
    invoices: invoiceRecords,
    bills: billRecords,
    commitments,
  };
}
