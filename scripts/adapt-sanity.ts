// Light checks for adaptive negotiation (not a test suite). Run: bun run check:adapt
// Part A is pure (the decision rules). Part B reads adaptation reports that real re-plans stored (run bun run check:plan first) and checks their invariants.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { decide, interpretResponses, withTheirTerms, type Candidate } from "../src/engine/plans/adapt";
import type { Constraint } from "../src/domain/constraints";
import type { Lever } from "../src/domain/plan";

const SUP = "00000000-0000-4000-8000-000000000001";
const BUY = "00000000-0000-4000-8000-000000000002";
const dep: Lever = { kind: "supplier_reduce_deposit", counterpartyId: SUP, percentBps: 1500 };
const chase: Lever = { kind: "chase_overdue", counterpartyId: BUY, payWithinDays: 7 };
const cons = (c: Partial<Constraint>): Constraint => ({ kind: "supplier_reduce_deposit", counterpartyId: SUP, excluded: false, source: "counter", round: 1, ...c });
const cand = (id: string, kind: Candidate["kind"], min: string, cost: string, rejected: string[] = []): Candidate => ({ id, label: id, kind, levers: [], metrics: { minBalanceMinor: min, minBalanceWeek: 3, firstNegativeWeek: null, totalCostMinor: cost, counterpartiesNeeded: 1 }, rejectedBecause: rejected });
const dn = { minBalanceMinor: "-6000000", minBalanceWeek: 5, firstNegativeWeek: 5 };
const base = { currency: "GBP", reserveMinor: "2800000", round: 1, maxRounds: 2, responses: [], original: cand("original", "original", "3000000", "10000", ["refused"]), doNothing: dn, roundsLeft: true };

