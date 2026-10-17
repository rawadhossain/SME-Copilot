import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { alerts } from "@/db/schema";
import { badId, handle } from "@/actions/http";
import { acknowledgeAlert } from "@/actions/monitor";
import { sessionFromRequest } from "@/auth";

// "Got it": mark an alert as seen. Any signed-in role of the alert's business; session and CSRF from the proxy, and the alert must belong to the
// business the session is working in.
export async function POST(req: Request, ctx: RouteContext<"/api/alerts/[id]/acknowledge">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const [a] = await db.select({ businessId: alerts.businessId }).from(alerts).where(eq(alerts.id, id));
  if (!a) return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  if (a.businessId !== session.businessId) return NextResponse.json({ error: "That alert belongs to a different business" }, { status: 403 });
  return handle(() => acknowledgeAlert(db, id, a.businessId, session.user.displayName));
}
