// FINANCIAL FLIGHT SIMULATOR, pure part. A scenario is a list of hypothetical shocks. `applyShocks` returns a COPY of the business (engine input,
// order events, learned refusals); the live objects are never touched, so a simulation cannot change a real record. Everything is then run through
// the same engine as the real forecast. No database, no clock, no model, no probabilities: counterparty acceptance is never predicted.
import type { CommitmentEvent } from "@/domain/commitment-event";
import type { Constraint } from "@/domain/constraints";
import { money, multiplyRatio } from "@/lib/money";
import { addDays } from "./dates";
import { buildForecast } from "./forecast";
import { adjustmentsOf, type TermChanges } from "./term-changes";
import type { BillRecord, EngineInput, Forecast, ForecastItem } from "./types";

export type Shock =
  /** A customer pays every expected receipt this many days later than the forecast says (invoices, expected invoices and the order payment). */
  | { kind: "customer_late"; counterpartyId: string; days: number }
  /** A customer pays this share (basis points, 1..10000) less than expected on every open invoice and on the order payment. */
  | { kind: "customer_short"; counterpartyId: string; shortBps: number }
  /** A supplier refuses to move its terms: a deferral of the balance, a lower deposit, or both. Removes those rescue actions; nothing else. */
  | { kind: "supplier_refuses"; counterpartyId: string; lever: "supplier_defer_balance" | "supplier_reduce_deposit" | "both" }
  /** An unexpected bill or expense of this amount falls due on this date. */
  | { kind: "unexpected_expense"; amountMinor: bigint; dueOn: string; label: string };

export const MAX_SHOCKS = 6;
export const MAX_LATE_DAYS = 90;

export interface ShockParties { buyerId: string | null }

export interface HypotheticalWorld {
  input: EngineInput;
  events: CommitmentEvent[];
  /** Counterparty refusals the scenario assumes, as the planner's own constraints (they remove the rescue actions exactly as a real refusal does). */
  refusals: Constraint[];
  /** One plain sentence per shock: what was assumed. */
  assumptions: string[];
}

export class ShockError extends Error {}

const SYNTHETIC_PREFIX = "sim:";

function validate(s: Shock, asOf: string): void {
  switch (s.kind) {
    case "customer_late":
      if (!Number.isInteger(s.days) || s.days < 1 || s.days > MAX_LATE_DAYS) throw new ShockError(`A late payment must be 1 to ${MAX_LATE_DAYS} days`);
      return;
    case "customer_short":
      if (!Number.isInteger(s.shortBps) || s.shortBps < 1 || s.shortBps > 10000) throw new ShockError("A short payment must be between 0.01% and 100%");
      return;
    case "unexpected_expense":
      if (s.amountMinor <= 0n) throw new ShockError("An unexpected expense must be more than zero");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.dueOn)) throw new ShockError("An unexpected expense needs a due date");
      if (s.dueOn < asOf) throw new ShockError("An unexpected expense cannot be due in the past");
      return;
    case "supplier_refuses":
      return;
  }
}

const shareOf = (amount: bigint, bps: number, currency: string): bigint => multiplyRatio(money(amount, currency), { num: BigInt(bps), den: 10000n }, "half-up").amountMinor;

/**
 * Apply the shocks to COPIES. `input` and `baseEvents` are read, never modified (the check script proves it by comparing before and after).
 * Order of effects does not matter except for two shocks on the same customer: a late AND short customer is both (days add up, shares compound once).
 */
