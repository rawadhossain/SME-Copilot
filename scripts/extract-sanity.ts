// Sanity checks for the AI gateway and the safe document reader (not a test suite). Run: bun run check:extract
// Everything uses the mock and replay providers; no live model is ever called.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, LlmRecordingMissingError, LlmSchemaError, RECORDINGS_DIR, registerStructuredScript, writeRecording, type GatewayConfig } from "../src/ai";
import { assertNoSecrets } from "../src/ai/recordings";
import { z } from "zod";
import { extractDocument, mapExtractionToEvents, MappingRefusedError, type Outcome } from "../src/ingest/documents";
import { sampleOrderEvents } from "../src/engine/samples/grocery-order";
import type { CommitmentEvent } from "../src/domain/commitment-event";

const read = (f: string) => readFileSync(join("fixtures", f), "utf8");
const PO = read("purchase-order-northgate.md");
const QUOTE = read("supplier-quote-kestrel.md");
const INJECTED = read("injected-purchase-order.md");
const asOf = /Date:\s*(\d{4}-\d{2}-\d{2})/.exec(QUOTE)![1]; // the quote is dated on the world date

const baseCfg: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };
const mock = createGateway(baseCfg);
const replay = createGateway({ ...baseCfg, mode: "replay" });

const run = (text: string, kind: "purchase_order" | "supplier_quote", gw = mock) => extractDocument(text, kind, { asOf, gateway: gw });
const key = (e: CommitmentEvent) => JSON.stringify({ date: e.date, amount: e.amountMinor.toString(), currency: e.currency, kind: e.kind, confidence: e.confidence, label: e.label, sourceRef: e.sourceRef });
const mapAll = (parts: [Outcome, string][]) => parts.flatMap(([o, filename]) => mapExtractionToEvents(o.result, { status: "confirmed", filename }));

