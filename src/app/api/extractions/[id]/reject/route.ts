// OWNER-FACING: rejecting an extraction is an owner action (logged).
import { z } from "zod";
import { db } from "@/db";
import { badId, handle, readJson } from "@/actions/http";
import { rejectExtraction } from "@/ingest/documents/confirm";

export async function POST(req: Request, ctx: RouteContext<"/api/extractions/[id]/reject">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(async () => {
    const b = z.object({ rejectedBy: z.string(), reason: z.string().max(300).optional() }).parse(body.data);
    return rejectExtraction(db, id, b.rejectedBy, b.reason);
  });
}
