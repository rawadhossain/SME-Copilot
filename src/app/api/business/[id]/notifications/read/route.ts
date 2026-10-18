import { z } from "zod";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { markRead } from "@/actions/notifications";
import { memberOrRefuse } from "@/auth/owner-only";

// Mark some or all of the signed-in person's notifications read. Only ones addressed to them change.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/notifications/read">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await memberOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => markRead(db, id, { id: who.id, role: who.role }, z.strictObject({ ids: z.array(z.string().uuid()).max(100).optional(), all: z.boolean().optional() }).parse(body.data)));
}
