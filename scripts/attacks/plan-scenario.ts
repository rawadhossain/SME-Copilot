// Shared setup for the plan-level attacks: a clone with the sample order confirmed, a planning run, one stored plan and (optionally) a signed,
// letter-bound authorisation, built through the real pipeline (mock provider, planner forced to the deterministic fallback).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGateway, RECORDINGS_DIR, type GatewayConfig } from "../../src/ai";
import { planId, type Lever } from "../../src/domain/plan";
import { PROPOSAL_KINDS } from "../../src/gate/mandate";
import { signMandate } from "../../src/gate/owner-signing";
import { makeSignaturePng } from "../png-fixture";
import type { Clone, Harness } from "./harness";

const base: GatewayConfig = { provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR };
export const mockGateway = () => createGateway(base);
export const replayGateway = () => createGateway({ ...base, mode: "replay" });
export const fixture = (f: string) => readFileSync(join("fixtures", f), "utf8");

export interface Scenario {
  clone: Clone;
  runId: string;
  planHash: string;
  supplierId: string;
  buyerId: string;
  lenderId: string;
  authorisationId: string | null;
}

/** The three-lever plan the check scripts use: a lower supplier deposit, a deferred balance and invoice finance at the 80% cap. */
export const standardLevers = (s: { supplierId: string; lenderId: string }): Lever[] => [
  { kind: "supplier_reduce_deposit", counterpartyId: s.supplierId, percentBps: 2000 },
  { kind: "supplier_defer_balance", counterpartyId: s.supplierId, daysAfterShipment: 14 },
  { kind: "finance_invoice", counterpartyId: s.lenderId, advanceBps: 8000 },
];

export async function confirmSampleOrder(h: Harness, cloneId: string): Promise<string> {
  const docs = await import("../../src/ingest/documents");
  const { confirmExtraction } = await import("../../src/ingest/documents/confirm");
  const gw = mockGateway();
  let quoteId = "";
  for (const [filename, kind] of [["supplier-quote-kestrel.md", "supplier_quote"], ["purchase-order-northgate.md", "purchase_order"]] as const) {
    const r = await docs.createDocumentAndExtract(h.db, cloneId, { filename, kind, text: fixture(filename) }, { gateway: gw });
    await confirmExtraction(h.db, r.extraction.id, "Attack Lab Owner");
    if (kind === "supplier_quote") quoteId = r.extraction.id;
  }
  return quoteId;
}

/** Builds the scenario. `authorise: false` stops before signing; `levers` overrides the plan (for a plan beyond the mandate). */
export async function scenario(h: Harness, label: string, opts: { authorise?: boolean; levers?: (s: { supplierId: string; lenderId: string }) => Lever[]; letters?: boolean } = {}): Promise<Scenario> {
  const { startRun, buildContext } = await import("../../src/actions/agent-run");
  const { authorisePlan, previewAuthorisation } = await import("../../src/actions/plan-authorise");
  const { buildPlanView } = await import("../../src/agent");
  const clone = await h.clone(label);
  // Plan-sized limits (the demo's own mandate raised so the plan's largest payment fits), signed with the dev owner key as the seed does.
  const [m] = await h.rows<{ canonical: string }>`select canonical from mandates where business_id = ${clone.id} and active`;
  const wire = JSON.parse(m.canonical);
  wire.version = 2; wire.limits.maxPaymentMinor = "8000000"; wire.limits.maxDailyOutflowMinor = "8500000"; wire.limits.allowedProposalKinds = [...PROPOSAL_KINDS];
  const signed = signMandate({ ...wire, businessId: clone.id });
  await h.owner`update mandates set active = false where business_id = ${clone.id}`;
  await h.owner`insert into mandates (business_id, version, canonical, signature, active) values (${clone.id}, 2, ${signed.canonical}, ${signed.signature}, true)`;
  await h.owner`update financial_accounts set balance_minor = balance_minor + 4000000 where business_id = ${clone.id}`;
  await h.owner`update sandbox_bank_accounts set balance_minor = balance_minor + 4000000 where business_id = ${clone.id}`;
  const quoteId = await confirmSampleOrder(h, clone.id);
  const run = await startRun(h.db, clone.id, { type: "commitment", extractionId: quoteId }, { gateway: mockGateway(), forceFallback: true });
  const ctx = await buildContext(h.db, clone.id, null);
  const { supplierId, buyerId, lenderId } = ctx.parties;
  const levers = (opts.levers ?? standardLevers)({ supplierId: supplierId!, lenderId: lenderId! });
  const built: any = buildPlanView(ctx, { title: "Strategy under attack", levers, contingencies: [], rationale: "A plan for the attack lab." }, "deterministic");
  // A plan beyond the mandate cannot even be built by the plan builder (its own bounds check). An attacker who writes the plan row straight into the
  // database gets a stored plan anyway, which is the case the signing step has to catch: so then the row is written raw.
  const view: any = built.ok ? built.view : { id: planId(levers), title: "Beyond the mandate", levers, contingencies: [], rationale: "x", source: "deterministic", metrics: { minBalanceMinor: "0", minBalanceWeek: 1, firstNegativeWeek: null, weeksBelowReserve: 0, closingAtHorizonMinor: "0", totalCostMinor: "0", counterpartiesNeeded: 1, horizonWeeks: 20 }, checks: [], assumptions: [], proseFlagged: false, removedSentences: [] };
  (built as any).view = view;
  await h.db.insert(h.S.plans).values({ businessId: clone.id, runId: run.runId, planHash: view.id, rank: 10, plan: JSON.parse(JSON.stringify(view)) });
  const sc: Scenario = { clone, runId: run.runId, planHash: built.view.id, supplierId: supplierId!, buyerId: buyerId!, lenderId: lenderId!, authorisationId: null };
  if (opts.authorise === false) return sc;
  const input: any = { runId: run.runId, confirmations: 2, planId: built.view.id };
  if (opts.letters) {
    const prev: any = await previewAuthorisation(h.db, clone.id, input);
    input.letters = prev.letters;
    input.signatureImage = makeSignaturePng();
  }
  const auth: any = await authorisePlan(h.db, clone.id, input, "Attack Lab Owner");
  sc.authorisationId = auth.authorisationId;
  (sc as any).authStatus = auth.status;
  (sc as any).authProblems = auth.problems;
  (sc as any).authGates = auth.gates;
  return sc;
}

/** What a refused call looks like to the lab: an ActionError code and the system's own words. */
export async function refusal(fn: () => Promise<unknown>): Promise<{ kind: string; code: string; reason: string }> {
  try {
    await fn();
    return { kind: "allowed", code: "none", reason: "the call succeeded" };
  } catch (e: any) {
    return { kind: "refused", code: String(e?.code ?? e?.name ?? "error"), reason: String(e?.message ?? e) };
  }
}
