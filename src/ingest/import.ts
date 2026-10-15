import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { db as appDb } from "@/db";
import { actionRecords, businesses, currencies, financialAccounts, transactions } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { parseBankStatement, type Reconciliation, type RowError } from "./bank-statement";
import { statementRowSourceId } from "./identity";

type Db = typeof appDb;

export interface ImportSummary {
  businessId: string;
  accountId: string;
  rowsRead: number;
  imported: number;
  duplicates: number;
  errors: RowError[];
  reconciliation: Reconciliation;
  exponent: number;
}

/** Imports a bank statement into the business's first account (creating one if none exists). */
export async function importBankStatement(db: Db, businessId: string, csvText: string, fileName: string): Promise<ImportSummary> {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) throw new Error(`Business not found: ${businessId}`);
  const [cur] = await db.select().from(currencies).where(eq(currencies.code, biz.baseCurrency));
  if (!cur) throw new Error(`Currency not in currencies table: ${biz.baseCurrency}`);
  const exponent = cur.minorUnitExponent;

  const parsed = parseBankStatement(csvText, biz.baseCurrency, exponent);

  return db.transaction(async (tx) => {
    let [account] = await tx
      .select()
      .from(financialAccounts)
      .where(eq(financialAccounts.businessId, businessId))
      .orderBy(financialAccounts.name)
      .limit(1);
    if (!account) {
      [account] = await tx
        .insert(financialAccounts)
        .values({ businessId, name: "Imported bank account", currency: biz.baseCurrency, balanceMinor: 0n, balanceAsOf: new Date(0) })
        .returning();
    }

    let imported = 0;
    const CHUNK = 500;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const chunk = parsed.rows.slice(i, i + CHUNK).map((r) => ({
        businessId,
        accountId: account.id,
        postedOn: r.postedOn,
        amountMinor: r.amount.amountMinor,
        currency: biz.baseCurrency,
        description: r.description,
        source: "csv",
        sourceId: statementRowSourceId(businessId, r.postedOn, r.amount.amountMinor, r.description, r.balance.amountMinor),
      }));
      const inserted = await tx.insert(transactions).values(chunk).onConflictDoNothing().returning({ id: transactions.id });
      imported += inserted.length;
    }

    const last = parsed.rows[parsed.rows.length - 1];
    if (last) {
      const asOf = new Date(`${last.postedOn}T00:00:00Z`);
      if (asOf >= account.balanceAsOf) {
        await tx
          .update(financialAccounts)
          .set({ balanceMinor: last.balance.amountMinor, balanceAsOf: asOf })
          .where(eq(financialAccounts.id, account.id));
      }
    }

    const summary: ImportSummary = {
      businessId,
      accountId: account.id,
      rowsRead: parsed.rowsRead,
      imported,
      duplicates: parsed.rows.length - imported,
      errors: parsed.errors,
      reconciliation: parsed.reconciliation,
      exponent,
    };

    await tx.insert(actionRecords).values({
      businessId,
      event: "ingest.csv_imported",
      actor: "system",
      detail: {
        file: fileName,
        fileSha256: createHash("sha256").update(csvText).digest("hex"),
        rowsRead: summary.rowsRead,
        imported,
        duplicates: summary.duplicates,
        errorCount: parsed.errors.length,
        reconciliationOk: parsed.reconciliation.ok,
        statementClosing: parsed.reconciliation.statementClosing ? formatMoney(parsed.reconciliation.statementClosing, exponent) : null,
      },
      verification: "verified",
    });
    return summary;
  });
}
