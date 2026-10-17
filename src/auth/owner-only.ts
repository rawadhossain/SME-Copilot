// Bookkeeping changes (invoices, bills, payments) are the owner's. An approver can read them but not change them.
import { NextResponse } from "next/server";
import { db } from "@/db";
import { sessionFromRequest } from "./index";

/** Returns the signed-in owner's display name, or the 401/403 response to send. */
export async function ownerOrRefuse(req: Request, businessId: string): Promise<{ name: string } | Response> {
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== businessId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Only the owner can change invoices, bills and payments." }, { status: 403 });
  return { name: session.user.displayName };
}
