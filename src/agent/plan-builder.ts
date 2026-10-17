// Validates and completes a plan: every number is computed here by the engine; the model prose is checked against it.
// Pure with respect to the snapshot in AgentToolContext (no database, no clock, no writes).
import { checkProse, collectNumbers } from "./prose";
import type { AgentToolContext } from "./context";
import { constraintProblems } from "@/domain/constraints";
import { planId, sortLevers, type Contingency, type Lever, type LeverCheck, type PlanSubmission, type PlanView } from "@/domain/plan";
import { buildForecast } from "@/engine";
import { FINANCE_FEE_BPS_ASSUMPTION, earlyPaymentBuyers, leverToRequest, originalDepositBps, overdueBuyers, simulateLevers } from "@/engine/plans";
import { checkSignedMandate, evaluate, requestSchema, type Mandate } from "@/gate";
import { formatMoney, money } from "@/lib/money";

export const MAX_DEFER_DAYS = 60;
export const MAX_BUYER_DEPOSIT_BPS = 5000;
export const MAX_CHASE_DAYS = 30;
export const MAX_EARLY_DAYS = 60;

const KIND_TO_PROPOSAL: Record<Lever["kind"], string> = {
  supplier_reduce_deposit: "supplier.reduce_deposit",
  supplier_defer_balance: "supplier.defer_balance",
  buyer_request_deposit: "buyer.request_deposit",
  finance_invoice: "lender.apply_invoice_finance",
  chase_overdue: "buyer.chase_payment",
  early_payment_discount: "buyer.request_early_payment",
};
const KIND_TO_ROLE: Record<Lever["kind"], "supplier" | "customer" | "lender"> = {
  supplier_reduce_deposit: "supplier",
  supplier_defer_balance: "supplier",
  buyer_request_deposit: "customer",
  finance_invoice: "lender",
  chase_overdue: "customer",
  early_payment_discount: "customer",
};

export const baseEventsOf = (ctx: AgentToolContext) => ctx.pending.map((p) => p.event);

export function mandateOf(ctx: AgentToolContext): { ok: true; mandate: Mandate } | { ok: false; reason: string } {
  const c = checkSignedMandate(ctx.mandate);
  return c.ok ? { ok: true, mandate: c.mandate } : { ok: false, reason: c.reason };
}

