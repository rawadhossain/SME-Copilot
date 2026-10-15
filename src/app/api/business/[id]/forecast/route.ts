import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_DELAY_DAYS, delayDaysSchema, forecastFor, horizonWeeksSchema, variantSchema } from "@/engine/service";

export async function GET(req: Request, ctx: RouteContext<"/api/business/[id]/forecast">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid business id" }, { status: 400 });
  const sp = new URL(req.url).searchParams;
  const variant = variantSchema.safeParse(sp.get("variant") ?? "baseline");
  if (!variant.success) return NextResponse.json({ error: "variant must be baseline or downside" }, { status: 400 });
  const delay = delayDaysSchema.safeParse(sp.get("delayDays") ?? DEFAULT_DELAY_DAYS);
  if (!delay.success) return NextResponse.json({ error: "delayDays must be an integer from 1 to 90" }, { status: 400 });
  const horizon = horizonWeeksSchema.safeParse(sp.get("horizonWeeks") ?? 13);
  if (!horizon.success) return NextResponse.json({ error: "horizonWeeks must be an integer from 1 to 26" }, { status: 400 });
  try {
    const result = await forecastFor(id, { variant: variant.data, delayDays: delay.data, horizonWeeks: horizon.data }, true);
    if (!result) return NextResponse.json({ error: "Business not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Forecast failed" }, { status: 422 });
  }
}
