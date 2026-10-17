// INVOICES AND BILLS. The owner records what customers owe and what suppliers are owed, with partial payments and a payment history.
// Everything here is plain code on the books: the cash engine reads the same rows (engine/loader), so a payment or a new invoice moves the
// forecast, the shortage check, the plans and the "ask about my cash" answers the same way. No model is involved and nothing is sent or paid:
// this records facts the owner states. Every create, edit, void and payment is one record in the hash-chained log (ids and amounts, no free text).
//
// Three double-counting protections, all deterministic:
//  1. Orders, recurring commitments and scheduled practice-bank payments that are the SAME money as a document: found by exact amount, direction
//     and date window; the owner either marks the document "counted elsewhere" (kept for tracking, not forecast twice) or says it is separate.
//  2. Bank transactions: a payment can point at the bank line it is; a bank line cannot be used for more than its amount; matching lines are suggested.
//  3. A payment reduces what the forecast waits for only when it is dated on or before the balance date, i.e. when the bank balance already has it.
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { todayIso } from "@/lib/clock";
import { bills, businesses, counterparties, documentPayments, invoices, sandboxPayees, sandboxPayments, sandboxReceipts, transactions } from "@/db/schema";
import {
  balanceOf, documentEditSchema, documentInputSchema, findOverlaps, paymentInputSchema, paymentProblems, paymentVoidSchema, rankBankCandidates, stateOf, storedStatusAfterPayment,
  transactionLinkProblems, type BankCandidate, type Balance, type DocKind, type Overlap, type PaymentLite,
} from "@/domain/ledger";
import { addDays, buildForecast, commitmentDates, diffDays, type EngineInput, type Forecast } from "@/engine";
import { liveCountedRefs, isLiveRef, loadEngineInput } from "@/engine/loader";
import { MoneyParseError, parseDecimalToMinor } from "@/lib/money";
import { toJsonValue } from "@/sandbox/proposals";
import { loadPending } from "./agent-run";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db, type Tx } from "./types";

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
const BANK_LOOKBACK_DAYS = 150;

type InvoiceRow = typeof invoices.$inferSelect;
type BillRow = typeof bills.$inferSelect;
type DocRow = { id: string; number: string; counterpartyId: string; issuedOn: string; dueOn: string; amountMinor: bigint; currency: string; paidOn: string | null; status: string; countedIn: string | null };

const asDoc = (kind: DocKind, r: InvoiceRow | BillRow): DocRow =>
  kind === "invoice"
    ? { id: r.id, number: (r as InvoiceRow).number, counterpartyId: (r as InvoiceRow).customerId, issuedOn: r.issuedOn, dueOn: r.dueOn, amountMinor: r.amountMinor, currency: r.currency, paidOn: r.paidOn, status: r.status, countedIn: r.countedIn }
    : { id: r.id, number: (r as BillRow).reference, counterpartyId: (r as BillRow).supplierId, issuedOn: r.issuedOn, dueOn: r.dueOn, amountMinor: r.amountMinor, currency: r.currency, paidOn: r.paidOn, status: r.status, countedIn: r.countedIn };

const today = todayIso;

function amountOf(text: string, currency: string, field: string): bigint {
  const exp = EXPONENTS[currency];
  if (exp === undefined) throw new ActionError("invalid", `Unsupported currency ${currency}`);
  try {
    const n = parseDecimalToMinor(text, exp);
    if (n <= 0n) throw new ActionError("invalid", `${field} must be more than zero`);
    return n;
  } catch (e) {
    if (e instanceof ActionError) throw e;
    throw new ActionError("invalid", `${field}: ${e instanceof MoneyParseError ? e.message : "not a valid amount"}`);
  }
}

async function businessOf(q: Db | Tx, businessId: string) {
  const [b] = await q.select().from(businesses).where(eq(businesses.id, businessId));
  if (!b) throw new ActionError("not_found", "Business not found");
  return b;
}

