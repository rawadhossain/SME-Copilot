import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { requestMonitorRun } from "@/actions/monitor";

// Run the alert monitor now (any signed-in role of the business; session, CSRF and business scoping from the proxy). At most once per 30 seconds per
// business: a sooner call gets the stored result of the last run.
export async function POST(_req: Request, ctx: RouteContext<"/api/business/[id]/monitor/run">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => requestMonitorRun(db, id, "manual"));
}
