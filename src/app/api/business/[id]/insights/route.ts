import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getInsights } from "@/actions/insights";

// Financial health and early warnings. Read-only and deterministic: no model, no writes. The session/business check is the proxy's.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/insights">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getInsights(db, id));
}
