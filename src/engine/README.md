# engine

The deterministic cash engine. Plain code, no AI. Same input, same output. Full method and conventions: ADR-008 in docs/decisions.md.

## How it works, in plain language

1. **Start from the bank balance** on the as-of date (taken from the data, not the clock). That is the only `actual` figure.
2. **Lay known money on a 13-week calendar** (week 1 starts on the as-of date, 7 days per week):
   - open invoices arrive on their due date, **moved later by how late that customer usually pays** (the median of their past paid invoices). Moved lines are `estimate`; with no history the due date is used and the line is `confirmed`;
   - open supplier bills leave on their due date (`confirmed`);
   - recurring commitments (payroll, rent, VAT, subscriptions, loan) repeat on their schedule (`confirmed`, or `estimate` when the amount is only an estimate).
3. **Add the run rate.** Invoices and bills that have not been issued yet are projected from each customer's and supplier's own rhythm (how often, what terms, average size). Without this the forecast would show costs but no future sales. These lines are `estimate`.
4. **Add the reserve** the owner set (`businesses.reserve_minor`). The forecast reports the lowest closing balance and week, the first week below the reserve, and how deep it goes.
5. **Scenarios.** A list of `CommitmentEvent`s (dated cash in or out, e.g. a deposit) is laid on top as `assumption` lines. The result is compared with the baseline week by week. The shape of `CommitmentEvent` is in `src/domain/commitment-event.ts`; the future document reader will output exactly that.
6. **Downside.** Every estimated customer receipt is delayed (default 14 days) and relabelled `assumption`.
7. **What is driving the gap.** Each driver (each event, each late-paying customer, the downside delay) is removed on its own and the forecast rebuilt. The driver's effect is how much the lowest balance would improve. Effects can overlap, so they do not have to add up.

**Horizon.** 13 weeks by default; `horizonWeeks` (1 to 26) is optional on the engine, the loader and the endpoints. The first 13 weeks of a longer run are identical to the 13-week run.

All amounts are `bigint` minor units; percentages use `multiplyRatio` with explicit rounding.

## Files

| File | Role |
|---|---|
| `types.ts`, `dates.ts` | Input and output types, date-only helpers (UTC whole days) |
| `forecast.ts` | `buildForecast`, `computeLateness` (pure) |
| `scenario.ts` | `runScenario`, `compare` (pure) |
| `drivers.ts` | `attributeDrivers` (pure) |
| `json.ts` | bigint to string wire format for the API and UI |
| `samples/grocery-order.ts` | The sample order (PO plus supplier quote) as `CommitmentEvent`s |
| `loader.ts` | Postgres to `EngineInput` (not pure) |
| `store.ts` | Saves runs to `forecast_runs`, `forecast_lines`, `forecast_items` (not pure; never writes `action_records`) |
| `service.ts` | Glue used by the API routes and `/demo/forecast` |

Check it with `bun run check:engine` (hand-checkable assertions, then the seeded business with the sample order; needs the database).

Batch 9: overdue customer invoices follow an explicit collection-delay assumption (`OverdueAssumption`, ADR-023); `ForecastOptions.adjustments` carries the chase and early-payment levers (ADR-024) and the forecast reports `adjustmentCostMinor`.