async function loadDoc(q: Db | Tx, businessId: string, kind: DocKind, docId: string, lock = false) {
  const t = kind === "invoice" ? invoices : bills;
  const base = q.select().from(t).where(and(eq(t.businessId, businessId), eq(t.id, docId)));
  const [row] = await (lock ? base.for("update") : base);
  if (!row) throw new ActionError("not_found", kind === "invoice" ? "Invoice not found" : "Bill not found");
  return asDoc(kind, row as InvoiceRow & BillRow);
}

async function paymentsOf(q: Db | Tx, kind: DocKind, docId: string) {
  const col = kind === "invoice" ? documentPayments.invoiceId : documentPayments.billId;
  return q.select().from(documentPayments).where(eq(col, docId)).orderBy(asc(documentPayments.paidOn), asc(documentPayments.createdAt));
}
const liteOf = (rows: (typeof documentPayments.$inferSelect)[]): PaymentLite[] => rows.map((p) => ({ id: p.id, amountMinor: p.amountMinor, paidOn: p.paidOn, voided: p.voidedAt !== null }));

async function asOfOf(db: Db | Tx, businessId: string): Promise<string> {
  const b = await businessOf(db, businessId);
  const [acc] = await db.execute<{ d: string | null }>(sql`select to_char(max(balance_as_of) at time zone 'UTC', 'YYYY-MM-DD') as d from financial_accounts where business_id = ${businessId} and currency = ${b.baseCurrency}`);
  return acc?.d ?? today();
}

/** A counterparty of the right role: an existing one of this business, or a new one created by name. */
async function resolveCounterparty(tx: Tx, businessId: string, kind: DocKind, id: string | undefined, newName: string | undefined): Promise<string> {
  const role = kind === "invoice" ? "customer" : "supplier";
  if ((id === undefined) === (newName === undefined)) throw new ActionError("invalid", `Choose a ${role} from the list or give the name of a new one`);
  if (id) {
    const [cp] = await tx.select().from(counterparties).where(and(eq(counterparties.id, id), eq(counterparties.businessId, businessId)));
    if (!cp || cp.role !== role) throw new ActionError("invalid", `That is not one of your ${role}s`);
    return cp.id;
  }
  const same = (await tx.select().from(counterparties).where(and(eq(counterparties.businessId, businessId), eq(counterparties.role, role)))).find((c) => c.name.toLowerCase() === newName!.toLowerCase());
  if (same) return same.id;
  const [created] = await tx.insert(counterparties).values({ businessId, name: newName!, role, isSimulated: false }).returning({ id: counterparties.id });
  return created.id;
}

// ---------------------------------------------------------------- overlaps and bank lines

async function overlapsFor(db: Db | Tx, businessId: string, kind: DocKind, counterpartyId: string, amountMinor: bigint, dueOn: string, input: EngineInput): Promise<Overlap[]> {
  const pending = await loadPending(db as Db, businessId, null);
  const orders = pending.map((p) => ({ ref: `${p.extractionId}:${p.event.kind}:${p.event.date}`, kind: p.event.kind, date: p.event.date, amountMinor: p.event.amountMinor, label: p.event.label }));
  const recurring = input.commitments.map((c) => ({ id: c.id, name: c.name, amountMinor: c.amount, dates: commitmentDates(c, addDays(dueOn, -7), addDays(dueOn, 7)) }));
  const scheduled: { id: string; direction: "out" | "in"; date: string; amountMinor: bigint; label: string }[] = [];
  const pays = await db.select({ p: sandboxPayments }).from(sandboxPayments).innerJoin(sandboxPayees, eq(sandboxPayees.id, sandboxPayments.payeeId))
    .where(and(eq(sandboxPayments.businessId, businessId), eq(sandboxPayments.status, "scheduled"), eq(sandboxPayees.counterpartyId, counterpartyId)));
  for (const { p } of pays) scheduled.push({ id: p.id, direction: "out", date: p.scheduledFor, amountMinor: p.amountMinor, label: `Scheduled payment ${p.reference}` });
  const rcts = await db.select().from(sandboxReceipts).where(and(eq(sandboxReceipts.businessId, businessId), eq(sandboxReceipts.status, "scheduled"), eq(sandboxReceipts.counterpartyId, counterpartyId)));
  for (const r of rcts) scheduled.push({ id: r.id, direction: "in", date: r.expectedOn, amountMinor: r.amountMinor, label: `Scheduled receipt ${r.reference}` });
  return findOverlaps({ kind, amountMinor, dueOn }, { orders, recurring, scheduled });
}

