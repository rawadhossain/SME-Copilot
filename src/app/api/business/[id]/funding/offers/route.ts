import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { listFundingOffers, saveFundingOffers } from "@/actions/funding-store";
import { toJsonValue } from "@/sandbox/proposals";

// The owner's saved funding offers. GET returns the active set (the forms, to show again, and the validated offers). PUT replaces the set;
// the old rows are archived, never edited. Needs a session (proxy). Nothing is sent to anyone.
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/funding/offers">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return NextResponse.json(toJsonValue(await listFundingOffers(db, id)));
}

export async function PUT(req: Request, ctx: RouteContext<"/api/business/[id]/funding/offers">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => saveFundingOffers(db, id, body.data));
}
