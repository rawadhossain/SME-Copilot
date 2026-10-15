import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, extractions } from "@/db/schema";
import { badId, handle, readJson } from "@/actions/http";
import { createDocumentAndExtract } from "@/ingest/documents";

// Stores the document (untrusted text) and runs the quarantined extraction. Returns the extraction with its flags.
export async function POST(req: Request, ctx: RouteContext<"/api/business/[id]/documents">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  return handle(() => createDocumentAndExtract(db, id, body.data));
}

// The business's documents and where each extraction stands (pending_confirmation, confirmed, rejected, failed).
export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/documents">) {
  const { id } = await ctx.params;
  const bad = badId(id);
  if (bad) return bad;
  return handle(async () => {
    const rows = await db.select({ ex: extractions, doc: documents }).from(extractions).innerJoin(documents, eq(documents.id, extractions.documentId)).where(eq(extractions.businessId, id)).orderBy(desc(extractions.createdAt));
    return rows.map(({ ex, doc }) => ({ extractionId: ex.id, filename: doc.filename, kind: doc.kind, status: ex.status, createdAt: ex.createdAt }));
  });
}
