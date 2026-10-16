import { NextResponse } from "next/server";
import { db } from "@/db";
import { sessionFromRequest } from "@/auth";
import { badId, handle, readJson } from "@/actions/http";
import { previewAuthorisation } from "@/actions/plan-authorise";

// What a signature would cover, in plain language, plus the mandate check per lever and a first draft of each proposal letter. Writes nothing.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-authorisations/preview">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => previewAuthorisation(db, id, body.data, { name: session.user.displayName.replace(/\s*\([^)]*\)\s*$/, "") }));
}
