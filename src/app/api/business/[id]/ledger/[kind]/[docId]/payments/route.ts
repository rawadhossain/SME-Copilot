import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, readJson } from "@/actions/http";
import { handleWatching } from "@/actions/http-watch";
import { recordPayment } from "@/actions/ledger";
import { ownerOrRefuse } from "@/auth/owner-only";
import { kindOf } from "../../../kind";

// Record a full or partial payment against one invoice or bill. Owner only. This records a fact the owner states; it moves no money.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/ledger/[kind]/[docId]/payments">) {
  const { id, kind, docId } = await ctx.params;
  const k = kindOf(kind);
  const bad = badId(id) ?? badId(docId);
  if (bad) return bad;
  if (!k) return NextResponse.json({ error: "Unknown kind" }, { status: 404 });
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handleWatching(id, "ledger_change", () => recordPayment(db, id, k, docId, body.data, who.name));
}
