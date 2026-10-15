import { db } from "@/db";
import { verifyAction } from "@/actions";
import { badId, handle } from "@/actions/http";

export async function POST(_req: Request, ctx: RouteContext<"/api/actions/[id]/verify">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => verifyAction(db, id));
}
