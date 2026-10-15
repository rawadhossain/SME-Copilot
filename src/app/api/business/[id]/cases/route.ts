import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { listCases } from "@/actions/room";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/cases">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => listCases(db, id));
}
