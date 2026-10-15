// Thin database loader: reads a business from Postgres and builds the plain EngineInput. Not part of the pure core.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { db as appDb } from "@/db";
import { bills, businesses, counterparties, financialAccounts, invoices, recurringCommitments } from "@/db/schema";
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
      id: invoices.id, number: invoices.number, cpId: invoices.customerId, cpName: counterparties.name,
      issuedOn: invoices.issuedOn, dueOn: invoices.dueOn, amount: invoices.amountMinor, status: invoices.status, paidOn: invoices.paidOn,
    })
    .from(invoices)
    .innerJoin(counterparties, eq(counterparties.id, invoices.customerId))
    .where(and(eq(invoices.businessId, businessId), eq(invoices.currency, biz.baseCurrency), ne(invoices.status, "void"), ne(invoices.status, "draft")))
    .orderBy(invoices.issuedOn, invoices.number);
  const invoiceRecords: InvoiceRecord[] = invRows.map((r) => ({
    id: r.id, number: r.number, counterpartyId: r.cpId, counterpartyName: r.cpName, issuedOn: r.issuedOn, dueOn: r.dueOn,
    amount: r.amount, status: r.status === "paid" ? "paid" : "open", ...(r.paidOn ? { paidOn: r.paidOn } : {}),
  }));

  const billRows = await db
    .select({
      id: bills.id, reference: bills.reference, cpId: bills.supplierId, cpName: counterparties.name,
      issuedOn: bills.issuedOn, dueOn: bills.dueOn, amount: bills.amountMinor, status: bills.status, paidOn: bills.paidOn,
    })
    .from(bills)
    .innerJoin(counterparties, eq(counterparties.id, bills.supplierId))
    .where(and(eq(bills.businessId, businessId), eq(bills.currency, biz.baseCurrency), ne(bills.status, "void")))
    .orderBy(bills.issuedOn, bills.reference);
  const billRecords: BillRecord[] = billRows.map((r) => ({
    id: r.id, reference: r.reference, counterpartyId: r.cpId, counterpartyName: r.cpName, issuedOn: r.issuedOn, dueOn: r.dueOn,
    amount: r.amount, status: r.status === "paid" ? "paid" : "open", ...(r.paidOn ? { paidOn: r.paidOn } : {}),
  }));

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