/** Recent bank lines with how much of each is already used by recorded payments. */
async function bankLines(db: Db | Tx, businessId: string, since: string): Promise<BankCandidate[]> {
  const txs = await db.select().from(transactions).where(and(eq(transactions.businessId, businessId), gte(transactions.postedOn, since)));
  const used = await db
    .select({ id: documentPayments.transactionId, sum: sql<string>`sum(${documentPayments.amountMinor})::text` })
    .from(documentPayments)
    .where(and(eq(documentPayments.businessId, businessId), isNotNull(documentPayments.transactionId), isNull(documentPayments.voidedAt)))
    .groupBy(documentPayments.transactionId);
  const usedBy = new Map(used.map((u) => [u.id!, BigInt(u.sum)]));
  return txs.map((t) => {
    const abs = t.amountMinor < 0n ? -t.amountMinor : t.amountMinor;
    return { id: t.id, postedOn: t.postedOn, amountMinor: t.amountMinor, description: t.description, counterpartyId: t.counterpartyId, remainingMinor: abs - (usedBy.get(t.id) ?? 0n) };
  });
}

// ---------------------------------------------------------------- read models

const labelOfRef = (ref: string | null, live: boolean): { ref: string; live: boolean; text: string } | null => {
  if (!ref) return null;
  const type = ref.split(":")[0];
  const what = type === "order" ? "a confirmed order" : type === "recurring" ? "a recurring commitment" : "a scheduled practice-bank item";
  return { ref, live, text: live ? `Already counted in ${what}, so it is tracked here but not forecast a second time.` : `It was marked as counted in ${what}, but that no longer exists, so it is forecast again.` };
};

function forecastImpact(f: Forecast, id: string) {
  const it = f.items.find((x) => x.sourceId === id && (x.sourceType === "invoice" || x.sourceType === "bill"));
  if (it) return { inWindow: true, date: it.date, week: it.weekIndex + 1, amountMinor: it.amount, provenance: it.kind, note: it.note ?? null };
  const out = f.outsideHorizon.find((x) => x.sourceId === id);
  return out ? { inWindow: false, date: out.date, week: null, amountMinor: out.amount, provenance: out.kind, note: "After the forecast window." } : null;
}

function docView(kind: DocKind, d: DocRow, cpName: string, pays: (typeof documentPayments.$inferSelect)[], asOf: string, f: Forecast, live: Set<string>) {
  const lite = liteOf(pays);
  const b = balanceOf({ amountMinor: d.amountMinor, status: d.status, paidOn: d.paidOn }, lite, asOf);
  const { state, overdueDays } = stateOf(d, b, asOf);
  return {
    kind, id: d.id, number: d.number, counterpartyId: d.counterpartyId, counterpartyName: cpName, issuedOn: d.issuedOn, dueOn: d.dueOn, currency: d.currency,
    amountMinor: d.amountMinor, paidMinor: b.paidMinor, outstandingMinor: b.outstandingMinor, status: d.status, state, overdueDays,
    legacyPaid: lite.filter((p) => !p.voided).length === 0 && d.status === "paid", paidOn: b.lastPaidOn,
    countedIn: labelOfRef(d.countedIn, d.countedIn ? isLiveRef(live, d.countedIn) : false),
    forecast: d.status === "void" || d.status === "draft" || b.outstandingMinor === 0n ? null : forecastImpact(f, d.id),
    payments: pays.map((p) => ({ id: p.id, amountMinor: p.amountMinor, paidOn: p.paidOn, transactionId: p.transactionId, note: p.note, voided: p.voidedAt !== null, voidReason: p.voidReason, afterBalanceDate: p.paidOn > asOf })),
  };
}

export type DocView = ReturnType<typeof docView>;

