import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { createAutomation, listAutomations } from "@/actions/automation-admin";
import { memberOrRefuse, ownerOrRefuse } from "@/auth/owner-only";

// Automations: any signed-in member reads them; only the owner creates. Session, CSRF and business scoping come from the proxy. An automation can only
// notify, prepare or draft (src/domain/automation.ts); the body is validated by that schema and unknown keys are refused.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/automations">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await memberOrRefuse(req, id);
  if (who instanceof Response) return who;
  return handle(() => listAutomations(db, id));
}

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/automations">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => createAutomation(db, id, body.data, who.name));
}
