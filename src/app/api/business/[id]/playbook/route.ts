import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { getPlaybook, savePlaybook } from "@/actions/playbook";
import { sessionFromRequest } from "@/auth";

// Owner playbook settings. Any signed-in member of the business may read them; only the owner saves. Session and CSRF come from the proxy.
export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/playbook">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return handle(() => getPlaybook(db, id));
}

export async function PUT(req: Request, ctx: RouteContext<"/api/business/[id]/playbook">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Only the owner can change the playbook." }, { status: 403 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => savePlaybook(db, id, body.data, session.user.displayName));
}
