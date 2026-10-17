import { NextResponse } from "next/server";
import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getLedger } from "@/actions/ledger";

// Invoices and bills with balances, payment history, forecast impact and the bank lines that look like payments. Read-only; needs a session (proxy).
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/ledger">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(() => getLedger(db, id)).catch(() => NextResponse.json({ error: "Unexpected error" }, { status: 500 }));
}
