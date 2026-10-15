// OWNER-FACING route: the only place (with the owner console) that signs an approval.
import { z } from "zod";
import { db } from "@/db";
import { sessionFromRequest } from "@/auth";
import { stepUpOrRefuse } from "@/auth/route";
import { approveAction } from "@/actions/approve";
import { badId, handle, readJson } from "@/actions/http";

const bodySchema = z.object({ approvedBy: z.string(), password: z.string().optional(), confirmations: z.number().int().min(1).max(2).default(1) });

export async function POST(req: Request, ctx: RouteContext<"/api/actions/[id]/approve">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const refused = await stepUpOrRefuse(req, (body.data as { password?: unknown })?.password, "approve an action");
  if (refused) return refused;
  return handle(async () => {
    const b = bodySchema.parse(body.data);
    const who = (await sessionFromRequest(db, req))?.user.displayName ?? b.approvedBy; // the signed-in owner, not a typed name
    return approveAction(db, id, who, b.confirmations);
  });
}
