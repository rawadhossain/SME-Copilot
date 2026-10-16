import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AuthError, sessionFromRequest, verifySecondApprover, verifyStepUp } from "@/auth";
import { badId, handle, readJson } from "@/actions/http";
import { authorisePlan } from "@/actions/plan-authorise";

// OWNER-FACING. Signs one stored plan with the dev owner key held by the server. The signed-in owner must RE-ENTER their password
// (step-up); a plan that needs two confirmations also needs a different approver account's password. The gate checks every lever
// against the signed mandate first; a plan beyond the mandate is stored as denied and answered with 422.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-authorisations">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = z.object({ password: z.string().max(200), secondApprover: z.object({ email: z.string(), password: z.string() }).optional() }).passthrough().safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Your password is required to sign." }, { status: 400 });
  // Batch 14: signing needs the proposal letters you approved and a drawn signature, as well as your password.
  const extra = body.data as { letters?: unknown; signatureImage?: unknown };
  if (typeof extra.signatureImage !== "string" || extra.signatureImage.length === 0) return NextResponse.json({ error: "Please draw your signature to sign." }, { status: 400 });
  if (!extra.letters || typeof extra.letters !== "object") return NextResponse.json({ error: "The proposal letters are missing; open the signing step again." }, { status: 400 });
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id));
  if (!biz) return NextResponse.json({ error: "Business not found" }, { status: 404 });
  const { password, secondApprover, ...input } = parsed.data;
  try {
    await verifyStepUp(db, session, password, "sign plan authorisation");
    let approvedBy = session.user.displayName;
    if ((input as { confirmations?: number }).confirmations === 2) {
      approvedBy += ` + ${await verifySecondApprover(db, session, secondApprover, "sign plan authorisation")}`;
    }
    const res = await handle(() => authorisePlan(db, id, input, approvedBy));
    if (res.status !== 200) return res;
    const json = await res.clone().json();
    return NextResponse.json(json, { status: json.status === "authorised" ? 200 : 422 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
