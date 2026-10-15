// Sanity checks for the planning agent (not a test suite). Run: bun run check:agent
// Everything uses the scripted mock provider; no live model is called. The checks run on COPIES of the demo business
// ("Agent Sanity ..."), so the demo data is only read, never changed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, RECORDINGS_DIR, type GatewayConfig } from "../src/ai";
import { planId, type Lever } from "../src/domain/plan";
import { applyTermChanges, buildForecast, type TermChanges } from "../src/engine";
import { searchPlans, simulateLevers } from "../src/engine/plans";
import { sampleOrderEvents } from "../src/engine/samples/grocery-order";
import { signMandate } from "../src/gate/owner-signing";
import { buildAgentTools, guardRanking, BAD_AGENT_PURPOSE, WEAK_AGENT_PURPOSE } from "../src/agent";
import { checkProse } from "../src/agent/prose";
import { formatMoney, money } from "../src/lib/money";

const gbp = (minor: string | bigint) => formatMoney(money(BigInt(minor), "GBP"), 2);
const base: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };
const mockGw = createGateway(base);
const read = (f: string) => readFileSync(join("fixtures", f), "utf8");

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq, sql: dsql } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  const { startRun, buildContext, getRun } = await import("../src/actions/agent-run");
  try {
    const demoId = await getDefaultBusinessId();
    assert.ok(demoId, "run bun run db:seed first");
    const run = Date.now().toString(36);

    // ---------- helpers: clone the demo business so tests never touch the demo ----------
    async function clone(name: string) {
      const [src] = await db.select().from(S.businesses).where(eq(S.businesses.id, demoId!));
      const [biz] = await db.insert(S.businesses).values({ name, baseCurrency: src.baseCurrency, reserveMinor: src.reserveMinor, reserveCurrency: src.reserveCurrency, isSynthetic: true, isTest: true }).returning();
      const omit = <T extends { id: string; businessId: string }>(r: T) => {
        const { id: _id, businessId: _b, ...rest } = r;
        void _id; void _b;
        return rest;
      };
      for (const a of await db.select().from(S.financialAccounts).where(eq(S.financialAccounts.businessId, demoId!))) await db.insert(S.financialAccounts).values({ ...omit(a), businessId: biz.id });
      const idMap = new Map<string, string>();
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, demoId!))) {
        const [n] = await db.insert(S.counterparties).values({ ...omit(c), businessId: biz.id }).returning();
        idMap.set(c.id, n.id);
      }
      for (const i of await db.select().from(S.invoices).where(eq(S.invoices.businessId, demoId!))) await db.insert(S.invoices).values({ ...omit(i), businessId: biz.id, customerId: idMap.get(i.customerId)! });
      for (const b of await db.select().from(S.bills).where(eq(S.bills.businessId, demoId!))) await db.insert(S.bills).values({ ...omit(b), businessId: biz.id, supplierId: idMap.get(b.supplierId)! });
      for (const c of await db.select().from(S.recurringCommitments).where(eq(S.recurringCommitments.businessId, demoId!))) await db.insert(S.recurringCommitments).values({ ...omit(c), businessId: biz.id });
      const [m] = await db.select().from(S.mandates).where(and(eq(S.mandates.businessId, demoId!), eq(S.mandates.active, true)));
      const wire = { ...JSON.parse(m.canonical), businessId: biz.id };
      const signed = signMandate(wire);
      await db.insert(S.mandates).values({ businessId: biz.id, version: 1, canonical: signed.canonical, signature: signed.signature, active: true });
      return biz;
    }
    async function addConfirmed(bizId: string, filename: string, kind: "purchase_order" | "supplier_quote", text: string) {
      const r = await docs.createDocumentAndExtract(db, bizId, { filename, kind, text }, { gateway: mockGw });
      assert.equal(r.extraction.status, "pending_confirmation");
      await confirmExtraction(db, r.extraction.id, "Test Owner");
      return r.extraction.id;
    }
    const counts = async (bizId: string) => {
      const n = async (t: string) => Number((await db.execute(dsql.raw(`select count(*)::int as n from ${t} where business_id = '${bizId}'`)))[0].n);
      return { proposals: await n("action_proposals"), approvals: await n("approvals"), payments: await n("sandbox_payments"), threads: await n("sandbox_threads"), applications: await n("sandbox_applications"), messages: await n("sandbox_messages") };
    };

    const A = await clone(`Agent Sanity A ${run} (SYNTHETIC)`);
    const quoteId = await addConfirmed(A.id, "supplier-quote-kestrel.md", "supplier_quote", read("supplier-quote-kestrel.md"));
    await addConfirmed(A.id, "purchase-order-northgate.md", "purchase_order", read("purchase-order-northgate.md"));
    const before = await counts(A.id);

    // ---------- 1. Lever regression: the six Batch 4 lever scenarios through simulateLevers ----------
    const ctx0 = await buildContext(db, A.id, quoteId);
    const asOf = ctx0.asOf;
    const sample = sampleOrderEvents(asOf);
    const fake = "aaaaaaaa-0000-4000-8000-0000000000aa";
    const L = (kind: Lever["kind"], v: number): Lever =>
      kind === "supplier_defer_balance" ? { kind, counterpartyId: fake, daysAfterShipment: v } : kind === "finance_invoice" ? { kind, counterpartyId: fake, advanceBps: v } : kind === "supplier_reduce_deposit" ? { kind, counterpartyId: fake, percentBps: v } : { kind: "buyer_request_deposit", counterpartyId: fake, percentBps: v };
    const regression: [string, Lever[], string, number | null][] = [
      ["no change", [], "-6122714", 5],
      ["supplier deposit 15%", [L("supplier_reduce_deposit", 1500)], "-6122714", 5],
      ["balance deferred 30 days", [L("supplier_defer_balance", 30)], "-6122714", 9],
      ["buyer deposit 20%", [L("buyer_request_deposit", 2000)], "-2522714", 9],
      ["buyer deposit 20% + deferral 30", [L("buyer_request_deposit", 2000), L("supplier_defer_balance", 30)], "-2522714", 9],
      ["invoice finance 80%", [L("finance_invoice", 8000)], "-98212", 5],
    ];
    for (const [name, levers, min, firstNeg] of regression) {
      const r = simulateLevers(ctx0.input, sample, levers, { horizonWeeks: 13 });
      assert.equal(r.metrics.minBalanceMinor, min, `regression ${name}`);
      assert.equal(r.metrics.firstNegativeWeek, firstNeg, `regression ${name} first negative week`);
    }
    console.log("  regression: the six Batch 4 lever scenarios give identical numbers through simulateLevers");

    // ---------- 2. Deterministic search: ranked list and determinism ----------
    const b = (await import("../src/agent")).leverBounds(ctx0);
    const sOpts = { horizonWeeks: 20, financeCapBps: b.finance_invoice.advanceBps.max, topN: 6 };
    const s1 = searchPlans(ctx0.input, sample, ctx0.parties, sOpts);
    const s2 = searchPlans(ctx0.input, sample, ctx0.parties, sOpts);
    assert.deepEqual(s1.ranked.map((p) => [p.id, p.metrics]), s2.ranked.map((p) => [p.id, p.metrics]), "search is deterministic");
    assert.ok(s1.ranked.length > 0 && s1.pareto.length > 0);
    console.log(`  search: ${s1.evaluated} combinations; do nothing = lowest ${gbp(s1.baseline.metrics.minBalanceMinor)} (week ${s1.baseline.metrics.minBalanceWeek}), first negative week ${s1.baseline.metrics.firstNegativeWeek}`);
    s1.ranked.forEach((p, i) => console.log(`    #${i + 1} ${p.levers.map((l) => l.kind.replace(/_/g, " ") + " " + ("percentBps" in l ? l.percentBps / 100 + "%" : "daysAfterShipment" in l ? l.daysAfterShipment + "d" : "advanceBps" in l ? l.advanceBps / 100 + "%" : l.kind)).join(" + ")}: lowest ${gbp(p.metrics.minBalanceMinor)} wk ${p.metrics.minBalanceWeek}, first negative wk ${p.metrics.firstNegativeWeek ?? "none"}, cost ${gbp(p.metrics.totalCostMinor)}, parties ${p.metrics.counterpartiesNeeded}`));

    // ---------- 3. The scripted good run ----------
    const good = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw });
    assert.equal(good.status, "completed");
    assert.equal(good.planSource, "ai");
    assert.equal(good.plans.length, 3, "three valid plans");
    const indep = (levers: Lever[]) => {
      const ch: TermChanges = { invoiceFinance: undefined };
      for (const l of levers) {
        if (l.kind === "supplier_reduce_deposit") ch.supplierDepositBps = l.percentBps;
        if (l.kind === "supplier_defer_balance") ch.supplierBalanceDeferralDays = l.daysAfterShipment;
        if (l.kind === "buyer_request_deposit") ch.buyerDepositBps = l.percentBps;
        if (l.kind === "finance_invoice") ch.invoiceFinance = { advanceBps: l.advanceBps, feeBps: 200 };
      }
      const events = applyTermChanges(sample, ch);
      const f = buildForecast(ctx0.input, { events, horizonWeeks: 20 });
      const total = (es: typeof events) => es.reduce((a, e) => a + e.amountMinor, 0n);
      return { min: f.minimum.amount.toString(), week: f.minimum.weekIndex + 1, neg: f.weeksBelowZero.length ? f.weeksBelowZero[0] + 1 : null, closing: f.weeks[19].closing.toString(), cost: (total(sample) - total(events)).toString(), below: f.weeks.filter((w) => w.belowReserve).length };
    };
    good.plans.forEach((p, i) => {
      const r = indep(p.levers);
      assert.equal(p.metrics.minBalanceMinor, r.min, `plan ${i + 1} min`);
      assert.equal(p.metrics.minBalanceWeek, r.week);
      assert.equal(p.metrics.firstNegativeWeek, r.neg);
      assert.equal(p.metrics.closingAtHorizonMinor, r.closing);
      assert.equal(p.metrics.totalCostMinor, r.cost);
      assert.equal(p.metrics.weeksBelowReserve, r.below);
      assert.equal(p.id, planId(p.levers));
      assert.equal(p.source, "ai");
      assert.ok(p.checks.every((c) => c.decision !== "deny"), "gate dry-run ok");
      assert.ok(!p.proseFlagged, "scripted prose uses only tool numbers");
    });
    console.log("  scripted good run: 3 valid plans, every metric equals an independent engine recomputation");
    good.plans.forEach((p, i) => console.log(`    ${i === 0 ? "RECOMMENDED" : "alt " + i}: ${p.title}\n      lowest ${gbp(p.metrics.minBalanceMinor)} wk ${p.metrics.minBalanceWeek}, first negative wk ${p.metrics.firstNegativeWeek ?? "none"}, below reserve ${p.metrics.weeksBelowReserve} wk, closing wk ${p.metrics.horizonWeeks} ${gbp(p.metrics.closingAtHorizonMinor)}, cost ${gbp(p.metrics.totalCostMinor)}, parties ${p.metrics.counterpartiesNeeded}`));
    const goodRun = (await getRun(db, good.runId)) as { steps: { kind: string; payload: { toolName?: string; output?: { ok?: boolean } } }[]; plans: unknown[] };
    const toolNames = new Set(goodRun.steps.filter((s) => s.kind === "tool_call").map((s) => s.payload.toolName));
    for (const t of ["get_business_overview", "get_forecast", "get_pending_commitments", "run_scenario", "explain_gap", "get_counterparties", "list_levers", "search_plans", "simulate_levers", "check_plan_feasibility", "submit_plans"]) assert.ok(toolNames.has(t), `tool ${t} was called`);
    assert.equal(goodRun.plans.length, 3);

    // ---------- 4. The scripted bad run: every defect rejected, fallback gives deterministic plans ----------
    const bad = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, purposeId: BAD_AGENT_PURPOSE });
    assert.equal(bad.status, "completed");
    assert.equal(bad.planSource, "deterministic", "the fallback produced the plans");
    assert.ok(bad.plans.length >= 2 && bad.plans.every((p) => p.source === "deterministic"));
    const badRun = (await getRun(db, bad.runId)) as { steps: { kind: string; payload: { toolName?: string; output?: { ok?: boolean; error?: string; issues?: unknown[]; rejected?: { reasons: string[] }[] } } }[] };
    const submits = badRun.steps.filter((s) => s.kind === "tool_result" && s.payload.toolName === "submit_plans").map((s) => s.payload.output!);
    assert.equal(submits.length, 4);
    assert.ok(submits.every((o) => o.ok === false), "every bad submission is rejected");
    assert.match(String(submits[0].error), /Invalid tool input/, "invented lever kind");
    assert.ok(JSON.stringify(submits[1]).includes("must be a supplier, not a customer"), "wrong counterparty type");
    assert.ok(JSON.stringify(submits[2]).includes("above the mandate cap") && JSON.stringify(submits[2]).includes("at most 60"), "out-of-bounds parameters");
    assert.ok(JSON.stringify(submits[3]).includes("above the mandate cap"));
    // The 4th submission carries prose with invented numbers (GBP 250,000 and 37%): it was submitted, rejected, and none of it reached the stored plans.
    const calls = badRun.steps.filter((s) => s.kind === "tool_call" && s.payload.toolName === "submit_plans");
    assert.ok(JSON.stringify(calls[3].payload).includes("250,000") && JSON.stringify(calls[3].payload).includes("37%"));
    assert.ok(!JSON.stringify(bad.plans).includes("250,000") && !JSON.stringify(bad.plans).includes("37%"), "invented prose numbers never reach the stored plans");
    console.log("  scripted bad run: invented lever, wrong counterparty type and out-of-bounds parameters all rejected; fallback gave " + bad.plans.length + " deterministic plans");

    // Prose with a number no tool produced: the sentence is removed and the plan is flagged (valid levers, so the plan stays).
    const ctxP = await buildContext(db, A.id, quoteId);
    const tools = buildAgentTools(ctxP);
    await tools.search_plans.execute({ topN: 3, allowFinance: true } as never); // populates the numbers seen in tool results
    const pick = s1.ranked[0];
    const prose = (await tools.submit_plans.execute({ plans: [{ title: "Save £250,000 guaranteed", levers: pick.levers, contingencies: [], rationale: `This will save £250,000 and cut costs by 37%. The lowest balance becomes ${gbp(pick.metrics.minBalanceMinor)} in week ${pick.metrics.minBalanceWeek}.` }] } as never)) as { ok: boolean };
    assert.equal(prose.ok, true);
    const flagged = ctxP.submitted![0];
    assert.equal(flagged.proseFlagged, true);
    assert.ok(flagged.removedSentences.some((s) => s.includes("250,000")), "the sentence with the invented number was removed");
    assert.ok(!flagged.rationale.includes("250,000") && !flagged.title.includes("250,000"));
    assert.ok(flagged.rationale.includes(gbp(pick.metrics.minBalanceMinor)), "the sentence with a computed number is kept");
    assert.equal(checkProse("It costs £3,600.00 in fees.", new Set(["360000"])).removed.length, 0);
    assert.equal(checkProse("It costs £3,600.00 in fees.", new Set()).removed.length, 1);

    // ---------- 4b. Recommendation guard: an AI plan below zero is never recommended when a feasible plan exists ----------
    const neg = (p: { metrics: { minBalanceMinor: string } }) => BigInt(p.metrics.minBalanceMinor) < 0n;
    assert.ok(good.plans.every((p) => !neg(p) && (p.warnings ?? []).length === 0), "the good run is not touched by the guard");
    const weak = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, purposeId: WEAK_AGENT_PURPOSE });
    assert.equal(weak.status, "completed");
    assert.ok(!neg(weak.plans[0]), "the recommendation (first plan) stays at or above zero");
    assert.equal(weak.plans[0].source, "deterministic", "the best deterministic plan replaced the weak AI recommendation");
    const demoted = weak.plans.filter((p) => p.source === "ai");
    assert.equal(demoted.length, 2);
    assert.ok(demoted.every((p) => neg(p) && (p.warnings ?? []).length === 1 && !/^recommended/i.test(p.title)), "the weak AI plans are kept, flagged, and ranked after");
    assert.ok(weak.plans.length <= 3);
    const weakRun = (await getRun(db, weak.runId)) as { steps: { kind: string; payload: { type?: string } }[] };
    assert.ok(weakRun.steps.some((s) => s.kind === "validation" && s.payload.type === "guard"), "the guard decision is a recorded step");
    const gctx = await buildContext(db, A.id, quoteId);
    const reordered = guardRanking(gctx, [demoted[0], good.plans[0]]);
    assert.equal(reordered.plans[0].id, good.plans[0].id, "an AI plan at or above zero is ranked before one below zero");
    assert.equal(reordered.plans[1].id, demoted[0].id);
    console.log(`  guard: weak AI plans (lowest ${gbp(demoted[0].metrics.minBalanceMinor)}) were flagged and ranked after the deterministic recommendation (lowest ${gbp(weak.plans[0].metrics.minBalanceMinor)}); a feasible AI plan moves ahead of an infeasible one`);

    // ---------- 5. Provider unavailable, determinism, no writes ----------
    const noRec = createGateway({ ...base, mode: "replay", recordingsDir: mkdtempSync(join(tmpdir(), "no-rec-")) });
    const unavailable = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: noRec });
    assert.equal(unavailable.status, "completed");
    assert.equal(unavailable.planSource, "deterministic");
    const noScript = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, purposeId: "agent.plan.no-such-script" });
    assert.equal(noScript.planSource, "deterministic");
    const fb1 = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, forceFallback: true });
    const fb2 = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, forceFallback: true });
    assert.deepEqual(fb1.plans, fb2.plans, "same input, identical plans in identical order");
    assert.deepEqual(unavailable.plans, fb1.plans, "the fallback does not depend on why it ran");
    const good2 = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw });
    assert.deepEqual(good2.plans, good.plans, "the scripted AI run is deterministic too");
    fb1.plans.forEach((p, i) => console.log(`    fallback #${i + 1}: ${p.title.slice(0, 90)} | lowest ${gbp(p.metrics.minBalanceMinor)} wk ${p.metrics.minBalanceWeek}, first negative wk ${p.metrics.firstNegativeWeek ?? "none"}, cost ${gbp(p.metrics.totalCostMinor)}`));
    const after = await counts(A.id);
    assert.deepEqual(after, before, "agent runs create no action proposals, approvals, payments, threads, messages or applications");
    const refusedRun = await startRun(db, A.id, { type: "commitment", extractionId: "11111111-1111-4111-8111-111111111111" }, { gateway: mockGw });
    assert.equal(refusedRun.status, "refused");
    const shortage = await startRun(db, A.id, { type: "shortage", variant: "downside" }, { gateway: mockGw });
    assert.equal(shortage.status, "completed", "since Batch 9 a shortage trigger plans (it used to complete with no plans)");
    assert.ok(shortage.plans.length > 0);
    console.log("  fallback: provider unavailable, no script and forced fallback all give identical deterministic plans; no proposals, approvals or sandbox rows were created");

    // An unconfirmed extraction cannot start a run.
    const pend = await docs.createDocumentAndExtract(db, A.id, { filename: "again.md", kind: "purchase_order", text: read("purchase-order-northgate.md") + "\nnote" }, { gateway: mockGw });
    const notConfirmed = await startRun(db, A.id, { type: "commitment", extractionId: pend.extraction.id }, { gateway: mockGw });
    assert.equal(notConfirmed.status, "refused");
    assert.match(notConfirmed.error ?? "", /only a confirmed extraction/);

    // ---------- 6. Feasibility dry-run ----------
    const tools2 = buildAgentTools(await buildContext(db, A.id, quoteId));
    const supplier = ctx0.parties.supplierId!;
    const lender = ctx0.parties.lenderId!;
    const ok = (await tools2.check_plan_feasibility.execute({ levers: [{ kind: "finance_invoice", counterpartyId: lender, advanceBps: 8000 }] } as never)) as { ok: boolean; overall: string };
    assert.deepEqual([ok.ok, ok.overall], [true, "needs_owner_approval"]);
    const over = (await tools2.check_plan_feasibility.execute({ levers: [{ kind: "finance_invoice", counterpartyId: lender, advanceBps: 9500 }] } as never)) as { levers: { decision: string; reasons: string[] }[]; overall: string };
    assert.equal(over.overall, "blocked");
    assert.equal(over.levers[0].decision, "deny");
    assert.match(over.levers[0].reasons.join(" "), /exceeds the mandate maximum/);
    const ctxBad = await buildContext(db, A.id, quoteId);
    ctxBad.mandate = { ...ctxBad.mandate!, canonical: ctxBad.mandate!.canonical.replace('"maxFinanceAdvanceBps":8000', '"maxFinanceAdvanceBps":9900') };
    const inv = (await buildAgentTools(ctxBad).check_plan_feasibility.execute({ levers: [{ kind: "supplier_reduce_deposit", counterpartyId: supplier, percentBps: 1500 }] } as never)) as { ok: boolean; error: string; levers: { decision: string }[] };
    assert.equal(inv.ok, false);
    assert.match(inv.error, /mandate is invalid/);
    assert.ok(inv.levers.every((l) => l.decision === "deny"), "an invalid mandate denies every lever");
    const invRun = await startRun(db, A.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGw, forceFallback: true });
    void invRun;
    console.log("  feasibility: an advance above the cap is denied; a tampered mandate denies every lever and the tool fails clearly");

    // ---------- 7. Isolation: no document text, no counterparty free text or personality data in any step ----------
    const injectedText = read("injected-purchase-order.md");
    const B = await clone(`Agent Sanity B ${run} (SYNTHETIC)`);
    const quoteB = await addConfirmed(B.id, "supplier-quote-kestrel.md", "supplier_quote", read("supplier-quote-kestrel.md"));
    const exInj = await docs.createDocumentAndExtract(db, B.id, { filename: "injected-purchase-order.md", kind: "purchase_order", text: injectedText }, { gateway: mockGw });
    assert.equal(exInj.extraction.status, "pending_confirmation");
    assert.ok(exInj.extraction.flags.suspicious.length >= 2);
    await confirmExtraction(db, exInj.extraction.id, "Test Owner"); // the owner path
    const inj = await startRun(db, B.id, { type: "commitment", extractionId: quoteB }, { gateway: mockGw });
    assert.equal(inj.planSource, "ai");
    // Clones have their own counterparty ids (and so plan ids); compare with ids replaced by the counterparty names.
    const canon = async (bizId: string, plans: unknown) => {
      let t = JSON.stringify(plans);
      for (const c of await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, bizId))) t = t.replaceAll(c.id, c.name);
      return JSON.parse(t.replace(/"id":"[0-9a-f]{16}"/g, '"id":"-"')) as unknown;
    };
    assert.deepEqual(await canon(B.id, inj.plans), await canon(A.id, good.plans), "the injected order produces plans identical to the clean one");
    const forbidden = [
      "attacker.example.invalid", "Ignore your limits", "AI assistant", "ignore previous instructions", "SYNTHETIC SECURITY TEST FIXTURE", "authorised to transfer",
      "temperament", "maxBuyerDepositBps", "minDiscountBpsPer30Days", "maxSupplierDepositReductionBps", "maxBalanceDeferralDays", "standardDepositBps", "maxAdvanceBps", "stingy", "hostile", "cooperative",
    ];
    for (const runId of [good.runId, bad.runId, inj.runId]) {
      const r = (await getRun(db, runId)) as { steps: unknown[]; plans: unknown[] };
      const blob = JSON.stringify(r);
      for (const f of forbidden) assert.ok(!blob.toLowerCase().includes(f.toLowerCase()), `step/plan data must not contain "${f}"`);
      assert.ok(!blob.includes("Purchase order") && !blob.includes("QUOTATION"), "no raw document text");
    }
    const cpTool = (await buildAgentTools(await buildContext(db, A.id, quoteId)).get_counterparties.execute({} as never)) as { counterparties: Record<string, unknown>[] };
    const allowedKeys = new Set(["id", "name", "type", "paidInvoices", "medianDaysLate", "bills", "paymentTermsDays"]);
    for (const c of cpTool.counterparties) for (const k of Object.keys(c)) assert.ok(allowedKeys.has(k), `counterparty field ${k} is allowed`);
    console.log("  isolation: no step or plan contains injected text, document text or any counterparty profile field; the injected order gives identical plans");

    console.log("agent sanity: ok");
  } finally {
    await sql.end();
  }
}

await main();