async function allViews(db: Db, businessId: string, kind: DocKind) {
  const input = await loadEngineInput(db, businessId);
  if (!input) throw new ActionError("not_found", "Business not found");
  const f = buildForecast(input);
  const t = kind === "invoice" ? invoices : bills;
  const cpCol = kind === "invoice" ? invoices.customerId : bills.supplierId;
  const rows = await db.select({ d: t, cp: counterparties.name }).from(t).innerJoin(counterparties, eq(counterparties.id, cpCol)).where(eq(t.businessId, businessId)).orderBy(asc(t.dueOn));
  const pays = await db.select().from(documentPayments).where(and(eq(documentPayments.businessId, businessId), isNotNull(kind === "invoice" ? documentPayments.invoiceId : documentPayments.billId)));
  const key = (p: typeof documentPayments.$inferSelect) => (kind === "invoice" ? p.invoiceId : p.billId)!;
  const live = await liveCountedRefs(db, businessId, rows.flatMap((r) => (r.d.countedIn ? [r.d.countedIn] : [])));
  const views = rows.map((r) => docView(kind, asDoc(kind, r.d as InvoiceRow & BillRow), r.cp, pays.filter((p) => key(p) === r.d.id), input.asOf, f, live));
  return { input, forecast: f, views };
}

function summarise(views: DocView[], asOf: string) {
  const open = views.filter((v) => ["open", "partial", "overdue", "partial_overdue"].includes(v.state));
  const sum = (rows: DocView[]) => rows.reduce((a, v) => a + v.outstandingMinor, 0n);
  const due = (days: number) => open.filter((v) => v.dueOn >= asOf && diffDays(asOf, v.dueOn) <= days);
  const overdue = open.filter((v) => v.overdueDays > 0);
  return {
    openCount: open.length, outstandingMinor: sum(open), overdueCount: overdue.length, overdueMinor: sum(overdue),
    dueIn7Minor: sum(due(7)), dueIn30Minor: sum(due(30)), partlyPaidCount: open.filter((v) => v.paidMinor > 0n).length,
    countedElsewhereCount: open.filter((v) => v.countedIn).length,
  };
}

/** Everything the Invoices & bills page shows for one list, plus both totals and the bank lines that look like payments of open documents. */
export async function getLedger(db: Db, businessId: string) {
  const biz = await businessOf(db, businessId);
  const inv = await allViews(db, businessId, "invoice");
  const bil = await allViews(db, businessId, "bill");
  const asOf = inv.input.asOf;
  const lines = await bankLines(db, businessId, addDays(asOf, -BANK_LOOKBACK_DAYS));
  const matches = [...inv.views, ...bil.views]
    .filter((v) => ["open", "partial", "overdue", "partial_overdue"].includes(v.state))
    .flatMap((v) => rankBankCandidates({ kind: v.kind, counterpartyId: v.counterpartyId, issuedOn: v.issuedOn, outstandingMinor: v.outstandingMinor }, lines).filter((t) => t.counterpartyId === v.counterpartyId && t.remainingMinor === v.outstandingMinor).slice(0, 1).map((t) => ({ docKind: v.kind, docId: v.id, number: v.number, counterpartyName: v.counterpartyName, transactionId: t.id, postedOn: t.postedOn, amountMinor: t.remainingMinor, description: t.description })));
  const counterpartyRows = await db.select({ id: counterparties.id, name: counterparties.name, role: counterparties.role }).from(counterparties).where(and(eq(counterparties.businessId, businessId), inArray(counterparties.role, ["customer", "supplier"]))).orderBy(asc(counterparties.name));
  // What the forecast takes from open documents inside its window.
  const inWindow = (views: DocView[]) => views.filter((v) => v.forecast?.inWindow).reduce((a, v) => a + (v.forecast!.amountMinor < 0n ? -v.forecast!.amountMinor : v.forecast!.amountMinor), 0n);
  return toJsonValue({
    business: { id: biz.id, currency: biz.baseCurrency }, asOf, horizonWeeks: inv.forecast.horizonWeeks,
    invoices: inv.views, bills: bil.views,
    summary: {
      receivable: { ...summarise(inv.views, asOf), inForecastMinor: inWindow(inv.views) },
      payable: { ...summarise(bil.views, asOf), inForecastMinor: inWindow(bil.views) },
    },
    bankMatches: matches, counterparties: counterpartyRows,
  });
}

