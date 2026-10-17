import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { computeFundingMatch, matchFunding } from "@/actions/funding-match";

// Financing-option matching: which products of a synthetic lender catalogue the business's books qualify for, sized to its funding need.
// Computed by code; no model. Applies for nothing. POST writes one log record; GET (what the page uses to show the products) writes nothing.
// Needs a session (proxy). The body is ignored.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/funding/match">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => computeFundingMatch(db, id));
}

export async function POST(_req: Request, ctx: RouteContext<"/api/business/[id]/funding/match">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => matchFunding(db, id));
}
