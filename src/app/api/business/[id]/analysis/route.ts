import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getAnalysis } from "@/actions/analysis";

// Business analysis (cash view): ageing, days to be paid, how customers pay, money in and out by month, runway. Read-only and not logged; any signed-in
// role of the business (proxy). Built from invoices, bills and bank transactions only: no cost or tax data, so no margin or profit.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/analysis">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => getAnalysis(db, id));
}