/** One document with its payment history, the bank lines that could be its payment, and whether it overlaps anything already in the forecast. */
export async function getDocument(db: Db, businessId: string, kind: DocKind, docId: string) {
  const { views, input } = await allViews(db, businessId, kind);
  const v = views.find((x) => x.id === docId);
  if (!v) throw new ActionError("not_found", kind === "invoice" ? "Invoice not found" : "Bill not found");
  const lines = await bankLines(db, businessId, addDays(input.asOf, -BANK_LOOKBACK_DAYS));
  const candidates = v.outstandingMinor > 0n ? rankBankCandidates({ kind, counterpartyId: v.counterpartyId, issuedOn: v.issuedOn, outstandingMinor: v.outstandingMinor }, lines) : [];
  return toJsonValue({ document: v, bankCandidates: candidates.map((t) => ({ id: t.id, postedOn: t.postedOn, amountMinor: t.remainingMinor, description: t.description })) });
}

/** The few numbers other screens and the assistant need. Pure read. */
export async function getLedgerSummary(db: Db, businessId: string) {
  const inv = await allViews(db, businessId, "invoice");
  const bil = await allViews(db, businessId, "bill");
  return { asOf: inv.input.asOf, currency: inv.input.currency, receivable: summarise(inv.views, inv.input.asOf), payable: summarise(bil.views, inv.input.asOf), invoices: inv.views, bills: bil.views };
}

// ---------------------------------------------------------------- writes

const pgUnique = (e: unknown) => typeof e === "object" && e !== null && ((e as { code?: string }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505");

/** Rejects a countedIn the server did not offer as an overlap, and an overlap nobody resolved. Pure given the overlaps. */
function resolveOverlaps(overlaps: Overlap[], countedIn: string | null | undefined, acknowledged: boolean | undefined): string | null {
  if (countedIn) {
    if (!overlaps.some((o) => o.ref === countedIn)) throw new ActionError("invalid", "That is not something this document overlaps with");
    return countedIn;
  }
  if (overlaps.length > 0 && !acknowledged) {
    throw new ActionError("conflict", "This looks like money the forecast already counts. Say whether it is the same thing or a separate one.", { overlaps });
  }
  return null;
}

export async function createDocument(db: Db, businessId: string, kind: DocKind, rawInput: unknown, actorName = "owner") {
  const input = documentInputSchema.parse(rawInput);
  const biz = await businessOf(db, businessId);
  const amountMinor = amountOf(input.amount, biz.baseCurrency, "Amount");
  if (input.dueOn < input.issuedOn) throw new ActionError("invalid", "The due date cannot be before the issue date");
  const status = kind === "invoice" ? (input.status ?? "sent") : "unpaid";
  const forecastInput = (await loadEngineInput(db, businessId))!;
  const id = await db.transaction(async (tx) => {
    const cpId = await resolveCounterparty(tx, businessId, kind, input.counterpartyId, input.newCounterpartyName);
    const t = kind === "invoice" ? invoices : bills;
    const dupCol = kind === "invoice" ? invoices.number : bills.reference;
    const cpCol = kind === "invoice" ? invoices.customerId : bills.supplierId;
    const [dup] = await tx.select({ id: t.id }).from(t).where(and(eq(t.businessId, businessId), eq(cpCol, cpId), eq(dupCol, input.number)));
    if (dup) throw new ActionError("conflict", `${kind === "invoice" ? "Invoice" : "Bill"} ${input.number} already exists for this ${kind === "invoice" ? "customer" : "supplier"}`);
    const countedIn = status === "draft" ? null : resolveOverlaps(await overlapsFor(tx, businessId, kind, cpId, amountMinor, input.dueOn, forecastInput), input.countedIn, input.acknowledgeOverlaps);
    const values = { businessId, issuedOn: input.issuedOn, dueOn: input.dueOn, amountMinor, currency: biz.baseCurrency, status, countedIn };
    const [row] = kind === "invoice"
      ? await tx.insert(invoices).values({ ...values, number: input.number, customerId: cpId }).returning({ id: invoices.id })
      : await tx.insert(bills).values({ ...values, reference: input.number, supplierId: cpId }).returning({ id: bills.id });
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.LEDGER_DOCUMENT_CREATED, actor: "owner", detail: { kind, documentId: row.id, number: input.number, counterpartyId: cpId, amountMinor: amountMinor.toString(), currency: biz.baseCurrency, dueOn: input.dueOn, status, countedIn, by: actorName } });
    return row.id;
  }).catch((e) => { if (pgUnique(e)) throw new ActionError("conflict", "That number is already used for this customer or supplier"); throw e; });
  return getDocument(db, businessId, kind, id);
}

