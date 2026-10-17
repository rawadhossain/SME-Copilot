import { db } from "@/db";
import { badId, readJson } from "@/actions/http";
import { handleWatching } from "@/actions/http-watch";
import { handoffStrategy } from "@/actions/flight-handoff";
import { sessionFromRequest } from "@/auth";
import { NextResponse } from "next/server";

// Hand a simulated strategy to Plans as an UNSIGNED proposal. Owner role only (it adds a proposal to the case); needs a session and CSRF (proxy).
// It never signs, approves, executes or sends. See src/actions/flight-handoff.ts.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/simulate/handoff">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const session = await sessionFromRequest(db, req);
  if (!session || session.businessId !== id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Only the owner can add a strategy to Plans" }, { status: 403 });
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handleWatching(id, "simulation_handoff", () => handoffStrategy(db, id, body.data));
}
