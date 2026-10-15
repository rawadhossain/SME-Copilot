import { z } from "zod";
import { db } from "@/db";
import { listActions, proposeAction } from "@/actions";
import { badId, handle, readJson } from "@/actions/http";

const bodySchema = z.object({
  request: z.unknown(),
  idempotencyKey: z.string(),
  createdBy: z.enum(["agent", "owner"]).default("agent"),
});

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/actions">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => listActions(db, id));
}

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/actions">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => {
    const b = bodySchema.parse(body.data);
    return proposeAction(db, id, b.request, b.idempotencyKey, b.createdBy);
  });
}
