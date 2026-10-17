import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { declareTradingSince } from "@/actions/funding-match";
import { sessionFromRequest } from "@/auth";
import { NextResponse } from "next/server";

// The owner states when the business started trading (their own statement, not verified). Owner role only; session and CSRF come from the proxy.
// Used only for the history requirement in financing matching; it never changes a forecast.
export async function PUT(req: Request, ctx: RouteContext<"/api/business/[id]/funding/profile">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Only the owner can state when the business started trading." }, { status: 403 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => declareTradingSince(db, id, body.data, session.user.displayName));
}
