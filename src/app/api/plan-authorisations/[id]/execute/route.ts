import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { executePlan } from "@/actions/plan-exec";

// Runs the authorised plan: negotiate (one round), commit, verify. Refuses an expired, tampered or already used authorisation.
// A plan that needs a re-plan, rolled back or failed verification answers 200/422 with the full outcome; nothing is silent.
export async function POST(_req: Request, ctx: RouteContext<"/api/plan-authorisations/[id]/execute">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const res = await handle(() => executePlan(db, id));
  if (res.status !== 200) return res;
  const json = await res.clone().json();
  return NextResponse.json(json, { status: json.status === "completed" || json.status === "needs_replan" ? 200 : 422 });
}
