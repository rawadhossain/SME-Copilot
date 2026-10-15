// Live confirmation for Batch 8b (not part of check:*). One full story with the REAL model, on a clone flagged is_test:
//   plan (model) -> owner signs -> negotiation hits the buyer's 10% cap -> needs re-plan (structured constraint) -> re-plan (model)
//   -> owner signs the NEW plan -> execute (receipts, payments, finance take-up) -> verify.
// Only the two planning runs call the model; documents use the mock provider. Budget: first run at most 6 loop steps, re-plan at most 4.
//   record:  LLM_MODE=record LLM_RECORDINGS_DIR=fixtures/llm-recordings-live bun --env-file=.env scripts/live-plan.ts record <state.json>
//   replay:  LLM_MODE=replay LLM_RECORDINGS_DIR=fixtures/llm-recordings-live LLM_API_KEY= bun --env-file=.env scripts/live-plan.ts replay <state.json>
// The demo business is only read. Never prints the key.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGateway, describeConfig, readConfig, RECORDINGS_DIR, type GatewayConfig } from "../src/ai";
import { signMandate } from "../src/gate/owner-signing";

const [phase, statePath] = [process.argv[2], process.argv[3]];
assert.ok((phase === "record" || phase === "replay") && statePath, "usage: live-plan.ts record|replay <state.json>");
const cfg = readConfig();
console.log(`phase=${phase}`, JSON.stringify(describeConfig(cfg)));
if (phase === "record") assert.ok(cfg.mode === "record" && cfg.provider === "openai-compatible" && cfg.apiKey, "record needs LLM_MODE=record and a configured provider");
else assert.ok(cfg.mode === "replay" && !cfg.apiKey, "replay must run with LLM_MODE=replay and NO api key");
const realGw = createGateway(cfg);
const mockCfg: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };
const mockGw = createGateway(mockCfg);
const read = (f: string) => readFileSync(`fixtures/${f}`, "utf8");
const state: Record<string, unknown> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const FIRST_LIMITS = { maxSteps: 6 };
// FIRST_PLAN=deterministic: the first plan comes from the deterministic planner (no model call), so the budget goes to the re-plan.
const FIRST_DETERMINISTIC = process.env.FIRST_PLAN === "deterministic";
const REPLAN_LIMITS = { maxSteps: 4 };

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const { startRun } = await import("../src/actions/agent-run");
  const { authorisePlan } = await import("../src/actions/plan-authorise");
  const { executePlan } = await import("../src/actions/plan-exec");
  const { verifyPlanExecution } = await import("../src/actions/plan-verify");
  const { replanFromExecution } = await import("../src/actions/replan");
  const { getPlanAuthorisation } = await import("../src/actions/plan-read");
  const summarise = (plans: { id: string; source: string; levers: { kind: string }[]; metrics: { minBalanceMinor: string; totalCostMinor: string } }[]) =>
    plans.map((p) => ({ id: p.id, source: p.source, levers: p.levers.map((l) => l.kind), minBalance: p.metrics.minBalanceMinor, cost: p.metrics.totalCostMinor }));
  try {
    let bizId = state.businessId as string | undefined;
    let quoteId = state.quoteId as string | undefined;
    if (phase === "record") {
      assert.ok(!bizId, "state file already has a clone; delete it to start over");
      const demoId = await getDefaultBusinessId();
      assert.ok(demoId);
      const [src] = await db.select().from(S.businesses).where(eq(S.businesses.id, demoId!));
      const [biz] = await db.insert(S.businesses).values({ name: `Agent Live Plan ${Date.now().toString(36)} (SYNTHETIC)`, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true }).returning();
      const omit = <T extends { id: string; businessId: string }>(r: T) => { const { id: _i, businessId: _b, ...rest } = r; void _i; void _b; return rest; };
      for (const a of await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, demoId!))) await db.insert(S.financialAccounts).values({ ...omit(a), businessId: biz.id });
      const idMap = new Map<string, string>();
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, demoId!))) { const [n] = await db.insert(S.counterparties).values({ ...omit(c), businessId: biz.id }).returning(); idMap.set(c.id, n.id); }
      for (const i of await db.select().from(S.invoices).where(eq(S.invoices.businessId, demoId!))) await db.insert(S.invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
      for (const b of await db.select().from(S.bills).where(eq(S.bills.businessId, demoId!))) await db.insert(S.bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
      for (const c of await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, demoId!))) await db.insert(S.recurringCommitments).values({ ...omit(c), businessId: biz.id });
      const [m] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, demoId!), eq(S.mandates.active, true)));
      const wire = JSON.parse(m.canonical);
      wire.limits.maxPaymentMinor = "8000000"; // demo limits as in the seed after Batch 8b (ADR-019)
      wire.limits.maxDailyOutflowMinor = "8500000";
      const signed = signMandate({ ...wire, businessId: biz.id });
      await db.insert(S.mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
      for (const b of await db.select().from(S.sandboxBankAccounts).where(eq(S.sandboxBankAccounts.businessId, demoId!))) await db.insert(S.sandboxBankAccounts).values({ ...omit(b), businessId: biz.id });
      for (const py of await db.select().from(S.sandboxPayees).where(eq(S.sandboxPayees.businessId, demoId!))) await db.insert(S.sandboxPayees).values({ ...omit(py), businessId: biz.id, counterpartyId: py.counterpartyId ? idMap.get(py.counterpartyId)! : null });
      bizId = biz.id;
      // Documents are read by the MOCK provider (no live call); the confirmed events equal the hand-built sample (Batch 6).
      for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
        const r = await docs.createDocumentAndExtract(db, biz.id, { filename, kind, text: read(filename) }, { gateway: mockGw });
        await confirmExtraction(db, r.extraction.id, "Test Owner");
        if (kind === "supplier_quote") quoteId = r.extraction.id;
      }
      state.businessId = bizId;
      state.quoteId = quoteId;
      writeFileSync(statePath, JSON.stringify(state, null, 1));
    }
    assert.ok(bizId && quoteId, "no clone in the state file; run record first");
    const trigger = { type: "commitment" as const, extractionId: quoteId! };

    // ---------- first planning run ----------
    const run1 = await startRun(db, bizId!, trigger, { gateway: realGw, limits: FIRST_LIMITS, forceFallback: FIRST_DETERMINISTIC });
    assert.equal(run1.status, "completed", run1.error ?? "");
    console.log(`  run 1: source=${run1.planSource} plans=${run1.plans.length}`);
    for (const p of summarise(run1.plans)) console.log(`    ${p.id} ${p.source} [${p.levers.join(", ")}] lowest ${p.minBalance} cost ${p.cost}`);
    state[`${phase}_run1`] = summarise(run1.plans);

    if (phase === "record") {
      const chosen1 = run1.plans[0];
      const auth1 = await authorisePlan(db, bizId!, { runId: run1.runId, planId: chosen1.id, confirmations: 2 }, "Test Owner");
      assert.equal(auth1.status, "authorised");
      const exec1 = await executePlan(db, auth1.authorisationId);
      console.log(`  attempt 1 [${chosen1.levers.map((l) => l.kind).join(", ")}]: ${exec1.status}; branches ${exec1.outcome.branches.map((b) => `${b.kind}:${b.status}`).join(" ")}`);
      console.log(`    constraints learned (structured): ${JSON.stringify(exec1.outcome.constraints.map((c) => ({ kind: c.kind, excluded: c.excluded, maxPercentBps: c.maxPercentBps, minPercentBps: c.minPercentBps, maxDays: c.maxDays, assumedFeeBps: c.assumedFeeBps })))}`);
      state.record_exec1 = { authorisationId: auth1.authorisationId, status: exec1.status, constraints: exec1.outcome.constraints, verification: exec1.verification ? { ok: exec1.verification.ok, metrics: exec1.verification.metrics, promiseVsAgreed: exec1.verification.promiseVsAgreed } : null };
      if (exec1.status !== "needs_replan") {
        // The model's plan needed no re-plan: report it and stop (the re-plan story is run with FIRST_PLAN=deterministic).
        console.log(`    scheduled: ${exec1.outcome.scheduled.map((x) => `${x.kind} ${x.amountMinor} on ${x.date}`).join("; ") || "none"}`);
        if (exec1.verification) {
          for (const m of exec1.verification.metrics) console.log(`    ${m.name}: expected ${m.promised} recomputed ${m.actual} diff ${m.difference} ${m.ok ? "ok" : "MISMATCH"}`);
          console.log(`    schedule check: ${exec1.verification.schedule.ok ? "ok" : exec1.verification.schedule.problems.join("; ")}; promise vs agreed: ${exec1.verification.promiseVsAgreed.label}`);
        }
        writeFileSync(statePath, JSON.stringify(state, null, 1));
        return;
      }

      // ---------- re-plan (model, at most 4 loop steps) ----------
      const rp = await replanFromExecution(db, auth1.authorisationId, { gateway: realGw, limits: REPLAN_LIMITS });
      console.log(`  re-plan: ${rp.status}, round ${rp.round}, new run ${rp.newRunId}, ${rp.plans.length} plans, note: ${rp.note ?? "-"}`);
      for (const p of summarise(rp.plans)) console.log(`    ${p.id} ${p.source} [${p.levers.join(", ")}] lowest ${p.minBalance} cost ${p.cost}`);
      state.record_replan = { status: rp.status, plans: summarise(rp.plans), constraints: rp.constraints, newRunId: rp.newRunId };
      assert.equal(rp.status, "replanned", rp.message ?? "");

      // ---------- NEW owner authorisation, execute, verify ----------
      const chosen2 = rp.plans[0];
      const auth2 = await authorisePlan(db, bizId!, { runId: rp.newRunId!, planId: chosen2.id, confirmations: 2 }, "Test Owner");
      assert.equal(auth2.status, "authorised", JSON.stringify(auth2.problems));
      const exec2 = await executePlan(db, auth2.authorisationId);
      console.log(`  attempt 2 [${chosen2.levers.map((l) => `${l.kind}`).join(", ")}]: ${exec2.status}; branches ${exec2.outcome.branches.map((b) => `${b.kind}:${b.status}${b.agreedTerms ? JSON.stringify(b.agreedTerms) : ""}`).join(" ")}`);
      console.log(`    scheduled: ${exec2.outcome.scheduled.map((x) => `${x.kind} ${x.amountMinor} on ${x.date}`).join("; ") || "none"}`);
      const v = exec2.verification;
      if (v) {
        for (const m of v.metrics) console.log(`    ${m.name}: expected ${m.promised} recomputed ${m.actual} diff ${m.difference} ${m.ok ? "ok" : "MISMATCH"}`);
        console.log(`    schedule check: ${v.schedule.ok ? "ok" : v.schedule.problems.join("; ")}; promise vs agreed: ${v.promiseVsAgreed.label}`);
        if (!v.ok) console.log(`    explanation: ${v.explanation.join(" | ")}`);
      } else console.log(`    no verification: ${JSON.stringify(exec2.outcome.failure ?? null)}`);
      const view = (await getPlanAuthorisation(db, auth1.authorisationId)) as { run: { lifecycle: string; successorRunId: string | null } };
      console.log(`  run status API: first run ${view.run.lifecycle}, successor ${view.run.successorRunId}`);
      state.record_exec2 = { authorisationId: auth2.authorisationId, planId: chosen2.id, status: exec2.status, verification: v ? { ok: v.ok, metrics: v.metrics, promiseVsAgreed: v.promiseVsAgreed } : null };
    } else {
      if (state.record_run1) assert.deepEqual(state.replay_run1, state.record_run1, "replayed first-run plans differ from the recorded ones");
      console.log("  replay: first-run plans identical to the recorded run");
      if (!state.record_replan) {
        // Story without a re-plan: re-verify whatever was executed on this business, from the sandbox state.
        const execs = await db.select().from(S.planExecutions).where(eq(S.planExecutions.businessId, bizId!));
        for (const x of execs) {
          const v = await verifyPlanExecution(db, x.authorisationId);
          console.log(`  replay: stored execution ${x.status}; re-verification ok=${v.ok}; ${v.promiseVsAgreed.label}`);
          const rec = state.record_exec1 as { verification: { ok: boolean; metrics: unknown } | null } | undefined;
          if (rec?.verification) assert.deepEqual({ ok: v.ok, metrics: v.metrics }, { ok: rec.verification.ok, metrics: rec.verification.metrics });
        }
        const rows0 = await db.select().from(S.llmCalls).where(eq(S.llmCalls.businessId, bizId!));
        assert.equal(rows0.filter((r) => r.mode === "live").length, 0, "replay must make zero live calls");
        console.log(`  llm_calls for this clone: ${rows0.length} rows; zero live`);
        return;
      }
      const rp = state.record_replan as { plans: unknown; constraints: unknown[]; newRunId: string };
      // The re-plan request is replayed directly (the stored re-plan is idempotent and would not call the model again).
      const [child] = await db.select().from(S.agentRuns).where(eq(S.agentRuns.id, rp.newRunId));
      const again = await startRun(db, bizId!, trigger, { gateway: realGw, limits: REPLAN_LIMITS, replan: { parentRunId: child.parentRunId!, round: child.round, constraints: child.constraints as never } });
      assert.deepEqual(summarise(again.plans), rp.plans, "replayed re-plan differs from the recorded one");
      console.log("  replay: re-plan identical to the recorded one (same constraints in, same plans out)");
      const e1 = state.record_exec1 as { authorisationId: string; status: string };
      const e2 = state.record_exec2 as { authorisationId: string; status: string; verification: { ok: boolean; metrics: unknown; promiseVsAgreed: unknown } | null };
      await assert.rejects(executePlan(db, e1.authorisationId), /already used/);
      await assert.rejects(executePlan(db, e2.authorisationId), /already used/);
      const [r1] = await db.select().from(S.planExecutions).where(eq(S.planExecutions.authorisationId, e1.authorisationId));
      const [r2] = await db.select().from(S.planExecutions).where(eq(S.planExecutions.authorisationId, e2.authorisationId));
      assert.equal(r1.status, e1.status);
      assert.equal(r2.status, e2.status);
      const v = await verifyPlanExecution(db, e2.authorisationId);
      assert.deepEqual({ ok: v.ok, metrics: v.metrics, promiseVsAgreed: v.promiseVsAgreed }, e2.verification, "re-verification differs from the recorded one");
      console.log(`  replay: both executions refused a second time; stored statuses (${r1.status}, ${r2.status}) and the re-verification (ok=${v.ok}) identical`);
    }
    const callsRows = await db.select().from(S.llmCalls).where(eq(S.llmCalls.businessId, bizId!));
    const byMode = callsRows.reduce<Record<string, number>>((a, r) => ((a[r.mode] = (a[r.mode] ?? 0) + 1), a), {});
    console.log(`  llm_calls for this clone: ${callsRows.length} rows; by mode ${JSON.stringify(byMode)}`);
    if (phase === "replay") assert.equal(byMode.live ?? 0, 0, "replay must make zero live calls");
    writeFileSync(statePath, JSON.stringify(state, null, 1));
  } finally {
    await sql.end();
  }
}
await main();
