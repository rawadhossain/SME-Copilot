import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { assistLetter } from "@/actions/plan-letter-assist";

// "Rewrite this letter": one model call (no tools) that returns a reworded letter for the owner's editor. It saves and sends nothing, and a rewrite
// that adds any figure or date is rejected. Needs a session (proxy).
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-letter-assist">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => assistLetter(db, id, body.data));
}
