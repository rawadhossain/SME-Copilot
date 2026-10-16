import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getRoom } from "@/actions/room";

// The cash desk. Optional ?lateDays=N (1 to 90) adds the "customers pay N days late" downside line.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/room">) {
  const { id } = await ctx.params;
  const raw = new URL(req.url).searchParams.get("lateDays");
  const n = raw === null ? undefined : Number(raw);
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 90)) return Response.json({ error: "lateDays must be a whole number from 1 to 90" }, { status: 400 });
  return badId(id) ?? handle(() => getRoom(db, id, { lateDays: n }));
}
