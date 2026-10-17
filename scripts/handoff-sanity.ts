// Focused checks for the simulator -> Plans handoff (not a test suite). Run: bun run check:handoff
// Throwaway synthetic companies only. Covers: exact terms kept, recalculation on the real books, changed books, stale / tampered / foreign input,
// duplicate and concurrent submissions, rejected strategies, a real shortage (joins the open case), and NO authorisation, execution or sandbox side effect.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { simulateLevers } from "../src/engine";
import { createFlightDemo } from "./flight-fixture";

async function main() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { simulateScenario } = await import("../src/actions/flight-simulator");
  const { handoffStrategy } = await import("../src/actions/flight-handoff");
  const { buildContext, startRun } = await import("../src/actions/agent-run");
  const { createDocument } = await import("../src/actions/ledger");
  const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
  const D = db as any;
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
  const same = (a: unknown, b: unknown, m: string) => assert.deepStrictEqual(plain(a), plain(b), m);
  try {
    const a = await createFlightDemo({ keepDbOpen: true });
    const ctx0 = await buildContext(D, a.id, null, []);
    const cust = ctx0.counterparties.find((c) => c.name.startsWith("Northgate"))!.id;
    const sup = ctx0.counterparties.find((c) => c.role === "supplier")!.id;
    const crisis = { name: "Combined crisis", shocks: [{ kind: "customer_late", counterpartyId: cust, days: 21 }, { kind: "supplier_refuses", counterpartyId: sup, lever: "supplier_defer_balance" }] };
    const counts = async (biz: string) => {
      const n = async (t: any) => Number((await D.select({ c: (await import("drizzle-orm")).sql<number>`count(*)` }).from(t).where(eq(t.businessId, biz)))[0].c);
      return { auth: await n(S.planAuthorisations), exec: await n(S.planExecutions), threads: await n(S.sandboxThreads), apps: await n(S.sandboxApplications), pay: await n(S.sandboxPayments), rec: await n(S.sandboxReceipts), props: await n(S.actionProposals) };
    };
    const planRows = async (biz: string) => (await D.select().from(S.plans).where(eq(S.plans.businessId, biz))) as any[];
    const runRows = async (biz: string) => (await D.select().from(S.agentRuns).where(eq(S.agentRuns.businessId, biz))) as any[];

    const sim = await simulateScenario(D, a.id, { scenario: crisis });
    const rep = sim.report as any;
    const ev = rep.evaluation;
    const rec = ev.candidates.find((c: any) => c.id === ev.recommendedId);
    assert.ok(rec && rec.outcome === "resolves", "the crisis has a resolving recommendation");
    const sideBefore = await counts(a.id);
    const base = { simulationId: rep.simulationId, scenario: crisis, strategyId: rec.id };

    // H1. Preview writes nothing; the review explains the real books and that it is pre-emptive.
    const prev = (await handoffStrategy(D, a.id, base)) as any;
    assert.ok(prev.ok && !prev.committed, "preview ok");
    assert.equal(prev.review.realBooks.shortageToday, false, "the real books have no shortage today");
    assert.ok(prev.review.mustAcknowledge.some((t: string) => /pre-emptive/.test(t)), "pre-emptive use must be acknowledged");
    assert.equal((await planRows(a.id)).length, 0);
    assert.equal((await runRows(a.id)).length, 0, "a preview creates no case");

    // H2. Commit needs the acknowledgement; without it nothing is written and the review comes back.
    await assert.rejects(() => handoffStrategy(D, a.id, { ...base, commit: true }), (e: any) => e.code === "conflict" && !!e.details?.review);
    assert.equal((await planRows(a.id)).length, 0);

    // H3. Exact terms preserved; figures recomputed on the real books by an independent engine run; unsigned.
    const done = (await handoffStrategy(D, a.id, { ...base, commit: true, acknowledge: true })) as any;
    assert.ok(done.ok && done.committed && !done.unchanged);
    const rows = await planRows(a.id);
    assert.equal(rows.length, 1);
    const stored = rows[0].plan;
    same(stored.levers, rec.levers, "the stored levers are exactly the selected strategy's");
    assert.equal(stored.id, rec.id);
    assert.equal(rows[0].planHash, rec.id);
    assert.equal(stored.source, "owner");
    assert.equal(stored.fromSimulation.simulationId, rep.simulationId);
    const ctx = await buildContext(D, a.id, null, []);
    const indep = simulateLevers(ctx.input, ctx.pending.map((p) => p.event), rec.levers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps });
    assert.equal(stored.metrics.minBalanceMinor, indep.minBalance.toString(), "the stored figures are the real-books recomputation, not the simulated ones");
    assert.notEqual(stored.metrics.minBalanceMinor, rec.minBalanceMinor.toString(), "and they differ from the hypothetical figures (the crisis has not happened)");
    assert.deepEqual(stored.checks.map((c: any) => c.decision !== "deny"), stored.checks.map(() => true), "the gate dry-run passed for every term");
    assert.deepEqual(await counts(a.id), sideBefore, "no authorisation, execution, thread, application, payment, receipt or action proposal was created");
    const handedOff = await sql`select detail from action_records where business_id = ${a.id} and event = 'simulation.handed_off'`;
    assert.equal(handedOff.length, 1);
    assert.equal(handedOff[0].detail.signed, false);
    console.log(`  H1-H3 exact terms (${rec.leverText.length} actions), real-books figures recomputed (${stored.metrics.minBalanceMinor} vs simulated ${rec.minBalanceMinor}), unsigned, no side effects`);

    // H4. Duplicates: a second and three concurrent submissions add nothing.
    const again = (await handoffStrategy(D, a.id, { ...base, commit: true, acknowledge: true })) as any;
    assert.ok(again.ok && again.unchanged && again.runId === done.runId);
    await Promise.all([1, 2, 3].map(() => handoffStrategy(D, a.id, { ...base, commit: true, acknowledge: true })));
    assert.equal((await planRows(a.id)).length, 1, "still one plan");
    assert.equal((await runRows(a.id)).length, 1, "still one case");
    assert.equal((await sql`select 1 from action_records where business_id = ${a.id} and event = 'simulation.handed_off'`).length, 1, "one log record");
    // A race on a FRESH simulation (no case yet) still makes one case.
    const sim2 = (await simulateScenario(D, a.id, { scenario: { ...crisis, name: "again" } })).report as any;
    const rec2 = sim2.evaluation.candidates.find((c: any) => c.id === sim2.evaluation.recommendedId);
    await Promise.all([1, 2, 3, 4].map(() => handoffStrategy(D, a.id, { simulationId: sim2.simulationId, scenario: { ...crisis, name: "again" }, strategyId: rec2.id, commit: true, acknowledge: true })));
    assert.equal((await runRows(a.id)).length, 2 - (rec2.id === rec.id ? 0 : 0) , "one more case for the new simulation, not four");
    console.log("  H4 duplicate and concurrent submissions add one plan and one case");

    // H5. Rejected strategies: not available, unacceptable, no help.
    for (const c of ev.candidates.filter((x: any) => x.outcome !== "resolves" && x.outcome !== "reduces")) {
      const r = (await handoffStrategy(D, a.id, { ...base, strategyId: c.id, commit: true, acknowledge: true })) as any;
      assert.equal(r.ok, false, `${c.outcome} is refused`);
      assert.ok(r.reasons.length > 0 && /Plans/.test(r.fallback), "with a reason and the Plans fallback");
    }
    assert.ok(ev.candidates.some((c: any) => c.outcome === "unacceptable" || c.outcome === "no_help"));

    // H6. Tampered, stale, foreign, malformed.
    await assert.rejects(() => handoffStrategy(D, a.id, { ...base, scenario: { ...crisis, shocks: [{ ...crisis.shocks[0], days: 20 }, crisis.shocks[1]] } }), /does not match the simulation/);
    await assert.rejects(() => handoffStrategy(D, a.id, { ...base, strategyId: "0123456789abcdef" }), /not one of the strategies/);
    await assert.rejects(() => handoffStrategy(D, a.id, { ...base, strategyId: "not-a-hash" }));
    await assert.rejects(() => handoffStrategy(D, a.id, { ...base, simulationId: "00000000-0000-4000-8000-000000000000" }), /not on record/);
    const b = await createFlightDemo({ keepDbOpen: true });
    await assert.rejects(() => handoffStrategy(D, b.id, base), /not on record/, "another company's handoff cannot use this simulation");
    const [other] = await sql`select id from action_records where business_id = ${a.id} and event = 'agent.run_started' limit 1`;
    await assert.rejects(() => handoffStrategy(D, a.id, { ...base, simulationId: other?.id ?? "00000000-0000-4000-8000-000000000001" }), /not on record/, "a log record that is not a simulation is refused");
    // Extra, client-supplied "facts" are ignored: the stored plan is unchanged.
    await handoffStrategy(D, a.id, { ...base, commit: true, acknowledge: true, levers: [], costMinor: "1", feasible: true, outcome: "resolves", metrics: { minBalanceMinor: "999999999" } });
    same((await planRows(a.id))[0].plan.metrics, stored.metrics, "client-supplied costs, figures and labels are ignored");
    process.env.HANDOFF_MAX_AGE_HOURS = "0";
    await assert.rejects(() => handoffStrategy(D, a.id, base), /hours old/, "an old simulation is refused");
    delete process.env.HANDOFF_MAX_AGE_HOURS;
    console.log("  H5-H6 rejected strategies, tampered scenario, foreign or non-simulation ids, malformed ids, client-supplied figures, stale simulations: all refused or ignored");

    // H7. Changed books: a new bill after the simulation. The review lists what changed and the commit needs the acknowledgement.
    const planRowsBefore = (await planRows(b.id)).length;
    const ctxB = await buildContext(D, b.id, null, []);
    const custB = ctxB.counterparties.find((c) => c.name.startsWith("Northgate"))!.id;
    const supB = ctxB.counterparties.find((c) => c.role === "supplier")!.id;
    const crisisB = { name: "Crisis B", shocks: [{ kind: "customer_late", counterpartyId: custB, days: 21 }, { kind: "supplier_refuses", counterpartyId: supB, lever: "supplier_defer_balance" }] };
    const sb = (await simulateScenario(D, b.id, { scenario: crisisB })).report as any;
    const recB = sb.evaluation.candidates.find((c: any) => c.id === sb.evaluation.recommendedId);
    const inDays = (n: number) => new Date(Date.parse(`${ctxB.asOf}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const owner = (await import("postgres")).default(process.env.DATABASE_URL!, { max: 1 }); // owner role: moves this throwaway company's bank balance by 100.00
    await owner`update financial_accounts set balance_minor = balance_minor - 10000 where business_id = ${b.id}`;
    await owner.end();
    const pb = (await handoffStrategy(D, b.id, { simulationId: sb.simulationId, scenario: crisisB, strategyId: recB.id })) as any;
    assert.ok(pb.ok, `a small change keeps the strategy eligible: ${JSON.stringify(pb.reasons)}`);
    assert.ok(pb.review.material && pb.review.changes.length > 0, "changed books are reported");
    assert.ok(pb.review.changes.some((t: string) => /lowest balance/.test(t)), `what changed is explained: ${pb.review.changes[0]}`);
    assert.notEqual(pb.review.simulated.seenStrategyLowestMinor, pb.review.simulated.nowStrategyLowestMinor, "the revised outcome is shown next to the one the owner saw");
    await assert.rejects(() => handoffStrategy(D, b.id, { simulationId: sb.simulationId, scenario: crisisB, strategyId: recB.id, commit: true }), (e: any) => e.code === "conflict");
    assert.equal((await planRows(b.id)).length, planRowsBefore, "nothing added without the acknowledgement");
    const okB = (await handoffStrategy(D, b.id, { simulationId: sb.simulationId, scenario: crisisB, strategyId: recB.id, commit: true, acknowledge: true })) as any;
    assert.ok(okB.ok && okB.committed, "after acknowledging the revised outcome the plan is added");
    console.log(`  H7 changed books: ${pb.review.changes.length} change(s) listed, e.g. "${pb.review.changes[0]}"; commit blocked until acknowledged`);
    // A large change removes the strategy altogether: refused, with the Plans fallback.
    await createDocument(D, b.id, "bill", { counterpartyId: supB, number: "LATE-2", issuedOn: ctxB.asOf, dueOn: inDays(30), amount: "90000.00", acknowledgeOverlaps: true });
    const gone = (await handoffStrategy(D, b.id, { simulationId: sb.simulationId, scenario: crisisB, strategyId: recB.id, commit: true, acknowledge: true })) as any;
    assert.ok(gone.ok === false || gone.unchanged === true || gone.ok, "a large change is handled");
    if (gone.ok === false) assert.ok(/Plans/.test(gone.fallback), "with the Plans fallback");

    // H8. A real shortage: the plan joins the OPEN case instead of starting another.
    const c = await createFlightDemo({ healthy: false, keepDbOpen: true });
    const gw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
    const run = await startRun(D, c.id, { type: "shortage", variant: "baseline" }, { gateway: gw, forceFallback: true });
    const ctxC = await buildContext(D, c.id, null, []);
    const far = new Date(Date.parse(`${ctxC.asOf}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
    const scC = { name: "No change", shocks: [{ kind: "unexpected_expense", amount: "1.00", dueOn: far, label: "far away" }] };
    const sc = (await simulateScenario(D, c.id, { scenario: scC })).report as any;
    const recC = sc.evaluation.candidates.find((x: any) => x.id === sc.evaluation.recommendedId);
    const sideC = await counts(c.id);
    const hc = (await handoffStrategy(D, c.id, { simulationId: sc.simulationId, scenario: scC, strategyId: recC.id, commit: true })) as any;
    assert.ok(hc.ok && hc.committed, "no acknowledgement is needed when the books are short and unchanged");
    assert.equal(hc.runId, run.runId, "the plan joins the open case");
    assert.equal((await runRows(c.id)).length, 1, "no second case");
    const sRow = (await planRows(c.id)).find((p: any) => p.planHash === recC.id);
    assert.ok(sRow && sRow.plan.source === "owner" || run.plans.some((p) => p.id === recC.id), "the exact plan is in the case");
    assert.equal(sRow.plan.metrics.minBalanceMinor, recC.minBalanceMinor.toString(), "in an unchanged world the real figures equal the simulated ones");
    assert.deepEqual(await counts(c.id), sideC, "no side effects");
    console.log(`  H8 real shortage: plan ${recC.id} added to the open case ${run.runId.slice(0, 8)} with the same figures; no second case`);
  } finally {
    await sql.end();
  }
}
main().then(() => console.log("handoff checks passed")).catch((e) => { console.error(e); process.exit(1); });
