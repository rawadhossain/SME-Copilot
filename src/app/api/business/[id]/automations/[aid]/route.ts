import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { deleteAutomation, loadAutomation, updateAutomation } from "@/actions/automation-admin";
import { memberOrRefuse, ownerOrRefuse } from "@/auth/owner-only";

export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/automations/[aid]">) {
  const { id, aid } = await ctx.params;
  const bad = badId(id) ?? badId(aid);
  if (bad) return bad;
  const who = await memberOrRefuse(req, id);
  if (who instanceof Response) return who;
  return handle(() => loadAutomation(db, id, aid));
}

// Edit: the flow is validated again and the version goes up, so a run that is waiting on the old version stops instead of continuing a changed flow.
export async function PUT(req: Request, ctx: RouteContext<"/api/business/[id]/automations/[aid]">) {
  const { id, aid } = await ctx.params;
  const bad = badId(id) ?? badId(aid);
  if (bad) return bad;
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => updateAutomation(db, id, aid, body.data, who.name));
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/business/[id]/automations/[aid]">) {
  const { id, aid } = await ctx.params;
  const bad = badId(id) ?? badId(aid);
  if (bad) return bad;
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  return handle(() => deleteAutomation(db, id, aid));
}
