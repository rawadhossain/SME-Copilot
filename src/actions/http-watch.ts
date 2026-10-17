// handle() plus a best-effort alert check after a successful change (documents confirmed, ledger writes, executions, handoffs, recovery).
// The check runs in the background and can never change the response; a failure is logged by watchAfter.
import { db } from "@/db";
import { handle } from "./http";
import { watchAfter } from "./monitor";

export async function handleWatching<T>(businessId: string, reason: string, fn: () => Promise<T | null>, notFound = "Not found"): Promise<Response> {
  const res = await handle(fn, notFound);
  if (res.ok) void watchAfter(db, businessId, reason);
  return res;
}
