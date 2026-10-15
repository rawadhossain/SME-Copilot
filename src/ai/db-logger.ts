// Writes one llm_calls row per call (operational telemetry, NOT the hash-chained action log). Content-free: no document
// text, no keys. Server-side only (imports the database).
import { db } from "@/db";
import { llmCalls } from "@/db/schema";
import type { CallLogger } from "./types";

export const dbCallLogger: CallLogger = async (row) => {
  try {
    await db.insert(llmCalls).values({
      businessId: row.businessId, purpose: row.purpose, mode: row.mode, model: row.model, requestHash: row.requestHash,
      promptTokens: row.promptTokens, completionTokens: row.completionTokens, latencyMs: row.latencyMs, ok: row.ok, error: row.error,
    });
  } catch {
    // Telemetry must never break a call.
  }
};
