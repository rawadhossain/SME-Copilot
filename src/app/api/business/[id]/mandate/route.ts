import { db } from "@/db";
import { getMandateInfo } from "@/actions";
import { badId, handle } from "@/actions/http";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/mandate">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => getMandateInfo(db, id));
}
