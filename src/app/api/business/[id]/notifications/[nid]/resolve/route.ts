import { z } from "zod";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { resolveDraft } from "@/actions/notifications";
import { ownerOrRefuse } from "@/auth/owner-only";

// The owner decides on a drafted reminder letter: mark it sent to the simulated customer (sandbox only, nothing leaves the app) or dismiss it. Owner only.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/notifications/[nid]/resolve">) {
  const { id, nid } = await ctx.params;
  const bad = badId(id) ?? badId(nid);
  if (bad) return bad;
  const who = await ownerOrRefuse(req, id);
  if (who instanceof Response) return who;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => resolveDraft(db, id, nid, z.strictObject({ action: z.enum(["send_sandbox", "dismiss"]) }).parse(body.data).action));
}
