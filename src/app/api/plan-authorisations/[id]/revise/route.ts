import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { reviseFromExecution } from "@/actions/revise";

// The owner revises the terms after a counterparty countered or refused. No model call: the terms are checked against the signed limits and
// what the counterparties said, recomputed by the engine, and opened as a new round that the owner must sign. commit=false only checks.
export async function POST(req: Request, ctx: RouteContext<"/api/plan-authorisations/[id]/revise">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => reviseFromExecution(db, id, body.data));
}
