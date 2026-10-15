import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { replanFromExecution } from "@/actions/replan";

// Re-plans after a plan needed it: learned constraints (structured only) go to the planning agent; the result is NEW plans for the
// owner to authorise. Nothing executes. At most 2 re-plan rounds, then "exhausted" with the best documented option.
export async function POST(_req: Request, ctx: RouteContext<"/api/plan-authorisations/[id]/replan">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => replanFromExecution(db, id));
}
