import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { releaseHeld } from "@/actions/plan-exec";

// Withdraws the agreements and offers an attempt kept on hold after a counterparty pushed back. Each withdrawal goes through the gate and is logged.
// Nothing is committed or paid by this. Needs a session (proxy).
export async function POST(_req: Request, ctx: RouteContext<"/api/plan-authorisations/[id]/release">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => releaseHeld(db, id));
}
