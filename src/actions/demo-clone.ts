// A fresh, flagged demo clone of the demo business (Batch 10): the same SYNTHETIC books, counterparties, sandbox bank and payees, and its
// own signed mandate, so the whole story can be replayed repeatedly. It is a NEW business (is_test = true); the demo business and the
// append-only log of every other business are never touched. Owner-side code: it signs the clone's mandate with the dev owner key.
import { and, eq } from "drizzle-orm";
import { appendActionRecord, ACTION_EVENTS } from "@/actionlog";
import { businesses, counterparties, financialAccounts, bills, invoices, mandates, recurringCommitments, sandboxBankAccounts, sandboxPayees, transactions } from "@/db/schema";
import { signMandate } from "@/gate/owner-signing";
import type { MandateWire } from "@/gate/mandate";
import type { Db } from "./types";

export async function createDemoClone(db: Db, sourceBusinessId: string): Promise<{ id: string; name: string }> {
  const [src] = await db.select().from(businesses).where(eq(businesses.id, sourceBusinessId));
  if (!src) throw new Error("Source business not found");
  const n = (await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.isTest, true))).length + 1;
  const name = `Mercer & Vale demo run ${n} (SYNTHETIC)`;
  const [biz] = await db.insert(businesses).values({ name, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true, tradingSince: src.tradingSince }).returning();
  const omit = <T extends { id: string; businessId: string }>(r: T) => { const { id: _i, businessId: _b, ...rest } = r; void _i; void _b; return rest; };
  const accountMap = new Map<string, string>();
  for (const a of await db.select().from(financialAccounts).where(eq(financialAccounts.businessId, src.id))) {
    const [x] = await db.insert(financialAccounts).values({ ...omit(a), businessId: biz.id }).returning();
    accountMap.set(a.id, x.id);
  }
  const idMap = new Map<string, string>();
  for (const c of await db.select().from(counterparties).where(eq(counterparties.businessId, src.id))) {
    const [x] = await db.insert(counterparties).values({ ...omit(c), businessId: biz.id }).returning();
    idMap.set(c.id, x.id);
  }
  // The bank history too (new ids, same dates, amounts, descriptions and links), so matching, insights and funding see a trading business.
  const history = (await db.select().from(transactions).where(eq(transactions.businessId, src.id))).map((t) => ({ ...omit(t), businessId: biz.id, accountId: accountMap.get(t.accountId)!, counterpartyId: t.counterpartyId ? idMap.get(t.counterpartyId) ?? null : null }));
  for (let i = 0; i < history.length; i += 200) await db.insert(transactions).values(history.slice(i, i + 200));
  for (const i of await db.select().from(invoices).where(eq(invoices.businessId, src.id))) await db.insert(invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
  for (const b of await db.select().from(bills).where(eq(bills.businessId, src.id))) await db.insert(bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
  for (const c of await db.select().from(recurringCommitments).where(eq(recurringCommitments.businessId, src.id))) await db.insert(recurringCommitments).values({ ...omit(c), businessId: biz.id });
  const [m] = await db.select().from(mandates).where(and(eq(mandates.businessId, src.id), eq(mandates.active, true)));
  const wire = { ...(JSON.parse(m.canonical) as MandateWire), version: 1, businessId: biz.id };
  const signed = signMandate(wire);
  await db.insert(mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
  for (const b of await db.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.businessId, src.id))) await db.insert(sandboxBankAccounts).values({ ...omit(b), businessId: biz.id });
  for (const p of await db.select().from(sandboxPayees).where(eq(sandboxPayees.businessId, src.id))) await db.insert(sandboxPayees).values({ ...omit(p), businessId: biz.id, counterpartyId: p.counterpartyId ? idMap.get(p.counterpartyId)! : null });
  await appendActionRecord(db, { businessId: biz.id, event: ACTION_EVENTS.DEMO_CLONE_CREATED, actor: "system", detail: { sourceBusinessId: src.id, name } });
  return { id: biz.id, name };
}
