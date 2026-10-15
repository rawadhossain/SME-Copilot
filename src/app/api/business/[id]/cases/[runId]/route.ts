import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getCase } from "@/actions/room";

// One case: the root planning run and its re-plans, with timelines, plans, authorisations, executions and verification.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/cases/[runId]">) {
  const { id, runId } = await ctx.params;
  return badId(id) ?? badId(runId) ?? handle(() => getCase(db, id, runId));
}
