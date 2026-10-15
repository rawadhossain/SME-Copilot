import { NextResponse } from "next/server";
import { z } from "zod";
import { commitmentEventsSchema } from "@/domain/commitment-event";
import { DEFAULT_DELAY_DAYS, delayDaysSchema, horizonWeeksSchema, scenarioFor, variantSchema } from "@/engine/service";

const bodySchema = z.object({
  events: commitmentEventsSchema,
  variant: variantSchema.optional(),
  delayDays: delayDaysSchema.optional(),
  horizonWeeks: horizonWeeksSchema.optional(),
});

export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/scenario">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid business id" }, { status: 400 });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) return NextResponse.json({ error: "Invalid request", issues: body.error.issues }, { status: 400 });
  try {
    const result = await scenarioFor(id, body.data.events, { variant: body.data.variant ?? "baseline", delayDays: body.data.delayDays ?? DEFAULT_DELAY_DAYS, horizonWeeks: body.data.horizonWeeks }, true);
    if (!result) return NextResponse.json({ error: "Business not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Scenario failed" }, { status: 422 });
  }
}
