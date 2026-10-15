import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { AuthError, sessionFromRequest, switchBusiness } from "@/auth";

export async function POST(req: Request) {
  const s = await sessionFromRequest(db, req);
  if (!s) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = z.object({ businessId: z.string().uuid() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "businessId required" }, { status: 400 });
  try {
    await switchBusiness(db, s, body.data.businessId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthError ? e.message : "Failed" }, { status: 403 });
  }
}
