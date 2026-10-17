// Focused checks for Invoices & bills (not a test suite). Run: bun run check:ledger
// Part A is pure (balances, states, overlap and bank-line rules). Part B uses a throwaway clone of the demo business (is_test) and checks that
// invoices, bills and part payments move the same forecast the shortage check, the planner and the assistant read, that nothing is counted twice,
// and that causes of a shortage link to their records. The demo business itself is never changed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { balanceOf, findOverlaps, paymentProblems, rankBankCandidates, stateOf, transactionLinkProblems, type PaymentLite } from "../src/domain/ledger";

const P = (id: string, amountMinor: bigint, paidOn: string, voided = false): PaymentLite => ({ id, amountMinor, paidOn, voided });

async function main() {
  // ---------- A. pure ----------
  const doc = { amountMinor: 100_000n, status: "sent", paidOn: null };
  let b = balanceOf(doc, [P("a", 30_000n, "2026-10-01"), P("b", 20_000n, "2026-10-20")], "2026-10-15");
  assert.deepEqual([b.paidMinor, b.outstandingMinor, b.paidByAsOfMinor, b.outstandingAtAsOfMinor], [50_000n, 50_000n, 30_000n, 70_000n], "a payment after the balance date is real, but the forecast still waits for it");
  b = balanceOf(doc, [P("a", 30_000n, "2026-10-01", true)], "2026-10-15");
  assert.equal(b.paidMinor, 0n, "a voided payment never counts");
  assert.equal(balanceOf({ amountMinor: 100_000n, status: "paid", paidOn: "2026-09-01" }, [], "2026-10-15").outstandingMinor, 0n, "an older record marked paid with no payment rows is paid in full");
  const part = balanceOf(doc, [P("a", 30_000n, "2026-10-01")], "2026-10-15");
  assert.equal(stateOf({ status: "sent", dueOn: "2026-10-10" }, part, "2026-10-15").state, "partial_overdue");
  assert.equal(stateOf({ status: "sent", dueOn: "2026-10-20" }, part, "2026-10-15").state, "partial");
  assert.equal(stateOf({ status: "draft", dueOn: "2026-10-10" }, part, "2026-10-15").state, "draft");
  const ok = { amountMinor: 10_000n, outstandingMinor: 20_000n, paidOn: "2026-10-10", issuedOn: "2026-10-01", latestAllowed: "2026-10-15", docStatus: "sent" };
  assert.deepEqual(paymentProblems(ok), []);
  assert.equal(paymentProblems({ ...ok, amountMinor: 20_001n }).length, 1, "more than owed is refused");
  assert.equal(paymentProblems({ ...ok, paidOn: "2026-10-16" }).length, 1, "a future date is refused");
  assert.equal(paymentProblems({ ...ok, paidOn: "2026-09-30" }).length, 1, "before the issue date is refused");
  assert.equal(paymentProblems({ ...ok, docStatus: "void" }).length, 1);
  const src = {
    orders: [{ ref: "ex1:customer_receipt:2026-11-10", kind: "customer_receipt", date: "2026-11-10", amountMinor: 500_000n, label: "PO from X" }, { ref: "ex1:supplier_deposit:2026-11-01", kind: "supplier_deposit", date: "2026-11-01", amountMinor: -120_000n, label: "Deposit" }, { ref: "ex1:supplier_balance:2026-12-01", kind: "supplier_balance", date: "2026-12-01", amountMinor: -280_000n, label: "Balance" }],
    recurring: [{ id: "r1", name: "Rent", amountMinor: -250_000n, dates: ["2026-11-01"] }],
    scheduled: [{ id: "s1", direction: "out" as const, date: "2026-11-02", amountMinor: 120_000n, label: "Scheduled payment" }],
  };
  assert.deepEqual(findOverlaps({ kind: "invoice", amountMinor: 500_000n, dueOn: "2026-11-12" }, src).map((o) => o.ref), ["order:ex1:customer_receipt:2026-11-10"]);
  assert.equal(findOverlaps({ kind: "invoice", amountMinor: 500_001n, dueOn: "2026-11-12" }, src).length, 0, "a different amount is a different invoice (no fuzzy matching)");
  assert.equal(findOverlaps({ kind: "invoice", amountMinor: 500_000n, dueOn: "2027-03-01" }, src).length, 0, "too far from the order date");
  assert.deepEqual(findOverlaps({ kind: "bill", amountMinor: 250_000n, dueOn: "2026-11-03" }, src).map((o) => o.ref), ["recurring:r1"]);
  assert.ok(findOverlaps({ kind: "bill", amountMinor: 400_000n, dueOn: "2026-11-15" }, src).some((o) => o.ref === "order:ex1:supplier"), "a bill for the whole supplier order matches deposit plus balance");
  assert.deepEqual(findOverlaps({ kind: "bill", amountMinor: 120_000n, dueOn: "2026-11-01" }, src).map((o) => o.type).sort(), ["order", "scheduled"]);
  assert.equal(findOverlaps({ kind: "invoice", amountMinor: 250_000n, dueOn: "2026-11-01" }, src).length, 0, "direction matters: a rent bill is not a customer invoice");
  const lines = [{ id: "t1", postedOn: "2026-10-05", amountMinor: 70_000n, description: "x", counterpartyId: "c1", remainingMinor: 70_000n }, { id: "t2", postedOn: "2026-10-05", amountMinor: -70_000n, description: "y", counterpartyId: "c1", remainingMinor: 70_000n }, { id: "t3", postedOn: "2026-10-05", amountMinor: 70_000n, description: "z", counterpartyId: "c1", remainingMinor: 0n }];
  assert.deepEqual(rankBankCandidates({ kind: "invoice", counterpartyId: "c1", issuedOn: "2026-10-01", outstandingMinor: 70_000n }, lines).map((l) => l.id), ["t1"], "right direction, something left of it, same party and amount");
  assert.ok(transactionLinkProblems({ kind: "invoice", currency: "GBP", counterpartyId: "c1" }, { amountMinor: -70_000n, currency: "GBP", remainingMinor: 70_000n, counterpartyId: "c1" }, 70_000n).length > 0, "money going out cannot be a customer payment");
  assert.ok(transactionLinkProblems({ kind: "invoice", currency: "GBP", counterpartyId: "c1" }, { amountMinor: 70_000n, currency: "GBP", remainingMinor: 50_000n, counterpartyId: "c1" }, 60_000n).length > 0, "a bank line cannot be used for more than it has left");
  console.log("  A pure rules: balances, states, payment limits, overlap matching (exact, directional) and bank-line rules");

  // ---------- B. database ----------
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq, and, sql: dsql } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const L = await import("../src/actions/ledger");
  const { loadEngineInput } = await import("../src/engine/loader");
  const { buildForecast } = await import("../src/engine");
  const { getRoom } = await import("../src/actions/room");
  const { askAboutCash } = await import("../src/actions/cash-ask");
  const { buildContext } = await import("../src/actions/agent-run");
  const { buildAgentTools } = await import("../src/agent/tools");
  const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
  const { ActionError } = await import("../src/actions/types");
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");
    const { id } = await createDemoClone(db as any, demo!);
    const forecast = async (horizon = 13) => buildForecast((await loadEngineInput(db as any, id, undefined, horizon))!, { runRate: false }); // books only: exact arithmetic
    const withRunRate = async () => buildForecast((await loadEngineInput(db as any, id))!);
    const inflow = (f: any) => f.weeks.reduce((a: bigint, w: any) => a + w.inflow, 0n);
    const outflow = (f: any) => f.weeks.reduce((a: bigint, w: any) => a + w.outflow, 0n);
    const cps = await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, id));
    const customer = cps.find((c) => c.role === "customer")!;
    const supplier = cps.find((c) => c.role === "supplier")!;
    const base = await forecast();
    const patternBefore = (await withRunRate()).items.filter((i: any) => i.sourceType === "pattern_invoice" && i.counterpartyId === customer.id).length;
    const asOf = base.asOf;
    const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const refuses = async (fn: () => Promise<unknown>, code: string, what: string) => {
      try { await fn(); assert.fail(`${what}: expected a refusal`); } catch (e) { assert.ok(e instanceof ActionError, `${what}: ${String(e)}`); assert.equal((e as any).code, code, `${what}: ${(e as any).message}`); }
    };

    // B1. A new invoice moves the forecast by exactly its amount, in the right week.
    const dueOn = addDays(asOf, 20);
    const created: any = await L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-1", issuedOn: asOf, dueOn, amount: "10000.00", acknowledgeOverlaps: true });
    const invId = created.document.id;
    const afterCreate = await forecast();
    const delta = inflow(afterCreate) - inflow(base);
    assert.equal(delta, 1_000_000n, "the invoice adds exactly its amount to the books forecast");
    const patternAfter = (await withRunRate()).items.filter((i: any) => i.sourceType === "pattern_invoice" && i.counterpartyId === customer.id).length;
    assert.ok(patternAfter <= patternBefore, "an invoice for a regular customer moves the expected-invoice projection; it does not add a second one");
    const item = afterCreate.items.find((i: any) => i.sourceId === invId)!;
    assert.ok(item, "the invoice is a forecast line that points back at its record");
    assert.equal(item.amount, 1_000_000n);
    assert.equal(created.document.forecast.week, item.weekIndex + 1, "the page shows the same week the forecast uses");
    await refuses(() => L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-1", issuedOn: asOf, dueOn, amount: "5.00", acknowledgeOverlaps: true }), "conflict", "duplicate invoice number");
    await refuses(() => L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-X", issuedOn: asOf, dueOn: addDays(asOf, -1), amount: "5.00" }), "invalid", "due before issue");
    await refuses(() => L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-X", issuedOn: asOf, dueOn, amount: "5.005" }), "invalid", "a three-decimal GBP amount");
    await refuses(() => L.createDocument(db as any, id, "invoice", { counterpartyId: supplier.id, number: "LEDGER-X", issuedOn: asOf, dueOn, amount: "5.00" }), "invalid", "a supplier as the customer");
    // a draft stays out of the forecast
    const draft: any = await L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-DRAFT", issuedOn: asOf, dueOn, amount: "7777.00", status: "draft" });
    assert.ok(!(await forecast()).items.some((i: any) => i.sourceId === draft.document.id), "a draft invoice is not forecast");
    console.log("  B1 invoice: forecast line equals the amount, same week as the page; duplicate number, bad dates, odd amounts and wrong party refused; drafts stay out");

    // B2. Partial payments.
    await refuses(() => L.recordPayment(db as any, id, "invoice", invId, { amount: "10000.01", paidOn: asOf }), "invalid", "paying more than is owed");
    await refuses(() => L.recordPayment(db as any, id, "invoice", invId, { amount: "100.00", paidOn: "2999-01-01" }), "invalid", "a payment dated in the future");
    const p1: any = await L.recordPayment(db as any, id, "invoice", invId, { amount: "4000.00", paidOn: asOf });
    assert.equal(p1.document.state, "partial");
    assert.equal(BigInt(p1.document.outstandingMinor), 600_000n);
    const f2 = await forecast();
    assert.equal(f2.items.find((i: any) => i.sourceId === invId)!.amount, 600_000n, "the forecast waits for the unpaid balance only");
    assert.equal(inflow(f2), inflow(afterCreate) - 400_000n, "4,000.00 left the forecast, no more and no less");
    // the planner's view, the shortage check and the assistant all read the same books
    const ctx = await buildContext(db as any, id, null);
    const overview: any = await (buildAgentTools(ctx).get_business_overview as any).execute({});
    const led = await L.getLedgerSummary(db as any, id);
    assert.equal(overview.openInvoices.totalMinor, led.receivable.outstandingMinor.toString(), "the planner's overview and the Invoices page add up to the same figure");
    assert.equal(overview.partlyPaid.count, 1);
    const p2: any = await L.recordPayment(db as any, id, "invoice", invId, { amount: "6000.00", paidOn: asOf, note: "balance" });
    assert.equal(p2.document.state, "paid");
    assert.equal(BigInt(p2.document.outstandingMinor), 0n);
    assert.ok(!(await forecast()).items.some((i: any) => i.sourceId === invId), "a paid invoice leaves the forecast");
    await refuses(() => L.recordPayment(db as any, id, "invoice", invId, { amount: "1.00", paidOn: asOf }), "invalid", "paying a paid invoice");
    // voiding a payment reopens it and the history keeps both
    const firstPay = p2.document.payments.find((p: any) => p.note === "balance");
    const v: any = await L.voidPayment(db as any, id, "invoice", invId, firstPay.id, { reason: "typed the wrong invoice" });
    assert.equal(v.document.state, "partial");
    assert.equal(v.document.payments.length, 2, "the voided payment stays in the history");
    assert.equal((await forecast()).items.find((i: any) => i.sourceId === invId)!.amount, 600_000n, "voiding put the balance back into the forecast");
    await refuses(() => L.editDocument(db as any, id, "invoice", invId, { amount: "3999.99" }), "invalid", "an amount lower than what was paid");
    await refuses(() => L.editDocument(db as any, id, "invoice", invId, { void: true }), "conflict", "voiding a document with payments");
    const edited: any = await L.editDocument(db as any, id, "invoice", invId, { amount: "12000.00", acknowledgeOverlaps: true });
    assert.equal(BigInt(edited.document.outstandingMinor), 800_000n, "raising the amount raises what is still owed");
    // a payment dated after the balance date is real but the forecast keeps waiting for it
    const t = new Date().toISOString().slice(0, 10);
    if (t > asOf) {
      const late: any = await L.recordPayment(db as any, id, "invoice", invId, { amount: "100.00", paidOn: t });
      assert.ok(late.warnings.length > 0, "told that the bank balance does not have it yet");
      assert.equal((await forecast()).items.find((i: any) => i.sourceId === invId)!.amount, 800_000n, "not yet in the bank balance, so the forecast still counts it");
      await L.voidPayment(db as any, id, "invoice", invId, late.document.payments.find((p: any) => !p.voided && p.paidOn === t).id, { reason: "check cleanup" });
    }
    console.log("  B2 payments: part payment, over-payment and future date refused, unpaid balance only in the forecast, planner overview equals the page, void restores the balance and keeps history");

    // B3. Not counted twice: a bill that is the same money as a recurring commitment.
    const rec = (await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, id))).find((r) => r.amountMinor < 0n)!;
    const rAbs = -rec.amountMinor;
    const typed = `${rAbs / 100n}.${(rAbs % 100n).toString().padStart(2, "0")}`;
    const fBefore = await forecast();
    let overlaps: any[] = [];
    try { await L.createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "LEDGER-RENT", issuedOn: asOf, dueOn: rec.nextDueOn, amount: typed }); assert.fail("expected an overlap"); } catch (e: any) { assert.equal(e.code, "conflict"); overlaps = e.details.overlaps; }
    assert.ok(overlaps.some((o) => o.ref === `recurring:${rec.id}`), "the recurring commitment is offered as the same money");
    assert.equal(outflow(await forecast()), outflow(fBefore), "nothing was stored by the refused attempt");
    await refuses(() => L.createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "LEDGER-RENT", issuedOn: asOf, dueOn: rec.nextDueOn, amount: typed, countedIn: "recurring:00000000-0000-4000-8000-000000000000" }), "invalid", "a made-up countedIn");
    const same: any = await L.createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "LEDGER-RENT", issuedOn: asOf, dueOn: rec.nextDueOn, amount: typed, countedIn: `recurring:${rec.id}` });
    assert.equal(outflow(await forecast()), outflow(fBefore), "tracked as the same thing: the forecast outflow did not change");
    assert.ok(same.document.countedIn?.live, "the page says why it is not forecast again");
    const sep: any = await L.createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "LEDGER-RENT-2", issuedOn: asOf, dueOn: rec.nextDueOn, amount: typed, acknowledgeOverlaps: true });
    assert.equal(outflow(await forecast()), outflow(fBefore) + rAbs, "said to be separate: counted, once");
    // if what it was counted in disappears, it is counted again rather than silently dropped
    await db.update(S.bills).set({ countedIn: `recurring:${rec.id.replace(/.$/, rec.id.endsWith("0") ? "1" : "0")}` }).where(eq(S.bills.id, same.document.id));
    assert.equal(outflow(await forecast()), outflow(fBefore) + rAbs + rAbs, "a marker that points at nothing no longer hides the bill");
    void sep;
    console.log("  B3 overlap: the same money as a recurring commitment is offered, tracked-not-doubled when the owner says so, counted once when separate, and a stale marker never hides a bill");

    // B4. Bank transactions: link, no over-use, wrong direction refused.
    const [acct] = await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, id));
    const inv2: any = await L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-BANK", issuedOn: addDays(asOf, -10), dueOn: addDays(asOf, -2), amount: "2500.00", acknowledgeOverlaps: true });
    const inv3: any = await L.createDocument(db as any, id, "invoice", { counterpartyId: customer.id, number: "LEDGER-BANK-2", issuedOn: addDays(asOf, -10), dueOn: addDays(asOf, -2), amount: "2500.00", acknowledgeOverlaps: true });
    const [tx] = await db.insert(S.transactions).values({ businessId: id, accountId: acct.id, postedOn: addDays(asOf, -3), amountMinor: 250_000n, currency: acct.currency, description: "BACS LEDGER CHECK", counterpartyId: customer.id, source: "ledger-check", sourceId: `ledger-check-${id}` }).returning();
    const [out] = await db.insert(S.transactions).values({ businessId: id, accountId: acct.id, postedOn: addDays(asOf, -3), amountMinor: -250_000n, currency: acct.currency, description: "OUTGOING LEDGER CHECK", counterpartyId: customer.id, source: "ledger-check", sourceId: `ledger-check-out-${id}` }).returning();
    const ledger: any = await L.getLedger(db as any, id);
    assert.ok(ledger.bankMatches.some((m: any) => m.transactionId === tx.id && m.docId === inv2.document.id), "the bank line is suggested for the matching invoice");
    await refuses(() => L.recordPayment(db as any, id, "invoice", inv2.document.id, { amount: "2500.00", transactionId: out.id }), "invalid", "money going out as a customer payment");
    await refuses(() => L.recordPayment(db as any, id, "invoice", inv2.document.id, { amount: "2500.00", transactionId: tx.id, paidOn: addDays(asOf, -1) }), "invalid", "a different date than the bank line");
    const linked: any = await L.recordPayment(db as any, id, "invoice", inv2.document.id, { amount: "2500.00", transactionId: tx.id });
    assert.equal(linked.document.payments[0].paidOn, tx.postedOn, "a linked payment takes the bank date");
    assert.equal(linked.document.state, "paid");
    await refuses(() => L.recordPayment(db as any, id, "invoice", inv3.document.id, { amount: "2500.00", transactionId: tx.id }), "invalid", "using the same bank line twice");
    console.log("  B4 bank lines: suggested for the matching invoice, linked once with the bank date, reuse / wrong direction / other date refused");

    // B5. A shortage links to its records, and the assistant answers from the same books.
    await L.createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "LEDGER-BIG", issuedOn: asOf, dueOn: addDays(asOf, 10), amount: "900000.00", acknowledgeOverlaps: true });
    const room: any = await getRoom(db as any, id);
    assert.ok(room.shortage.shortage, "a huge bill creates a shortage");
    const bigDoc = room.causeDocuments.find((c: any) => c.label.includes("LEDGER-BIG"));
    assert.ok(bigDoc?.document?.id, "the shortage lists the bill as a cause, with its record id");
    const detail: any = await L.getDocument(db as any, id, "bill", bigDoc.document.id);
    assert.equal(detail.document.number, "LEDGER-BIG", "the link resolves to the bill");
    assert.ok(room.ledger.billsDueSoonCount >= 1);
    const mock = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR } as any);
    const ans: any = await askAboutCash(db as any, id, { question: "Which invoices are overdue?" }, { gateway: mock });
    assert.ok(ans.ok && ans.intent === "ledger", "routed to the invoices answer");
    const summary = await L.getLedgerSummary(db as any, id);
    const fmt = (n: bigint) => `${(n / 100n).toLocaleString("en-GB")}.${(n % 100n).toString().padStart(2, "0")}`;
    assert.ok(ans.draftAnswer.includes(fmt(summary.receivable.outstandingMinor)), "the assistant's figure is the page's figure");
    console.log("  B5 shortage and assistant: the bill is listed as a cause and resolves to its record; the assistant states the same total as the page");

    // B6. Every change is in the hash-chained log, with amounts and ids but no free text.
    const events = await db.select({ e: S.actionRecords.event, d: S.actionRecords.detail }).from(S.actionRecords).where(and(eq(S.actionRecords.businessId, id), dsql`${S.actionRecords.event} like 'ledger.%'`));
    const kinds = new Set(events.map((e) => e.e));
    for (const k of ["ledger.document_created", "ledger.document_updated", "ledger.payment_recorded", "ledger.payment_voided"]) assert.ok(kinds.has(k), `${k} is logged`);
    assert.ok(!JSON.stringify(events).includes("typed the wrong invoice"), "free-text reasons and notes are not copied into the log");
    console.log(`  B6 log: ${events.length} ledger records written (created, updated, payment recorded, payment voided); no free text`);
    console.log("ledger checks passed");
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
