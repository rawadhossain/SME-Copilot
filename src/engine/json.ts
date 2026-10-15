// JSON wire format: every bigint becomes a string. Used by the API and by the UI.
import type { Comparison } from "./scenario";
import type { Driver, DriverAnalysis } from "./drivers";
import type { Forecast, ForecastItem } from "./types";

export type Str = string;

export interface ForecastJson {
  engineVersion: string;
  asOf: string;
  currency: string;
  variant: Forecast["variant"];
  reserveMinor: Str;
  openingBalanceMinor: Str;
  horizonWeeks: number;
  weeks: { index: number; start: string; end: string; openingMinor: Str; inflowMinor: Str; outflowMinor: Str; closingMinor: Str; belowReserve: boolean }[];
  items: ItemJson[];
  outsideHorizon: ItemJson[];
  minimum: { amountMinor: Str; weekIndex: number; weekStart: string };
  firstBreach: { weekIndex: number; weekStart: string; closingMinor: Str; shortfallMinor: Str } | null;
  maxShortfallMinor: Str;
  weeksBelowZero: number[];
  parameters: Forecast["parameters"];
}

export type ItemJson = Omit<ForecastItem, "amount"> & { amountMinor: Str };

const item = (i: ForecastItem): ItemJson => {
  const { amount, ...rest } = i;
  return { ...rest, amountMinor: amount.toString() };
};

export function forecastToJson(f: Forecast): ForecastJson {
  return {
    engineVersion: f.engineVersion,
    asOf: f.asOf,
    currency: f.currency,
    variant: f.variant,
    reserveMinor: f.reserve.toString(),
    openingBalanceMinor: f.openingBalance.toString(),
    horizonWeeks: f.horizonWeeks,
    weeks: f.weeks.map((w) => ({
      index: w.index, start: w.start, end: w.end, openingMinor: w.opening.toString(), inflowMinor: w.inflow.toString(),
      outflowMinor: w.outflow.toString(), closingMinor: w.closing.toString(), belowReserve: w.belowReserve,
    })),
    items: f.items.map(item),
    outsideHorizon: f.outsideHorizon.map(item),
    minimum: { amountMinor: f.minimum.amount.toString(), weekIndex: f.minimum.weekIndex, weekStart: f.minimum.weekStart },
    firstBreach: f.firstBreach && { weekIndex: f.firstBreach.weekIndex, weekStart: f.firstBreach.weekStart, closingMinor: f.firstBreach.closing.toString(), shortfallMinor: f.firstBreach.shortfall.toString() },
    maxShortfallMinor: f.maxShortfall.toString(),
    weeksBelowZero: f.weeksBelowZero,
    parameters: f.parameters,
  };
}

export interface ComparisonJson {
  baselineMinimum: ForecastJson["minimum"];
  scenarioMinimum: ForecastJson["minimum"];
  minimumDeltaMinor: Str;
  weekly: { weekIndex: number; weekStart: string; baselineClosingMinor: Str; scenarioClosingMinor: Str; deltaMinor: Str }[];
  baselineFirstBreach: ForecastJson["firstBreach"];
  scenarioFirstBreach: ForecastJson["firstBreach"];
  createsNewBreach: boolean;
  baselineMaxShortfallMinor: Str;
  scenarioMaxShortfallMinor: Str;
}

const breach = (b: Comparison["baselineFirstBreach"]): ForecastJson["firstBreach"] =>
  b && { weekIndex: b.weekIndex, weekStart: b.weekStart, closingMinor: b.closing.toString(), shortfallMinor: b.shortfall.toString() };
const min = (m: Comparison["baselineMinimum"]): ForecastJson["minimum"] => ({ amountMinor: m.amount.toString(), weekIndex: m.weekIndex, weekStart: m.weekStart });

export function comparisonToJson(c: Comparison): ComparisonJson {
  return {
    baselineMinimum: min(c.baselineMinimum),
    scenarioMinimum: min(c.scenarioMinimum),
    minimumDeltaMinor: c.minimumDelta.toString(),
    weekly: c.weekly.map((w) => ({ weekIndex: w.weekIndex, weekStart: w.weekStart, baselineClosingMinor: w.baselineClosing.toString(), scenarioClosingMinor: w.scenarioClosing.toString(), deltaMinor: w.delta.toString() })),
    baselineFirstBreach: breach(c.baselineFirstBreach),
    scenarioFirstBreach: breach(c.scenarioFirstBreach),
    createsNewBreach: c.createsNewBreach,
    baselineMaxShortfallMinor: c.baselineMaxShortfall.toString(),
    scenarioMaxShortfallMinor: c.scenarioMaxShortfall.toString(),
  };
}

export interface DriverJson extends Omit<Driver, "effectOnMinimum"> {
  effectOnMinimumMinor: Str;
}
export interface SequentialStepJson {
  kind: Driver["kind"];
  label: string;
  refs: string[];
  effectMinor: Str;
  minimumAfterMinor: Str;
}
export interface DriverAnalysisJson {
  minimumMinor: Str;
  maxShortfallMinor: Str;
  reserveMinor: Str;
  drivers: DriverJson[];
  sequential: SequentialStepJson[];
  totalEffectMinor: Str;
  minimumWithoutDriversMinor: Str;
}

export function driversToJson(d: DriverAnalysis): DriverAnalysisJson {
  return {
    minimumMinor: d.minimum.toString(),
    maxShortfallMinor: d.maxShortfall.toString(),
    reserveMinor: d.reserve.toString(),
    drivers: d.drivers.map(({ effectOnMinimum, ...rest }) => ({ ...rest, effectOnMinimumMinor: effectOnMinimum.toString() })),
    sequential: d.sequential.map((s) => ({ kind: s.kind, label: s.label, refs: s.refs, effectMinor: s.effect.toString(), minimumAfterMinor: s.minimumAfter.toString() })),
    totalEffectMinor: d.totalEffect.toString(),
    minimumWithoutDriversMinor: d.minimumWithoutDrivers.toString(),
  };
}
