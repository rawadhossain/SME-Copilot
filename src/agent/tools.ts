// The planning agent's tools. ALL READ-ONLY: pure functions of an AgentToolContext snapshot. Inputs and outputs are zod
// validated; errors come back as { ok: false, error } and never throw to the model. No tool returns raw document text or any
// counterparty free text, and none reads a counterparty profile. submit_plans only validates and stores in memory; the
// orchestrator (outside src/agent) persists. Nothing here executes, proposes to a counterparty, or creates an approval.
import { z } from "zod";
import type { AgentTool } from "@/ai";
import { leverSchema, submitPlansInputSchema, LEVER_KINDS, type Lever, type PlanView } from "@/domain/plan";
import { attributeDrivers, buildForecast, computeLateness, isForecast, medianInt, type Forecast } from "@/engine";
import { searchPlans, simulateLevers, type SearchedPlan } from "@/engine/plans";
import { compareOffers } from "@/engine/financing";
import { buildPlanView, baseEventsOf, doNothingSummary, dryRun, isRunnable, leverBounds, leverProblems, mandateOf } from "./plan-builder";
import { collectNumbers } from "./prose";
import type { AgentToolContext, PendingEvent, ValidationNote } from "./context";

type Out = Record<string, unknown>;

const err = (error: string, extra: Out = {}): Out => ({ ok: false, error, ...extra });
const withSeen = (ctx: AgentToolContext, out: Out): Out => {
  collectNumbers(out, ctx.seen);
  return out;
};

const empty = z.object({});
const refs = z.array(z.string().regex(/^pc\d+$/)).max(10).optional();

function forecastSummary(f: Forecast): Out {
  return {
    asOf: f.asOf, variant: f.variant, horizonWeeks: f.horizonWeeks, currency: f.currency, reserveMinor: f.reserve.toString(), openingBalanceMinor: f.openingBalance.toString(),
    minimum: { amountMinor: f.minimum.amount.toString(), week: f.minimum.weekIndex + 1 },
    firstWeekBelowReserve: f.firstBreach ? f.firstBreach.weekIndex + 1 : null,
    weeksBelowZero: f.weeksBelowZero.map((w) => w + 1),
    weeks: f.weeks.map((w) => ({ week: w.index + 1, closingMinor: w.closing.toString() })),
  };
}


function pick(ctx: AgentToolContext, wanted: string[] | undefined): { events: PendingEvent[] } | { error: string } {
  if (!wanted || wanted.length === 0) return { events: ctx.pending };
  const events = wanted.map((r) => ctx.pending.find((p) => p.ref === r));
  const missing = wanted.filter((_, i) => !events[i]);
  return missing.length > 0 ? { error: `Unknown event refs: ${missing.join(", ")}` } : { events: events as PendingEvent[] };
}

