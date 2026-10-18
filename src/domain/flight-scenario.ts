// The typed scenario the flight simulator accepts (the ONE definition: the simulator's POST, the Copilot and the simulator page's deep link all validate with it).
// Pure: zod and the engine's limits only.
import { z } from "zod";
import { MAX_LATE_DAYS, MAX_SHOCKS } from "@/engine";

const id = z.string().uuid();
export const shockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("customer_late"), counterpartyId: id, days: z.number().int().min(1).max(MAX_LATE_DAYS) }),
  z.object({ kind: z.literal("customer_short"), counterpartyId: id, shortBps: z.number().int().min(1).max(10000) }),
  z.object({ kind: z.literal("supplier_refuses"), counterpartyId: id, lever: z.enum(["supplier_defer_balance", "supplier_reduce_deposit", "both"]) }),
  z.object({ kind: z.literal("unexpected_expense"), amount: z.string().trim().min(1).max(20), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().trim().max(60).default("Unexpected expense") }),
]);
export const scenarioSchema = z.object({ name: z.string().trim().max(80).optional(), shocks: z.array(shockSchema).min(1).max(MAX_SHOCKS) });
export type ScenarioInput = z.output<typeof scenarioSchema>;