/** Parameter bounds, taken from the signed mandate where it has a limit, else from documented planning policy (ADR-015). */
export function leverBounds(ctx: AgentToolContext) {
  const m = mandateOf(ctx);
  const orig = originalDepositBps(baseEventsOf(ctx));
  const allowed = (kind: Lever["kind"]) => m.ok && (m.mandate.limits.allowedProposalKinds as string[]).includes(KIND_TO_PROPOSAL[kind]);
  // Constraints learned from counterparty replies (ADR-021) narrow the bounds; a refused lever is unavailable.
  const cs = ctx.constraints;
  const refused = (kind: Lever["kind"], cpId: string | null) => cs.some((c) => c.kind === kind && c.counterpartyId === cpId && c.excluded) || (ctx.unavailable ?? []).some((u) => u.kind === kind && u.counterpartyId === cpId);
  const depMin = Math.max(1, ...cs.filter((c) => c.kind === "supplier_reduce_deposit" && c.counterpartyId === ctx.parties.supplierId).map((c) => c.minPercentBps ?? 1));
  const deferMax = Math.min(MAX_DEFER_DAYS, ...cs.filter((c) => c.kind === "supplier_defer_balance" && c.counterpartyId === ctx.parties.supplierId).map((c) => c.maxDays ?? MAX_DEFER_DAYS));
  const buyMax = Math.min(MAX_BUYER_DEPOSIT_BPS, ...cs.filter((c) => c.kind === "buyer_request_deposit" && c.counterpartyId === ctx.parties.buyerId).map((c) => c.maxPercentBps ?? MAX_BUYER_DEPOSIT_BPS));
  // Chase and early payment act on the books' invoices (ADR-024): candidates are customers with overdue / not-yet-due open invoices.
  const chaseBuyers = overdueBuyers(ctx.input).filter((id) => !refused("chase_overdue", id));
  const earlyBuyers = earlyPaymentBuyers(ctx.input).filter((id) => !refused("early_payment_discount", id));
  const discountCap = m.ok ? m.mandate.limits.maxEarlyPaymentDiscountBps : 0;
  const chaseMinDays = Math.max(1, ...cs.filter((c) => c.kind === "chase_overdue").map((c) => c.minDays ?? 1));
  const earlyMinDiscount = Math.max(1, ...cs.filter((c) => c.kind === "early_payment_discount").map((c) => c.minDiscountBps ?? 1));
  return {
    mandateValid: m.ok,
    mandateProblem: m.ok ? null : m.reason,
    chase_overdue: { available: allowed("chase_overdue") && chaseBuyers.length > 0 && chaseMinDays <= MAX_CHASE_DAYS, payWithinDays: { min: chaseMinDays, max: MAX_CHASE_DAYS }, candidates: chaseBuyers },
    early_payment_discount: { available: allowed("early_payment_discount") && earlyBuyers.length > 0 && discountCap >= earlyMinDiscount, daysEarly: { min: 1, max: MAX_EARLY_DAYS }, discountBps: { min: earlyMinDiscount, max: discountCap }, candidates: earlyBuyers },
    supplier_reduce_deposit: { available: allowed("supplier_reduce_deposit") && orig !== null && !refused("supplier_reduce_deposit", ctx.parties.supplierId) && depMin <= (orig ?? 0) - 1, percentBps: { min: depMin, max: orig !== null ? orig - 1 : 0 }, originalPercentBps: orig },
    supplier_defer_balance: { available: allowed("supplier_defer_balance") && !refused("supplier_defer_balance", ctx.parties.supplierId) && deferMax >= 1, daysAfterShipment: { min: 1, max: deferMax } },
    buyer_request_deposit: { available: allowed("buyer_request_deposit") && !refused("buyer_request_deposit", ctx.parties.buyerId) && buyMax >= 1, percentBps: { min: 1, max: buyMax } },
    finance_invoice: { available: allowed("finance_invoice") && m.ok && !refused("finance_invoice", ctx.parties.lenderId), advanceBps: { min: 1, max: m.ok ? m.mandate.limits.maxFinanceAdvanceBps : 0 }, feeBpsAssumed: ctx.financeFeeBps },
  };
}