async function main() {
  // interpretation: a refusal, a counter beyond the signed limit, and a counter accepted inside it, each from structured fields only
  const entries = [{ index: 0, lever: dep, bound: { kind: "supplier_reduce_deposit", maxPercentBps: 3000 } }, { index: 1, lever: chase, bound: { kind: "chase_overdue", maxDays: 14 } }];
  const r = interpretResponses(entries, [
    { index: 0, kind: "supplier_reduce_deposit", counterpartyId: SUP, status: "needs_replan" },
    { index: 1, kind: "chase_overdue", counterpartyId: BUY, status: "agreed", agreedTerms: { payWithinDays: 10 } },
  ], [cons({ minPercentBps: 4000 })]);
  assert.deepEqual(r.map((x) => x.outcome), ["countered_beyond_limit", "countered_accepted"]);
  assert.match(r[0].summary, /40% deposit.*outside what you allowed.*30%/);
  assert.match(r[1].summary, /within 10 days instead of.*7 days.*inside your limits/);
  assert.equal(interpretResponses(entries.slice(0, 1), [{ index: 0, kind: "supplier_reduce_deposit", counterpartyId: SUP, status: "needs_replan" }], [cons({ excluded: true, source: "reject" })])[0].outcome, "refused");
  const inf = interpretResponses(entries.slice(0, 1), [{ index: 0, kind: "supplier_reduce_deposit", counterpartyId: SUP, status: "needs_replan", reason: "counter not financially feasible: the counter would leave a lowest balance of -1.00 GBP, below your safety cushion of 5.00 GBP" }], [cons({ minPercentBps: 2500 })])[0];
  assert.equal(inf.outcome, "countered_infeasible");
  assert.match(inf.summary, /inside your tolerance but not affordable.*safety cushion.*not accepted/);
  assert.equal((withTheirTerms(dep, cons({ minPercentBps: 4000 })) as any).percentBps, 4000);
  assert.equal(withTheirTerms(dep, cons({ excluded: true })), null, "a refused lever has no counter to take");

  // happy path: the cushion-keeping, cheaper feasible option wins; a rejected counter-offer never does; a worse-than-nothing option never does
  const a = decide({ ...base, candidates: [base.original, cand("counter", "counter_offer", "9000000", "1", ["above your signed limit"]), cand("plan:a", "revised_plan", "3000000", "20000"), cand("plan:b", "revised_plan", "2900000", "15000"), cand("plan:c", "revised_plan", "-7000000", "1"), cand("do_nothing", "do_nothing", dn.minBalanceMinor, "0")] });
  assert.equal(a.status, "recommended");
  assert.equal(a.selected?.id, "plan:b", "cheaper of the options that keep the cushion; the rejected counter and the worse-than-nothing plan are never chosen");
  assert.ok(a.selected!.cashImpact.join(" ").includes("keeps your safety cushion") || a.selected!.cashImpact.join(" ").includes("It keeps"), "the cash impact says whether the cushion is kept");
  assert.ok(a.selected!.tradeoffs.some((t) => /more than the original plan/.test(t)), "trade-off against the original is stated from the numbers");

  // best available: nothing keeps the cushion but one beats doing nothing -> proposed, flagged, with next steps
  const b = decide({ ...base, candidates: [cand("plan:a", "revised_plan", "1000000", "5000"), cand("do_nothing", "do_nothing", dn.minBalanceMinor, "0")] });
  assert.equal(b.status, "best_available");
  assert.ok(b.selected!.risks.some((x) => /cushion is not fully restored/.test(x)) && b.nextSteps.length > 0);

  // failure path: nothing feasible improves on doing nothing -> a clear no, next steps, no loop; the rejected counter's effect is shown for the owner's decision
  const c = decide({ ...base, roundsLeft: false, candidates: [base.original, { ...cand("counter", "counter_offer", "0", "0", ["above your signed limit"]), metrics: null, ifAccepted: { minBalanceMinor: "3500000", totalCostMinor: "12000" } }, cand("do_nothing", "do_nothing", dn.minBalanceMinor, "0")] });
  assert.equal(c.status, "no_feasible");
  assert.equal(c.selected, null);
  assert.ok(c.nextSteps.some((s) => /widened the limit/.test(s.label) && /35,000\.00 GBP/.test(s.label)), "the owner sees what widening the limit would do");
  assert.ok(c.nextSteps.some((s) => /Do nothing/.test(s.label)) && !c.nextSteps.some((s) => /Adjust the terms/.test(s.label)), "no further automatic round is offered when the limit is reached");
  console.log("  A pure decision: refusal / counter beyond limit / counter accepted read from structured fields; best feasible chosen; rejected and worse-than-nothing options never chosen; no-feasible gives next steps");

  // ---------- B. stored reports ----------
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  try {
    const steps = (await db.select().from(S.agentSteps).where(eq(S.agentSteps.kind, "note"))).filter((s) => (s.payload as any)?.type === "adaptation" && (s.payload as any).report?.v === 2); // v2 = written by the current code (the append-only log keeps older reports)
    let selected = 0, none = 0;
    for (const s of steps) {
      const rep = (s.payload as any).report;
      assert.ok(rep.round >= 1 && rep.round <= rep.maxRounds, "round within the limit");
      const keepsDn = BigInt(rep.doNothing.minBalanceMinor);
      if (rep.selected) {
        const sel = rep.candidates.find((x: any) => x.id === rep.selected.id);
        assert.ok(sel && sel.rejectedBecause.length === 0, "the chosen option passed every check");
        assert.ok(BigInt(sel.metrics.minBalanceMinor) > keepsDn, "the chosen option beats doing nothing");
        selected += 1;
      } else { assert.ok(rep.nextSteps.length > 0, "no option -> next steps"); none += 1; }
      const orig = rep.candidates.find((x: any) => x.id === "original");
      if (orig) assert.ok(orig.rejectedBecause.length > 0, "the refused original is never proposed again");
    }
    console.log(`  B ${steps.length} stored report(s): ${selected} with a chosen option, ${none} with none; invariants hold`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
