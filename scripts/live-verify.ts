// Live verification of Batches 6 and 7 against a real model (Batch 7 follow-up). Not part of check:*.
//   record:  LLM_MODE=record  bun --env-file=.env scripts/live-verify.ts record <state.json>
//   replay:  LLM_MODE=replay LLM_API_KEY= bun --env-file=.env scripts/live-verify.ts replay <state.json>
// Works on a CLONE of the demo business ("Agent Live ... (SYNTHETIC)"); the demo business is only read. Never prints the key.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGateway, describeConfig, readConfig } from "../src/ai";
import { applyTermChanges, buildForecast, type TermChanges } from "../src/engine";
import { sampleOrderEvents } from "../src/engine/samples/grocery-order";
import { signMandate } from "../src/gate/owner-signing";
import { formatMoney, money } from "../src/lib/money";
import type { Lever } from "../src/domain/plan";

const [phase, statePath] = [process.argv[2], process.argv[3]];
assert.ok((phase === "record" || phase === "replay") && statePath, "usage: live-verify.ts record|replay <state.json>");
const cfg = readConfig();
console.log(`phase=${phase}`, JSON.stringify(describeConfig(cfg)));
if (phase === "record") assert.ok(cfg.mode === "record" && cfg.provider === "openai-compatible" && cfg.apiKey, "record needs LLM_MODE=record and a configured provider");
else assert.ok(cfg.mode === "replay" && !cfg.apiKey, "replay must run with LLM_MODE=replay and NO api key");
const gw = createGateway(cfg);
const read = (f: string) => readFileSync(`fixtures/${f}`, "utf8");
const gbp = (m: string | bigint) => formatMoney(money(BigInt(m), "GBP"), 2);
const state: Record<string, unknown> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq, asc, desc, inArray } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const { startRun, buildContext, getRun } = await import("../src/actions/agent-run");
  try {
    let bizId = state.businessId as string | undefined;
    const agentOnly = process.env.AGENT_ONLY === "1" && !!bizId; // reuse the clone and its confirmed extractions (saves live calls)
    if (phase === "record" && !agentOnly) {
      assert.ok(!bizId, "state file already has a clone; delete it to start over");
      const demoId = await getDefaultBusinessId();
      assert.ok(demoId);
      const [src] = await db.select().from(S.businesses).where(eq(S.businesses.id, demoId!));
      const [biz] = await db.insert(S.businesses).values({ name: `Agent Live ${Date.now().toString(36)} (SYNTHETIC)`, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true }).returning();
      const omit = <T extends { id: string; businessId: string }>(r: T) => { const { id: _i, businessId: _b, ...rest } = r; void _i; void _b; return rest; };
      for (const a of await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, demoId!))) await db.insert(S.financialAccounts).values({ ...omit(a), businessId: biz.id });
      const idMap = new Map<string, string>();
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, demoId!))) { const [n] = await db.insert(S.counterparties).values({ ...omit(c), businessId: biz.id }).returning(); idMap.set(c.id, n.id); }
      for (const i of await db.select().from(S.invoices).where(eq(S.invoices.businessId, demoId!))) await db.insert(S.invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
      for (const b of await db.select().from(S.bills).where(eq(S.bills.businessId, demoId!))) await db.insert(S.bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
      for (const c of await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, demoId!))) await db.insert(S.recurringCommitments).values({ ...omit(c), businessId: biz.id });
      const [m] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, demoId!), eq(S.mandates.active, true)));
      const signed = signMandate({ ...JSON.parse(m.canonical), businessId: biz.id });
      await db.insert(S.mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
      bizId = biz.id;
      state.businessId = bizId;
      writeFileSync(statePath, JSON.stringify(state, null, 1));
    }
    assert.ok(bizId, "no clone in the state file; run record first");

    // ---------- Step 1: extraction ----------
    const extractionSummary: unknown[] = [];
    const confirmedEvents: { kind: string; date: string; amountMinor: string; confidence: string }[] = [];
    let lastId = "";
    let asOf = "";
    const { mapExtractionToEvents } = docs;
    for (const [file, kind] of agentOnly ? [] : ([["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const)) {
      const r = await docs.createDocumentAndExtract(db, bizId!, { filename: file, kind, text: read(file) }, { gateway: gw });
      const ex = r.extraction;
      const fields = Object.entries(ex.result.fields).map(([k, v]) => `${k}:${v.status}${v.reason ? `(${v.reason})` : ""}`);
      const flags = ex.flags.flags.map((f) => `${f.severity}:${f.code}${f.field ? `@${f.field}` : ""}`);
      console.log(`\n[extract] ${file}: status=${ex.status}`);
      console.log(`  fields: ${fields.join(", ")}`);
      console.log(`  flags: ${flags.join(", ") || "none"}; suspicious passages: ${ex.flags.suspicious.length}`);
      extractionSummary.push({ file, status: ex.status, fields, flags, suspicious: ex.flags.suspicious.length });
      if (ex.status !== "pending_confirmation") { console.log("  extraction did not pass the validator; stopping (no retries)"); state[`${phase}_extraction`] = extractionSummary; writeFileSync(statePath, JSON.stringify(state, null, 1)); return; }
      await confirmExtraction(db, ex.id, "Test Owner");
      lastId = ex.id;
      asOf = ex.result.asOf;
      for (const e of mapExtractionToEvents(ex.result, { status: "confirmed", filename: file })) confirmedEvents.push({ kind: e.kind, date: e.date, amountMinor: e.amountMinor.toString(), confidence: e.confidence });
    }
    if (agentOnly) {
      const [ex] = await db.select().from(S.extractions).where(and(eq(S.extractions.businessId, bizId!), eq(S.extractions.status, "confirmed"))).orderBy(desc(S.extractions.confirmedAt)).limit(1);
      lastId = ex.id;
      asOf = (ex.result as { asOf: string }).asOf;
    }
    const key = (e: { kind: string; date: string; amountMinor: string }) => `${e.date}|${e.kind}|${e.amountMinor}`;
    const sample = sampleOrderEvents(asOf).map((e) => ({ kind: e.kind, date: e.date, amountMinor: e.amountMinor.toString() }));
    const same = JSON.stringify(sample.map(key).sort()) === JSON.stringify(confirmedEvents.map(key).sort());
    if (!agentOnly) console.log(`[extract] mapped events equal the hand-built sample order: ${same}`);
    if (!same) console.log("  extracted:", confirmedEvents.map(key).sort().join(" ; "), "\n  sample:   ", sample.map(key).sort().join(" ; "));
    if (!agentOnly) state[`${phase}_extraction`] = { extractionSummary, same, confirmedEvents };

    // ---------- Step 2: agent run ----------
    const ctx = await buildContext(db, bizId!, lastId);
    const run = await startRun(db, bizId!, { type: "commitment", extractionId: lastId });
    const got = (await getRun(db, run.runId)) as { steps: { kind: string; payload: Record<string, unknown> }[] };
    const calls = got.steps.filter((s) => s.kind === "tool_call").map((s) => String(s.payload.toolName));
    const fin = got.steps.find((s) => s.kind === "note" && s.payload.type === "loop_finished")?.payload;
    const unavailable = got.steps.find((s) => s.kind === "note" && s.payload.type === "ai_unavailable")?.payload;
    const valNotes = got.steps.filter((s) => s.kind === "validation").map((s) => JSON.stringify(s.payload).slice(0, 200));
    console.log(`\n[agent] status=${run.status} planSource=${run.planSource} plans=${run.plans.length} note=${run.note ?? "-"} error=${run.error ?? "-"}`);
    console.log(`  loop: steps=${String(fin?.steps ?? "-")} toolCalls=${calls.length} stopped=${String(fin?.stopped ?? "-")}; tools: ${calls.join(" > ")}`);
    if (unavailable) console.log(`  AI path unavailable: ${JSON.stringify(unavailable)}`);
    for (const v of valNotes) console.log(`  validation: ${v}`);
    const base = sampleOrderEvents(asOf);
    const indep = (levers: Lever[]) => {
      const ch: TermChanges = { invoiceFinance: undefined };
      for (const l of levers) {
        if (l.kind === "supplier_reduce_deposit") ch.supplierDepositBps = l.percentBps;
        if (l.kind === "supplier_defer_balance") ch.supplierBalanceDeferralDays = l.daysAfterShipment;
        if (l.kind === "buyer_request_deposit") ch.buyerDepositBps = l.percentBps;
        if (l.kind === "finance_invoice") ch.invoiceFinance = { advanceBps: l.advanceBps, feeBps: 200 };
      }
      const f = buildForecast(ctx.input, { events: applyTermChanges(base, ch), horizonWeeks: 20 });
      return { min: f.minimum.amount.toString(), week: f.minimum.weekIndex + 1, neg: f.weeksBelowZero.length ? f.weeksBelowZero[0] + 1 : null, closing: f.weeks[19].closing.toString() };
    };
    const planSummary = run.plans.map((p) => {
      const r = indep(p.levers);
      const match = p.metrics.minBalanceMinor === r.min && p.metrics.minBalanceWeek === r.week && p.metrics.firstNegativeWeek === r.neg && p.metrics.closingAtHorizonMinor === r.closing;
      console.log(`  plan [${p.source}${p.proseFlagged ? ", prose flagged" : ""}] ${p.title.slice(0, 80)}\n    lowest ${gbp(p.metrics.minBalanceMinor)} wk ${p.metrics.minBalanceWeek}, closing ${gbp(p.metrics.closingAtHorizonMinor)}, cost ${gbp(p.metrics.totalCostMinor)}; metrics equal independent engine recomputation: ${match}`);
      return { title: p.title, source: p.source, levers: p.levers, metrics: p.metrics, rationale: p.rationale, proseFlagged: p.proseFlagged, match };
    });
    state[`${phase}_agent`] = { status: run.status, planSource: run.planSource, plans: planSummary, tools: calls };

    // ---------- telemetry ----------
    const rows = await db.select().from(S.llmCalls).where(eq(S.llmCalls.businessId, bizId!)).orderBy(asc(S.llmCalls.createdAt));
    const sum = (k: "promptTokens" | "completionTokens") => rows.filter((r) => r.mode === "record" || r.mode === "live").reduce((a, r) => a + (r[k] ?? 0), 0);
    console.log(`\n[llm_calls for this clone] rows=${rows.length}; by mode: ${JSON.stringify(rows.reduce<Record<string, number>>((a, r) => ((a[r.mode] = (a[r.mode] ?? 0) + 1), a), {}))}; live/record prompt tokens=${sum("promptTokens")} completion tokens=${sum("completionTokens")}`);
    void inArray;

    if (phase === "replay") {
      const rec = state.record_extraction as { extractionSummary: unknown[]; same: boolean };
      const recAgent = state.record_agent as { status: string; planSource: string; plans: unknown[] };
      const cur = state.replay_extraction as { extractionSummary: unknown[]; same: boolean };
      const curAgent = state.replay_agent as { status: string; planSource: string; plans: unknown[] };
      console.log(`\n[replay] extraction identical to the recorded run: ${JSON.stringify(rec.extractionSummary) === JSON.stringify(cur.extractionSummary)}`);
      console.log(`[replay] agent status/source/plans identical to the recorded run: ${JSON.stringify({ s: recAgent.status, p: recAgent.planSource, pl: recAgent.plans }) === JSON.stringify({ s: curAgent.status, p: curAgent.planSource, pl: curAgent.plans })}`);
    }
    writeFileSync(statePath, JSON.stringify(state, null, 1));
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
