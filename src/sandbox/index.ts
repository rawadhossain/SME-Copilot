// The sandbox world: a fake bank, simulated counterparties and a proposal protocol.
// These are plain functions with the database passed in. They do NOT enforce permissions or owner limits (the gate
// does, in Batch 5); they are idempotent, validate their inputs, use bigint minor units, and have no clock inside:
// dates are passed in. Free text never drives a decision; only structured fields do.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { db as appDb } from "@/db";
import {
  businesses, counterparties, financialAccounts, sandboxApplications, sandboxBankAccounts, sandboxMessages, sandboxPayees,
  sandboxPayments, sandboxReceipts, sandboxThreads,
} from "@/db/schema";
import { formatMoney, money } from "@/lib/money";
import { parseProfile } from "./profile";
import { proposalSchema, roleForKind, toJsonValue, type Proposal, type ProposalJson, type SimResponse } from "./proposals";
import { describeProposal, respond } from "./simulators";

export * from "./profile";
export * from "./proposals";
export { respond, describeProposal } from "./simulators";

type Db = typeof appDb;

export class SandboxError extends Error {}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a real date");
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const keySchema = z.string().trim().min(1).max(100);

// ---------------------------------------------------------------- proposals

export interface ProposalResult {
  threadId: string;
  threadStatus: string;
  outboundMessageId: string;
  inboundMessageId: string;
  response: SimResponse;
  /** True when an identical proposal had already been answered and nothing new was stored. */
  duplicate: boolean;
}

const canonical = (v: unknown) => JSON.stringify(toJsonValue(v));

export async function sendProposal(db: Db, businessId: string, counterpartyId: string, proposalInput: unknown, opts: { coverText?: string } = {}): Promise<ProposalResult> {
  const proposal: Proposal = proposalSchema.parse(proposalInput);
  const structured = toJsonValue(proposal);

  return db.transaction(async (tx) => {
    const [cp] = await tx.select().from(counterparties).where(and(eq(counterparties.id, counterpartyId), eq(counterparties.businessId, businessId)));
    if (!cp) throw new SandboxError("Unknown counterparty");
    if (roleForKind(proposal.kind) !== cp.role) throw new SandboxError(`A ${proposal.kind} proposal cannot be sent to a ${cp.role}`);
    const profile = parseProfile(cp.profile);

    // Idempotency: the same proposal to the same counterparty, already answered, returns the stored exchange.
    const threads = await tx
      .select()
      .from(sandboxThreads)
      .where(and(eq(sandboxThreads.businessId, businessId), eq(sandboxThreads.counterpartyId, counterpartyId), eq(sandboxThreads.topic, proposal.kind)))
      .orderBy(desc(sandboxThreads.createdAt), desc(sandboxThreads.id));
    for (const t of threads) {
      if (t.status === "withdrawn") continue; // a withdrawn exchange is history; asking again starts a new one
      const msgs = await tx.select().from(sandboxMessages).where(and(eq(sandboxMessages.businessId, businessId), eq(sandboxMessages.threadId, t.id))).orderBy(asc(sandboxMessages.createdAt), desc(sandboxMessages.direction));
      const out = msgs.find((m) => m.direction === "outbound" && canonical(m.structured) === canonical(structured));
      const inn = msgs.find((m) => m.direction === "inbound" && m.kind === "response");
      if (out && inn && t.status !== "open") {
        const parsed = inn.structured as { outcome: SimResponse["outcome"]; terms: SimResponse["terms"]; note: string };
        return { threadId: t.id, threadStatus: t.status, outboundMessageId: out.id, inboundMessageId: inn.id, response: parsed, duplicate: true };
      }
    }

    // Reuse the latest thread on this topic that is still being negotiated, else start one.
    let thread = threads.find((t) => t.status === "open" || t.status === "countered");
    if (!thread) {
      [thread] = await tx.insert(sandboxThreads).values({ businessId, counterpartyId, topic: proposal.kind, status: "open" }).returning();
    }

    const [outbound] = await tx
      .insert(sandboxMessages)
      .values({ businessId, threadId: thread.id, counterpartyId, direction: "outbound", kind: "proposal", body: opts.coverText ?? describeProposal(proposal), structured, untrusted: false })
      .returning();

    const response = respond(profile, proposal);
    const [inbound] = await tx
      .insert(sandboxMessages)
      .values({ businessId, threadId: thread.id, counterpartyId, direction: "inbound", kind: "response", body: response.note, structured: toJsonValue(response), untrusted: true })
      .returning();

    const status = response.outcome === "accept" ? "agreed" : response.outcome === "reject" || response.outcome === "decline" ? "rejected" : "countered";
    await tx
      .update(sandboxThreads)
      .set({ status, agreedTerms: response.outcome === "accept" ? toJsonValue(response.terms) : null })
      .where(eq(sandboxThreads.id, thread.id));

    return { threadId: thread.id, threadStatus: status, outboundMessageId: outbound.id, inboundMessageId: inbound.id, response, duplicate: false };
  });
}

