import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { listAlerts } from "@/actions/monitor";

// Open and acknowledged alerts for the business, and when the monitor last ran. Any signed-in role of the business (proxy). When the last run is older
// than 10 minutes the monitor runs first, so Today stays fresh without a timer.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/alerts">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => listAlerts(db, id));
}
