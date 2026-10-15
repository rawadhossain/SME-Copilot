import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { badId, handle, readJson } from "@/actions/http";
import { listRuns, startRun } from "@/actions/agent-run";

// The planning agent can only READ and PROPOSE PLANS. Starting a run never executes, sends, schedules or approves anything.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/agent/runs">) {
  const { id } = await ctx.params;
  return badId(id) ?? handle(() => listRuns(db, id));
}

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/agent/runs">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = z.object({ trigger: z.unknown() }).safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Body must be { trigger }" }, { status: 400 });
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id));
  if (!biz) return NextResponse.json({ error: "Business not found" }, { status: 404 });
  try {
    const result = await startRun(db, id, parsed.data.trigger);
    const status = result.status === "refused" ? 409 : result.status === "failed" ? 422 : 200;
    return NextResponse.json(JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), { status });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Invalid trigger", issues: e.issues }, { status: 400 });
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