async function main() {
  // ---------- 1. The two fixtures: expected fields, pass validation, map to the existing sample ----------
  const po = await run(PO, "purchase_order");
  const quote = await run(QUOTE, "supplier_quote");
  for (const r of [po, quote]) {
    assert.equal(r.outcome.status, "pending_confirmation", JSON.stringify(r.outcome.flags));
    assert.deepEqual(r.outcome.flags.flags, [], "clean documents raise no flags");
    assert.deepEqual(r.outcome.flags.suspicious, [], "clean documents have no suspicious text");
  }
  const pf = po.outcome.result.fields;
  assert.deepEqual([pf.buyerName.value, pf.orderReference.value, pf.totalAmount.value, pf.currency.value, pf.paymentTermsDays.value], ["Northgate Grocers plc (SYNTHETIC)", "NG-PO-48213", "180,000.00", "GBP", 60]);
  assert.equal(pf.deliveryDate.value, new Date(Date.parse(`${asOf}T00:00:00Z`) + 35 * 86_400_000).toISOString().slice(0, 10));
  const qf = quote.outcome.result.fields;
  assert.deepEqual([qf.quoteReference.value, qf.totalAmount.value, qf.depositPercent.value, qf.balanceAmount.value], ["KPM-Q-7731", "96,000.00", "30", "67,200.00"]);
  for (const f of [...Object.values(pf), ...Object.values(qf)]) if (f.status === "verified") assert.ok(f.evidence && (PO + QUOTE).replace(/\s+/g, " ").includes(f.evidence.replace(/\s+/g, " ")), "evidence is verbatim");

  const events = mapAll([[quote.outcome, "supplier-quote-kestrel.md"], [po.outcome, "purchase-order-northgate.md"]]);
  const sample = sampleOrderEvents(asOf);
  assert.equal(events.length, sample.length);
  events.forEach((e, i) => {
    assert.equal(e.source, "document");
    assert.equal(key(e), key(sample[i]), `event ${i} equals the hand-built sample (amount, date, kind, confidence, label)`);
  });
  console.log("  fixtures: PO and quote validate, and the mapped events equal the hand-built sample exactly (only source differs: document vs manual)");

  // ---------- 2. Rejection and flags ----------
  const fabricated = await run(PO + "\n[[test:fabricated-amount]]\n", "purchase_order");
  assert.equal(fabricated.outcome.status, "failed");
  assert.ok(fabricated.outcome.flags.flags.some((f) => f.code === "field_rejected" && f.field === "totalAmount" && f.severity === "error"), "fabricated total is rejected and flagged");
  assert.equal(fabricated.outcome.result.fields.totalAmount.status, "rejected");
  assert.throws(() => mapExtractionToEvents(fabricated.outcome.result, { status: "confirmed", filename: "x" }), MappingRefusedError, "nothing is mapped");
  assert.throws(() => mapExtractionToEvents(po.outcome.result, { status: "pending_confirmation", filename: "x" }), MappingRefusedError, "an unconfirmed extraction is never mapped");

  const badQuote = await run(QUOTE.replace("(67,200.00 GBP)", "(60,000.00 GBP)"), "supplier_quote");
  assert.equal(badQuote.outcome.status, "failed");
  assert.ok(badQuote.outcome.flags.flags.some((f) => f.code === "inconsistent_totals"), "deposit + balance != total is flagged");
  assert.equal(badQuote.outcome.result.derived, null);

  // A hand-made model claim whose evidence is not in the document, and one with an unverifiable date.
  registerStructuredScript("extract.supplier_quote.v1", ({ messages }) => {
    const base = JSON.parse(JSON.stringify(readScripted(messages)));
    base.quoteReference.evidence = "QUOTATION KPM-Q-9999 (made up)";
    base.shipmentDate = { value: "2026-12-31", confidence: "high", evidence: "w/c 2026-12-31" };
    return base;
  });
  const lying = await run(QUOTE, "supplier_quote", createGateway(baseCfg));
  assert.equal(lying.outcome.result.fields.quoteReference.status, "rejected");
  assert.equal(lying.outcome.result.fields.shipmentDate.status, "rejected");
  assert.equal(lying.outcome.status, "failed");
  restoreScripts();
  console.log("  validation: fabricated amount, made-up evidence, unverifiable date and inconsistent totals are all rejected or flagged");

  // ---------- 3. The injected purchase order ----------
  const inj = await run(INJECTED, "purchase_order");
  assert.equal(inj.outcome.status, "pending_confirmation", "pending, never auto-confirmed");
  assert.ok(inj.outcome.flags.suspicious.some((s) => s.source === "scan"), "the deterministic scan found it");
  assert.ok(inj.outcome.flags.suspicious.some((s) => s.source === "model"), "the reader also reported it");
  assert.ok(inj.outcome.flags.flags.some((f) => f.code === "suspicious_text" && f.severity === "warning"));
  const injEvents = mapAll([[inj.outcome, "purchase-order-northgate.md"]]);
  assert.equal(injEvents.length, 1);
  assert.equal(key(injEvents[0]), key(events[2]), "the injected instructions change nothing in the mapped events");
  // The scan is independent of the model: even when the model call fails, the scan still runs.
  const broken = await extractDocument(INJECTED, "purchase_order", { asOf, gateway: createGateway({ ...baseCfg, mode: "replay", recordingsDir: mkdtempSync(join(tmpdir(), "empty-rec-")) }) });
  assert.equal(broken.outcome.status, "failed");
  assert.ok(broken.outcome.flags.suspicious.some((s) => s.source === "scan"), "scan runs without the model");
  console.log(`  injected PO: ${inj.outcome.flags.suspicious.length} suspicious passages found (scan + reader), not auto-confirmed, events unchanged`);

  // ---------- 4. Gateway: replay, missing recording, schema failure, secrets ----------
  const viaReplay = await run(PO, "purchase_order", replay);
  assert.deepEqual(viaReplay.outcome, po.outcome, "replay gives the same result as the mock");
  const missing = await extractDocument(PO + "\nchanged", "purchase_order", { asOf, gateway: replay });
  assert.equal(missing.outcome.status, "failed");
  assert.match(missing.outcome.flags.flags[0].message, /No LLM recording/);
  await assert.rejects(replay.generateStructured(z.object({ x: z.string() }), [{ role: "user", content: "never recorded" }], { purposeId: "test.missing" }), LlmRecordingMissingError);
  registerStructuredScript("test.badschema", () => ({ x: 123 }));
  await assert.rejects(mock.generateStructured(z.object({ x: z.string() }), [{ role: "user", content: "hi" }], { purposeId: "test.badschema" }), LlmSchemaError);
  const files = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const rec = JSON.parse(readFileSync(join(RECORDINGS_DIR, f), "utf8"));
    assertNoSecrets(rec, [process.env.LLM_API_KEY, process.env.OPENAI_API_KEY]);
    assert.equal(rec.scripted, true, "bundled recordings are marked scripted");
    assert.ok(!/authorization|api[_-]?key|bearer/i.test(JSON.stringify(rec)), "no headers or keys");
  }
  assert.throws(() => writeRecording(mkdtempSync(join(tmpdir(), "rec-")), { version: 1, kind: "structured", purposeId: "x", requestHash: "0".repeat(64), scripted: true, recordedWith: { model: "mock" }, request: { messages: [], definitions: {} }, response: { token: "sk-abcdefghijklmnopqrstuvwxyz123456" } }), /secret/);
  console.log(`  gateway: replay matches mock, a missing recording fails loudly, schema failure is an error, ${files.length} recordings contain no secrets`);
  console.log("extract sanity part A (gateway, validation, mapping): ok");

  await partB();
}

