import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { createDocument } from "@/actions/ledger";
import { ownerOrRefuse } from "@/auth/owner-only";
import { kindOf } from "../kind";

// Create an invoice (kind "invoices") or a bill (kind "bills"). Owner only. Overlaps with money the forecast already counts come back as 409
// with the candidates; the owner answers by resending with countedIn or acknowledgeOverlaps.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/ledger/[kind]">) {
  const { id, kind } = await ctx.params;
  const bad = badId(id);
  const k = kindOf(kind);
  if (bad) return bad;
  if (!k) return NextResponse.json({ error: "Unknown kind" }, { status: 404 });
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => createDocument(db, id, k, body.data, who.name));
}
