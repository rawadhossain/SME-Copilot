// OWNER-ONLY payee changes. Changing bank details un-approves the payee until the owner re-approves (ADR-010).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { sandboxPayees } from "@/db/schema";
import { payeeDetailsHash } from "@/gate";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

const refSchema = z.string().trim().min(3).max(60);

export async function updatePayeeBankDetails(db: Db, businessId: string, payeeId: string, newAccountRef: string, changedBy: string) {
  const ref = refSchema.parse(newAccountRef);
  return db.transaction(async (tx) => {
    const [payee] = await tx.select().from(sandboxPayees).where(and(eq(sandboxPayees.id, z.string().uuid().parse(payeeId)), eq(sandboxPayees.businessId, businessId))).for("update");
    if (!payee) throw new ActionError("not_found", "Unknown payee");
    const [updated] = await tx
      .update(sandboxPayees)
      .set({ accountRef: ref, approved: false, bankDetailsHash: payeeDetailsHash(payee.name, ref) })
      .where(eq(sandboxPayees.id, payee.id))
      .returning();
    await appendRecord(tx, {
      businessId, event: ACTION_EVENTS.PAYEE_BANK_DETAILS_CHANGED, actor: "owner",
      detail: { payeeId: payee.id, name: payee.name, oldHash: payee.bankDetailsHash, newHash: updated.bankDetailsHash, changedBy, approved: false, note: "payee is unapproved until the owner re-approves" },
    });
    return updated;
  });
}

/** Owner re-approves a payee at its current bank details. */
export async function reapprovePayee(db: Db, businessId: string, payeeId: string, approvedBy: string) {
  return db.transaction(async (tx) => {
    const [payee] = await tx.select().from(sandboxPayees).where(and(eq(sandboxPayees.id, z.string().uuid().parse(payeeId)), eq(sandboxPayees.businessId, businessId))).for("update");
    if (!payee) throw new ActionError("not_found", "Unknown payee");
    const [updated] = await tx.update(sandboxPayees).set({ approved: true, bankDetailsHash: payeeDetailsHash(payee.name, payee.accountRef) }).where(eq(sandboxPayees.id, payee.id)).returning();
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.PAYEE_REAPPROVED, actor: "owner", detail: { payeeId: payee.id, name: payee.name, accountRef: payee.accountRef, hash: updated.bankDetailsHash, approvedBy } });
    return updated;
  });
}
