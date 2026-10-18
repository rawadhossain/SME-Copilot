import { z } from "zod";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { createFromTemplate } from "@/actions/automation-admin";
import { ownerOrRefuse } from "@/auth/owner-only";

// Create a draft automation from one of the five code templates. Owner only; the result is turned on separately.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/automations/from-template">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => createFromTemplate(db, id, z.strictObject({ templateId: z.string().min(1).max(60) }).parse(body.data).templateId, who.name));
}
