import { z } from "zod";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { setEnabled } from "@/actions/automation-admin";
import { ownerOrRefuse } from "@/auth/owner-only";

// Turn an automation on or off. Owner only.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/automations/[aid]/enabled">) {
  const { id, aid } = await ctx.params;
  const bad = badId(id) ?? badId(aid);
  if (bad) return bad;
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => setEnabled(db, id, aid, z.strictObject({ enabled: z.boolean() }).parse(body.data).enabled, who.name));
}
