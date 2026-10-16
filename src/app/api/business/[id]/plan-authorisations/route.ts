import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AuthError, sessionFromRequest, verifyStepUp } from "@/auth";
import { badId, handle, readJson } from "@/actions/http";
import { authorisePlan, requestSecondApproval } from "@/actions/plan-authorise";

// OWNER-FACING. The owner signs one stored plan: they must be signed in as the OWNER and RE-ENTER their own password (step-up), draw their
// signature and approve the letters. The gate checks every lever against the signed mandate first; a plan beyond the mandate is stored as
// denied and answered with 422. A plan that needs two confirmations is NOT signed here: it waits ("awaiting_second") for a DIFFERENT approver
// account to confirm from their own sign-in (POST /api/plan-authorisations/[id]/second-approval). Nobody ever types another person's password.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-authorisations">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Only the owner can sign a plan. An approver confirms a plan the owner has signed." }, { status: 403 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = z.object({ password: z.string().max(200) }).passthrough().safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Your password is required to sign." }, { status: 400 });
  // Signing needs the proposal letters you approved and a drawn signature, as well as your password.
  const extra = body.data as { letters?: unknown; signatureImage?: unknown };
  if (typeof extra.signatureImage !== "string" || extra.signatureImage.length === 0) return NextResponse.json({ error: "Please draw your signature to sign." }, { status: 400 });
  if (!extra.letters || typeof extra.letters !== "object") return NextResponse.json({ error: "The proposal letters are missing; open the signing step again." }, { status: 400 });
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id));
  if (!biz) return NextResponse.json({ error: "Business not found" }, { status: 404 });
  const { password, ...input } = parsed.data;
  try {
    await verifyStepUp(db, session, password, "sign plan authorisation");
    const needsSecond = (input as { confirmations?: number }).confirmations === 2;
    const res = await handle<unknown>(async () => (needsSecond ? await requestSecondApproval(db, id, input, { id: session.user.id, name: session.user.displayName }) : await authorisePlan(db, id, input, session.user.displayName)));
    if (res.status !== 200) return res;
    const json = await res.clone().json();
    return NextResponse.json(json, { status: json.status === "authorised" || json.status === "awaiting_second" ? 200 : 422 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