/** Problems that make a lever set invalid: catalogue, counterparty type, mandate bounds, one lever per kind. */
export function leverProblems(ctx: AgentToolContext, levers: Lever[]): string[] {
  const problems: string[] = [];
  const b = leverBounds(ctx);
  if (!b.mandateValid) problems.push(`The signed mandate is invalid (${b.mandateProblem}); no lever can be used`);
  problems.push(...constraintProblems(levers, ctx.constraints));
  const seen = new Set<string>();
  for (const l of levers) {
    if (seen.has(l.kind)) problems.push(`Only one "${l.kind}" lever is allowed in a plan`);
    seen.add(l.kind);
    const cp = ctx.counterparties.find((c) => c.id === l.counterpartyId);
    if (!cp) problems.push(`${l.kind}: unknown counterparty`);
    else if (cp.role !== KIND_TO_ROLE[l.kind]) problems.push(`${l.kind}: the counterparty must be a ${KIND_TO_ROLE[l.kind]}, not a ${cp.role}`);
    switch (l.kind) {
      case "supplier_reduce_deposit":
        if (!b.supplier_reduce_deposit.available) problems.push("supplier_reduce_deposit is not available");
        else if (l.percentBps < b.supplier_reduce_deposit.percentBps.min || l.percentBps > b.supplier_reduce_deposit.percentBps.max) problems.push(`supplier_reduce_deposit: percentBps must be between ${b.supplier_reduce_deposit.percentBps.min} and ${b.supplier_reduce_deposit.percentBps.max}`);
        break;
      case "supplier_defer_balance":
        if (!b.supplier_defer_balance.available) problems.push("supplier_defer_balance is not available");
        else if (l.daysAfterShipment > MAX_DEFER_DAYS) problems.push(`supplier_defer_balance: daysAfterShipment must be at most ${MAX_DEFER_DAYS}`);
        break;
      case "buyer_request_deposit":
        if (!b.buyer_request_deposit.available) problems.push("buyer_request_deposit is not available");
        else if (l.percentBps > MAX_BUYER_DEPOSIT_BPS) problems.push(`buyer_request_deposit: percentBps must be at most ${MAX_BUYER_DEPOSIT_BPS}`);
        break;
      case "chase_overdue":
        if (!b.chase_overdue.available) problems.push("chase_overdue is not available (no overdue invoices, or not allowed)");
        else {
          if (!b.chase_overdue.candidates.includes(l.counterpartyId)) problems.push("chase_overdue: this customer has no overdue invoice");
          if (l.payWithinDays < b.chase_overdue.payWithinDays.min || l.payWithinDays > MAX_CHASE_DAYS) problems.push(`chase_overdue: payWithinDays must be between ${b.chase_overdue.payWithinDays.min} and ${MAX_CHASE_DAYS}`);
        }
        break;
      case "early_payment_discount":
        if (!b.early_payment_discount.available) problems.push("early_payment_discount is not available (no invoices to pay early, or not allowed)");
        else {
          if (!b.early_payment_discount.candidates.includes(l.counterpartyId)) problems.push("early_payment_discount: this customer has no open invoice that is not yet due");
          if (l.discountBps > b.early_payment_discount.discountBps.max) problems.push(`early_payment_discount: discount ${l.discountBps / 100}% is above the mandate cap of ${b.early_payment_discount.discountBps.max / 100}%`);
          if (l.discountBps < b.early_payment_discount.discountBps.min) problems.push(`early_payment_discount: discount is below the ${b.early_payment_discount.discountBps.min / 100}% a counterparty already said it needs`);
          if (l.daysEarly > MAX_EARLY_DAYS) problems.push(`early_payment_discount: daysEarly must be at most ${MAX_EARLY_DAYS}`);
        }
        break;
      case "finance_invoice":
        if (!b.finance_invoice.available) problems.push("finance_invoice is not available");
        else if (l.advanceBps > b.finance_invoice.advanceBps.max) problems.push(`finance_invoice: advanceBps ${l.advanceBps} is above the mandate cap of ${b.finance_invoice.advanceBps.max}`);
        break;
    }
  }
  return problems;
}

/**
 * The supplier payments a lever set implies (the engine's changed events), checked against the signed per-payment and daily limits. The gate checks
 * these payments again at run time and would stop the plan; this finds the problem while the owner is still choosing. Pure.
 */
export function impliedPaymentBlockers(ctx: AgentToolContext, events: { kind: string; date: string; amountMinor: bigint }[]): string[] {
  const m = mandateOf(ctx);
  if (!m.ok) return [];
  const unmatched = [...baseEventsOf(ctx)];
  const added: { kind: string; date: string; amountMinor: bigint }[] = [];
  for (const e of events) {
    const i = unmatched.findIndex((b) => b.kind === e.kind && b.date === e.date && b.amountMinor === e.amountMinor);
    if (i >= 0) unmatched.splice(i, 1);
    else added.push(e);
  }
  const pays = added.filter((e) => (e.kind === "supplier_deposit" || e.kind === "supplier_balance") && e.amountMinor < 0n).map((e) => ({ date: e.date, amount: -e.amountMinor, kind: e.kind }));
  const maxPayment = BigInt(String(m.mandate.limits.maxPaymentMinor));
  const maxDaily = BigInt(String(m.mandate.limits.maxDailyOutflowMinor));
  const out: string[] = [];
  const label = (k: string) => (k === "supplier_deposit" ? "supplier deposit" : "supplier balance payment");
  for (const p of pays) if (p.amount > maxPayment) out.push(`The ${label(p.kind)} these terms imply is ${fmt(p.amount.toString(), ctx.currency)} on ${p.date}, above your per-payment limit of ${fmt(maxPayment.toString(), ctx.currency)}, so the plan would be stopped when it runs`);
  const byDate = new Map<string, bigint>();
  for (const p of pays) byDate.set(p.date, (byDate.get(p.date) ?? 0n) + p.amount);
  for (const [date, total] of byDate) if (total > maxDaily && pays.filter((p) => p.date === date).length > 1) out.push(`The supplier payments these terms imply on ${date} total ${fmt(total.toString(), ctx.currency)}, above your daily limit of ${fmt(maxDaily.toString(), ctx.currency)}`);
  return out;
}

