// Focused checks for the financial flight simulator (not a test suite). Run: bun run check:flight
// Part A is pure and hand-computed: shocks change exactly what they say, the live objects are never modified, combined events are one whole forecast.
// Part B uses a throwaway clone of the demo business: a combined crisis (major customer late + supplier refuses to defer) is simulated, every
// candidate is recomputed, changing one assumption recomputes everything, and NOTHING in the business's tables changes (row-content hashes).
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { applyShocks, attributeShocks, buildForecast, changedItems, type EngineInput, type Shock } from "../src/engine";
import type { CommitmentEvent } from "../src/domain/commitment-event";

const asOf = "2026-10-15";
const mkInput = (): EngineInput => ({
  asOf, currency: "GBP", openingBalance: 1_000_000n, reserve: 300_000n, horizonWeeks: 13,
  invoices: [{ id: "i1", number: "INV-1", counterpartyId: "cust", counterpartyName: "Acme (test)", issuedOn: "2026-10-01", dueOn: "2026-10-30", amount: 500_000n, status: "open" }],
  bills: [{ id: "b1", reference: "B-1", counterpartyId: "sup", counterpartyName: "Kestrel (test)", issuedOn: "2026-10-01", dueOn: "2026-11-05", amount: 600_000n, status: "open" }],
  commitments: [],
});
const events: CommitmentEvent[] = [];
const closings = (i: EngineInput, e: CommitmentEvent[] = events) => buildForecast(i, { events: e, horizonWeeks: 13 }).weeks.map((w) => w.closing);
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const parties = { buyerId: null };

function partA() {
  const input = mkInput();
  const live = buildForecast(input, { events, horizonWeeks: 13 });
  assert.equal(live.minimum.amount, 900_000n, "live: 1,000,000 + 500,000 - 600,000 = 900,000 in week 4");

  // A1. Isolation: applying shocks returns copies; the originals are byte-for-byte unchanged.
  const before = json({ input, events });
  const all: Shock[] = [{ kind: "customer_late", counterpartyId: "cust", days: 14 }, { kind: "customer_short", counterpartyId: "cust", shortBps: 1000 }, { kind: "unexpected_expense", amountMinor: 250_000n, dueOn: "2026-11-05", label: "Repair" }, { kind: "supplier_refuses", counterpartyId: "sup", lever: "both" }];
  const w = applyShocks(input, events, parties, all);
  assert.equal(json({ input, events }), before, "the live input and events are not modified by a simulation");
  assert.notEqual(w.input, input);
  assert.equal(input.bills.length, 1, "the unexpected expense exists only in the copy");
  assert.equal(w.input.bills.length, 2);

  // A2. Each shock does exactly what it says (hand arithmetic).
  const late = closings(applyShocks(input, events, parties, [all[0]]).input);
  assert.equal(late[2], 1_000_000n, "week 3: invoice not yet in (due 10-30 + 14 days = 11-13)");
  assert.equal(late[3], 400_000n, "week 4: 1,000,000 - 600,000 bill, invoice still late");
  assert.equal(late[4], 900_000n, "week 5 (11-12..11-18): invoice arrives, +500,000");
  const short = buildForecast(applyShocks(input, events, parties, [all[1]]).input, { events, horizonWeeks: 13 });
  assert.equal(short.items.find((i) => i.sourceId === "i1")!.amount, 450_000n, "10% short: 500,000 -> 450,000 exactly");
  assert.equal(short.minimum.amount, 850_000n, "lowest balance 1,450,000 - 600,000 = 850,000");
  const exp = closings(applyShocks(input, events, parties, [all[2]]).input);
  assert.equal(exp[3], 650_000n, "expense of 250,000 due 11-05 lowers week 4 from 900,000 to 650,000");
  assert.equal(exp[2], closings(input)[2], "weeks before the due date are unchanged");

  // A3. Combined events are one whole forecast; their interaction is named, never hidden.
  // Early bill 900,000 (week 1) and bill 100,000 (week 4); invoice 500,000 in week 3. Live closings: 100,000 / 100,000 / 600,000 / 500,000, lowest 100,000.
  const in3: EngineInput = { ...mkInput(), bills: [{ ...mkInput().bills[0], id: "b1", dueOn: "2026-10-16", amount: 900_000n }, { ...mkInput().bills[0], id: "b2", reference: "B-2", dueOn: "2026-11-05", amount: 100_000n }] };
  const mix: Shock[] = [{ kind: "customer_late", counterpartyId: "cust", days: 14 }, { kind: "unexpected_expense", amountMinor: 250_000n, dueOn: "2026-11-06", label: "Tax" }];
  const c = attributeShocks(in3, events, parties, mix, { horizonWeeks: 13 });
  assert.equal(buildForecast(in3, { events, horizonWeeks: 13 }).minimum.amount, 100_000n);
  assert.equal(c.rows[0].aloneDeltaMinor, -100_000n, "late alone: the invoice misses week 3 and 4, so week 4 closes at 0 instead of 500,000; lowest 0");
  assert.equal(c.rows[1].aloneDeltaMinor, 0n, "tax alone: week 4 closes at 250,000, still above the week-1 low of 100,000");
  assert.equal(c.combinedDeltaMinor, -350_000n, "together: week 4 closes at 500,000 - 500,000 - 250,000 = -250,000");
  assert.equal(c.interactionMinor, -250_000n, "the events are not simply added: separately they cost 100,000, together 350,000");
  const wk = buildForecast(applyShocks(in3, events, parties, mix).input, { events, horizonWeeks: 13 });
  assert.equal(wk.minimum.amount, -250_000n);
  assert.deepEqual(changedItems(buildForecast(in3, { events, horizonWeeks: 13 }), wk).map((x) => x.label.slice(0, 7)).sort(), ["Bill SI", "Invoice"], "the changed lines are the expense and the late invoice");

  // A4. Bad input is refused, not guessed.
  assert.throws(() => applyShocks(input, events, parties, [{ kind: "customer_late", counterpartyId: "cust", days: 0 }]));
  assert.throws(() => applyShocks(input, events, parties, [{ kind: "unexpected_expense", amountMinor: 1n, dueOn: "2026-10-01", label: "past" }]));
  assert.throws(() => applyShocks(input, events, parties, Array.from({ length: 7 }, () => all[0])));
  console.log("  A pure: copies not originals; late/short/expense exact to the penny; combined = one forecast with a named interaction; bad input refused");
}

