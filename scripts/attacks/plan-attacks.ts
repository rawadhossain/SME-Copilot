// PLAN INTEGRITY and counterparty counters. The owner signs one stored plan; everything signed is bound by a hash and an Ed25519 signature. An attacker with
// database access edits what was signed, or a counterparty answers outside the signed tolerance. Sources: check:plan 2a-2c, 3a-3c, 5a (the sections the
// numbers below were taken from); the attacks here run them on throwaway clones and measure the same four things for every one.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Attack } from "./types";
import { refusal, scenario } from "./plan-scenario";

const executePlan = async (h: any, id: string) => (await import("../../src/actions/plan-exec")).executePlan(h.db, id);

export const planAttacks: Attack[] = [
  {
    id: "P01", category: "Plan integrity", moneyAttack: false,
    title: "The levers of a signed plan are edited in the database (supplier deposit changed from 20% to 15%) and the plan is executed",
    threat: "Changing what was signed after the owner approved it.",
    setup: "Clone with the sample order; a plan is signed (two confirmations recorded), then the stored plan is edited with owner-role database access.",
    attack: "executePlan on the signed authorisation.",
    expected: { kind: "refused", code: "refused", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P01");
      await h.owner`update plans set plan = jsonb_set(plan, '{levers,0,percentBps}', '1500') where business_id = ${s.clone.id} and plan_hash = ${s.planHash}`;
      return h.observe(s.clone, () => refusal(() => executePlan(h, s.authorisationId!)));
    },
  },
  {
    id: "P02", category: "Plan integrity", moneyAttack: false,
    title: "The signed terms of a plan are edited (the deposit request changed to 5%) and the plan is executed",
    threat: "Editing the exact requests the plan will send.",
    setup: "A signed plan; the stored terms are edited.", attack: "executePlan on the signed authorisation.",
    expected: { kind: "refused", code: "refused", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P02");
      await h.owner`update plan_authorisations set terms = jsonb_set(terms, '{entries,0,request,proposal,percentBps}', '500') where id = ${s.authorisationId}`;
      return h.observe(s.clone, () => refusal(() => executePlan(h, s.authorisationId!)));
    },
  },
  {
    id: "P03", category: "Plan integrity", moneyAttack: false,
    title: "The expiry of a signed plan is pushed back by a day and the plan is executed",
    threat: "Stretching how long an approval lasts.",
    setup: "A signed plan; its expiry timestamp is edited.", attack: "executePlan on the signed authorisation.",
    expected: { kind: "refused", code: "refused", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P03");
      await h.owner`update plan_authorisations set expires_at = expires_at + interval '1 day' where id = ${s.authorisationId}`;
      return h.observe(s.clone, () => refusal(() => executePlan(h, s.authorisationId!)));
    },
  },
  {
    id: "P04", category: "Plan integrity", moneyAttack: false,
    title: "The proposal letters the owner approved are edited after signing and the plan is executed",
    threat: "Changing the words that go to a counterparty after the owner read them.",
    setup: "A signed plan with approved letters and a drawn signature; one letter's text is edited in the database.", attack: "executePlan on the signed authorisation.",
    expected: { kind: "refused", code: "refused", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P04", { letters: true });
      await h.owner`update plan_authorisations set letters = replace(letters::text, 'Dear', 'Dearest')::jsonb where id = ${s.authorisationId}`;
      return h.observe(s.clone, () => refusal(() => executePlan(h, s.authorisationId!)));
    },
  },
  {
    id: "P05", category: "Plan integrity", moneyAttack: false,
    title: "A plan that goes beyond the signed limits (a 95% invoice-finance advance; the cap is 80%) is put forward for signing",
    threat: "A compromised planner proposes a plan outside the mandate and hopes it gets signed.",
    setup: "A stored plan with a 95% advance lever; signing is attempted through the normal signing steps.",
    attack: "authorisePlan (propose and check, then sign) on that plan, then try to approve the denied authorisation anyway.",
    expected: { kind: "denied", code: "maxFinanceAdvanceBps", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P05", { authorise: false, levers: (x) => [{ kind: "finance_invoice", counterpartyId: x.lenderId, advanceBps: 9500 }] });
      const { authorisePlan, approveAuthorisation } = await import("../../src/actions/plan-authorise");
      return h.observe(s.clone, async () => {
        const r: any = await authorisePlan(h.db, s.clone.id, { runId: s.runId, confirmations: 2, planId: s.planHash }, "Attack Lab Owner");
        const failing = JSON.stringify(r.gates ?? []).match(/"limit":"(\w+)","value":"[^"]*","bound":"[^"]*","ok":false/g) ?? [];
        const code = (failing[0]?.match(/"limit":"(\w+)"/) ?? [])[1] ?? String(r.status);
        const again = await refusal(() => approveAuthorisation(h.db, r.authorisationId, "Attack Lab Owner"));
        return { kind: r.status === "denied" ? "denied" : String(r.status), code, reason: `${[...(r.problems ?? []), ...((r.gates ?? []).flatMap((g: any) => g.reasons ?? []))].join(" | ")} | approving the denied authorisation anyway: ${again.kind} (${again.code}) ${again.reason}` };
      });
    },
  },
  {
    id: "P06", category: "Plan integrity", moneyAttack: false,
    title: "The owner's mandate is replaced by a different signed version after a plan was signed, then the plan is executed",
    threat: "Running an old approval under changed limits.",
    setup: "A signed plan; a version-2 mandate (signed by the owner key) replaces the active one.",
    attack: "executePlan on the earlier authorisation.",
    expected: { kind: "refused", code: "refused", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P06");
      const { signMandate } = await import("../../src/gate/owner-signing");
      const [m] = await h.rows<{ canonical: string }>`select canonical from mandates where business_id = ${s.clone.id} and active`;
      const v3 = signMandate({ ...JSON.parse(m.canonical), version: 3 });
      await h.owner`update mandates set active = false where business_id = ${s.clone.id}`;
      await h.owner`insert into mandates (business_id, version, canonical, signature, active) values (${s.clone.id}, 3, ${v3.canonical}, ${v3.signature}, true)`;
      return h.observe(s.clone, () => refusal(() => executePlan(h, s.authorisationId!)));
    },
  },
  {
    id: "P07", category: "Plan integrity", moneyAttack: false,
    title: "The same signed authorisation is executed a second time",
    threat: "Replay: running one approval twice to repeat its payments and agreements.",
    setup: "A signed plan is executed once, legitimately (it completes).", attack: "executePlan on the same authorisation again.",
    expected: { kind: "refused", code: "conflict", logged: true },
    run: async (h) => {
      const s = await scenario(h, "P07");
      const first: any = await executePlan(h, s.authorisationId!);
      if (first.status !== "completed") throw new Error(`setup: the first execution should complete (${first.status})`);
      return h.observe(s.clone, () => refusal(() => executePlan(h, s.authorisationId!)));
    },
  },
  {
    id: "U05", category: "Untrusted text", moneyAttack: false,
    title: "A supplier counters outside what the owner signed (asked 15% deposit, counter 20%, zero tolerance)",
    threat: "A counterparty answers beyond the signed tolerance and expects it to be accepted.",
    setup: "A signed plan with one lever (supplier deposit 15%) and no tolerance; the supplier's limit is set so it counters at 20%.",
    attack: "executePlan: the supplier's counter arrives.",
    expected: { kind: "not_accepted", code: "needs_replan", logged: true },
    run: async (h) => {
      const s = await scenario(h, "U05", { authorise: false, levers: (x) => [{ kind: "supplier_reduce_deposit", counterpartyId: x.supplierId, percentBps: 1500 }] });
      await h.owner`update counterparties set profile = profile || '{"maxSupplierDepositReductionBps":1000}'::jsonb where id = ${s.supplierId}`;
      const { authorisePlan } = await import("../../src/actions/plan-authorise");
      const auth: any = await authorisePlan(h.db, s.clone.id, { runId: s.runId, confirmations: 2, planId: s.planHash }, "Attack Lab Owner");
      return h.observe(s.clone, async () => {
        const r: any = await executePlan(h, auth.authorisationId);
        const threads = await h.rows<{ status: string }>`select status from sandbox_threads where business_id = ${s.clone.id}`;
        const accepted = threads.some((t: any) => t.status === "agreed");
        return { kind: r.status === "needs_replan" && !accepted ? "not_accepted" : `accepted:${r.status}`, code: String(r.status), reason: `${r.outcome?.branches?.[0]?.reason ?? ""} (thread status: ${threads.map((t: any) => t.status).join(",")})` };
      }, { core: true });
    },
  },
];