// ---------------------------------------------------------------- payments

const scheduleSchema = z.object({ payeeId: z.string().uuid(), amountMinor: z.bigint().positive(), currency: currencyCode, scheduledFor: isoDate, idempotencyKey: keySchema });

export async function schedulePayment(db: Db, businessId: string, payeeId: string, amountMinor: bigint, currency: string, scheduledFor: string, idempotencyKey: string) {
  const input = scheduleSchema.parse({ payeeId, amountMinor, currency, scheduledFor, idempotencyKey });
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(sandboxPayments).where(and(eq(sandboxPayments.businessId, businessId), eq(sandboxPayments.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      if (existing.payeeId !== input.payeeId || existing.amountMinor !== input.amountMinor || existing.currency !== input.currency || existing.scheduledFor !== input.scheduledFor) {
        throw new SandboxError("Idempotency key already used with different payment details");
      }
      return { payment: existing, duplicate: true };
    }
    const [payee] = await tx.select().from(sandboxPayees).where(and(eq(sandboxPayees.id, input.payeeId), eq(sandboxPayees.businessId, businessId)));
    if (!payee) throw new SandboxError("Unknown payee");
    const [account] = await tx.select().from(sandboxBankAccounts).where(and(eq(sandboxBankAccounts.businessId, businessId), eq(sandboxBankAccounts.currency, input.currency))).orderBy(asc(sandboxBankAccounts.name)).limit(1);
    if (!account) throw new SandboxError(`No sandbox bank account in ${input.currency}`);
    const [payment] = await tx
      .insert(sandboxPayments)
      .values({
        businessId, bankAccountId: account.id, payeeId: payee.id, amountMinor: input.amountMinor, currency: input.currency, scheduledFor: input.scheduledFor,
        status: "scheduled", idempotencyKey: input.idempotencyKey, reference: `PAY-${sha(`${businessId}:${input.idempotencyKey}`).slice(0, 10).toUpperCase()}`,
      })
      .returning();
    return { payment, duplicate: false };
  });
}

export interface ExecutionSummary {
  asOf: string;
  executed: { id: string; reference: string; amountMinor: bigint }[];
  failed: { id: string; reference: string; reason: string }[];
  balanceMinor: bigint | null;
}

/** Executes scheduled payments due on or before asOf, oldest first. Never overdraws the account. */
export async function executeDuePayments(db: Db, businessId: string, asOf: string): Promise<ExecutionSummary> {
  const date = isoDate.parse(asOf);
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(sandboxPayments)
      .where(and(eq(sandboxPayments.businessId, businessId), eq(sandboxPayments.status, "scheduled"), lte(sandboxPayments.scheduledFor, date)))
      .orderBy(asc(sandboxPayments.scheduledFor), asc(sandboxPayments.createdAt), asc(sandboxPayments.id));
    const summary: ExecutionSummary = { asOf: date, executed: [], failed: [], balanceMinor: null };
    const executedAt = new Date(`${date}T00:00:00Z`);
    for (const p of due) {
      const [acct] = await tx.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.id, p.bankAccountId)).for("update");
      if (acct.balanceMinor >= p.amountMinor) {
        await tx.update(sandboxBankAccounts).set({ balanceMinor: acct.balanceMinor - p.amountMinor, updatedAt: executedAt }).where(eq(sandboxBankAccounts.id, acct.id));
        await tx.update(sandboxPayments).set({ status: "executed", executedAt }).where(eq(sandboxPayments.id, p.id));
        summary.executed.push({ id: p.id, reference: p.reference, amountMinor: p.amountMinor });
      } else {
        const reason = `Insufficient funds: balance ${formatMoney(money(acct.balanceMinor, acct.currency), 2)}, payment ${formatMoney(money(p.amountMinor, p.currency), 2)}`;
        await tx.update(sandboxPayments).set({ status: "failed", failureReason: reason, executedAt }).where(eq(sandboxPayments.id, p.id));
        summary.failed.push({ id: p.id, reference: p.reference, reason });
      }
    }
    const [bank] = await tx.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.businessId, businessId)).orderBy(asc(sandboxBankAccounts.name)).limit(1);
    summary.balanceMinor = bank?.balanceMinor ?? null;
    return summary;
  });
}

