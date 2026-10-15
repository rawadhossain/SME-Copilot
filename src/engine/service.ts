// Glue used by the API routes and the demo page: load from the database, run the pure engine, optionally persist.
import { z } from "zod";
import { db } from "@/db";
import type { CommitmentEvent } from "@/domain/commitment-event";
import { MAX_HORIZON_WEEKS } from "./types";
import { attributeDrivers } from "./drivers";
import { buildForecast } from "./forecast";
import { comparisonToJson, driversToJson, forecastToJson, type ComparisonJson, type DriverAnalysisJson, type ForecastJson } from "./json";
import { loadEngineInput } from "./loader";
import { runScenario } from "./scenario";
import { persistForecast } from "./store";

export const DEFAULT_DELAY_DAYS = 14;

export const variantSchema = z.enum(["baseline", "downside"]);
export const delayDaysSchema = z.coerce.number().int().min(1).max(90);
export const horizonWeeksSchema = z.coerce.number().int().min(1).max(MAX_HORIZON_WEEKS);

export interface VariantParams {
  variant: "baseline" | "downside";
  delayDays: number;
  /** 1 to 26, default 13. */
  horizonWeeks?: number;
}

const downside = (v: VariantParams) => (v.variant === "downside" ? v.delayDays : undefined);

export async function forecastFor(businessId: string, v: VariantParams, persist: boolean): Promise<{ runId: string | null; forecast: ForecastJson } | null> {
  const input = await loadEngineInput(db, businessId, undefined, v.horizonWeeks);
  if (!input) return null;
  const forecast = buildForecast(input, { downsideDelayDays: downside(v) });
  const runId = persist ? (await persistForecast(db, businessId, input, forecast)).runId : null;
  return { runId, forecast: forecastToJson(forecast) };
}

export interface ScenarioResponse {
  baselineRunId: string | null;
  scenarioRunId: string | null;
  baseline: ForecastJson;
  scenario: ForecastJson;
  comparison: ComparisonJson;
  drivers: DriverAnalysisJson;
}

export async function scenarioFor(businessId: string, events: CommitmentEvent[], v: VariantParams, persist: boolean): Promise<ScenarioResponse | null> {
  const input = await loadEngineInput(db, businessId, undefined, v.horizonWeeks);
  if (!input) return null;
  const result = runScenario(input, events, { downsideDelayDays: downside(v) });
  const drivers = attributeDrivers(input, { events, downsideDelayDays: downside(v) });
  const baselineRunId = persist ? (await persistForecast(db, businessId, input, result.baseline)).runId : null;
  const scenarioRunId = persist ? (await persistForecast(db, businessId, input, result.scenario, events)).runId : null;
  return {
    baselineRunId,
    scenarioRunId,
    baseline: forecastToJson(result.baseline),
    scenario: forecastToJson(result.scenario),
    comparison: comparisonToJson(result.comparison),
    drivers: driversToJson(drivers),
  };
}
