// Persists forecast runs (ForecastRun, ForecastLine weekly rows, forecast_items). Never writes action_records.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { db as appDb } from "@/db";
import { forecastItems, forecastLines, forecastRuns } from "@/db/schema";
import { commitmentEventToJson, type CommitmentEvent } from "@/domain/commitment-event";
import type { EngineInput, Forecast, Provenance } from "./types";

type Db = typeof appDb;

const RANK: Record<Provenance, number> = { actual: 0, confirmed: 1, estimate: 2, assumption: 3 };

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x.toString()}n` : x));

export function forecastInputHash(input: EngineInput, forecast: Forecast, events: CommitmentEvent[]): string {
  const payload = stable({ engine: forecast.engineVersion, input, parameters: forecast.parameters, events: events.map(commitmentEventToJson) });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export async function persistForecast(
  db: Db,
  businessId: string,
  input: EngineInput,
  forecast: Forecast,
  events: CommitmentEvent[] = [],
): Promise<{ runId: string; created: boolean }> {
  const inputHash = forecastInputHash(input, forecast, events);
  const [existing] = await db
    .select({ id: forecastRuns.id })
    .from(forecastRuns)
    .where(and(eq(forecastRuns.businessId, businessId), eq(forecastRuns.inputHash, inputHash)));
  if (existing) return { runId: existing.id, created: false };

  const assumptions = [
    `Variant: ${forecast.variant}.`,
    forecast.parameters.downsideDelayDays !== null ? `Estimated customer receipts delayed by ${forecast.parameters.downsideDelayDays} days.` : "",
    forecast.parameters.runRate ? "Invoices and bills not yet issued are projected from each counterparty's history." : "No run-rate projection.",
    events.length > 0 ? `Scenario events: ${events.map((e) => e.label).join("; ")}.` : "",
    `Reserve ${forecast.reserve.toString()} minor units.`,
  ].filter(Boolean).join(" ");

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(forecastRuns)
      .values({
        businessId,
        startsOn: forecast.asOf,
        horizonWeeks: forecast.horizonWeeks,
        assumptions,
        variant: forecast.variant,
        parameters: { ...forecast.parameters, engineVersion: forecast.engineVersion, events: events.map(commitmentEventToJson) },
        inputHash,
        summary: {
          minimumMinor: forecast.minimum.amount.toString(),
          minimumWeekIndex: forecast.minimum.weekIndex,
          firstBreachWeekIndex: forecast.firstBreach?.weekIndex ?? null,
          maxShortfallMinor: forecast.maxShortfall.toString(),
        },
      })
      .returning({ id: forecastRuns.id });

    await tx.insert(forecastLines).values(
      forecast.weeks.map((w) => {
        const kinds = forecast.items.filter((i) => i.weekIndex === w.index).map((i) => i.kind);
        const kind = kinds.length === 0 ? "confirmed" : kinds.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
        return {
          businessId, forecastRunId: run.id, weekStart: w.start, currency: forecast.currency,
          openingMinor: w.opening, inflowMinor: w.inflow, outflowMinor: w.outflow, closingMinor: w.closing, kind, sourceRef: null,
        };
      }),
    );
    if (forecast.items.length > 0) {
      await tx.insert(forecastItems).values(
        forecast.items.map((i) => ({
          businessId, forecastRunId: run.id, weekIndex: i.weekIndex, occursOn: i.date, currency: forecast.currency, amountMinor: i.amount,
          kind: i.kind, sourceType: i.sourceType, sourceId: i.sourceId, label: i.label, note: i.note ?? null,
        })),
      );
    }
    return { runId: run.id, created: true };
  });
}
