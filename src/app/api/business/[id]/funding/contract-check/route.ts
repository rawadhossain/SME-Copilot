import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { checkFundingContract } from "@/actions/funding-store";

// Compares the terms a lender's contract states (typed by the owner) with the offer, in plain code. Read-only; no model. Needs a session (proxy).
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/funding/contract-check">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => checkFundingContract(db, id, body.data));
}