export function applyShocks(input: EngineInput, baseEvents: CommitmentEvent[], parties: ShockParties, shocks: Shock[], fmt: (minor: bigint) => string = (m) => m.toString()): HypotheticalWorld {
  if (shocks.length > MAX_SHOCKS) throw new ShockError(`At most ${MAX_SHOCKS} events can be combined`);
  for (const s of shocks) validate(s, input.asOf);
  const cur = input.currency;
  const nameOf = (id: string) => input.invoices.find((i) => i.counterpartyId === id)?.counterpartyName ?? input.bills.find((b) => b.counterpartyId === id)?.counterpartyName ?? "A counterparty";
  const copy: EngineInput = {
    ...input,
    invoices: input.invoices.map((i) => ({ ...i })),
    bills: input.bills.map((b) => ({ ...b })),
    commitments: input.commitments.map((c) => ({ ...c })),
    ...(input.adjustments ? { adjustments: { chase: input.adjustments.chase.map((c) => ({ ...c })), early: input.adjustments.early.map((e) => ({ ...e })) } } : {}),
    ...(input.hypotheticalDelays ? { hypotheticalDelays: input.hypotheticalDelays.map((d) => ({ ...d })) } : {}),
  };
  const events = baseEvents.map((e) => ({ ...e }));
  const refusals: Constraint[] = [];
  const assumptions: string[] = [];
  let expenses = 0;

  for (const s of shocks) {
    switch (s.kind) {
      case "customer_late": {
        copy.hypotheticalDelays = [...(copy.hypotheticalDelays ?? []), { counterpartyId: s.counterpartyId, days: s.days }];
        if (s.counterpartyId === parties.buyerId) for (const e of events) if (e.kind === "customer_receipt") { e.date = addDays(e.date, s.days); e.label = `${e.label} [simulated: ${s.days} days late]`.slice(0, 200); }
        assumptions.push(`${nameOf(s.counterpartyId)} pays ${s.days} days later than the forecast expects, on everything it owes, including any new promise to pay sooner.`);
        break;
      }
      case "customer_short": {
        for (const i of copy.invoices) {
          if (i.counterpartyId !== s.counterpartyId || i.status !== "open") continue;
          const owed = i.outstanding ?? i.amount;
          i.outstanding = owed - shareOf(owed, s.shortBps, cur);
        }
        if (s.counterpartyId === parties.buyerId) for (const e of events) if (e.kind === "customer_receipt") { e.amountMinor -= shareOf(e.amountMinor, s.shortBps, cur); e.label = `${e.label} [simulated: pays ${s.shortBps / 100}% less]`.slice(0, 200); }
        assumptions.push(`${nameOf(s.counterpartyId)} pays ${s.shortBps / 100}% less than expected on every open invoice and on the order payment. The shortfall is not collected within the forecast.`);
        break;
      }
      case "supplier_refuses": {
        const kinds = s.lever === "both" ? (["supplier_defer_balance", "supplier_reduce_deposit"] as const) : ([s.lever] as const);
        for (const kind of kinds) refusals.push({ kind, counterpartyId: s.counterpartyId, excluded: true, source: "decline", round: 1 });
        assumptions.push(`${nameOf(s.counterpartyId)} refuses ${s.lever === "both" ? "both a payment deferral and a lower deposit" : s.lever === "supplier_defer_balance" ? "a payment deferral" : "a lower deposit"}. This is an assumption for the simulation, not something the supplier said.`);
        break;
      }
      case "unexpected_expense": {
        expenses += 1;
        const bill: BillRecord = {
          id: `${SYNTHETIC_PREFIX}expense:${expenses}`, reference: `SIM-${expenses}`, counterpartyId: `${SYNTHETIC_PREFIX}expense:${expenses}`, counterpartyName: s.label.trim().slice(0, 60) || "Unexpected expense",
          issuedOn: input.asOf, dueOn: s.dueOn, amount: s.amountMinor, status: "open",
        };
        copy.bills.push(bill);
        assumptions.push(`An unexpected expense "${bill.counterpartyName}" of ${fmt(s.amountMinor)} falls due ${s.dueOn}.`);
        break;
      }
    }
  }
  return { input: copy, events, refusals, assumptions };
}

// ------------------------------------------------------------------------------------------------------------------ what the scenario does

export interface ForecastView {
  minBalanceMinor: bigint;
  minBalanceWeek: number;
  firstBelowReserveWeek: number | null;
  firstNegativeWeek: number | null;
  /** Reserve minus the lowest balance when positive, else 0. */
  gapMinor: bigint;
  weeksBelowReserve: number;
  weeklyClosing: bigint[];
}

