// Live confirmation for Batch 9 (not part of check:*). On a CLONE flagged is_test of the demo business:
//   a commitment is confirmed -> the deterministic detector flags a shortage -> the REAL model plans (read-only) -> the owner signs ->
//   negotiation, scheduling, execution -> independent verification -> scoreboard.
// Only the planning run calls the model (budget: at most 6 loop steps; a re-plan, if the counterparties refuse, at most 4). Documents use the mock provider.
//   record:  LLM_MODE=record LLM_RECORDINGS_DIR=fixtures/llm-recordings-live bun --env-file=.env scripts/live-shortage.ts record <state.json>
//   replay:  LLM_MODE=replay LLM_RECORDINGS_DIR=fixtures/llm-recordings-live LLM_API_KEY= bun --env-file=.env scripts/live-shortage.ts replay <state.json>
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGateway, describeConfig, readConfig, RECORDINGS_DIR, type GatewayConfig } from "../src/ai";
import { signMandate } from "../src/gate/owner-signing";

const [phase, statePath] = [process.argv[2], process.argv[3]];
assert.ok((phase === "record" || phase === "replay") && statePath, "usage: live-shortage.ts record|replay <state.json>");
const cfg = readConfig();
console.log(`phase=${phase}`, JSON.stringify(describeConfig(cfg)));
const REHEARSAL = process.env.REHEARSAL === "1"; // mock provider + deterministic planner: rehearses the whole flow with no live call
if (REHEARSAL) console.log("REHEARSAL: no live calls");
else if (phase === "record") assert.ok(cfg.mode === "record" && cfg.provider === "openai-compatible" && cfg.apiKey, "record needs LLM_MODE=record and a configured provider");
else assert.ok(cfg.mode === "replay" && !cfg.apiKey, "replay must run with LLM_MODE=replay and NO api key");
const realGw0 = REHEARSAL ? null : createGateway(cfg);
const mockGw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR } as GatewayConfig);
const realGw = (REHEARSAL ? mockGw : realGw0)!;
const RO = REHEARSAL ? { forceFallback: true } : {};
const read = (f: string) => readFileSync(`fixtures/${f}`, "utf8");
const state: Record<string, unknown> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const FIRST_LIMITS = { maxSteps: 6 };
const REPLAN_LIMITS = { maxSteps: 4 };

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const { startRun } = await import("../src/actions/agent-run");
  const { checkShortage } = await import("../src/actions/shortage");
  const { authorisePlan } = await import("../src/actions/plan-authorise");
  const { executePlan } = await import("../src/actions/plan-exec");
  const { verifyPlanExecution } = await import("../src/actions/plan-verify");
  const { replanFromExecution } = await import("../src/actions/replan");
  const { getScoreboard } = await import("../src/actions/scoreboard");
  const summarise = (plans: { id: string; source: string; levers: { kind: string }[]; metrics: { minBalanceMinor: string; totalCostMinor: string; firstNegativeWeek: number | null } }[]) =>
    plans.map((p) => ({ id: p.id, source: p.source, levers: p.levers.map((l) => l.kind), minBalance: p.metrics.minBalanceMinor, cost: p.metrics.totalCostMinor, firstNegativeWeek: p.metrics.firstNegativeWeek }));
  const NEW_LEVERS = ["chase_overdue", "early_payment_discount"];
  try {
    let bizId = state.businessId as string | undefined;
    if (phase === "record") {
      assert.ok(!bizId, "state file already has a clone; delete it to start over");
      const demoId = await getDefaultBusinessId();
      assert.ok(demoId);
      const [src] = await db.select().from(S.businesses).where(eq(S.businesses.id, demoId!));
      const [biz] = await db.insert(S.businesses).values({ name: `Agent Live Shortage ${Date.now().toString(36)} (SYNTHETIC)`, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true }).returning();
      const omit = <T extends { id: string; businessId: string }>(r: T) => { const { id: _i, businessId: _b, ...rest } = r; void _i; void _b; return rest; };
      for (const a of await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, demoId!))) await db.insert(S.financialAccounts).values({ ...omit(a), businessId: biz.id });
      const idMap = new Map<string, string>();
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, demoId!))) { const [n] = await db.insert(S.counterparties).values({ ...omit(c), businessId: biz.id }).returning(); idMap.set(c.id, n.id); }
      for (const i of await db.select().from(S.invoices).where(eq(S.invoices.businessId, demoId!))) await db.insert(S.invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
      for (const b of await db.select().from(S.bills).where(eq(S.bills.businessId, demoId!))) await db.insert(S.bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
      for (const c of await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, demoId!))) await db.insert(S.recurringCommitments).values({ ...omit(c), businessId: biz.id });
      const [m] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, demoId!), eq(S.mandates.active, true)));
      const wire = JSON.parse(m.canonical);
      wire.version = 1; // the clone has its own history; limits and kinds are the demo's mandate v2 as signed
      const signed = signMandate({ ...wire, businessId: biz.id });
      await db.insert(S.mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
      for (const b of await db.select().from(S.sandboxBankAccounts).where(eq(S.sandboxBankAccounts.businessId, demoId!))) await db.insert(S.sandboxBankAccounts).values({ ...omit(b), businessId: biz.id });
      for (const py of await db.select().from(S.sandboxPayees).where(eq(S.sandboxPayees.businessId, demoId!))) await db.insert(S.sandboxPayees).values({ ...omit(py), businessId: biz.id, counterpartyId: py.counterpartyId ? idMap.get(py.counterpartyId)! : null });
      bizId = biz.id;
      state.businessId = bizId;
      writeFileSync(statePath, JSON.stringify(state, null, 1));
      // The new commitment: both documents are read by the MOCK provider (no live call) and confirmed by the owner.
      for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
        const r = await docs.createDocumentAndExtract(db, biz.id, { filename, kind, text: read(filename) }, { gateway: mockGw });
        await confirmExtraction(db, r.extraction.id, "Test Owner");
      }
    }
    assert.ok(bizId, "no clone in the state file; run record first");

    if (phase === "record") {
      // ---------- detect + plan (the only model calls) ----------
      const chk = await checkShortage(db, bizId!, { source: "commitment_confirmed" }, { gateway: realGw, limits: FIRST_LIMITS, ...RO });
      assert.equal(chk.status, "planned");
      const reason = chk.detection.reason!;
      console.log(`  shortage: ${reason.kind}; lowest ${reason.minBalanceMinor} in week ${reason.minBalanceWeek}; first negative week ${reason.firstNegativeWeek}; reserve ${reason.reserveMinor}; hash ${reason.forecastHash.slice(0, 12)}`);
      const run = chk.run!;
      console.log(`  plans: source=${run.planSource} count=${run.plans.length}`);
      for (const p of summarise(run.plans)) console.log(`    ${p.id} ${p.source} [${p.levers.join(", ")}] lowest ${p.minBalance} cost ${p.cost} firstNeg ${p.firstNegativeWeek}`);
      const again = await checkShortage(db, bizId!, { source: "api" }, { gateway: realGw, ...RO });
      assert.equal(again.status, "existing_run", "the same shortage does not create a second run");
      console.log("  same shortage checked again: existing run, no second planning call");
      state.record_shortage = { runId: run.runId, trigger: { type: "shortage", variant: reason.variant, reason }, plans: summarise(run.plans) };

      // Harness choice (disclosed): prefer a plan that uses one of the new levers, so the live run exercises them.
      const chosen = run.plans.find((p) => p.levers.some((l) => NEW_LEVERS.includes(l.kind))) ?? run.plans[0];
      console.log(`  chosen plan ${chosen.id} [${chosen.levers.map((l) => l.kind).join(", ")}]${chosen.levers.some((l) => NEW_LEVERS.includes(l.kind)) ? " (uses a new lever)" : " (no plan used a new lever)"}`);
      let auth = await authorisePlan(db, bizId!, { runId: run.runId, planId: chosen.id, confirmations: 2 }, "Test Owner");
      assert.equal(auth.status, "authorised", JSON.stringify(auth.problems));
      let exec = await executePlan(db, auth.authorisationId);
      console.log(`  attempt 1: ${exec.status}; branches ${exec.outcome.branches.map((b) => `${b.kind}:${b.status}${b.agreedTerms ? JSON.stringify(b.agreedTerms) : ""}`).join(" ")}`);
      const attempts = [{ authorisationId: auth.authorisationId, status: exec.status }];
      if (exec.status === "needs_replan") {
        const rp = await replanFromExecution(db, auth.authorisationId, { gateway: realGw, limits: REPLAN_LIMITS, ...RO });
        console.log(`  re-plan: ${rp.status}, ${rp.plans.length} plans, constraints ${JSON.stringify(rp.constraints.map((c) => ({ kind: c.kind, excluded: c.excluded, minDays: c.minDays, minDiscountBps: c.minDiscountBps, maxPercentBps: c.maxPercentBps })))}`);
        state.record_replan = { newRunId: rp.newRunId, plans: summarise(rp.plans) };
        assert.equal(rp.status, "replanned");
        auth = await authorisePlan(db, bizId!, { runId: rp.newRunId!, planId: rp.plans[0].id, confirmations: 2 }, "Test Owner");
        assert.equal(auth.status, "authorised", JSON.stringify(auth.problems));
        exec = await executePlan(db, auth.authorisationId);
        console.log(`  attempt 2: ${exec.status}; branches ${exec.outcome.branches.map((b) => `${b.kind}:${b.status}${b.agreedTerms ? JSON.stringify(b.agreedTerms) : ""}`).join(" ")}`);
        attempts.push({ authorisationId: auth.authorisationId, status: exec.status });
      }
      console.log(`    scheduled: ${exec.outcome.scheduled.map((x) => `${x.kind} ${x.amountMinor} on ${x.date}`).join("; ") || "none"}`);
      const v = exec.verification;
      if (v) {
        for (const m of v.metrics) console.log(`    ${m.name}: expected ${m.promised} recomputed ${m.actual} diff ${m.difference} ${m.ok ? "ok" : "MISMATCH"}`);
        console.log(`    schedule check: ${v.schedule.ok ? "ok" : v.schedule.problems.join("; ")}; promise vs agreed: ${v.promiseVsAgreed.label}`);
        if (!v.ok) console.log(`    explanation: ${v.explanation.join(" | ")}`);
      }
      state.record_attempts = attempts;
      state.record_verification = v ? { ok: v.ok, metrics: v.metrics, promiseVsAgreed: v.promiseVsAgreed, agreedOutcome: v.agreedOutcome } : null;
      const sb = (await getScoreboard(db, bizId!)) as { summary: unknown; entries: unknown[] };
      console.log(`  scoreboard: ${JSON.stringify(sb.summary)}`);
      console.log(`    entry: ${JSON.stringify((sb.entries[0] as { label: string; doNothing: unknown; executedPlan: unknown; lowestBalanceImprovementMinor: unknown; ownerApprovals: unknown; deniedOrBlocked: unknown }))}`);
      state.record_scoreboard = sb;
    } else {
      const rec = state.record_shortage as { trigger: never; plans: unknown };
      const again = await startRun(db, bizId!, rec.trigger, { gateway: realGw, limits: FIRST_LIMITS, ...RO });
      assert.deepEqual(summarise(again.plans), rec.plans, "replayed plans differ from the recorded ones");
      console.log("  replay: the shortage planning run replays to identical plans (ids, levers, metrics)");
      const attempts = state.record_attempts as { authorisationId: string; status: string }[];
      for (const a of attempts) {
        await assert.rejects(executePlan(db, a.authorisationId), /already used/);
        const [row] = await db.select().from(S.planExecutions).where(eq(S.planExecutions.authorisationId, a.authorisationId));
        assert.equal(row.status, a.status);
      }
      const recV = state.record_verification as { ok: boolean; metrics: unknown; promiseVsAgreed: unknown; agreedOutcome: unknown } | null;
      if (recV) {
        const v = await verifyPlanExecution(db, attempts[attempts.length - 1].authorisationId);
        assert.deepEqual({ ok: v.ok, metrics: v.metrics, promiseVsAgreed: v.promiseVsAgreed, agreedOutcome: v.agreedOutcome }, recV, "re-verification differs from the recorded one");
        console.log(`  replay: executions refused a second time; stored statuses and the re-verification (ok=${v.ok}) identical`);
      }
      const sb = (await getScoreboard(db, bizId!)) as { entries: unknown[] };
      const recSb = state.record_scoreboard as { entries: unknown[] };
      assert.equal(JSON.stringify((sb.entries[0] as { executedPlan: unknown }).executedPlan), JSON.stringify((recSb.entries[0] as { executedPlan: unknown }).executedPlan));
      console.log("  replay: scoreboard executed-plan numbers identical");
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
