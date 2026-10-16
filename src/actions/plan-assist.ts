// OWNER EDIT ASSISTANT (Batch 13). The owner types what to change ("deposit to 15%, defer 20 days"); ONE model call (no tools, structured output
// only) turns it into a short list of edits; code applies them to the current terms with whitelisted fields and ranges and returns the proposed
// terms and a plain diff. Nothing is saved or sent here: the owner reviews the filled-in form, and the usual engine check, mandate check and
// signature decide everything. The model never supplies a number the owner did not write and never sees documents or counterparty text.
// If the model is unavailable the rule-based reader answers instead (labelled). At most ASSIST_MAX calls per case.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ASSIST_PURPOSE, applyEdits, assistOutputSchema, buildAssistMessages, ruleEdits, type AssistChange, type AssistCounterparty } from "@/agent";
import { getGateway, type Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { actionRecords, agentRuns, counterparties } from "@/db/schema";
import { leverSchema, type Lever } from "@/domain/plan";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export const assistInputSchema = z.object({
  runId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(500),
  /** The terms as they stand in the owner's form (not yet saved). */
  levers: z.array(leverSchema).min(1).max(6),
});

export const assistMax = (): number => {
  const n = Number(process.env.PLAN_EDIT_ASSIST_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
};

export type AssistResult =
  | { ok: true; source: "model" | "rules"; levers: Lever[]; changes: AssistChange[]; ignored: string[]; unclear: string | null; remaining: number }
  | { ok: false; error: string; remaining: number };

export async function assistEdit(db: Db, businessId: string, input: unknown, opts: { gateway?: Gateway } = {}): Promise<AssistResult> {
  const { runId, instruction, levers } = assistInputSchema.parse(input);
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.businessId, businessId)));
  if (!run) throw new ActionError("not_found", "Unknown agent run for this business");

  const [{ used }] = await db.select({ used: sql<number>`count(*)::int` }).from(actionRecords)
    .where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.PLAN_EDIT_ASSISTED), sql`${actionRecords.detail}->>'runId' = ${runId}`));
  const max = assistMax();
  if (used >= max) return { ok: false, error: `You have used the assistant ${max} times on this case. Use the form to make further changes.`, remaining: 0 };

  const cps = await db.select({ id: counterparties.id, name: counterparties.name, role: counterparties.role }).from(counterparties).where(eq(counterparties.businessId, businessId)).orderBy(counterparties.name);
  const refs: AssistCounterparty[] = cps.map((c, i) => ({ ref: `c${i + 1}`, id: c.id, name: c.name, role: c.role }));
  const messages = buildAssistMessages(levers, refs, instruction);

  let source: "model" | "rules" = "model";
  let output;
  try {
    const gw = opts.gateway ?? getGateway();
    output = (await gw.generateStructured(assistOutputSchema, messages, { purposeId: ASSIST_PURPOSE, businessId, logger: dbCallLogger })).object;
  } catch {
    // The model could not be reached or did not answer in the schema: the rule-based reader handles common phrasings.
    source = "rules";
    output = ruleEdits({ terms: levers.map((l) => ({ kind: l.kind })), instruction });
  }
  const applied = applyEdits(levers, output.edits, refs);
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.PLAN_EDIT_ASSISTED, actor: "owner",
    detail: { runId, source, instructionSha256: createHash("sha256").update(instruction, "utf8").digest("hex"), instructionLength: instruction.length, changes: applied.changes, ignoredCount: applied.ignored.length, unclear: output.unclear ? true : false },
  });
  return { ok: true, source, levers: applied.levers, changes: applied.changes, ignored: applied.ignored, unclear: output.unclear, remaining: Math.max(0, max - used - 1) };
}
