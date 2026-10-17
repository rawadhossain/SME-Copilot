// The pure forecast core. Plain data in, plain data out. No database, no clock, no randomness.
import { money, multiplyRatio } from "@/lib/money";
import { addDays, addMonths, diffDays, medianInt } from "./dates";
import {
  DEFAULT_OVERDUE,
  ENGINE_VERSION,
  HORIZON_WEEKS,
  MAX_HORIZON_WEEKS,
  type BillRecord,
  type CommitmentRecord,
  type EngineInput,
  type Forecast,
  type ForecastItem,
  type ForecastOptions,
  type InvoiceAdjustments,
  type InvoiceRecord,
  type LatenessStat,
  type Provenance,
  type SourceType,
  type WeekBucket,
} from "./types";

/** Minimum paid-and-open invoices (or bills) a counterparty needs before we project future ones from its pattern. */
const MIN_PATTERN_DOCS = 3;

/** Typical lateness per customer: median of (paid date - due date) over paid invoices, floored at 0. */
export function computeLateness(input: EngineInput): Map<string, LatenessStat> {
  const byCp = new Map<string, { name: string; days: number[] }>();
  for (const inv of input.invoices) {
    if (inv.status !== "paid" || !inv.paidOn) continue;
    const e = byCp.get(inv.counterpartyId) ?? { name: inv.counterpartyName, days: [] };
    e.days.push(diffDays(inv.dueOn, inv.paidOn));
    byCp.set(inv.counterpartyId, e);
  }
  const out = new Map<string, LatenessStat>();
  for (const [id, e] of [...byCp.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.set(id, { counterpartyId: id, counterpartyName: e.name, paidCount: e.days.length, shiftDays: Math.max(0, medianInt(e.days)) });
  }
  return out;
}

function mean(amounts: bigint[], currency: string): bigint {
  const sum = amounts.reduce((a, b) => a + b, 0n);
  // Mean rounded half-up to the minor unit.
  return multiplyRatio(money(sum, currency), { num: 1n, den: BigInt(amounts.length) }, "half-up").amountMinor;
}

function groupBy<T>(rows: T[], key: (r: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function commitmentDates(c: CommitmentRecord, asOf: string, end: string): string[] {
  const step = (d: string, n: number): string => {
    switch (c.frequency) {
      case "weekly": return addDays(d, 7);
      case "fortnightly": return addDays(d, 14);
      case "monthly": return addMonths(c.nextDueOn, n);
      case "quarterly": return addMonths(c.nextDueOn, 3 * n);
      case "annual": return addMonths(c.nextDueOn, 12 * n);
    }
  };
  const out: string[] = [];
  let d = c.nextDueOn;
  for (let n = 0; n < 2000 && d <= end; n++) {
    if (d >= asOf) out.push(d);
    d = step(d, n + 1);
  }
  return out;
}

export function buildForecast(input: EngineInput, options: ForecastOptions = {}): Forecast {
  const { asOf, currency } = input;
  const horizon = options.horizonWeeks ?? input.horizonWeeks ?? HORIZON_WEEKS;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_WEEKS) throw new Error(`horizonWeeks must be an integer from 1 to ${MAX_HORIZON_WEEKS}`);
  const end = addDays(asOf, horizon * 7 - 1);
  const events = options.events ?? [];
  const runRate = options.runRate ?? true;
  const noShift = new Set(options.noShiftFor ?? []);
  const delay = options.downsideDelayDays ?? null;
  const lateness = computeLateness(input);
  const shiftFor = (cpId: string): number => (noShift.has(cpId) ? 0 : (lateness.get(cpId)?.shiftDays ?? 0));
  const items: Omit<ForecastItem, "weekIndex">[] = [];
  const od = input.overdue ?? DEFAULT_OVERDUE;
  const adj: InvoiceAdjustments = { chase: [...(input.adjustments?.chase ?? []), ...(options.adjustments?.chase ?? [])], early: [...(input.adjustments?.early ?? []), ...(options.adjustments?.early ?? [])] };
  let adjustmentCost = 0n;
  const hypoDays = (cpId: string): number => (input.hypotheticalDelays ?? []).filter((d) => d.counterpartyId === cpId).reduce((n, d) => n + d.days, 0);

  // 1. Open customer invoices: due date shifted by the counterparty's typical lateness.
  for (const inv of input.invoices) {
    if (inv.status !== "open" || inv.countedIn) continue; // counted elsewhere (an order, a recurring commitment): tracked, not forecast twice
    if (inv.outstanding !== undefined && inv.outstanding <= 0n) continue;
    const stat = lateness.get(inv.counterpartyId);
    const shift = shiftFor(inv.counterpartyId);
    let date = addDays(inv.dueOn, shift);
    let amount = inv.outstanding ?? inv.amount; // only the unpaid balance is still to come
    let kind: ForecastItem["kind"] = "confirmed";
    const notes: string[] = [`Due ${inv.dueOn}.`];
    if (inv.outstanding !== undefined && inv.outstanding < inv.amount) notes.push("Partly paid; only the unpaid balance is forecast.");
    if (shift > 0 && stat) notes.push(`${inv.counterpartyName} typically pays ${shift} days late (median of ${stat.paidCount} paid invoices); shifted to ${date}.`);
    const overdueBy = inv.dueOn < asOf ? diffDays(inv.dueOn, asOf) : 0;
    if (overdueBy > 0) {
      // ADR-023: an overdue invoice is not assumed to arrive today. Collection delay after asOf, longer when it is long overdue.
      const delay = overdueBy > od.longAfterDays ? od.longDelayDays : od.delayDays;
      const assumed = addDays(asOf, delay);
      notes.push(`${overdueBy} days overdue. Assumption: collected ${delay} days after the forecast start (${assumed})${overdueBy > od.longAfterDays ? `, because it is more than ${od.longAfterDays} days overdue` : ""}.`);
      if (assumed > date) date = assumed;
      const chase = adj.chase.find((c) => c.counterpartyId === inv.counterpartyId);
      if (chase) {
        // "Within N days" is an upper bound: a commitment never makes the expected date later than the default assumption.
        const committed = addDays(asOf, chase.payWithinDays);
        if (committed < date) date = committed;
        kind = "assumption";
        notes.push(`${inv.counterpartyName} agreed to pay within ${chase.payWithinDays} days (chase); expected ${date}.`);
      }
    } else {
      const early = adj.early.find((c) => c.counterpartyId === inv.counterpartyId);
      if (early) {
        const discount = multiplyRatio(money(amount, currency), { num: BigInt(early.discountBps), den: 10000n }, "half-up").amountMinor;
        const earlier = addDays(date, -early.daysEarly);
        date = earlier < asOf ? asOf : earlier;
        amount -= discount;
        adjustmentCost += discount;
        kind = "assumption";
        notes.push(`${inv.counterpartyName} agreed to pay ${early.daysEarly} days earlier for a ${early.discountBps / 100}% discount; expected ${date}.`);
      }
    }
    const hypo = hypoDays(inv.counterpartyId);
    if (hypo > 0) {
      date = addDays(date, hypo);
      kind = "assumption";
      notes.push(`Hypothetical (simulation): ${inv.counterpartyName} pays a further ${hypo} days late; expected ${date}.`);
    }
    if (date < asOf) date = asOf;
    items.push({
      date, amount, sourceType: "invoice", sourceId: inv.id, counterpartyId: inv.counterpartyId,
      kind: kind === "assumption" ? kind : date === inv.dueOn ? "confirmed" : "estimate",
      label: `Invoice ${inv.number} from ${inv.counterpartyName}`, note: notes.join(" "),
    });
  }

  // 2. Open supplier bills on their due date (overdue bills are assumed paid at the start).
  for (const bill of input.bills) {
    if (bill.status !== "open" || bill.countedIn) continue;
    if (bill.outstanding !== undefined && bill.outstanding <= 0n) continue;
    const date = bill.dueOn < asOf ? asOf : bill.dueOn;
    items.push({
      date, amount: -(bill.outstanding ?? bill.amount), sourceType: "bill", sourceId: bill.id, counterpartyId: bill.counterpartyId, kind: "confirmed",
      label: `Bill ${bill.reference} to ${bill.counterpartyName}`,
      note: (bill.dueOn < asOf ? `Due ${bill.dueOn}, already overdue; assumed paid at the start of the forecast.` : `Due ${bill.dueOn}.`) + (bill.outstanding !== undefined && bill.outstanding < bill.amount ? " Partly paid; only the unpaid balance is forecast." : ""),
    });
  }

  // 3. Recurring commitments projected by their schedule.
  for (const c of input.commitments) {
    for (const date of commitmentDates(c, asOf, end)) {
      items.push({
        date, amount: c.amount, sourceType: "commitment", sourceId: c.id, kind: c.kind === "estimate" ? "estimate" : "confirmed",
        label: c.name, note: `${c.frequency} commitment${c.kind === "estimate" ? "; amount is an estimate" : ""}.`,
      });
    }
  }

  // 4. Run rate: invoices and bills not yet issued, projected from each counterparty's own history.
  if (runRate) {
    for (const [cpId, rows] of groupBy(input.invoices, (r) => r.counterpartyId)) {
      if (rows.length < MIN_PATTERN_DOCS) continue;
      const proj = projectPattern(rows, asOf, end, currency);
      if (!proj) continue;
      const shift = shiftFor(cpId);
      for (const issue of proj.issueDates) {
        const date = addDays(issue, proj.termsDays + shift + hypoDays(cpId));
        if (date < asOf || date > end) continue;
        items.push({
          date, amount: proj.amount, sourceType: "pattern_invoice", sourceId: `pattern:${cpId}:${issue}`, counterpartyId: cpId, kind: "estimate",
          label: `Expected invoice to ${rows[0].counterpartyName} (not yet issued)`,
          note: `Pattern: issued about every ${proj.cadenceDays} days, ${proj.termsDays}-day terms, average amount from ${rows.length} invoices. Next issue ${issue}${shift > 0 ? `; paid ${shift} days late` : ""}.`,
        });
      }
    }
    for (const [cpId, rows] of groupBy(input.bills, (r) => r.counterpartyId)) {
      if (rows.length < MIN_PATTERN_DOCS) continue;
      const proj = projectPattern(rows, asOf, end, currency);
      if (!proj) continue;
      for (const issue of proj.issueDates) {
        const date = addDays(issue, proj.termsDays);
        if (date < asOf || date > end) continue;
        items.push({
          date, amount: -proj.amount, sourceType: "pattern_bill", sourceId: `pattern:${cpId}:${issue}`, counterpartyId: cpId, kind: "estimate",
          label: `Expected bill from ${rows[0].counterpartyName} (not yet received)`,
          note: `Pattern: billed about every ${proj.cadenceDays} days, ${proj.termsDays}-day terms, average amount from ${rows.length} bills. Next issue ${issue}.`,
        });
      }
    }
  }

  // 5. Downside variant: every estimated customer receipt is delayed; those lines become assumptions.
  if (delay !== null) {
    for (const it of items) {
      if ((it.sourceType === "invoice" || it.sourceType === "pattern_invoice") && it.kind === "estimate") {
        it.date = addDays(it.date, delay);
        it.kind = "assumption";
        it.note = `${it.note ?? ""} Downside assumption: delayed a further ${delay} days to ${it.date}.`.trim();
      }
    }
  }

  // 6. Scenario commitment events (always assumptions: they are what-ifs supplied by a person or a document).
  events.forEach((e, i) => {
    if (e.currency !== currency) throw new Error(`Event "${e.label}" is in ${e.currency}, forecast is in ${currency}`);
    const clamped = e.date < asOf;
    items.push({
      date: clamped ? asOf : e.date, amount: e.amountMinor, sourceType: "event", sourceId: `event:${i}`, kind: "assumption",
      label: e.label,
      note: `Scenario ${e.kind.replaceAll("_", " ")} (source: ${e.source}, confidence: ${e.confidence})${e.sourceRef ? `, ref ${e.sourceRef}` : ""}.${clamped ? ` Dated ${e.date}, before the forecast start; placed at ${asOf}.` : ""}`,
    });
  });

  // Bucket into weeks.
  const placed: ForecastItem[] = [];
  const outside: ForecastItem[] = [];
  for (const it of items) {
    const w = Math.floor(diffDays(asOf, it.date) / 7);
    (w >= horizon ? outside : placed).push({ ...it, weekIndex: w });
  }
  const order = (a: ForecastItem, b: ForecastItem) =>
    a.date.localeCompare(b.date) || (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0) || a.sourceType.localeCompare(b.sourceType) || a.sourceId.localeCompare(b.sourceId);
  placed.sort(order);
  outside.sort(order);

  const weeks: WeekBucket[] = [];
  let opening = input.openingBalance;
  for (let w = 0; w < horizon; w++) {
    let inflow = 0n;
    let outflow = 0n;
    for (const it of placed) {
      if (it.weekIndex !== w) continue;
      if (it.amount >= 0n) inflow += it.amount;
      else outflow += -it.amount;
    }
    const closing = opening + inflow - outflow;
    weeks.push({ index: w, start: addDays(asOf, w * 7), end: addDays(asOf, w * 7 + 6), opening, inflow, outflow, closing, belowReserve: closing < input.reserve });
    opening = closing;
  }

  let minWeek = weeks[0];
  for (const w of weeks) if (w.closing < minWeek.closing) minWeek = w;
  const breach = weeks.find((w) => w.belowReserve);
  return {
    engineVersion: ENGINE_VERSION,
    asOf,
    currency,
    variant: delay !== null ? "downside" : "baseline",
    reserve: input.reserve,
    openingBalance: input.openingBalance,
    horizonWeeks: horizon,
    weeks,
    items: placed,
    outsideHorizon: outside,
    minimum: { amount: minWeek.closing, weekIndex: minWeek.index, weekStart: minWeek.start },
    firstBreach: breach ? { weekIndex: breach.index, weekStart: breach.start, closing: breach.closing, shortfall: input.reserve - breach.closing } : null,
    maxShortfall: input.reserve > minWeek.closing ? input.reserve - minWeek.closing : 0n,
    weeksBelowZero: weeks.filter((w) => w.closing < 0n).map((w) => w.index),
    adjustmentCostMinor: adjustmentCost,
    parameters: { downsideDelayDays: delay, runRate, eventCount: events.length, horizonWeeks: horizon },
  };
}

interface Pattern {
  cadenceDays: number;
  termsDays: number;
  amount: bigint;
  issueDates: string[];
}

/** Learns issue cadence, terms and average amount from a counterparty's invoices or bills and lists future issue dates up to `end`. */
function projectPattern(rows: (InvoiceRecord | BillRecord)[], asOf: string, end: string, currency: string): Pattern | null {
  const issued = rows.map((r) => r.issuedOn).sort();
  const gaps: number[] = [];
  for (let i = 1; i < issued.length; i++) gaps.push(diffDays(issued[i - 1], issued[i]));
  const positive = gaps.filter((g) => g > 0);
  if (positive.length === 0) return null;
  const cadenceDays = medianInt(positive);
  const termsDays = medianInt(rows.map((r) => diffDays(r.issuedOn, r.dueOn)));
  const amount = mean(rows.map((r) => r.amount), currency);
  let next = addDays(issued[issued.length - 1], cadenceDays);
  while (next < asOf) next = addDays(next, cadenceDays);
  const issueDates: string[] = [];
  for (let n = 0; n < 500 && next <= end; n++) {
    issueDates.push(next);
    next = addDays(next, cadenceDays);
  }
  return { cadenceDays, termsDays, amount, issueDates };
}

export type { Provenance, SourceType };
