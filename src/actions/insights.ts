// FINANCIAL INTELLIGENCE & EARLY WARNING read model. Reads the books, the bank transactions and the shortage detector for ONE business and
// hands them to the pure rules in src/engine/insights.ts. Writes nothing, signs nothing, calls no model: every figure is deterministic.
import { and, eq, gte } from "drizzle-orm";
import { counterparties, transactions } from "@/db/schema";
import { computeInsights, type InsightsResult, type InsightTx } from "@/engine";
import { loadEngineInput } from "@/engine/loader";
import { detectShortage } from "./shortage";
import { ActionError, type Db } from "./types";

/** How far back the bank history is read. Two windows are compared, and a longer tail lets "usual size" be judged for one-off payments. */
const HISTORY_DAYS = 400;

export async function getInsights(db: Db, businessId: string): Promise<InsightsResult> {
  const input = await loadEngineInput(db, businessId).catch(() => null);
  if (!input) throw new ActionError("not_found", "Business not found");
  const since = new Date(Date.parse(`${input.asOf}T00:00:00Z`) - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ id: transactions.id, postedOn: transactions.postedOn, amount: transactions.amountMinor, description: transactions.description, role: counterparties.role })
    .from(transactions)
    .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
    .where(and(eq(transactions.businessId, businessId), eq(transactions.currency, input.currency), gte(transactions.postedOn, since)));
  const txs: InsightTx[] = rows.map((r) => ({ id: r.id, postedOn: r.postedOn, amount: r.amount, description: r.description, counterpartyRole: r.role }));
  const d = await detectShortage(db, businessId);
  return computeInsights({
    engine: input,
    transactions: txs,
    forecast: {
      shortage: d.shortage, belowZero: d.reason?.kind === "below_zero", minBalanceMinor: d.checked.minBalanceMinor, minBalanceWeek: d.checked.minBalanceWeek,
      minWeekStart: null, firstNegativeWeek: d.reason?.firstNegativeWeek ?? null, reserveMinor: d.checked.reserveMinor,
    },
  });
}