export function viewOf(f: Forecast): ForecastView {
  return {
    minBalanceMinor: f.minimum.amount, minBalanceWeek: f.minimum.weekIndex + 1,
    firstBelowReserveWeek: f.firstBreach ? f.firstBreach.weekIndex + 1 : null,
    firstNegativeWeek: f.weeksBelowZero.length > 0 ? f.weeksBelowZero[0] + 1 : null,
    gapMinor: f.maxShortfall > 0n ? f.maxShortfall : 0n, weeksBelowReserve: f.weeks.filter((w) => w.belowReserve).length,
    weeklyClosing: f.weeks.map((w) => w.closing),
  };
}

export interface ItemChange { label: string; before: { date: string; amountMinor: bigint } | null; after: { date: string; amountMinor: bigint } | null }

const keyOf = (i: ForecastItem) => `${i.sourceType}|${i.sourceId}|${i.label.replace(/ \[simulated.*$/, "")}`;

/** Forecast lines that differ between the live forecast and the simulated one (moved, smaller, new, gone), biggest first. Recurring commitments cannot differ. */
export function changedItems(live: Forecast, sim: Forecast, limit = 12): ItemChange[] {
  const rows = (f: Forecast) => new Map(f.items.filter((i) => i.sourceType !== "commitment").map((i) => [keyOf(i), i]));
  const a = rows(live);
  const b = rows(sim);
  const out: (ItemChange & { size: bigint })[] = [];
  const abs = (n: bigint) => (n < 0n ? -n : n);
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) out.push({ label: x.label, before: { date: x.date, amountMinor: x.amount }, after: null, size: abs(x.amount) });
    else if (y.date !== x.date || y.amount !== x.amount) out.push({ label: x.label, before: { date: x.date, amountMinor: x.amount }, after: { date: y.date, amountMinor: y.amount }, size: abs(x.amount) > abs(y.amount) ? abs(x.amount) : abs(y.amount) });
  }
  for (const [k, y] of b) if (!a.has(k)) out.push({ label: y.label, before: null, after: { date: y.date, amountMinor: y.amount }, size: abs(y.amount) });
  return out.sort((p, q) => (p.size === q.size ? p.label.localeCompare(q.label) : p.size > q.size ? -1 : 1)).slice(0, limit).map(({ size: _s, ...rest }) => (void _s, rest));
}

export interface CauseRow {
  /** Index into the scenario's shock list. */
  shockIndex: number;
  /** Lowest balance if only this event happened. */
  aloneMinBalanceMinor: bigint;
  /** That minus the lowest balance today (negative = worse). */
  aloneDeltaMinor: bigint;
}

export interface Causes {
  rows: CauseRow[];
  /** All events together, minus the lowest balance today. */
  combinedDeltaMinor: bigint;
  /** Combined effect minus the sum of the separate effects: nonzero when the events hit the same weeks (they are never simply added). */
  interactionMinor: bigint;
}

/** Each event on its own against the live forecast, then all together: the engine runs the whole forecast every time. */
export function attributeShocks(input: EngineInput, baseEvents: CommitmentEvent[], parties: ShockParties, shocks: Shock[], term: { horizonWeeks: number; changes?: TermChanges }): Causes {
  const run = (w: { input: EngineInput; events: CommitmentEvent[] }) => buildForecast(w.input, { events: w.events, horizonWeeks: term.horizonWeeks, adjustments: adjustmentsOf(term.changes ?? {}) }).minimum.amount;
  const live = run({ input, events: baseEvents });
  const rows: CauseRow[] = shocks.map((s, shockIndex) => {
    const min = run(applyShocks(input, baseEvents, parties, [s]));
    return { shockIndex, aloneMinBalanceMinor: min, aloneDeltaMinor: min - live };
  });
  const combined = run(applyShocks(input, baseEvents, parties, shocks)) - live;
  return { rows, combinedDeltaMinor: combined, interactionMinor: combined - rows.reduce((n, r) => n + r.aloneDeltaMinor, 0n) };
}