/** True when none of the payments a lever set implies breaks a signed limit; the search offers only such plans. Pure. */
export function isRunnable(ctx: AgentToolContext, levers: Lever[]): boolean {
  try {
    const sim = simulateLevers(ctx.input, baseEventsOf(ctx), levers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps });
    return impliedPaymentBlockers(ctx, sim.events).length === 0;
  } catch {
    return false;
  }
}

/** Pure gate dry-run per lever. Writes nothing. */
export function dryRun(ctx: AgentToolContext, levers: Lever[]): LeverCheck[] {
  const base = baseEventsOf(ctx);
  return sortLevers(levers).map((lever) => {
    const request = leverToRequest(lever, base, levers);
    if (!request) return { lever, request: null, decision: "deny" as const, reasons: ["The lever cannot be turned into a request (the order data it needs is missing)"] };
    const r = evaluate(ctx.mandate, ctx.gateState, requestSchema.parse(request));
    return { lever, request, decision: r.decision, reasons: r.reasons };
  });
}

const fmt = (minor: string, cur: string) => formatMoney(money(BigInt(minor), cur), 2);

/** Human-readable description of a lever, with numbers taken from the lever itself. */
export function describeLever(l: Lever, ctx: AgentToolContext): string {
  const name = ctx.counterparties.find((c) => c.id === l.counterpartyId)?.name ?? "a counterparty";
  const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
  switch (l.kind) {
    case "supplier_reduce_deposit": return `Ask ${name} to cut the deposit to ${pct(l.percentBps)}`;
    case "supplier_defer_balance": return `Ask ${name} to take the balance ${l.daysAfterShipment} days after shipment`;
    case "buyer_request_deposit": return `Ask ${name} for a ${pct(l.percentBps)} deposit`;
    case "finance_invoice": return `Apply to ${name} for an invoice-finance advance of ${pct(l.advanceBps)}`;
    case "chase_overdue": return `Ask ${name} to pay its overdue invoices within ${l.payWithinDays} days`;
    case "early_payment_discount": return `Offer ${name} a ${pct(l.discountBps)} discount to pay ${l.daysEarly} days early`;
  }
}

export function assumptionsFor(ctx: AgentToolContext, levers: Lever[]): string[] {
  const a = [
    "Counterparty agreement is unknown until asked: no likelihood is given.",
    `Cash effect is computed over ${ctx.horizonWeeks} weeks by the deterministic engine, starting ${ctx.asOf}.`,
    "Each lever becomes a proposal that must pass the permission gate and the owner's approval before anything is sent.",
  ];
  if (levers.some((l) => l.kind === "finance_invoice")) a.push(`Invoice-finance fee assumed ${(ctx.financeFeeBps / 100).toFixed(1)}% of the invoice face value (ADR-010${ctx.financeFeeBps !== FINANCE_FEE_BPS_ASSUMPTION ? ", updated from a lender reply" : ""}); the real fee is known only when the application is answered.`);
  return a;
}

export type BuildResult = { ok: true; view: PlanView } | { ok: false; reasons: string[] };