async function partB() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { createDocument } = await import("../src/actions/ledger");
  const { buildContext } = await import("../src/actions/agent-run");
  const { getSimulatorOptions, simulateScenario } = await import("../src/actions/flight-simulator");
  const { readFileSync } = await import("node:fs");
  const postgres = (await import("postgres")).default;
  const { join } = await import("node:path");
  const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
  const docs = await import("../src/ingest/documents");
  const { confirmExtraction } = await import("../src/ingest/documents/confirm");
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");
    const { id } = await createDemoClone(db as any, demo!);
    const gw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
    for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
      const r = await docs.createDocumentAndExtract(db as any, id, { filename, kind, text: readFileSync(join("fixtures", filename), "utf8") }, { gateway: gw });
      await confirmExtraction(db as any, r.extraction.id, "Test Owner");
    }
    const ctx0 = await buildContext(db as any, id, null, []);
    const supplier = (await db.select().from(S.counterparties).where(eq(S.counterparties.businessId, id))).find((c) => c.role === "supplier")!;
    const inDays = (n: number) => new Date(Date.parse(`${ctx0.asOf}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await createDocument(db as any, id, "bill", { counterpartyId: supplier.id, number: "FLIGHT-1", issuedOn: ctx0.asOf, dueOn: inDays(21), amount: "50000.00", acknowledgeOverlaps: true });

    // The seeded demo books are already short once the order is confirmed. Top the clone's bank balance up (owner role, throwaway clone only) so the books are
    // HEALTHY today and the crisis is what creates the gap: lowest balance today = cushion + 10,000.00.
    const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
    const probe = await buildContext(db as any, id, null, []);
    const f0 = buildForecast(probe.input, { events: probe.pending.map((p) => p.event), horizonWeeks: probe.horizonWeeks });
    const topUp = probe.input.reserve + 1_000_000n - f0.minimum.amount;
    await owner`update financial_accounts set balance_minor = balance_minor + ${topUp.toString()} where business_id = ${id}`;
    await owner.end();
    // Row-content fingerprint of every table that belongs to this business, except the append-only log (which gains exactly one record per run).
    const tables = (await sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'business_id' and table_name <> 'action_records' order by table_name`).map((r: any) => r.table_name as string);
    const fingerprint = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) { const [r] = await sql`select count(*)::int as n, coalesce(md5(string_agg(x::text, ',' order by x::text)), '') as h from ${sql(t)} x where business_id = ${id}`; out[t] = `${r.n}:${r.h}`; }
      return out;
    };
    const logCount = async () => Number((await sql`select count(*)::int as n from action_records where business_id = ${id}`)[0].n);
    const before = await fingerprint();
    const logBefore = await logCount();

    const opts = await getSimulatorOptions(db as any, id);
    assert.ok(opts.majorCustomerId, "there is a major customer");
    const major = opts.customers.find((c) => c.id === opts.majorCustomerId)!;
    const sup = opts.suppliers[0];
    const combined = { name: "Combined crisis", shocks: [{ kind: "customer_late", counterpartyId: major.id, days: 21 }, { kind: "supplier_refuses", counterpartyId: sup.id, lever: "supplier_defer_balance" }] };

    // B1. The combined crisis.
    const { report: r1 } = await simulateScenario(db as any, id, { scenario: combined });
    const reserve = BigInt(r1.reserveMinor);
    assert.ok(BigInt(r1.live.minBalanceMinor) >= reserve, "today's books keep the cushion");
    assert.ok(BigInt(r1.simulated.minBalanceMinor) < reserve, "the combined crisis is what creates the gap");
    assert.equal(r1.hypothetical, true);
    assert.equal(r1.verified, false, "a simulation is never verified");
    assert.ok(r1.notices.some((n) => /not verified/.test(n)) && r1.notices.some((n) => /unknown until/.test(n)), "the notices say it is hypothetical and acceptance is not guaranteed");
    console.log(`  B1 live lowest ${r1.live.minBalanceMinor} (week ${r1.live.minBalanceWeek}); scenario lowest ${r1.simulated.minBalanceMinor} (week ${r1.simulated.minBalanceWeek}), gap ${r1.simulated.gapMinor}, cushion ${reserve}`);
    for (const l of r1.causes.lines) console.log(`     - ${l}`);
    const ev = r1.evaluation as any;
    for (const c of ev.candidates) console.log(`     [${c.outcome}] ${c.role}: ${c.leverText.join("; ")} -> lowest ${c.minBalanceMinor} cost ${c.costMinor}${c.blockers.length ? " blocked: " + c.blockers[0] : ""}`);
    console.log(`     recommended: ${ev.recommendedId} (${ev.verdict}); ${ev.whyPreferred.join(" | ")}`);

    // Independent recomputation of the scenario's lowest balance: shock the context by hand, run the engine directly.
    const ctx = await buildContext(db as any, id, null, []);
    const events = ctx.pending.map((p) => p.event);
    const shifted = events.map((e) => (e.kind === "customer_receipt" && ctx.parties.buyerId === major.id ? { ...e, date: new Date(Date.parse(`${e.date}T00:00:00Z`) + 21 * 86_400_000).toISOString().slice(0, 10) } : { ...e }));
    const hand = buildForecast({ ...ctx.input, hypotheticalDelays: [{ counterpartyId: major.id, days: 21 }] }, { events: shifted, horizonWeeks: ctx.horizonWeeks });
    assert.equal(hand.minimum.amount.toString(), r1.simulated.minBalanceMinor, "the reported lowest balance equals an independent engine run");
    const live = buildForecast(ctx.input, { events, horizonWeeks: ctx.horizonWeeks });
    assert.equal(live.minimum.amount.toString(), r1.live.minBalanceMinor, "the live figure is the real forecast");

    // Every candidate's outcome agrees with its own recomputed figures; nothing is called resolved unless every week is at or above the cushion.
    for (const c of ev.candidates) {
      if (c.outcome === "resolves") assert.ok(BigInt(c.minBalanceMinor) >= reserve && c.blockers.length === 0, "a resolving candidate keeps the cushion and is permitted");
      if (c.outcome === "reduces") assert.ok(BigInt(c.minBalanceMinor) < reserve && BigInt(c.minBalanceMinor) > BigInt(ev.nothing.minBalanceMinor), "a reducing candidate improves but leaves a gap");
      if (c.outcome === "blocked") assert.ok(c.blockers.length > 0, "a blocked candidate says why");
    }
    const refusedKind = ev.candidates.filter((c: any) => c.levers.some((l: any) => l.kind === "supplier_defer_balance" && l.counterpartyId === sup.id));
    assert.ok(refusedKind.every((c: any) => c.outcome === "blocked"), "no permitted candidate relies on the deferral the supplier refused in the scenario");
    const rec = ev.candidates.find((c: any) => c.id === ev.recommendedId);
    if (rec) assert.ok(rec.outcome === "resolves" || rec.outcome === "reduces", "the recommendation is something that helps");

    // B2. Change ONE assumption (21 -> 7 days late): the whole thing is recomputed and compared.
    const softer = { name: "Combined crisis (7 days late)", shocks: [{ ...combined.shocks[0], days: 7 }, combined.shocks[1]] };
    const { report: r2, comparison } = await simulateScenario(db as any, id, { scenario: softer, compareWith: combined });
    assert.ok(comparison && comparison.lines.length >= 2, "a comparison with the previous assumption is produced");
    assert.ok(BigInt(r2.simulated.minBalanceMinor) >= BigInt(r1.simulated.minBalanceMinor), "a shorter delay is never worse");
    if (BigInt(r2.simulated.minBalanceMinor) >= reserve) assert.ok(r2.evaluation.recommendedId === null && r2.evaluation.verdict === "no_shortage", "when the scenario causes no shortage nobody is asked for anything");
    const { report: r2again } = await simulateScenario(db as any, id, { scenario: softer });
    assert.equal(json(r2again.evaluation), json(r2.evaluation), "the same scenario gives the same answer (deterministic)");
    console.log(`  B2 7 instead of 21 days: lowest ${r1.simulated.minBalanceMinor} -> ${r2.simulated.minBalanceMinor}; ${comparison!.lines.join(" | ")}`);

    // B3. The other scenarios run through the same mechanism.
    const others: any[] = [
      { name: "Customer 14 days late", shocks: [{ kind: "customer_late", counterpartyId: major.id, days: 14 }] },
      { name: "Customer pays 25% less", shocks: [{ kind: "customer_short", counterpartyId: major.id, shortBps: 2500 }] },
      { name: "Unexpected bill", shocks: [{ kind: "unexpected_expense", amount: "30000.00", dueOn: inDays(10), label: "Repair" }] },
      { name: "Everything at once", shocks: [...combined.shocks, { kind: "customer_short", counterpartyId: major.id, shortBps: 1000 }, { kind: "unexpected_expense", amount: "15000.00", dueOn: inDays(14), label: "Tax" }] },
    ];
    for (const s of others) {
      const { report } = await simulateScenario(db as any, id, { scenario: s });
      assert.equal(report.hypothetical, true);
      console.log(`  B3 ${s.name}: lowest ${report.simulated.minBalanceMinor}; ${report.evaluation.candidates.length} candidates; recommended ${report.evaluation.recommendedId ?? "none"}`);
    }
    await assert.rejects(() => simulateScenario(db as any, id, { scenario: { shocks: [{ kind: "customer_late", counterpartyId: sup.id, days: 7 }] } }), /customers/, "a late payment must name a customer");

    // B4. Isolation: no business row changed; the only writes are the log records.
    const after = await fingerprint();
    assert.deepEqual(after, before, "no table of this business changed (row-content hashes equal)");
    assert.equal(await logCount() - logBefore, 7, "exactly one log record per simulation run (and nothing else)");
    const [lastLog] = await sql`select event, detail from action_records where business_id = ${id} order by chain_seq desc limit 1`;
    assert.equal(lastLog.event, "simulation.run");
    assert.equal(lastLog.detail.hypothetical, true);
    console.log(`  B4 ${tables.length} tables unchanged after 7 simulation runs; ${await logCount() - logBefore} log records, all simulation.run`);
  } finally {
    await sql.end();
  }
}

partA();
partB().then(() => console.log("flight checks passed")).catch((e) => { console.error(e); process.exit(1); });
