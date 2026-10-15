import { db } from "@/db";
import { executeAction } from "@/actions";
import { badId, handle } from "@/actions/http";

export async function POST(_req: Request, ctx: RouteContext<"/api/actions/[id]/execute">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => executeAction(db, id));
}
