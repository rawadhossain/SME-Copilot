// OWNER-FACING manual console endpoint: acts as the owner with a pre-approval, but through the full pipeline.
// A denied action stays denied. Nothing here bypasses the gate.
import { z } from "zod";
import { db } from "@/db";
import { runAsOwner } from "@/actions/owner-console";
import { stepUpOrRefuse } from "@/auth/route";
import { badId, handle, readJson } from "@/actions/http";

const bodySchema = z.object({ request: z.unknown(), idempotencyKey: z.string(), password: z.string().optional() });

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/console">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const refused = await stepUpOrRefuse(req, (body.data as { password?: unknown })?.password, "owner console action");
  if (refused) return refused;
  return handle(async () => {
    const b = bodySchema.parse(body.data);
    return runAsOwner(db, id, b.request, b.idempotencyKey);
  });
}