/** Everything a plan needs: validation, engine metrics, gate dry-run, checked prose. */
export function buildPlanView(ctx: AgentToolContext, sub: PlanSubmission, source: "ai" | "deterministic" | "owner"): BuildResult {
  const reasons: string[] = [];
  reasons.push(...leverProblems(ctx, sub.levers));
  sub.contingencies.forEach((c: Contingency, i) => {
    if (c.ifRefusedLeverIndex >= sub.levers.length) reasons.push(`contingency ${i}: ifRefusedLeverIndex points at a lever that does not exist`);
    reasons.push(...leverProblems(ctx, c.useLevers).map((r) => `contingency ${i}: ${r}`));
  });
  if (reasons.length > 0) return { ok: false, reasons };

  let sim;
  try {
    sim = simulateLevers(ctx.input, baseEventsOf(ctx), sub.levers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps });
  } catch (e) {
    return { ok: false, reasons: [e instanceof Error ? e.message : "The levers cannot be simulated"] };
  }
  const checks = dryRun(ctx, sub.levers);
  const denied = checks.filter((c) => c.decision === "deny");
  if (denied.length > 0) return { ok: false, reasons: denied.map((d) => `${d.lever.kind} would be denied by the gate: ${d.reasons.join("; ")}`) };

  // Numbers the prose may use: tool results seen so far, this plan own computed fields, its levers, the mandate limits.
  const allowed = new Set<string>(ctx.seen);
  collectNumbers([sim.metrics, sub.levers, sub.contingencies, sim.events.map((e) => e.amountMinor.toString())], allowed);
  const m = mandateOf(ctx);
  if (m.ok) collectNumbers({ ...m.mandate.limits, allowedProposalKinds: undefined }, allowed);

  const blockers = impliedPaymentBlockers(ctx, sim.events);
  const title = checkProse(sub.title, allowed);
  const rationale = checkProse(sub.rationale, allowed);
  const removed = [...title.removed, ...rationale.removed];
  const fallbackTitle = sub.levers.map((l) => describeLever(l, ctx)).join("; ").slice(0, 120);
  return {
    ok: true,
    view: {
      id: planId(sub.levers),
      title: title.text.trim() === "" ? fallbackTitle : title.text,
      levers: sortLevers(sub.levers),
      // Contingency indexes refer to the lever order as submitted; the view stores levers sorted, so remap them.
      contingencies: sub.contingencies.map((c) => ({ ...c, ifRefusedLeverIndex: Math.max(0, sortLevers(sub.levers).findIndex((l) => planId([l]) === planId([sub.levers[c.ifRefusedLeverIndex]]))) })),
      rationale: rationale.text.trim() === "" ? "The rationale was removed because it contained numbers that no tool produced. See the computed effects." : rationale.text,
      source,
      metrics: sim.metrics,
      checks,
      assumptions: assumptionsFor(ctx, sub.levers),
      ...(sub.levers.some((l) => l.kind === "finance_invoice") ? { financeFeeBps: ctx.financeFeeBps } : {}),
      proseFlagged: removed.length > 0,
      removedSentences: removed,
      ...(blockers.length > 0 ? { blockers, warnings: blockers.map((b) => `${b}.`) } : {}),
    },
  };
}

/** The "do nothing" baseline over the planning horizon, for contrast. Also used by the page. */
export function doNothingSummary(ctx: AgentToolContext) {
  const f = buildForecast(ctx.input, { events: baseEventsOf(ctx), horizonWeeks: ctx.horizonWeeks });
  return {
    minBalanceMinor: f.minimum.amount.toString(),
    minBalanceWeek: f.minimum.weekIndex + 1,
    firstNegativeWeek: f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null,
    weeksBelowReserve: f.weeks.filter((w) => w.belowReserve).length,
    weeksBelowZero: f.weeksBelowZero.length,
    closingAtHorizonMinor: f.weeks[f.weeks.length - 1].closing.toString(),
  };
}

export { fmt as formatMinor };
