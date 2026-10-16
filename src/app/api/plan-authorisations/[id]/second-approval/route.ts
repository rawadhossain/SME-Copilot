import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { AuthError, sessionFromRequest, verifyStepUp } from "@/auth";
import { badId, handle, readJson } from "@/actions/http";
import { confirmSecond } from "@/actions/plan-authorise";

// The SECOND approver confirms (or declines) a plan the owner has already signed for. They must be signed in as themselves, with their own
// approver account, and re-enter their own password. The person who gave the first confirmation cannot give the second. Approving is what
// makes the system sign the plan; nothing runs before that.
export async function POST(req: Request, ctx: RouteContext<"/api/plan-authorisations/[id]/second-approval">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = z.object({ password: z.string().max(200), decision: z.enum(["approve", "decline"]).default("approve") }).safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Your password is required to confirm." }, { status: 400 });
  try {
    await verifyStepUp(db, session, parsed.data.password, parsed.data.decision === "approve" ? "second approval" : "decline second approval");
    return await handle(() => confirmSecond(db, session.businessId, id, { id: session.user.id, name: session.user.displayName, role: session.user.role }, parsed.data.decision));
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
