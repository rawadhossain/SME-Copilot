import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { assessFunding } from "@/actions/funding-decision";

// Funding decision: is borrowing needed, does a non-borrowing option solve it, which available funding is affordable. Computed by code from the
// forecast, the saved offers and the rescue planner; no model. Applies for nothing and writes one log record. Needs a session (proxy).
export async function POST(_req: Request, ctx: RouteContext<"/api/business/[id]/funding/decision">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => assessFunding(db, id));
}
