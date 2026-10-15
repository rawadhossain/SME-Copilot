import { db } from "@/db";
import { badId, handle } from "@/actions/http";
import { getExtraction } from "@/ingest/documents";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/extractions/[extractionId]">) {
  const { id, extractionId } = await ctx.params;
  const bad = badId(id) ?? badId(extractionId);
  if (bad) return bad;
  return handle(() => getExtraction(db, id, extractionId), "Extraction not found");
}
