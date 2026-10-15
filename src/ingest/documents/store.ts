// Database layer for documents and extractions. Documents are insert-only. The owner confirmation path is in confirm.ts.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appendActionRecord, ACTION_EVENTS } from "@/actionlog";
import { worldDate } from "@/actions/state";
import { ActionError, type Db } from "@/actions/types";
import type { Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { documents, extractions } from "@/db/schema";
import { toJsonValue } from "@/sandbox/proposals";
import { commitmentEventToJson, type CommitmentEventJson } from "@/domain/commitment-event";
import { extractDocument } from "./extract";
import { mapExtractionToEvents } from "./map";
import type { ExtractionResult, FlagsBlob } from "./validate";

export const createDocumentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  kind: z.enum(["purchase_order", "supplier_quote"]),
  text: z.string().min(1).max(200_000),
});

export interface ExtractionView {
  id: string;
  documentId: string;
  status: string;
  result: ExtractionResult;
  flags: FlagsBlob;
  model: string;
  promptVersion: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

function viewOf(row: typeof extractions.$inferSelect): ExtractionView {
  return toJsonValue({
    id: row.id, documentId: row.documentId, status: row.status, result: row.result, flags: row.flags, model: row.model, promptVersion: row.promptVersion,
    confirmedAt: row.confirmedAt, confirmedBy: row.confirmedBy,
  }) as ExtractionView;
}

/** Stores the document, runs the quarantined extraction, stores the extraction, and logs any suspicious text. */
export async function createDocumentAndExtract(db: Db, businessId: string, input: unknown, opts: { gateway?: Gateway } = {}) {
  const { filename, kind, text } = createDocumentSchema.parse(input);
  const asOf = await worldDate(db, businessId);
  const [doc] = await db.insert(documents).values({ businessId, filename, kind, text, sha256: createHash("sha256").update(text, "utf8").digest("hex") }).returning();
  const run = await extractDocument(text, kind, { asOf, businessId, gateway: opts.gateway, logger: dbCallLogger });
  const [row] = await db
    .insert(extractions)
    .values({
      businessId, documentId: doc.id, status: run.outcome.status, result: toJsonValue(run.outcome.result) as Record<string, unknown>,
      flags: toJsonValue(run.outcome.flags) as Record<string, unknown>, model: run.model, promptVersion: run.promptVersion,
    })
    .returning();
  // Only firm pattern-scan findings are logged as a security event; sentences that only the model pointed at stay a soft note on the extraction
  // (the model over-reports ordinary payment terms), so a normal document does not put a security alarm in the evidence log.
  const suspicious = run.outcome.flags.suspicious.filter((x) => x.source === "scan");
  if (suspicious.length > 0) {
    await appendActionRecord(db, {
      businessId, event: ACTION_EVENTS.SUSPICIOUS_TEXT_DETECTED, actor: "system",
      detail: {
        documentId: doc.id, extractionId: row.id, filename,
        // The log keeps a fingerprint and the length, not the text: untrusted document text does not enter the evidence log or its export.
        matches: suspicious.slice(0, 10).map((s) => ({ source: s.source, pattern: s.pattern ?? null, length: s.text.length, sha256: createHash("sha256").update(s.text, "utf8").digest("hex") })),
        note: "text was treated as data and ignored",
      },
    });
  }
  return { document: { id: doc.id, filename, kind, sha256: doc.sha256 }, extraction: viewOf(row) };
}

export async function getExtraction(db: Db, businessId: string, extractionId: string) {
  const [row] = await db.select().from(extractions).where(and(eq(extractions.businessId, businessId), eq(extractions.id, z.string().uuid().parse(extractionId))));
  if (!row) return null;
  const [doc] = await db.select().from(documents).where(eq(documents.id, row.documentId));
  return { extraction: viewOf(row), document: { id: doc.id, filename: doc.filename, kind: doc.kind, text: doc.text, sha256: doc.sha256 } };
}

export async function getExtractionById(db: Db, extractionId: string) {
  const [row] = await db.select().from(extractions).where(eq(extractions.id, z.string().uuid().parse(extractionId)));
  if (!row) throw new ActionError("not_found", "Unknown extraction");
  const [doc] = await db.select().from(documents).where(eq(documents.id, row.documentId));
  return { row, doc };
}

/** Mapped events for an already confirmed extraction (read-only; safe for any caller to expose). */
export async function eventsForConfirmed(db: Db, extractionId: string): Promise<CommitmentEventJson[]> {
  const { row, doc } = await getExtractionById(db, extractionId);
  if (row.status !== "confirmed") throw new ActionError("conflict", `Extraction is ${row.status}; only a confirmed extraction can be mapped`);
  return mapExtractionToEvents(row.result as unknown as ExtractionResult, { status: row.status, filename: doc.filename }).map(commitmentEventToJson);
}
