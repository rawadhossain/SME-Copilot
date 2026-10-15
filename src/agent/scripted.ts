// SCRIPTED planning agents for the mock provider (not model output). They call the real tools, so every number they use
// comes from a tool result, exactly as the prompt demands of a real model.
//   agent.plan.v1      the good agent: investigates, searches, checks feasibility, submits three plans
//   agent.plan.bad.v1  the bad agent: submits an invented lever, a counterparty of the wrong type, out-of-bounds parameters
//                      and prose with a number that no tool produced, to exercise validation (every submission is rejected)
import { registerAgentScript, type ScriptContext } from "@/ai";
import { formatMoney, money } from "@/lib/money";
import { AGENT_PURPOSE } from "./prompt";

export const BAD_AGENT_PURPOSE = "agent.plan.bad.v1";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface SearchedLike {
  planId: string;
  levers: Json[];
  metrics: { minBalanceMinor: string; minBalanceWeek: number; firstNegativeWeek: number | null; closingAtHorizonMinor: string; totalCostMinor: string; counterpartiesNeeded: number };
}

const call = (toolName: string, input: unknown = {}) => ({ toolName, input });
const kinds = (p: SearchedLike) => p.levers.map((l) => l.kind).sort().join("+");

registerAgentScript(AGENT_PURPOSE, async (c: ScriptContext) => {
  const [overview] = (await c.step([call("get_business_overview"), call("get_forecast", { variant: "baseline", horizonWeeks: 20 }), call("get_pending_commitments")])) as Json[];
  await c.step([call("run_scenario"), call("explain_gap")]);
  await c.step([call("get_counterparties"), call("list_levers")]);
  const [search] = (await c.step([call("search_plans", { topN: 6 })])) as Json[];
  const cur = String(overview?.currency ?? "GBP");
  const ranked: SearchedLike[] = search?.ranked ?? [];
  const pareto: SearchedLike[] = search?.pareto ?? [];
  if (ranked.length === 0) return "No plan could be built from the search.";

  // A = the top-ranked plan; B = the cheapest plan that never goes below zero; C = the best plan that needs only one counterparty.
  const picks: SearchedLike[] = [ranked[0]];
  const add = (p?: SearchedLike) => {
    if (p && picks.length < 3 && !picks.some((x) => x.planId === p.planId) && !picks.some((x) => kinds(x) === kinds(p))) picks.push(p);
  };
  add([...pareto].filter((p) => p.metrics.firstNegativeWeek === null).sort((a, b) => Number(BigInt(a.metrics.totalCostMinor) - BigInt(b.metrics.totalCostMinor)))[0]);
  add(ranked.find((p) => p.metrics.counterpartiesNeeded === 1));
  for (const p of [...ranked, ...pareto]) add(p);

  await c.step(picks.map((p) => call("simulate_levers", { levers: p.levers })));
  await c.step(picks.slice(0, 2).map((p) => call("check_plan_feasibility", { levers: p.levers })));

  const fm = (minor: string) => formatMoney(money(BigInt(minor), cur), 2);
  const words = (l: Json) =>
    l.kind === "supplier_reduce_deposit" ? `cut the supplier deposit to ${l.percentBps / 100}%`
    : l.kind === "supplier_defer_balance" ? `defer the supplier balance by ${l.daysAfterShipment} days`
    : l.kind === "buyer_request_deposit" ? `ask the buyer for a ${l.percentBps / 100}% deposit`
    : `apply for an invoice-finance advance of ${l.advanceBps / 100}%`;
  const plans = picks.map((p, i) => ({
    title: `${i === 0 ? "Recommended: " : ""}${p.levers.map(words).join(", ").replace(/^./, (s) => s.toUpperCase())}`.slice(0, 120),
    levers: p.levers,
    contingencies: [] as unknown[],
    rationale:
      `The lowest balance becomes ${fm(p.metrics.minBalanceMinor)} in week ${p.metrics.minBalanceWeek}. ` +
      (p.metrics.firstNegativeWeek ? `It first goes below zero in week ${p.metrics.firstNegativeWeek}. ` : "It never goes below zero. ") +
      `The total cost is ${fm(p.metrics.totalCostMinor)} and ${p.metrics.counterpartiesNeeded} counterpart${p.metrics.counterpartiesNeeded === 1 ? "y" : "ies"} must agree.`,
  }));
  await c.step([call("submit_plans", { plans })]);
  return `Submitted ${plans.length} plans.`;
});

registerAgentScript(BAD_AGENT_PURPOSE, async (c: ScriptContext) => {
  await c.step([call("get_business_overview"), call("get_pending_commitments")]);
  const [cps, levers] = (await c.step([call("get_counterparties"), call("list_levers")])) as Json[];
  const list: Json[] = cps?.counterparties ?? [];
  const customer = list.find((x) => x.type === "customer");
  const supplier = list.find((x) => x.type === "supplier");
  const lender = list.find((x) => x.type === "lender");
  void levers;
  const base = { title: "Fix everything", rationale: "This plan helps." };
  // 1. An invented lever kind (rejected by the input schema).
  await c.step([call("submit_plans", { plans: [{ ...base, levers: [{ kind: "buyer_waive_invoice", counterpartyId: customer?.id }] }] })]);
  // 2. A counterparty of the wrong type: a supplier lever aimed at a customer.
  await c.step([call("submit_plans", { plans: [{ ...base, levers: [{ kind: "supplier_reduce_deposit", counterpartyId: customer?.id, percentBps: 1500 }] }] })]);
  // 3. Parameters outside the mandate: an advance above the cap, and a deferral longer than allowed.
  await c.step([call("submit_plans", { plans: [{ ...base, levers: [{ kind: "finance_invoice", counterpartyId: lender?.id, advanceBps: 9500 }, { kind: "supplier_defer_balance", counterpartyId: supplier?.id, daysAfterShipment: 120 }] }] })]);
  // 4. Prose with a number that no tool produced, on levers that are otherwise out of bounds (so the plan is rejected too).
  await c.step([call("submit_plans", { plans: [{ title: "Save £250,000 guaranteed", rationale: "This will save £250,000 and cut costs by 37%.", levers: [{ kind: "finance_invoice", counterpartyId: lender?.id, advanceBps: 9900 }] }] })]);
  return "Done.";
});

/** The weak agent: valid, in-bounds plans that still go below zero (a first-time-composed lever set, as a real model did). */
export const WEAK_AGENT_PURPOSE = "agent.plan.weak.v1";
registerAgentScript(WEAK_AGENT_PURPOSE, async (c: ScriptContext) => {
  await c.step([call("get_business_overview"), call("get_pending_commitments")]);
  const [cps] = (await c.step([call("get_counterparties")])) as Json[];
  const supplier = (cps?.counterparties ?? []).find((x: Json) => x.type === "supplier");
  const plans = [
    { title: "Recommended: Ask the supplier for a smaller deposit", levers: [{ kind: "supplier_reduce_deposit", counterpartyId: supplier?.id, percentBps: 1500 }], contingencies: [], rationale: "A single request to one counterparty." },
    { title: "Ask the supplier for a later balance", levers: [{ kind: "supplier_defer_balance", counterpartyId: supplier?.id, daysAfterShipment: 30 }], contingencies: [], rationale: "Delays the balance payment." },
  ];
  await c.step([call("submit_plans", { plans })]);
  return "Submitted 2 plans.";
});
