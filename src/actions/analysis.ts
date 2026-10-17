// BUSINESS ANALYSIS (cash view): read-only. Builds the engine input from the loaders the forecast and the insights already use (same books, the business's
// stored as-of), and returns the pure analysis (src/engine/analysis.ts). Writes nothing, logs nothing, calls no model.
import { and, eq, gte, lte } from "drizzle-orm";
import { counterparties, transactions } from "@/db/schema";
import { analyse, addDays, type AnalysisResult } from "@/engine";
import { loadEngineInput } from "@/engine/loader";
import { ActionError, type Db } from "./types";

/** How far back the bank history is read: six complete months plus the current one, with room to spare. */
const HISTORY_DAYS = 400;

export async function getAnalysis(db: Db, businessId: string): Promise<AnalysisResult> {
  const input = await loadEngineInput(db, businessId).catch(() => null);
  if (!input) throw new ActionError("not_found", "Business not found");
  const since = addDays(input.asOf, -HISTORY_DAYS);
  const rows = await db
    .select({ postedOn: transactions.postedOn, amount: transactions.amountMinor, description: transactions.description, role: counterparties.role, cpId: counterparties.id, cpName: counterparties.name })
    .from(transactions)
    .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
    .where(and(eq(transactions.businessId, businessId), eq(transactions.currency, input.currency), gte(transactions.postedOn, since), lte(transactions.postedOn, input.asOf)));
  return analyse({
    asOf: input.asOf, currency: input.currency, invoices: input.invoices, bills: input.bills, openingBalanceMinor: input.openingBalance,
    transactions: rows.map((r) => ({ postedOn: r.postedOn, amount: r.amount, description: r.description, counterpartyRole: r.role, counterpartyId: r.cpId, counterpartyName: r.cpName })),
  });
}