export async function editDocument(db: Db, businessId: string, kind: DocKind, docId: string, rawInput: unknown, actorName = "owner") {
  const input = documentEditSchema.parse(rawInput);
  const biz = await businessOf(db, businessId);
  const forecastInput = (await loadEngineInput(db, businessId))!;
  await db.transaction(async (tx) => {
    const doc = await loadDoc(tx, businessId, kind, docId, true);
    if (doc.status === "void") throw new ActionError("conflict", "This document is void and cannot be changed");
    const pays = liteOf(await paymentsOf(tx, kind, docId));
    const live = pays.filter((p) => !p.voided);
    const t = kind === "invoice" ? invoices : bills;
    const change: Record<string, unknown> = {};
    const detail: Record<string, unknown> = { kind, documentId: docId, by: actorName };

    if (input.void) {
      if (live.length > 0) throw new ActionError("conflict", "This document has payments. Void the payments first, then void the document.");
      if (doc.status === "paid") throw new ActionError("conflict", "This document was marked paid before payments were tracked. Edit or replace it instead of voiding it.");
      await tx.update(t).set({ status: "void" }).where(eq(t.id, docId));
      await appendRecord(tx, { businessId, event: ACTION_EVENTS.LEDGER_DOCUMENT_VOIDED, actor: "owner", detail: { ...detail, number: doc.number, hasReason: !!input.reason } });
      return;
    }

    const next = { ...doc };
    if (input.counterpartyId !== undefined && input.counterpartyId !== doc.counterpartyId) {
      if (live.length > 0) throw new ActionError("conflict", "A document with payments cannot change customer or supplier");
      next.counterpartyId = await resolveCounterparty(tx, businessId, kind, input.counterpartyId, undefined);
      change[kind === "invoice" ? "customerId" : "supplierId"] = next.counterpartyId;
    }
    if (input.number !== undefined && input.number !== doc.number) { next.number = input.number; change[kind === "invoice" ? "number" : "reference"] = input.number; }
    if (input.issuedOn !== undefined) { next.issuedOn = input.issuedOn; change.issuedOn = input.issuedOn; }
    if (input.dueOn !== undefined) { next.dueOn = input.dueOn; change.dueOn = input.dueOn; }
    if (next.dueOn < next.issuedOn) throw new ActionError("invalid", "The due date cannot be before the issue date");
    if (live.some((p) => p.paidOn < next.issuedOn)) throw new ActionError("invalid", "A payment is dated before that issue date");
    if (input.amount !== undefined) {
      const amountMinor = amountOf(input.amount, biz.baseCurrency, "Amount");
      if (amountMinor !== doc.amountMinor) {
        if (live.length === 0 && doc.status === "paid") throw new ActionError("conflict", "This document was marked paid before payments were tracked. Replace it with a corrected one.");
        const paid = live.reduce((a, p) => a + p.amountMinor, 0n);
        if (amountMinor < paid) throw new ActionError("invalid", "The amount cannot be lower than what has already been paid");
        next.amountMinor = amountMinor;
        change.amountMinor = amountMinor;
      }
    }
    if (input.status !== undefined && kind === "invoice") {
      if (input.status === "draft" && live.length > 0) throw new ActionError("conflict", "An invoice with payments cannot go back to draft");
      if (doc.status !== "paid") { next.status = input.status; change.status = input.status; }
    }
    if (input.number !== undefined && input.number !== doc.number) {
      const dupCol = kind === "invoice" ? invoices.number : bills.reference;
      const cpCol = kind === "invoice" ? invoices.customerId : bills.supplierId;
      const [dup] = await tx.select({ id: t.id }).from(t).where(and(eq(t.businessId, businessId), eq(cpCol, next.counterpartyId), eq(dupCol, input.number)));
      if (dup) throw new ActionError("conflict", `${input.number} already exists for this ${kind === "invoice" ? "customer" : "supplier"}`);
    }

    // Overlaps are checked again only when something that decides them changed.
    const moved = "amountMinor" in change || "dueOn" in change || "customerId" in change || "supplierId" in change || (input.status === "sent" && doc.status === "draft");
    if (input.countedIn === null) { next.countedIn = null; change.countedIn = null; }
    else if (input.countedIn !== undefined || (moved && !doc.countedIn && next.status !== "draft")) {
      const overlaps = await overlapsFor(tx, businessId, kind, next.counterpartyId, next.amountMinor, next.dueOn, forecastInput);
      next.countedIn = resolveOverlaps(overlaps, input.countedIn, input.acknowledgeOverlaps);
      change.countedIn = next.countedIn;
    } else if (moved && doc.countedIn) {
      next.countedIn = null; // the thing it was counted in no longer matches after the change: count it on its own
      change.countedIn = null;
    }

    const balance = balanceOf({ amountMinor: next.amountMinor, status: doc.status, paidOn: doc.paidOn }, pays, forecastInput.asOf);
    const status = live.length > 0 ? storedStatusAfterPayment(kind, "status" in change ? String(change.status) : doc.status, balance) : "status" in change ? String(change.status) : doc.status;
    if (status !== doc.status) change.status = status;
    if (Object.keys(change).length === 0) return;
    if (live.length > 0) change.paidOn = status === "paid" ? balance.lastPaidOn : null;
    await tx.update(t).set(change).where(eq(t.id, docId));
    const printable = Object.fromEntries(Object.entries(change).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.LEDGER_DOCUMENT_UPDATED, actor: "owner", detail: { ...detail, number: next.number, changed: printable, previousAmountMinor: "amountMinor" in change ? doc.amountMinor.toString() : undefined } });
  }).catch((e) => { if (pgUnique(e)) throw new ActionError("conflict", "That number is already used for this customer or supplier"); throw e; });
  return getDocument(db, businessId, kind, docId);
}

