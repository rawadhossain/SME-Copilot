import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { compareFunding } from "@/actions/funding";

// Compares funding offers the owner typed in against not borrowing. Read-only: nothing is stored, sent or signed, and no model is involved.
// Needs a session (proxy). POST because the offers are in the body.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/funding/compare">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => compareFunding(db, id, body.data));
}
