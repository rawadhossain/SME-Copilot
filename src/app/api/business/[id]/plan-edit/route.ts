import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { editPlan } from "@/actions/plan-edit";

// Owner edits the lever parameters of a stored plan. No model call: the engine recomputes the numbers and the signed mandate is checked.
// commit=false previews (writes nothing); commit=true stores the edited plan in the same run so it can be signed. Needs a session (proxy).
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-edit">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => editPlan(db, id, body.data));
}