export async function recordPayment(db: Db, businessId: string, kind: DocKind, docId: string, rawInput: unknown, actorName = "owner") {
  const input = paymentInputSchema.parse(rawInput);
  const biz = await businessOf(db, businessId);
  const asOf = await asOfOf(db, businessId);
  const warnings: string[] = [];
  await db.transaction(async (tx) => {
    const doc = await loadDoc(tx, businessId, kind, docId, true);
    const pays = liteOf(await paymentsOf(tx, kind, docId));
    const balance = balanceOf({ amountMinor: doc.amountMinor, status: doc.status, paidOn: doc.paidOn }, pays, asOf);
    const amountMinor = amountOf(input.amount, doc.currency, "Payment");
    let paidOn = input.paidOn ?? today();
    let linked: (typeof transactions.$inferSelect) | null = null;
    if (input.transactionId) {
      const [txn] = await tx.select().from(transactions).where(and(eq(transactions.id, input.transactionId), eq(transactions.businessId, businessId))).for("update");
      if (!txn) throw new ActionError("invalid", "That bank transaction does not exist");
      const lines = (await bankLines(tx, businessId, txn.postedOn)).find((l) => l.id === txn.id)!;
      const problems = transactionLinkProblems({ kind, currency: doc.currency, counterpartyId: doc.counterpartyId }, { amountMinor: txn.amountMinor, currency: txn.currency, remainingMinor: lines.remainingMinor, counterpartyId: txn.counterpartyId }, amountMinor);
      if (problems.length > 0) throw new ActionError("invalid", problems.join(" "));
      if (input.paidOn && input.paidOn !== txn.postedOn) throw new ActionError("invalid", `A payment linked to a bank transaction takes the bank date (${txn.postedOn})`);
      paidOn = txn.postedOn;
      linked = txn;
    }
    const latestAllowed = today() > asOf ? today() : asOf;
    const problems = paymentProblems({ amountMinor, outstandingMinor: balance.outstandingMinor, paidOn, issuedOn: doc.issuedOn, latestAllowed, docStatus: doc.status });
    if (problems.length > 0) throw new ActionError("invalid", problems.join(" "));

    const [row] = await tx.insert(documentPayments).values({ businessId, invoiceId: kind === "invoice" ? docId : null, billId: kind === "bill" ? docId : null, amountMinor, currency: doc.currency, paidOn, transactionId: linked?.id ?? null, note: input.note ?? null }).returning({ id: documentPayments.id });
    const after = balanceOf({ amountMinor: doc.amountMinor, status: doc.status, paidOn: doc.paidOn }, [...pays, { id: row.id, amountMinor, paidOn, voided: false }], asOf);
    const status = storedStatusAfterPayment(kind, doc.status, after);
    const t = kind === "invoice" ? invoices : bills;
    await tx.update(t).set({ status, paidOn: status === "paid" ? after.lastPaidOn : null }).where(eq(t.id, docId));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.LEDGER_PAYMENT_RECORDED, actor: "owner", detail: { kind, documentId: docId, number: doc.number, paymentId: row.id, amountMinor: amountMinor.toString(), currency: doc.currency, paidOn, transactionId: linked?.id ?? null, outstandingAfterMinor: after.outstandingMinor.toString(), status, by: actorName } });

    if (paidOn > asOf) warnings.push(`This is dated after the bank balance date (${asOf}). The forecast keeps counting it until the bank balance includes it.`);
    else if (!linked) {
      const lines = await bankLines(tx, businessId, addDays(asOf, -BANK_LOOKBACK_DAYS));
      const hit = lines.find((l) => (kind === "invoice" ? l.amountMinor > 0n : l.amountMinor < 0n) && l.remainingMinor === amountMinor && Math.abs(diffDays(l.postedOn, paidOn)) <= 5);
      if (hit) warnings.push(`A bank transaction on ${hit.postedOn} ("${hit.description}") has the same amount. Link it to this payment so it is not entered twice.`);
    }
  });
  return { ...(await getDocument(db, businessId, kind, docId)) as object, warnings, currency: biz.baseCurrency };
}

