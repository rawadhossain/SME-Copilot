// The bank's own end-of-day run (a system operation, not an agent action). It only executes payments that already
// passed the pipeline: nothing can become "scheduled" any other way.
import { z } from "zod";
import { db } from "@/db";
import { runBankTick } from "@/actions";
import { badId, handle, readJson } from "@/actions/http";

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/sandbox/execute">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => runBankTick(db, id, z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(body.data).asOf));
}
