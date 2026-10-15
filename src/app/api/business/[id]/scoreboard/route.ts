import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getScoreboard } from "@/actions/scoreboard";

// Scoreboard: per commitment or shortage, do nothing against the executed plan. Numbers come from the engine and the action log only.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/scoreboard">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getScoreboard(db, id));
}
