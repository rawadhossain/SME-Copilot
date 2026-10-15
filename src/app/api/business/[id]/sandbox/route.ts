import { db } from "@/db";
import { getSandboxState } from "@/sandbox";
import { badId, respond } from "@/sandbox/http";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/sandbox">) {
  const { id } = await ctx.params;
  return badId(id) ?? respond(() => getSandboxState(db, id));
}
