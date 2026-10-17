import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { voidPayment } from "@/actions/ledger";
import { ownerOrRefuse } from "@/auth/owner-only";
import { kindOf } from "../../../../../kind";

// Void a payment recorded by mistake. The payment stays in the history, marked void with the reason; nothing is deleted. Owner only.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/ledger/[kind]/[docId]/payments/[paymentId]/void">) {
  const { id, kind, docId, paymentId } = await ctx.params;
  const k = kindOf(kind);
  const bad = badId(id) ?? badId(docId) ?? badId(paymentId);
  if (bad) return bad;
  if (!k) return NextResponse.json({ error: "Unknown kind" }, { status: 404 });
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => voidPayment(db, id, k, docId, paymentId, body.data, who.name));
}
