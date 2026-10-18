// Light checks for the evaluation harness (not a test suite). Run: bun run check:eval
// A. the generator: same seed, same parameters; ranges respected; a case does not depend on how many cases are asked for.
// B. failure path: an impossible case (zero balance and a signed mandate that allows no kind of request) is classified no_feasible_plan, not an error.
// C. determinism: the quick mode (8 cases) run twice gives byte-identical JSON and Markdown.
import assert from "node:assert/strict";
import { generateCases, DEFAULT_SEED } from "./eval/generate";
import { closeEnv, createEnv, runCase, shutdown } from "./eval/run-case";
import { runEval } from "./eval/report";
import { signMandate } from "../src/gate/owner-signing";

function partA() {
  const a = generateCases(60, DEFAULT_SEED);
  assert.deepEqual(a, generateCases(60, DEFAULT_SEED), "same seed, same parameters");
  assert.notDeepEqual(a, generateCases(60, DEFAULT_SEED + 1), "another seed gives other parameters");
  assert.deepEqual(generateCases(5, DEFAULT_SEED)[3], generateCases(200, DEFAULT_SEED)[3], "case 4 is the same whatever the number of cases");
  const many = generateCases(2000, 7);
  const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi && Number.isInteger(v);
  for (const c of many) {
    assert.ok(within(c.balancePct, 60, 160) && within(c.reservePct, 80, 120) && within(c.orderPct, 50, 150) && within(c.lateExtraDays, 0, 30), "numeric ranges");
    assert.ok([5, 10, 20, 30].includes(c.buyerDepositCapPct) && [15, 20, 25, 30].includes(c.supplierMinDepositPct), "choice ranges");
    assert.ok(c.lenderFeeBps >= 150 && c.lenderFeeBps <= 400 && c.lenderFeeBps % 25 === 0, "fee range");
    assert.ok(["none", "customer_late", "supplier_refusal"].includes(c.shock));
  }
  const spread = (f: (c: (typeof many)[number]) => unknown) => new Set(many.map(f)).size;
  assert.ok(spread((c) => c.balancePct) > 50 && spread((c) => c.shock) === 3 && spread((c) => c.buyersAcceptChase) === 2, "the generator actually varies");
  console.log("  A generator: reproducible, case k independent of N, 2000 cases inside every range and varied");
}

async function partB() {
  const env = await createEnv();
  try {
    const r = await runCase(env, { index: 900, balancePct: 0, reservePct: 100, orderPct: 100, lateExtraDays: 0, buyerDepositCapPct: 5, buyersAcceptChase: false, supplierDefers: false, supplierMinDepositPct: 30, lenderFeeBps: 250, shock: "none" }, {
      afterPerturb: async (e, id) => {
        const [m] = await e.owner`select canonical from mandates where business_id = ${id} and active`;
        const wire = JSON.parse(m.canonical);
        wire.version = 2;
        wire.limits.allowedProposalKinds = [];
        const signed = signMandate(wire);
        await e.owner`update mandates set active = false where business_id = ${id}`;
        await e.owner`insert into mandates (business_id, version, canonical, signature, active) values (${id}, 2, ${signed.canonical}, ${signed.signature}, true)`;
      },
    });
    assert.equal(r.shortage, true, "the books are short");
    assert.equal(r.outcome, "no_feasible_plan");
    assert.equal(r.error, null, "no feasible plan is an outcome, not an error");
    assert.equal(r.rounds, 0, "nothing was signed or executed");
    assert.deepEqual([r.limitViolations.length, r.floorBreaches.length, r.unsignedExecutions], [0, 0, 0]);
    console.log("  B impossible case (zero balance, mandate allows no request): classified no_feasible_plan, no error, nothing executed");
  } finally {
    await closeEnv(env);
  }
}

async function partC() {
  const one = await runEval({ cases: 8, seed: DEFAULT_SEED });
  const two = await runEval({ cases: 8, seed: DEFAULT_SEED });
  assert.equal(one.json, two.json, "JSON is byte-identical across two runs");
  assert.equal(one.md, two.md, "Markdown is byte-identical across two runs");
  assert.ok(one.invariants.every((i) => i.ok), "invariants hold in the quick run");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(one.json + one.md), "no raw ids in the output");
  console.log(`  C determinism: 8 cases twice, ${one.json.length} bytes of JSON and ${one.md.length} of Markdown identical; invariants hold`);
}

partA();
partB().then(partC).then(() => shutdown()).then(() => console.log("eval checks passed")).catch((e) => { console.error(e); process.exit(1); });
