import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "./index";
import { bills, businesses, currencies, financialAccounts, invoices, recurringCommitments, transactions } from "./schema";
import { money, moneyToJson, type Money, type MoneyJson } from "@/lib/money";

export interface BusinessSummary {
  business: { id: string; name: string; isSynthetic: boolean; baseCurrency: string; minorUnitExponent: number };
  balance: MoneyJson;
  counts: { transactions: number; openInvoices: number; openBills: number; overdueInvoices: number };
}

const OPEN_INVOICE = ["draft", "sent", "overdue"];
const OPEN_BILL = ["unpaid", "scheduled"];

export async function getBusinessSummary(id: string): Promise<BusinessSummary | null> {
  const [biz] = await db
    .select({ id: businesses.id, name: businesses.name, isSynthetic: businesses.isSynthetic, baseCurrency: businesses.baseCurrency, exp: currencies.minorUnitExponent })
    .from(businesses)
    .innerJoin(currencies, eq(currencies.code, businesses.baseCurrency))
    .where(eq(businesses.id, id));
  if (!biz) return null;

  // SUM(bigint) is numeric in Postgres: read it as text and convert with BigInt, never Number.
  const [bal] = await db
    .select({ total: sql<string>`coalesce(sum(${financialAccounts.balanceMinor}), 0)::text` })
    .from(financialAccounts)
    .where(and(eq(financialAccounts.businessId, id), eq(financialAccounts.currency, biz.baseCurrency)));
  const [txCount] = await db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(eq(transactions.businessId, id));
  const [openInv] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.businessId, id), inArray(invoices.status, OPEN_INVOICE)));
  const [overdueInv] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.businessId, id), inArray(invoices.status, OPEN_INVOICE), lt(invoices.dueOn, sql`current_date`)));
  const [openBill] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bills)
    .where(and(eq(bills.businessId, id), inArray(bills.status, OPEN_BILL)));

  return {
    business: { id: biz.id, name: biz.name, isSynthetic: biz.isSynthetic, baseCurrency: biz.baseCurrency, minorUnitExponent: biz.exp },
    balance: moneyToJson(money(BigInt(bal.total), biz.baseCurrency)),
    counts: { transactions: txCount.n, openInvoices: openInv.n, openBills: openBill.n, overdueInvoices: overdueInv.n },
  };
}

export interface RecentTransaction {
  id: string;
  postedOn: string;
  description: string;
  amount: Money;
}

export async function getRecentTransactions(businessId: string, limit = 10): Promise<RecentTransaction[]> {
  const rows = await db
    .select({ id: transactions.id, postedOn: transactions.postedOn, description: transactions.description, amountMinor: transactions.amountMinor, currency: transactions.currency })
    .from(transactions)
    .where(eq(transactions.businessId, businessId))
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, postedOn: r.postedOn, description: r.description, amount: money(r.amountMinor, r.currency) }));
}

/** The main demo business (a synthetic business that has recurring commitments), newest first. Used by /demo pages when no id is given. */
export async function getDefaultBusinessId(): Promise<string | null> {
  const [row] = await db.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.isSynthetic, true), eq(businesses.isTest, false), sql`exists (select 1 from ${recurringCommitments} where ${recurringCommitments.businessId} = ${businesses.id})`)).orderBy(desc(businesses.createdAt)).limit(1);
  return row?.id ?? null;
}
