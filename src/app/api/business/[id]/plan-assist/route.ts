import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { assistEdit } from "@/actions/plan-assist";

// "Tell the assistant what to change": one model call (no tools) that suggests edits to the terms in the owner's form. It saves and sends nothing;
// the owner reviews the filled-in form and the usual engine check and signature apply. Needs a session (proxy).
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-assist">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => assistEdit(db, id, body.data));
}
