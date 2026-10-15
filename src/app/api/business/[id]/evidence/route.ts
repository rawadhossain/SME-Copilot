import { db } from "@/db";
import { getEvidence } from "@/actions";
import { badId, handle } from "@/actions/http";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/evidence">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getEvidence(db, id));
}