export function buildAgentTools(ctx: AgentToolContext): Record<string, AgentTool> {
  const baseEvents = baseEventsOf(ctx);
  const bounds = () => leverBounds(ctx);

  // Every plan in a search result carries its mandate check (the same pure gate dry-run as check_plan_feasibility), so the model does not
  // need a separate feasibility step: reads + search in step 1, submit in step 2 (Batch 11: the model used to run out of steps at 3).
  const planOut = (p: SearchedPlan): Out => {
    const checks = dryRun(ctx, p.levers);
    const denied = checks.filter((c) => c.decision === "deny");
    return { planId: p.id, levers: p.levers, metrics: p.metrics, deviation: p.deviation, mandate: denied.length ? { ok: false, reason: denied[0].reasons[0] } : { ok: true } };
  };

  const tools: Record<string, AgentTool> = {
    get_business_overview: {
      description: "Overview of the business: opening bank balance, owner reserve, open invoices and bills, overdue invoices, recurring commitments. Read-only.",
      parameters: empty,
      execute: () => {
        const i = ctx.input;
        const open = i.invoices.filter(isForecast);
        const overdue = open.filter((x) => x.dueOn < i.asOf);
        const openBills = i.bills.filter(isForecast);
        const sum = (rows: { amount: bigint; outstanding?: bigint }[]) => rows.reduce((a, x) => a + (x.outstanding ?? x.amount), 0n).toString();
        // Only present when payments were part-recorded or something is counted elsewhere, so a business without them reads exactly as before.
        const partly = [...open, ...openBills].filter((x) => x.outstanding !== undefined && x.outstanding < x.amount);
        const countedElsewhere = [...i.invoices, ...i.bills].filter((x) => x.status === "open" && x.countedIn).length;
        return withSeen(ctx, {
          ok: true, asOf: i.asOf, currency: i.currency, openingBalanceMinor: i.openingBalance.toString(), reserveMinor: i.reserve.toString(),
          openInvoices: { count: open.length, totalMinor: sum(open) },
          overdueInvoices: { count: overdue.length, totalMinor: sum(overdue) },
          openBills: { count: openBills.length, totalMinor: sum(openBills) },
          ...(partly.length > 0 ? { partlyPaid: { count: partly.length, unpaidMinor: sum(partly) } } : {}),
          ...(countedElsewhere > 0 ? { countedElsewhereNotForecastTwice: countedElsewhere } : {}),
          recurringCommitments: i.commitments.map((c) => ({ name: c.name, amountMinor: c.amount.toString(), frequency: c.frequency, nextDueOn: c.nextDueOn, kind: c.kind })),
        });
      },
    },

    get_forecast: {
      description: "The deterministic cash forecast without the new commitment: weekly closing balances, the lowest balance, weeks below the reserve.",
      parameters: z.object({ variant: z.enum(["baseline", "downside"]).default("baseline"), horizonWeeks: z.number().int().min(1).max(26).optional() }),
      execute: (a: { variant: "baseline" | "downside"; horizonWeeks?: number }) =>
        withSeen(ctx, { ok: true, ...forecastSummary(buildForecast(ctx.input, { horizonWeeks: a.horizonWeeks ?? ctx.horizonWeeks, downsideDelayDays: a.variant === "downside" ? 14 : undefined })) }),
    },

    get_pending_commitments: {
      description: "Commitments from CONFIRMED document extractions that are not yet in the books (supplier deposit, supplier balance, customer receipt). Each has a ref (pc1, pc2, ...) to use in other tools. Provenance only; no document text.",
      parameters: empty,
      execute: () =>
        withSeen(ctx, {
          ok: true,
          commitments: ctx.pending.map((p) => ({
            ref: p.ref, kind: p.event.kind, date: p.event.date, amountMinor: p.event.amountMinor.toString(), currency: p.event.currency, confidence: p.event.confidence,
            provenance: { source: p.event.source, extractionId: p.extractionId, confirmedByOwner: true },
          })),
        }),
    },

    run_scenario: {
      description: "Baseline versus baseline plus the pending commitments (all of them unless eventRefs is given): lowest balance and week, first negative week, comparison by week.",
      parameters: z.object({ eventRefs: refs, variant: z.enum(["baseline", "downside"]).default("baseline"), horizonWeeks: z.number().int().min(1).max(26).optional() }),
      execute: (a: { eventRefs?: string[]; variant: "baseline" | "downside"; horizonWeeks?: number }) => {
        const p = pick(ctx, a.eventRefs);
        if ("error" in p) return err(p.error);
        const horizonWeeks = a.horizonWeeks ?? ctx.horizonWeeks;
        const down = a.variant === "downside" ? 14 : undefined;
        const base = buildForecast(ctx.input, { horizonWeeks, downsideDelayDays: down });
        const scen = buildForecast(ctx.input, { horizonWeeks, downsideDelayDays: down, events: p.events.map((x) => x.event) });
        return withSeen(ctx, { ok: true, baseline: forecastSummary(base), scenario: forecastSummary(scen), minimumDeltaMinor: (scen.minimum.amount - base.minimum.amount).toString() });
      },
    },

    explain_gap: {
      description: "What drives the gap in the scenario: drivers removed one after another in rank order, so the steps add up to the total change in the lowest balance.",
      parameters: z.object({ eventRefs: refs }),
      execute: (a: { eventRefs?: string[] }) => {
        const p = pick(ctx, a.eventRefs);
        if ("error" in p) return err(p.error);
        const d = attributeDrivers(ctx.input, { events: p.events.map((x) => x.event), horizonWeeks: ctx.horizonWeeks });
        // Event drivers are described by tool-owned labels (kind and date), never by document-derived text.
        const nameOf = (s: { kind: string; label: string; refs: string[] }) => {
          if (s.kind !== "event") return s.label;
          const i = Number((s.refs.find((r) => r.startsWith("event:")) ?? "event:0").slice(6));
          const e = p.events[i];
          return e ? `${e.event.kind.replaceAll("_", " ")} on ${e.event.date} (${e.ref})` : "an event";
        };
        return withSeen(ctx, {
          ok: true, lowestBalanceMinor: d.minimum.toString(), reserveMinor: d.reserve.toString(), totalEffectMinor: d.totalEffect.toString(), lowestBalanceWithoutDriversMinor: d.minimumWithoutDrivers.toString(),
          steps: d.sequential.map((s) => ({ driver: nameOf(s), kind: s.kind, effectMinor: s.effect.toString(), lowestBalanceAfterMinor: s.minimumAfter.toString() })),
        });
      },
    },

    get_counterparties: {
      description: "Counterparties (id, name, type) with history statistics: customers have paid-invoice counts and median days late; suppliers have payment terms. No personality or profile data.",
      parameters: empty,
      execute: () => {
        const late = computeLateness(ctx.input);
        return withSeen(ctx, {
          ok: true,
          counterparties: ctx.counterparties.map((c) => {
            if (c.role === "customer") {
              const l = late.get(c.id);
              return { id: c.id, name: c.name, type: c.role, paidInvoices: l?.paidCount ?? 0, medianDaysLate: l ? l.shiftDays : null };
            }
            if (c.role === "supplier") {
              const terms = ctx.input.bills.filter((b) => b.counterpartyId === c.id).map((b) => (Date.parse(`${b.dueOn}T00:00:00Z`) - Date.parse(`${b.issuedOn}T00:00:00Z`)) / 86_400_000);
              return { id: c.id, name: c.name, type: c.role, bills: terms.length, paymentTermsDays: terms.length > 0 ? medianInt(terms) : null };
            }
            return { id: c.id, name: c.name, type: c.role };
          }),
        });
      },
    },

    list_levers: {
      description: "The levers available (each maps to one proposal kind) with parameter bounds taken from the signed mandate where it has limits, and the counterparty each applies to.",
      parameters: empty,
      execute: () => {
        const b = bounds();
        return withSeen(ctx, {
          ok: b.mandateValid, mandateValid: b.mandateValid, ...(b.mandateValid ? {} : { error: `The signed mandate is invalid: ${b.mandateProblem}` }),
          horizonWeeks: ctx.horizonWeeks,
          learnedConstraints: ctx.constraints.map((c) => ({ kind: c.kind, counterpartyId: c.counterpartyId, excluded: c.excluded, minPercentBps: c.minPercentBps, maxPercentBps: c.maxPercentBps, maxDays: c.maxDays, assumedFeeBps: c.assumedFeeBps })),
          levers: [
            { kind: "supplier_reduce_deposit", counterpartyId: ctx.parties.supplierId, mapsTo: "supplier.reduce_deposit", ...b.supplier_reduce_deposit },
            { kind: "supplier_defer_balance", counterpartyId: ctx.parties.supplierId, mapsTo: "supplier.defer_balance", ...b.supplier_defer_balance },
            { kind: "buyer_request_deposit", counterpartyId: ctx.parties.buyerId, mapsTo: "buyer.request_deposit", ...b.buyer_request_deposit },
            { kind: "finance_invoice", counterpartyId: ctx.parties.lenderId, mapsTo: "lender.apply_invoice_finance", ...b.finance_invoice },
            { kind: "chase_overdue", mapsTo: "buyer.chase_payment", ...b.chase_overdue },
            { kind: "early_payment_discount", mapsTo: "buyer.request_early_payment", ...b.early_payment_discount },
          ],
        });
      },
    },

    simulate_levers: {
      description: "Computed cash effect of a set of levers (at most one of each kind): lowest balance and week, first negative week, weeks below reserve, closing balance at the horizon, total cost, counterparties needed.",
      parameters: z.object({ levers: z.array(leverSchema).min(1).max(6) }),
      execute: (a: { levers: Lever[] }) => {
        const problems = leverProblems(ctx, a.levers);
        if (problems.length > 0) return err("Invalid levers", { problems });
        try {
          const s = simulateLevers(ctx.input, baseEvents, a.levers, { horizonWeeks: ctx.horizonWeeks, financeFeeBps: ctx.financeFeeBps });
          return withSeen(ctx, { ok: true, planId: s.id, levers: s.levers, metrics: s.metrics, doNothing: doNothingSummary(ctx) });
        } catch (e) {
          return err(e instanceof Error ? e.message : "Simulation failed");
        }
      },
    },

    search_plans: {
      description: "START HERE (call it in your first step together with the reads). Each plan already includes its mandate check, so no separate feasibility call is needed. Choose your plans from these ranked results (the best plan of each different kind) and copy their levers exactly. Deterministic search over lever combinations (supplier deposit 25/20/15%, balance deferral 14/30 days, buyer deposit 10/20%, finance up to the mandate cap). Returns the top plans, the cost versus lowest-balance Pareto set, and the do-nothing baseline.",
      parameters: z.object({
        topN: z.number().int().min(1).max(10).default(5),
        allowFinance: z.boolean().default(true),
        maxCounterparties: z.number().int().min(1).max(3).optional(),
        requireAtLeast: z.enum(["reserve", "zero"]).optional(),
        maxCostMinor: z.string().regex(/^\d+$/).optional(),
      }),
      execute: (a: { topN: number; allowFinance: boolean; maxCounterparties?: number; requireAtLeast?: "reserve" | "zero"; maxCostMinor?: string }) => {
        const b = bounds();
        if (!b.mandateValid) return err(`The signed mandate is invalid: ${b.mandateProblem}`);
        const allowedKinds = LEVER_KINDS.filter((k) => b[k].available && (k !== "finance_invoice" || a.allowFinance));
        const r = searchPlans(ctx.input, baseEvents, ctx.parties, {
          horizonWeeks: ctx.horizonWeeks, financeCapBps: b.finance_invoice.available ? b.finance_invoice.advanceBps.max : null, allowedKinds, topN: Math.max(a.topN, 40),
          maxCounterparties: a.maxCounterparties, requireAtLeast: a.requireAtLeast ?? null, maxCostMinor: a.maxCostMinor ? BigInt(a.maxCostMinor) : null,
          constraints: ctx.constraints, financeFeeBps: ctx.financeFeeBps, earlyDiscountCapBps: b.early_payment_discount.available ? b.early_payment_discount.discountBps.max : null,
        });
        // Plans whose implied payments break a signed limit are never offered (they would be stopped at run time).
        const runnable = (p: SearchedPlan) => isRunnable(ctx, p.levers);
        return withSeen(ctx, { ok: true, evaluated: r.evaluated, doNothing: r.baseline.metrics, ranked: r.ranked.filter(runnable).slice(0, a.topN).map(planOut), pareto: r.pareto.filter(runnable).slice(0, 8).map(planOut) });
      },
    },

    check_plan_feasibility: {
      description: "Dry-run of the permission gate for each lever of a plan: allow, needs_approval or deny with reasons. Writes nothing. Fails clearly if the signed mandate is invalid.",
      parameters: z.object({ levers: z.array(leverSchema).min(1).max(6) }),
      execute: (a: { levers: Lever[] }) => {
        const m = mandateOf(ctx);
        const checks = dryRun(ctx, a.levers);
        const shown = checks.map((c) => ({ lever: c.lever, decision: c.decision, reasons: c.reasons, request: c.request }));
        if (!m.ok) return withSeen(ctx, err(`The signed mandate is invalid: ${m.reason}. Every lever is denied.`, { mandateValid: false, levers: shown }));
        return withSeen(ctx, { ok: true, mandateValid: true, overall: checks.some((c) => c.decision === "deny") ? "blocked" : "needs_owner_approval", levers: shown });
      },
    },

    submit_plans: {
      description: "FINAL. Submit 1 to 3 plans, the recommended plan first. Each has a title, levers, optional contingencies (if lever N is refused, use these levers) and a short rationale. Do NOT include computed numbers as data; any number in the prose must come from a tool result. Invalid plans are rejected with reasons.",
      parameters: submitPlansInputSchema,
      execute: (a: z.output<typeof submitPlansInputSchema>) => {
        if (ctx.submitted) return err("Plans were already submitted");
        const accepted: PlanView[] = [];
        const rejected: { index: number; reasons: string[] }[] = [];
        const notes: ValidationNote[] = [];
        a.plans.forEach((sub, index) => {
          const r = buildPlanView(ctx, sub, "ai");
          if (!r.ok) {
            rejected.push({ index, reasons: r.reasons });
            notes.push({ planIndex: index, accepted: false, reasons: r.reasons });
          } else if (accepted.some((x) => x.id === r.view.id)) {
            rejected.push({ index, reasons: ["Duplicate of an earlier plan in this submission"] });
            notes.push({ planIndex: index, accepted: false, reasons: ["duplicate plan"] });
          } else {
            accepted.push(r.view);
            notes.push({ planIndex: index, accepted: true, reasons: r.view.proseFlagged ? [`prose flagged: ${r.view.removedSentences.length} sentence(s) removed`] : [] });
          }
        });
        ctx.notes.push(...notes);
        if (accepted.length === 0) return err("No valid plan in this submission", { rejected });
        ctx.submitted = accepted;
        return { ok: true, accepted: accepted.map((p, i) => ({ rank: i + 1, planId: p.id, proseFlagged: p.proseFlagged })), rejected };
      },
    },
  };

  // Funding comparison (Phase K). Offered to the model ONLY when the owner has saved offers, so a run without offers sends exactly the same
  // request as before. Read-only. The model sees "offer1", "offer2"... and product types, never the lender's name or the owner's label: those
  // are free text. Every figure comes from the engine and joins the numbers the model's prose may use.
  if (ctx.fundingOffers && ctx.fundingOffers.length > 0) {
    const saved = ctx.fundingOffers;
    tools.compare_financing_options = {
      description: "Compare the funding offers the owner has saved with NOT borrowing: total cost, estimated yearly cost, the effect on the lowest balance, debt service coverage and warnings, all computed by the engine. Read-only; it does not apply for anything. Mention only the figures it returns, and say plainly when not borrowing is enough.",
      parameters: empty,
      execute: () => {
        const m = mandateOf(ctx);
        const lim = m.ok ? m.mandate.limits : null;
        const c = compareOffers(ctx.input, baseEvents, saved, { horizonWeeks: ctx.horizonWeeks, maxAnnualisedCostBps: lim?.maxFundingCostBps ?? null, maxAmountMinor: lim?.maxFundingAmountMinor ?? null });
        const ref = new Map(saved.map((o, i) => [o.id, `offer${i + 1}`]));
        return withSeen(ctx, {
          ok: true,
          notBorrowing: { lowestBalanceMinor: c.doNotBorrow.minBalanceMinor.toString(), lowestBalanceWeek: c.doNotBorrow.minBalanceWeek, firstNegativeWeek: c.doNotBorrow.firstNegativeWeek, weeksBelowReserve: c.doNotBorrow.weeksBelowReserve, borrowingNeeded: c.borrowingNeeded },
          offers: c.offers.map((o) => ({
            ref: ref.get(o.offerId), product: o.product, totalCostMinor: o.cost.totalCostMinor.toString(), costOfAmountBps: o.cost.costOfAmountBps, simpleYearlyCostBps: o.cost.annualisedCostBps,
            lowestBalanceMinor: o.summary.minBalanceMinor.toString(), lowestBalanceWeek: o.summary.minBalanceWeek, changeInLowestBalanceMinor: o.lowestBalanceImprovementMinor.toString(),
            coverRatioX100: o.dscr.ratioX100, withinSignedCostLimit: o.withinCostCap, withinSignedAmountLimit: o.withinAmountCap, warnings: o.warnings,
          })),
          cheapestFirst: c.cheapestFirst.map((id) => ref.get(id)),
        });
      },
    };
  }
  return tools;
}

