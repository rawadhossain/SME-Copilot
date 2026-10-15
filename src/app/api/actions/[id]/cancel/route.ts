import { z } from "zod";
import { db } from "@/db";
import { cancelAction } from "@/actions";
import { badId, handle } from "@/actions/http";

export async function POST(req: Request, ctx: RouteContext<"/api/actions/[id]/cancel">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = z.object({ cancelledBy: z.string().default("owner") }).safeParse(await req.json().catch(() => ({})));
  return handle(() => cancelAction(db, id, body.success ? body.data.cancelledBy : "owner"));
}