/** Cancels a payment that is still scheduled. An executed payment is irreversible and cannot be cancelled. */
export async function cancelPayment(db: Db, businessId: string, paymentId: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(sandboxPayments).where(and(eq(sandboxPayments.id, z.string().uuid().parse(paymentId)), eq(sandboxPayments.businessId, businessId))).for("update");
    if (!p) throw new SandboxError("Unknown payment");
    if (p.status === "cancelled") return { payment: p, duplicate: true };
    if (p.status !== "scheduled") throw new SandboxError(`Payment is ${p.status}; only a scheduled payment can be cancelled`);
    const [updated] = await tx.update(sandboxPayments).set({ status: "cancelled" }).where(eq(sandboxPayments.id, p.id)).returning();
    return { payment: updated, duplicate: false };
  });
}

// ---------------------------------------------------------------- applications

const applySchema = z.object({ lenderId: z.string().uuid(), invoiceAmountMinor: z.bigint().positive(), advanceBps: z.number().int().min(0).max(10000), idempotencyKey: keySchema });

export async function submitApplication(db: Db, businessId: string, lenderId: string, invoiceAmountMinor: bigint, advanceBps: number, idempotencyKey: string, opts: { coverText?: string } = {}) {
  const input = applySchema.parse({ lenderId, invoiceAmountMinor, advanceBps, idempotencyKey });
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(sandboxApplications).where(and(eq(sandboxApplications.businessId, businessId), eq(sandboxApplications.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      const offer = existing.offer as { request?: { invoiceAmountMinor: string; advanceBps: number } } | null;
      if (existing.lenderId !== input.lenderId || existing.requestedAmountMinor !== input.invoiceAmountMinor || offer?.request?.advanceBps !== input.advanceBps) {
        throw new SandboxError("Idempotency key already used with different application details");
      }
      return { application: existing, duplicate: true };
    }
    const [lender] = await tx.select().from(counterparties).where(and(eq(counterparties.id, input.lenderId), eq(counterparties.businessId, businessId)));
    if (!lender || lender.role !== "lender") throw new SandboxError("Unknown lender");
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId));
    const proposal = proposalSchema.parse({ kind: "lender.apply_invoice_finance", invoiceAmountMinor: input.invoiceAmountMinor.toString(), currency: biz.baseCurrency, advanceBps: input.advanceBps });
    const response = respond(parseProfile(lender.profile), proposal);
    const [application] = await tx
      .insert(sandboxApplications)
      .values({
        businessId, lenderId: lender.id, kind: "invoice_finance", requestedAmountMinor: input.invoiceAmountMinor, currency: biz.baseCurrency,
        status: response.outcome === "offer" ? "offered" : "declined",
        offer: toJsonValue({ request: { invoiceAmountMinor: input.invoiceAmountMinor, advanceBps: input.advanceBps }, response, ...(opts.coverText ? { coverText: opts.coverText } : {}) }),
        reference: `APP-${sha(`${businessId}:${input.idempotencyKey}`).slice(0, 10).toUpperCase()}`,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    return { application, duplicate: false };
  });
}

/** Takes up a finance offer (status offered -> accepted). Idempotent. Only the action pipeline calls this. */
export async function acceptApplicationOffer(db: Db, businessId: string, applicationId: string) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(sandboxApplications).where(and(eq(sandboxApplications.id, z.string().uuid().parse(applicationId)), eq(sandboxApplications.businessId, businessId))).for("update");
    if (!a) throw new SandboxError("Unknown application");
    if (a.status === "accepted") return { application: a, duplicate: true };
    if (a.status !== "offered") throw new SandboxError(`Application is ${a.status}; only an offered application can be taken up`);
    const [updated] = await tx.update(sandboxApplications).set({ status: "accepted" }).where(eq(sandboxApplications.id, a.id)).returning();
    return { application: updated, duplicate: false };
  });
}