// Scripted outputs used by the hand-made lying reader above.
import { scriptedSupplierQuote } from "../src/ingest/documents/scripted";
import { purposeIdFor } from "../src/ingest/documents/prompt";
import { scriptedPurchaseOrder } from "../src/ingest/documents/scripted";
function readScripted(messages: { role: string; content: string }[]) {
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const s = user.indexOf("<document>\n") + "<document>\n".length;
  return scriptedSupplierQuote(user.slice(s, user.lastIndexOf("\n</document>")));
}
function restoreScripts() {
  const doc = (messages: { role: string; content: string }[]) => {
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const s = user.indexOf("<document>\n") + "<document>\n".length;
    return user.slice(s, user.lastIndexOf("\n</document>"));
  };
  registerStructuredScript(purposeIdFor("supplier_quote"), ({ messages }) => scriptedSupplierQuote(doc(messages)));
  registerStructuredScript(purposeIdFor("purchase_order"), ({ messages }) => scriptedPurchaseOrder(doc(messages)));
}

// ---------- Part B: database path (documents, extractions, llm_calls, owner confirmation, log) ----------
async function partB() {
  if (!process.env.APP_DATABASE_URL) {
    console.log("extract sanity part B: skipped (no APP_DATABASE_URL)");
    return;
  }
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq, desc } = await import("drizzle-orm");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction, rejectExtraction } = await import("../src/ingest/documents/confirm");
  const { getEvidence } = await import("../src/actions");
  const { eventsForConfirmed } = docs;
  try {
    const name = "Extract Sanity Co (SYNTHETIC)";
    let [biz] = await db.select().from(S.businesses).where(eq(S.businesses.name, name));
    if (!biz) [biz] = await db.insert(S.businesses).values({ name, baseCurrency: "GBP", reserveCurrency: "GBP", isSynthetic: true, isTest: true }).returning();
    await db.delete(S.financialAccounts).where(eq(S.financialAccounts.businessId, biz.id));
    await db.insert(S.financialAccounts).values({ businessId: biz.id, name: "Extract test account", currency: "GBP", balanceMinor: 4_200_000n, balanceAsOf: new Date(`${asOf}T00:00:00Z`) });
    const events = async (gw = replay) => {
      const q = await docs.createDocumentAndExtract(db, biz.id, { filename: "supplier-quote-kestrel.md", kind: "supplier_quote", text: QUOTE }, { gateway: gw });
      const p = await docs.createDocumentAndExtract(db, biz.id, { filename: "purchase-order-northgate.md", kind: "purchase_order", text: PO }, { gateway: gw });
      return { q, p };
    };
    const countRecords = async (event: string) => (await db.select().from(S.actionRecords).where(and(eq(S.actionRecords.businessId, biz.id), eq(S.actionRecords.event, event)))).length;

    // Clean documents: pending, confirm them as the owner, events equal the sample.
    const calls0 = (await db.select().from(S.llmCalls).where(eq(S.llmCalls.businessId, biz.id))).length;
    const { q, p } = await events();
    assert.equal(q.extraction.status, "pending_confirmation");
    assert.equal(p.extraction.status, "pending_confirmation");
    await assert.rejects(eventsForConfirmed(db, q.extraction.id), /only a confirmed/);
    const c0 = await countRecords("document.extraction_confirmed");
    const cq = await confirmExtraction(db, q.extraction.id, "Test Owner");
    const cp = await confirmExtraction(db, p.extraction.id, "Test Owner");
    assert.equal(await countRecords("document.extraction_confirmed"), c0 + 2);
    await assert.rejects(confirmExtraction(db, q.extraction.id, "Test Owner"), /only a pending/);
    const mapped = [...cq.events, ...cp.events];
    const sampleJson = sampleOrderEvents(asOf);
    assert.deepEqual(mapped.map((e) => [e.date, e.amountMinor, e.kind]), sampleJson.map((e) => [e.date, e.amountMinor.toString(), e.kind]), "stored-then-confirmed events equal the sample");
    assert.deepEqual((await eventsForConfirmed(db, p.extraction.id)).map((e) => e.amountMinor), [cp.events[0].amountMinor]);

    // Telemetry: one llm_calls row per call, content-free.
    const calls = await db.select().from(S.llmCalls).where(eq(S.llmCalls.businessId, biz.id)).orderBy(desc(S.llmCalls.createdAt));
    assert.equal(calls.length - calls0, 2);
    assert.ok(calls.slice(0, 2).every((c) => c.ok && c.mode === "replay" && c.error === null && /^extract\./.test(c.purpose) && c.requestHash.length === 64));
    assert.ok(!JSON.stringify(calls.slice(0, 2)).includes("Northgate"), "llm_calls holds no document text");

    // Injected document: suspicious record written, not auto-confirmed, owner can still reject.
    const s0 = await countRecords("security.suspicious_text_detected");
    const inj = await docs.createDocumentAndExtract(db, biz.id, { filename: "injected-purchase-order.md", kind: "purchase_order", text: INJECTED }, { gateway: replay });
    assert.equal(inj.extraction.status, "pending_confirmation");
    assert.ok(inj.extraction.flags.suspicious.length >= 2);
    assert.equal(await countRecords("security.suspicious_text_detected"), s0 + 1);
    const logged = (await db.select().from(S.actionRecords).where(and(eq(S.actionRecords.businessId, biz.id), eq(S.actionRecords.event, "security.suspicious_text_detected"))).orderBy(desc(S.actionRecords.chainSeq)).limit(1))[0];
    assert.ok(((logged.detail as { matches: unknown[] }).matches ?? []).length >= 2, "matched snippets are in the log");
    const r0 = await countRecords("document.extraction_rejected");
    await rejectExtraction(db, inj.extraction.id, "Test Owner", "contains injected instructions");
    assert.equal(await countRecords("document.extraction_rejected"), r0 + 1);
    await assert.rejects(confirmExtraction(db, inj.extraction.id, "Test Owner"), /only a pending/);

    // A failed extraction (fabricated total) cannot be confirmed.
    const bad = await docs.createDocumentAndExtract(db, biz.id, { filename: "bad.md", kind: "purchase_order", text: PO + "\n[[test:fabricated-amount]]\n" }, { gateway: mock });
    assert.equal(bad.extraction.status, "failed");
    await assert.rejects(confirmExtraction(db, bad.extraction.id, "Test Owner"), /only a pending/);

    const ev = (await getEvidence(db, biz.id)) as { chain: { ok: boolean } };
    assert.equal(ev.chain.ok, true);
    console.log("extract sanity part B (documents, owner confirmation, log, telemetry): ok");
  } finally {
    await sql.end();
  }
}

await main();
