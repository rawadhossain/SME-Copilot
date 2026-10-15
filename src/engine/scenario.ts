import type { CommitmentEvent } from "@/domain/commitment-event";
import { buildForecast } from "./forecast";
import type { EngineInput, Forecast } from "./types";

export interface Variant {
  /** Undefined or null means the baseline variant. */
  downsideDelayDays?: number | null;
  horizonWeeks?: number;
}

export interface Comparison {
  baselineMinimum: Forecast["minimum"];
  scenarioMinimum: Forecast["minimum"];
  /** scenario minimum minus baseline minimum (negative = the scenario is worse). */
  minimumDelta: bigint;
  weekly: { weekIndex: number; weekStart: string; baselineClosing: bigint; scenarioClosing: bigint; delta: bigint }[];
  baselineFirstBreach: Forecast["firstBreach"];
  scenarioFirstBreach: Forecast["firstBreach"];
  /** True when the scenario breaches the reserve but the baseline does not. */
  createsNewBreach: boolean;
  baselineMaxShortfall: bigint;
  scenarioMaxShortfall: bigint;
}

export interface ScenarioResult {
  baseline: Forecast;
  scenario: Forecast;
  comparison: Comparison;
}

/** Baseline vs baseline-plus-events, in the same variant (baseline or downside). */
export function runScenario(input: EngineInput, events: CommitmentEvent[], variant: Variant = {}): ScenarioResult {
  const delay = variant.downsideDelayDays ?? undefined;
  const baseline = buildForecast(input, { downsideDelayDays: delay, horizonWeeks: variant.horizonWeeks });
  const scenario = buildForecast(input, { downsideDelayDays: delay, events, horizonWeeks: variant.horizonWeeks });
  return { baseline, scenario, comparison: compare(baseline, scenario) };
}

export function compare(baseline: Forecast, scenario: Forecast): Comparison {
  return {
    baselineMinimum: baseline.minimum,
    scenarioMinimum: scenario.minimum,
    minimumDelta: scenario.minimum.amount - baseline.minimum.amount,
    weekly: baseline.weeks.map((w, i) => ({
      weekIndex: w.index,
      weekStart: w.start,
      baselineClosing: w.closing,
      scenarioClosing: scenario.weeks[i].closing,
      delta: scenario.weeks[i].closing - w.closing,
    })),
    baselineFirstBreach: baseline.firstBreach,
    scenarioFirstBreach: scenario.firstBreach,
    createsNewBreach: baseline.firstBreach === null && scenario.firstBreach !== null,
    baselineMaxShortfall: baseline.maxShortfall,
    scenarioMaxShortfall: scenario.maxShortfall,
  };
}
