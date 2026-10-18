import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { listNotifications } from "@/actions/notifications";
import { memberOrRefuse } from "@/auth/owner-only";

// The signed-in person's in-app notifications (addressed to them or to their role), newest first, with the unread count. In-app only (sandbox): nothing is emailed.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/notifications">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const who = await memberOrRefuse(req, id);
  if (who instanceof Response) return who;
  return handle(() => listNotifications(db, id, { id: who.id, role: who.role }));
}