export async function voidPayment(db: Db, businessId: string, kind: DocKind, docId: string, paymentId: string, rawInput: unknown, actorName = "owner") {
  const { reason } = paymentVoidSchema.parse(rawInput);
  const asOf = await asOfOf(db, businessId);
  await db.transaction(async (tx) => {
    const doc = await loadDoc(tx, businessId, kind, docId, true);
    const rows = await paymentsOf(tx, kind, docId);
    const target = rows.find((p) => p.id === paymentId);
    if (!target) throw new ActionError("not_found", "Payment not found");
    if (target.voidedAt) throw new ActionError("conflict", "That payment is already voided");
    await tx.update(documentPayments).set({ voidedAt: new Date(), voidReason: reason }).where(eq(documentPayments.id, paymentId));
    const lite = liteOf(rows).map((p) => (p.id === paymentId ? { ...p, voided: true } : p));
    const after: Balance = balanceOf({ amountMinor: doc.amountMinor, status: doc.status, paidOn: doc.paidOn }, lite, asOf);
    const status = lite.some((p) => !p.voided) ? storedStatusAfterPayment(kind, doc.status, after) : kind === "invoice" ? "sent" : "unpaid";
    const t = kind === "invoice" ? invoices : bills;
    await tx.update(t).set({ status, paidOn: status === "paid" ? after.lastPaidOn : null }).where(eq(t.id, docId));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.LEDGER_PAYMENT_VOIDED, actor: "owner", detail: { kind, documentId: docId, number: doc.number, paymentId, amountMinor: target.amountMinor.toString(), outstandingAfterMinor: after.outstandingMinor.toString(), status, by: actorName } });
  });
  return getDocument(db, businessId, kind, docId);
}
