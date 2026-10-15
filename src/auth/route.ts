// Route helper: the signed-in owner must re-enter their password before an owner route signs or approves anything (step-up).
import { NextResponse } from "next/server";
import { db } from "@/db";
import { AuthError, sessionFromRequest, verifyStepUp } from "./index";

/** Returns null when the step-up passed, else the 401/403 response to send. The attempt is logged either way. */
export async function stepUpOrRefuse(req: Request, password: unknown, purpose: string): Promise<Response | null> {
  const session = await sessionFromRequest(db, req);
  if (!session) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  try {
    await verifyStepUp(db, session, password, purpose);
    return null;
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthError ? e.message : "Step-up failed" }, { status: 403 });
  }
}
