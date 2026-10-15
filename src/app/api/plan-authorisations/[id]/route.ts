import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getPlanAuthorisation } from "@/actions/plan-read";

// Status and the evidence trail: steps, actions, log records and the verification.
export async function GET(_req: Request, ctx: RouteContext<"/api/plan-authorisations/[id]">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getPlanAuthorisation(db, id));
}
