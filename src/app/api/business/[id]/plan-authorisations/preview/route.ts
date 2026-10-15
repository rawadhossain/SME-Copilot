import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { previewAuthorisation } from "@/actions/plan-authorise";

// What a signature would cover, in plain language, plus the mandate check per lever. Writes nothing. Needs a session (proxy).
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/plan-authorisations/preview">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => previewAuthorisation(db, id, body.data));
}
