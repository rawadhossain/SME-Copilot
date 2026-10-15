import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getRoomForecast } from "@/actions/room";

// Weekly lines for the chart: do nothing, the selected plan, and the outcome of the agreed terms of an authorisation.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/room/forecast">) {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  return badId(id) ?? handle(() => getRoomForecast(db, id, { runId: sp.get("runId") ?? undefined, planId: sp.get("planId") ?? undefined, authorisationId: sp.get("authorisationId") ?? undefined }));
}
