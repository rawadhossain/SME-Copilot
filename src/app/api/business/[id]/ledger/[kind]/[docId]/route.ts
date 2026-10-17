import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { handleWatching } from "@/actions/http-watch";
import { editDocument, getDocument } from "@/actions/ledger";
import { ownerOrRefuse } from "@/auth/owner-only";
import { kindOf } from "../../kind";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/ledger/[kind]/[docId]">) {
  const { id, kind, docId } = await ctx.params;
  const k = kindOf(kind);
  const bad = badId(id) ?? badId(docId);
  if (bad) return bad;
  if (!k) return NextResponse.json({ error: "Unknown kind" }, { status: 404 });
  return handle(() => getDocument(db, id, k, docId));
}

// Edit or void one document. Owner only. Amounts cannot go below what was paid; a document with payments cannot be voided.
export async function PATCH(req: Request, ctx: RouteContext<"/api/business/[id]/ledger/[kind]/[docId]">) {
  const { id, kind, docId } = await ctx.params;
  const k = kindOf(kind);
  const bad = badId(id) ?? badId(docId);
  if (bad) return bad;
  if (!k) return NextResponse.json({ error: "Unknown kind" }, { status: 404 });
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handleWatching(id, "ledger_change", () => editDocument(db, id, k, docId, body.data, who.name));
}
