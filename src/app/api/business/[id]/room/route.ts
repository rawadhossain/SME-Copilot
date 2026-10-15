import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getRoom } from "@/actions/room";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/room">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getRoom(db, id));
}
