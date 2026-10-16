import { NextResponse } from "next/server";
import { db } from "@/db";
import { getDefaultBusinessId } from "@/db/queries";
import { sessionFromRequest, switchBusiness } from "@/auth";
import { createDemoClone } from "@/actions/demo-clone";
import { demoToolsEnabled } from "@/lib/demo-tools";

// Starts a fresh flagged demo clone (a new business; nothing existing is changed) and switches this session to it.
export async function POST(req: Request) {
  if (!demoToolsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const s = await sessionFromRequest(db, req);
  if (!s) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const source = s.user.businessId ?? (await getDefaultBusinessId());
  const clone = await createDemoClone(db, source);
  await switchBusiness(db, s, clone.id);
  return NextResponse.json(clone);
}
