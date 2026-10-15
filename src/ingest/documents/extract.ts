// extractDocument: ONE quarantined model call (no tools, structured output only), then deterministic validation.
// No database access here. The document is untrusted data: the model is told to ignore and report instructions in it,
// and the validator checks every claim against the text anyway.
import type { ZodType } from "zod";
import { getGateway, type Gateway, type CallLogger } from "@/ai";
// Registers the scripted responses used by the mock provider (tests and the offline demo). Not used with a real model.
import "./scripted";
import { buildMessages, purposeIdFor, PROMPT_VERSION } from "./prompt";
import { poOutputSchema, quoteOutputSchema, type DocKind } from "./schema";
import { failedOutcome, validateExtraction, type Outcome } from "./validate";

export interface ExtractionRun {
  outcome: Outcome;
  model: string;
  promptVersion: string;
}

export async function extractDocument(
  text: string,
  kind: DocKind,
  opts: { asOf: string; businessId?: string | null; gateway?: Gateway; logger?: CallLogger },
): Promise<ExtractionRun> {
  const gw = opts.gateway ?? getGateway();
  const schema = (kind === "purchase_order" ? poOutputSchema : quoteOutputSchema) as unknown as ZodType<unknown>;
  try {
    const { object, meta } = await gw.generateStructured(schema, buildMessages(text, kind), { purposeId: purposeIdFor(kind), businessId: opts.businessId ?? null, logger: opts.logger });
    return { outcome: validateExtraction(kind, text, object, { asOf: opts.asOf }), model: meta.model, promptVersion: PROMPT_VERSION };
  } catch (e) {
    // The reader failed (missing recording, bad config, schema failure). The deterministic scan still runs.
    const message = e instanceof Error ? `${e.name}: ${e.message}` : "The reader failed";
    return { outcome: failedOutcome(kind, text, opts.asOf, message.slice(0, 500)), model: gw.config.model || "mock", promptVersion: PROMPT_VERSION };
  }
}
