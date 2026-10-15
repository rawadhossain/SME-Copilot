// Driver attribution by removal. Two views, both deterministic:
//  1. Standalone: take each driver out on its own, rebuild the forecast, and report how much the minimum
//     closing balance improves. Effects can overlap, so they need not add up.
//  2. Sequential: remove drivers cumulatively in rank order (largest standalone effect first) and report each
//     step's improvement of the minimum. These steps add up exactly to the total movement of the minimum
//     between "everything on" and "all drivers removed".
import type { CommitmentEvent } from "@/domain/commitment-event";
import { buildForecast, computeLateness } from "./forecast";
import type { EngineInput, ForecastOptions } from "./types";

export type DriverKind = "event" | "counterparty_delay" | "downside_delay";

export interface Driver {
  kind: DriverKind;
  label: string;
  /** Source references: event index/ref, or the invoice ids and pattern lines affected by a counterparty delay. */
  refs: string[];
  /** Improvement of the minimum closing balance if this driver were removed on its own (minor units; can be negative). */
  effectOnMinimum: bigint;
  /** effectOnMinimum as basis points of the deepest shortfall; null when there is no shortfall. */
  shareOfShortfallBps: number | null;
}

export interface SequentialStep {
  kind: DriverKind;
  label: string;
  refs: string[];
  /** Improvement of the minimum when this driver is removed after all higher-ranked drivers were already removed. */
  effect: bigint;
  /** Minimum closing balance after this step. */
  minimumAfter: bigint;
}

export interface DriverAnalysis {
  minimum: bigint;
  maxShortfall: bigint;
  reserve: bigint;
  /** Standalone view, ranked by effect (largest first), ties by label. Zero-effect drivers are omitted. */
  drivers: Driver[];
  /** Sequential view in the same rank order. Steps with zero effect are omitted; the rest sum to totalEffect. */
  sequential: SequentialStep[];
  /** Minimum with every driver removed minus the minimum with everything on. Equals the sum of sequential steps. */
  totalEffect: bigint;
  minimumWithoutDrivers: bigint;
}

interface Candidate {
  kind: DriverKind;
  label: string;
  refs: string[];
  eventIndex?: number;
  counterpartyId?: string;
}

export function attributeDrivers(input: EngineInput, options: ForecastOptions = {}): DriverAnalysis {
  const events: CommitmentEvent[] = options.events ?? [];
  const base = buildForecast(input, options);
  const candidates: Candidate[] = [];

  events.forEach((e, i) => {
    candidates.push({ kind: "event", label: e.label, refs: [e.sourceRef ?? `event:${i}`, `event:${i}`], eventIndex: i });
  });

  const alreadyIgnored = new Set(options.noShiftFor ?? []);
  for (const stat of computeLateness(input).values()) {
    if (stat.shiftDays <= 0 || alreadyIgnored.has(stat.counterpartyId)) continue;
    const refs = base.items
      .filter((it) => it.counterpartyId === stat.counterpartyId && (it.sourceType === "invoice" || it.sourceType === "pattern_invoice"))
      .map((it) => it.sourceId);
    candidates.push({
      kind: "counterparty_delay",
      label: `${stat.counterpartyName} pays ${stat.shiftDays} days late`,
      refs: refs.length > 0 ? refs : [stat.counterpartyId],
      counterpartyId: stat.counterpartyId,
    });
  }
  if (options.downsideDelayDays) {
    candidates.push({ kind: "downside_delay", label: `Downside assumption: customer receipts delayed ${options.downsideDelayDays} days`, refs: ["downside"] });
  }

  // Options with a given set of candidates removed.
  const without = (removed: Candidate[]): ForecastOptions => {
    const dropEvents = new Set(removed.filter((c) => c.eventIndex !== undefined).map((c) => c.eventIndex!));
    return {
      ...options,
      events: events.filter((_, i) => !dropEvents.has(i)),
      noShiftFor: [...alreadyIgnored, ...removed.filter((c) => c.counterpartyId).map((c) => c.counterpartyId!)],
      downsideDelayDays: removed.some((c) => c.kind === "downside_delay") ? undefined : options.downsideDelayDays,
    };
  };
  const minOf = (removed: Candidate[]) => buildForecast(input, without(removed)).minimum.amount;

  const standalone = candidates.map((c) => ({ c, effect: minOf([c]) - base.minimum.amount }));
  standalone.sort((a, b) => (a.effect < b.effect ? 1 : a.effect > b.effect ? -1 : a.c.label.localeCompare(b.c.label)));

  const drivers: Driver[] = standalone
    .filter((s) => s.effect !== 0n)
    .map((s) => ({
      kind: s.c.kind,
      label: s.c.label,
      refs: s.c.refs,
      effectOnMinimum: s.effect,
      shareOfShortfallBps: base.maxShortfall > 0n ? Number((s.effect * 10000n) / base.maxShortfall) : null,
    }));

  const sequential: SequentialStep[] = [];
  const removed: Candidate[] = [];
  let previous = base.minimum.amount;
  for (const s of standalone) {
    removed.push(s.c);
    const now = minOf(removed);
    if (now !== previous) sequential.push({ kind: s.c.kind, label: s.c.label, refs: s.c.refs, effect: now - previous, minimumAfter: now });
    previous = now;
  }

  return {
    minimum: base.minimum.amount,
    maxShortfall: base.maxShortfall,
    reserve: base.reserve,
    drivers,
    sequential,
    totalEffect: previous - base.minimum.amount,
    minimumWithoutDrivers: previous,
  };
}
