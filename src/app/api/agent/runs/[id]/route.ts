import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getRun } from "@/actions/agent-run";

export async function GET(_req: Request, ctx: RouteContext<"/api/agent/runs/[id]">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getRun(db, id), "Run not found");
}