/** Compensation: withdraws an offered or accepted application. Idempotent. */
export async function withdrawApplication(db: Db, businessId: string, applicationId: string) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(sandboxApplications).where(and(eq(sandboxApplications.id, z.string().uuid().parse(applicationId)), eq(sandboxApplications.businessId, businessId))).for("update");
    if (!a) throw new SandboxError("Unknown application");
    if (a.status === "withdrawn") return { application: a, duplicate: true };
    if (a.status !== "offered" && a.status !== "accepted") throw new SandboxError(`Application is ${a.status}; only an offered or accepted application can be withdrawn`);
    const [updated] = await tx.update(sandboxApplications).set({ status: "withdrawn" }).where(eq(sandboxApplications.id, a.id)).returning();
    return { application: updated, duplicate: false };
  });
}

/** Compensation: withdraws an agreed or open negotiation thread. Idempotent. */
export async function withdrawThread(db: Db, businessId: string, threadId: string) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(sandboxThreads).where(and(eq(sandboxThreads.id, z.string().uuid().parse(threadId)), eq(sandboxThreads.businessId, businessId))).for("update");
    if (!t) throw new SandboxError("Unknown thread");
    if (t.status === "withdrawn") return { thread: t, duplicate: true };
    const [updated] = await tx.update(sandboxThreads).set({ status: "withdrawn" }).where(eq(sandboxThreads.id, t.id)).returning();
    return { thread: updated, duplicate: false };
  });
}

// ---------------------------------------------------------------- receipts (ADR-019)

const receiptSchema = z.object({
  counterpartyId: z.string().uuid(), amountMinor: z.bigint().positive(), currency: currencyCode, expectedOn: isoDate,
  backingType: z.enum(["thread", "application"]), backingId: z.string().uuid(), idempotencyKey: keySchema,
});

/** Schedules money expected from a customer or lender. Idempotent by key. The bank credits it on or after the date. */
export async function scheduleReceipt(db: Db, businessId: string, counterpartyId: string, amountMinor: bigint, currency: string, expectedOn: string, backingType: "thread" | "application", backingId: string, idempotencyKey: string) {
  const input = receiptSchema.parse({ counterpartyId, amountMinor, currency, expectedOn, backingType, backingId, idempotencyKey });
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), eq(sandboxReceipts.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      if (existing.counterpartyId !== input.counterpartyId || existing.amountMinor !== input.amountMinor || existing.currency !== input.currency || existing.expectedOn !== input.expectedOn) {
        throw new SandboxError("Idempotency key already used with different receipt details");
      }
      return { receipt: existing, duplicate: true };
    }
    const [cp] = await tx.select().from(counterparties).where(and(eq(counterparties.id, input.counterpartyId), eq(counterparties.businessId, businessId)));
    if (!cp || (cp.role !== "customer" && cp.role !== "lender")) throw new SandboxError("A receipt must come from a known customer or lender");
    const [account] = await tx.select().from(sandboxBankAccounts).where(and(eq(sandboxBankAccounts.businessId, businessId), eq(sandboxBankAccounts.currency, input.currency))).orderBy(asc(sandboxBankAccounts.name)).limit(1);
    if (!account) throw new SandboxError(`No sandbox bank account in ${input.currency}`);
    const [receipt] = await tx
      .insert(sandboxReceipts)
      .values({
        businessId, bankAccountId: account.id, counterpartyId: cp.id, amountMinor: input.amountMinor, currency: input.currency, expectedOn: input.expectedOn, status: "scheduled",
        backingType: input.backingType, backingId: input.backingId, idempotencyKey: input.idempotencyKey, reference: `RCT-${sha(`${businessId}:${input.idempotencyKey}`).slice(0, 10).toUpperCase()}`,
      })
      .returning();
    return { receipt, duplicate: false };
  });
}

/** Compensation: cancels a receipt that has not been received. Idempotent. */
export async function cancelReceipt(db: Db, businessId: string, receiptId: string) {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.id, z.string().uuid().parse(receiptId)), eq(sandboxReceipts.businessId, businessId))).for("update");
    if (!r) throw new SandboxError("Unknown receipt");
    if (r.status === "cancelled") return { receipt: r, duplicate: true };
    if (r.status !== "scheduled") throw new SandboxError(`Receipt is ${r.status}; only a scheduled receipt can be cancelled`);
    const [updated] = await tx.update(sandboxReceipts).set({ status: "cancelled" }).where(eq(sandboxReceipts.id, r.id)).returning();
    return { receipt: updated, duplicate: false };
  });
}

