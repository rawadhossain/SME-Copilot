import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { askCopilot } from "@/actions/copilot";
import { sessionFromRequest } from "@/auth";
import { NextResponse } from "next/server";

// Copilot: a sentence in, a typed and validated request run by the existing read-only engines, an answer written by code out. Any signed-in role of the
// business (session, CSRF and business scoping come from the proxy). It writes one log record per question and nothing else.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/copilot">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => askCopilot(db, id, body.data, { viewerRole: session.user.role }));
}
