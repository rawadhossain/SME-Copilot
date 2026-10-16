import { NextResponse } from "next/server";
import { db } from "@/db";
import { sessionFromRequest } from "@/auth";
import { badId } from "@/actions/http";
import { listAwaitingSecond } from "@/actions/plan-authorise";
import { toJsonValue } from "@/sandbox/proposals";

// Plans waiting for a second approval in this business, for the signed-in user (needs a session, which the proxy requires). Read-only.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/approvals">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.json(toJsonValue(await listAwaitingSecond(db, id, session.user.id)));
}
