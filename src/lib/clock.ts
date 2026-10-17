/** The demo "as of" date every fresh seed uses unless SEED_AS_OF overrides it. Keeps forecasts and recordings the same on any day. */
export const DEFAULT_DEMO_AS_OF = "2026-10-15";

/** The calendar day for the few places that need "today" (a payment's default date). APP_TODAY=YYYY-MM-DD overrides the wall clock. */
export const todayIso = (): string => process.env.APP_TODAY ?? new Date().toISOString().slice(0, 10);
