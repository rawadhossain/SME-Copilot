// Loads the business profile used by financing-option matching: bank transactions, the ledger's open invoices, confirmed orders and the owner's declared
// trading start. Read-only. Shared by the matching action and the funding decision so both use the same profile.
import { and, eq, lte } from "drizzle-orm";
import { businesses, counterparties, transactions } from "@/db/schema";
import type { CommitmentEvent } from "@/domain/commitment-event";
import { deriveBusinessProfile, type BusinessProfile } from "@/engine";
import type { AgentToolContext } from "@/agent";
import type { Db } from "./types";

export async function loadBusinessProfile(db: Db, businessId: string, ctx: AgentToolContext, events: CommitmentEvent[]): Promise<BusinessProfile> {
  const [biz] = await db.select({ tradingSince: businesses.tradingSince }).from(businesses).where(eq(businesses.id, businessId));
  const rows = await db
    .select({ postedOn: transactions.postedOn, amount: transactions.amountMinor, description: transactions.description, role: counterparties.role })
    .from(transactions)
    .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
    .where(and(eq(transactions.businessId, businessId), eq(transactions.currency, ctx.currency), lte(transactions.postedOn, ctx.asOf)));
  const buyer = ctx.counterparties.find((c) => c.id === ctx.parties.buyerId);
  return deriveBusinessProfile({
    asOf: ctx.asOf, currency: ctx.currency,
    transactions: rows.map((r) => ({ postedOn: r.postedOn, amount: r.amount, description: r.description, counterpartyRole: r.role })),
    invoices: ctx.input.invoices, tradingSince: biz?.tradingSince ?? null,
    orders: events.filter((e) => e.kind === "customer_receipt" && e.amountMinor > 0n).map((e) => ({ valueMinor: e.amountMinor, receiptDate: e.date, customerName: buyer?.name ?? null })),
  });
}
