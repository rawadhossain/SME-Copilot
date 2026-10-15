import { NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessSummary } from "@/db/queries";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/summary">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid business id" }, { status: 400 });
  const summary = await getBusinessSummary(id);
  if (!summary) return NextResponse.json({ error: "Business not found" }, { status: 404 });
  return NextResponse.json(summary);
}
