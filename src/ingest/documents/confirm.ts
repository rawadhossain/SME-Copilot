// OWNER-ONLY PATH: confirm or reject an extraction. Only owner-facing API routes may import this file; src/agent may read
// extractions but must never confirm them (ESLint enforces it). Both outcomes are written to the hash-chained log.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appendActionRecord, ACTION_EVENTS } from "@/actionlog";
import { ActionError, type Db } from "@/actions/types";
import { extractions } from "@/db/schema";
import { commitmentEventToJson, type CommitmentEventJson } from "@/domain/commitment-event";
import { canonicalize } from "@/gate/canonical";
import { mapExtractionToEvents } from "./map";
import { getExtractionById } from "./store";
import type { ExtractionResult, FlagsBlob } from "./validate";

const who = z.string().trim().min(1).max(100);

export async function confirmExtraction(db: Db, extractionId: string, confirmedByInput: string) {
  const confirmedBy = who.parse(confirmedByInput);
  const { row, doc } = await getExtractionById(db, extractionId);
  if (row.status !== "pending_confirmation") throw new ActionError("conflict", `Extraction is ${row.status}; only a pending extraction can be confirmed`);
  const flags = row.flags as unknown as FlagsBlob;
  if (flags.flags.some((f) => f.severity === "error")) throw new ActionError("refused", "The extraction has errors (missing, rejected or contradictory fields) and cannot be confirmed");
  const result = row.result as unknown as ExtractionResult;
  if (!result.derived) throw new ActionError("refused", "Nothing can be mapped from this extraction");

  const claimed = await db
    .update(extractions)
    .set({ status: "confirmed", confirmedAt: new Date(), confirmedBy })
    .where(and(eq(extractions.id, row.id), eq(extractions.status, "pending_confirmation")))
    .returning({ id: extractions.id });
  if (claimed.length === 0) throw new ActionError("conflict", "Extraction was already handled");
  await appendActionRecord(db, {
    businessId: row.businessId, event: ACTION_EVENTS.DOCUMENT_EXTRACTION_CONFIRMED, actor: "owner",
    detail: {
      extractionId: row.id, documentId: doc.id, filename: doc.filename, confirmedBy,
      resultHash: createHash("sha256").update(canonicalize(row.result), "utf8").digest("hex"),
      warnings: flags.flags.map((f) => f.code), suspiciousPassages: flags.suspicious.length,
    },
    verification: "verified",
  });
  const events = mapExtractionToEvents(result, { status: "confirmed", filename: doc.filename }).map(commitmentEventToJson);
  return { extractionId: row.id, status: "confirmed" as const, events: events as CommitmentEventJson[] };
}

export async function rejectExtraction(db: Db, extractionId: string, rejectedByInput: string, reason?: string) {
  const rejectedBy = who.parse(rejectedByInput);
  const { row, doc } = await getExtractionById(db, extractionId);
  if (row.status !== "pending_confirmation" && row.status !== "failed") throw new ActionError("conflict", `Extraction is ${row.status}; it cannot be rejected`);
  await db.update(extractions).set({ status: "rejected", confirmedAt: new Date(), confirmedBy: rejectedBy }).where(eq(extractions.id, row.id));
  await appendActionRecord(db, {
    businessId: row.businessId, event: ACTION_EVENTS.DOCUMENT_EXTRACTION_REJECTED, actor: "owner",
    detail: { extractionId: row.id, documentId: doc.id, filename: doc.filename, rejectedBy, reason: reason?.slice(0, 300) ?? null, previousStatus: row.status },
  });
  return { extractionId: row.id, status: "rejected" as const };
}
