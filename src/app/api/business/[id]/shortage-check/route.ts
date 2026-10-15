import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { badId, handle, readJson } from "@/actions/http";
import { checkShortage, detectShortage } from "@/actions/shortage";

// Explicit shortage check. GET only looks (no run). POST detects and, for a shortage that has no run yet, starts the READ-ONLY planning
// run: it proposes plans and never executes anything; the owner still signs. Same forecast = same run (idempotent).
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/shortage-check">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => detectShortage(db, id));
}

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/shortage-check">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req).catch(() => null);
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id));
  if (!biz) return NextResponse.json({ error: "Business not found" }, { status: 404 });
  return handle(() => checkShortage(db, id, body && body.ok ? { ...(body.data as object), source: "api" } : { source: "api" }).then((r) => ({ ...r, run: r.run ? { runId: r.run.runId, status: r.run.status, planSource: r.run.planSource, plans: r.run.plans, note: r.run.note } : null })));
}
