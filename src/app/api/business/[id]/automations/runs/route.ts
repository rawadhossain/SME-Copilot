import { db } from "@/db";
import { badId, handle, uuidSchema } from "@/actions/http";
import { listRuns } from "@/actions/automation-admin";
import { memberOrRefuse } from "@/auth/owner-only";

// Run history (newest 50), for all automations or one (?automationId=). Any signed-in member.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/automations/runs">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await memberOrRefuse(req, id);
  if (who instanceof Response) return who;
  const a = new URL(req.url).searchParams.get("automationId");
  const aid = a && uuidSchema.safeParse(a).success ? a : undefined;
  return handle(() => listRuns(db, id, aid));
}