/** The bank's own end-of-day job for money in: credits scheduled receipts due on or before asOf. Not an agent action. */
export async function executeDueReceipts(db: Db, businessId: string, asOf: string) {
  const date = isoDate.parse(asOf);
  return db.transaction(async (tx) => {
    const due = await tx.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), eq(sandboxReceipts.status, "scheduled"), lte(sandboxReceipts.expectedOn, date))).orderBy(asc(sandboxReceipts.expectedOn), asc(sandboxReceipts.createdAt));
    const receivedAt = new Date(`${date}T00:00:00Z`);
    const received: { id: string; reference: string; amountMinor: bigint }[] = [];
    for (const r of due) {
      const [acct] = await tx.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.id, r.bankAccountId)).for("update");
      await tx.update(sandboxBankAccounts).set({ balanceMinor: acct.balanceMinor + r.amountMinor, updatedAt: receivedAt }).where(eq(sandboxBankAccounts.id, acct.id));
      await tx.update(sandboxReceipts).set({ status: "received", receivedAt }).where(eq(sandboxReceipts.id, r.id));
      received.push({ id: r.id, reference: r.reference, amountMinor: r.amountMinor });
    }
    return { asOf: date, received };
  });
}

// ---------------------------------------------------------------- state

export async function getSandboxState(db: Db, businessId: string) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!biz) return null;
  const banks = await db.select().from(sandboxBankAccounts).where(eq(sandboxBankAccounts.businessId, businessId)).orderBy(asc(sandboxBankAccounts.name));
  const payees = await db.select().from(sandboxPayees).where(eq(sandboxPayees.businessId, businessId)).orderBy(asc(sandboxPayees.name));
  const payments = await db.select().from(sandboxPayments).where(eq(sandboxPayments.businessId, businessId)).orderBy(asc(sandboxPayments.scheduledFor), asc(sandboxPayments.createdAt));
  const threads = await db.select().from(sandboxThreads).where(eq(sandboxThreads.businessId, businessId)).orderBy(asc(sandboxThreads.createdAt), asc(sandboxThreads.id));
  const messages = await db.select().from(sandboxMessages).where(eq(sandboxMessages.businessId, businessId)).orderBy(asc(sandboxMessages.createdAt), desc(sandboxMessages.direction));
  const applications = await db.select().from(sandboxApplications).where(eq(sandboxApplications.businessId, businessId)).orderBy(asc(sandboxApplications.createdAt));
  const receipts = await db.select().from(sandboxReceipts).where(eq(sandboxReceipts.businessId, businessId)).orderBy(asc(sandboxReceipts.expectedOn), asc(sandboxReceipts.createdAt));
  const cps = await db.select().from(counterparties).where(eq(counterparties.businessId, businessId)).orderBy(asc(counterparties.name));
  const [acct] = await db.select({ asOf: financialAccounts.balanceAsOf }).from(financialAccounts).where(eq(financialAccounts.businessId, businessId)).orderBy(desc(financialAccounts.balanceAsOf)).limit(1);
  return toJsonValue({
    business: { id: biz.id, name: biz.name, currency: biz.baseCurrency },
    asOf: acct ? acct.asOf.toISOString().slice(0, 10) : null,
    counterparties: cps.map((c) => ({ id: c.id, name: c.name, role: c.role, temperament: parseProfile(c.profile).temperament })),
    banks, payees, payments,
    threads: threads.map((t) => ({ ...t, messages: messages.filter((m) => m.threadId === t.id) })),
    applications,
    receipts,
  }) as SandboxState;
}

export interface SandboxState {
  business: { id: string; name: string; currency: string };
  asOf: string | null;
  counterparties: { id: string; name: string; role: string; temperament: string }[];
  banks: { id: string; name: string; currency: string; balanceMinor: string }[];
  payees: { id: string; name: string; accountRef: string; approved: boolean; counterpartyId: string | null; createdVia: string }[];
  payments: { id: string; payeeId: string; amountMinor: string; currency: string; scheduledFor: string; status: string; failureReason: string | null; reference: string; idempotencyKey: string }[];
  threads: { id: string; counterpartyId: string; topic: string; status: string; agreedTerms: unknown; messages: { id: string; direction: string; kind: string; body: string; structured: unknown; untrusted: boolean }[] }[];
  receipts: { id: string; counterpartyId: string; amountMinor: string; currency: string; expectedOn: string; status: string; reference: string; backingType: string; backingId: string }[];
  applications: { id: string; lenderId: string; kind: string; requestedAmountMinor: string; currency: string; status: string; offer: unknown; reference: string }[];
}

export type { ProposalJson };
