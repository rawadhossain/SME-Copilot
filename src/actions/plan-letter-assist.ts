// OWNER LETTER ASSISTANT (Batch 14). The owner asks for a rewrite of one proposal letter ("make it firmer", "shorter", "more formal"). ONE model call (no
// tools, structured output only) returns the rewritten letter; code rejects it if it adds any figure or date that is not already in the letter or the
// locked terms, and otherwise returns it for the owner's editor. Nothing is saved or sent here; the owner reviews, can undo, and signs as usual.
// If the model is unavailable the rule-based rewriter answers (labelled). At most LETTER_ASSIST_MAX calls per case.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { LETTER_ASSIST_PURPOSE, buildLetterRewriteMessages, letterRewriteSchema, ruleRewrite, type LetterRewrite } from "@/agent";
import { getGateway, type Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { actionRecords, agentRuns, counterparties, plans } from "@/db/schema";
import { leverSchema } from "@/domain/plan";
import { letterSchema, newFigures, type Letter } from "@/domain/letter-text";
import { checkSignedMandate } from "@/gate";
import { canonicalize } from "@/gate/canonical";
import { buildContext } from "./agent-run";
import { appendRecord } from "./log";
import { termLinesFor } from "./plan-letters";
import { buildTerms, tolerancesSchema } from "./plan-terms";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export const letterAssistInputSchema = z.object({
  runId: z.string().uuid(),
  planId: z.string().min(1).max(64),
  counterpartyId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(300),
  /** The letter as it stands in the owner's editor. */
  letter: letterSchema,
});

export const letterAssistMax = (): number => {
  const n = Number(process.env.LETTER_ASSIST_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
};

export type LetterAssistResult =
  | { ok: true; source: "model" | "rules"; letter: Letter; changed: boolean; unclear: string | null; remaining: number }
  | { ok: false; error: string; remaining: number };

export async function assistLetter(db: Db, businessId: string, input: unknown, opts: { gateway?: Gateway } = {}): Promise<LetterAssistResult> {
  const { runId, planId: planHash, counterpartyId, instruction, letter } = letterAssistInputSchema.parse(input);
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.businessId, businessId)));
  if (!run) throw new ActionError("not_found", "Unknown agent run for this business");
  const [plan] = await db.select().from(plans).where(and(eq(plans.businessId, businessId), eq(plans.runId, runId), eq(plans.planHash, planHash)));
  if (!plan) throw new ActionError("not_found", "Unknown plan in this run");

  const [{ used }] = await db.select({ used: sql<number>`count(*)::int` }).from(actionRecords)
    .where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.PLAN_LETTER_ASSISTED), sql`${actionRecords.detail}->>'runId' = ${runId}`));
  const max = letterAssistMax();
  if (used >= max) return { ok: false, error: `You have used the letter assistant ${max} times on this case. Edit the letter by hand instead.`, remaining: 0 };

  // The locked terms for this counterparty, rebuilt from the plan exactly as the signing preview builds them.
  const levers = z.array(leverSchema).parse((plan.plan as { levers?: unknown }).levers ?? []);
  const ctx = await buildContext(db, businessId, null);
  const mandate = checkSignedMandate(ctx.mandate);
  const terms = buildTerms(levers, ctx.pending.map((p) => p.event), tolerancesSchema.parse({}), mandate.ok ? mandate.mandate.limits.maxFinanceFeeBps : 0, (plan.plan as { financeFeeBps?: number }).financeFeeBps, 1);
  const termLines = termLinesFor(terms, ctx.currency)[counterpartyId];
  if (!termLines) throw new ActionError("invalid", "This counterparty is not part of the plan");
  const [cp] = await db.select({ name: counterparties.name, role: counterparties.role }).from(counterparties).where(and(eq(counterparties.id, counterpartyId), eq(counterparties.businessId, businessId)));
  if (!cp) throw new ActionError("not_found", "Unknown counterparty");

  let source: "model" | "rules" = "model";
  let output: LetterRewrite;
  try {
    const gw = opts.gateway ?? getGateway();
    const messages = buildLetterRewriteMessages({ counterparty: { name: cp.name.replace(" (SYNTHETIC)", ""), role: cp.role }, letter, termLines, instruction });
    output = (await gw.generateStructured(letterRewriteSchema, messages, { purposeId: LETTER_ASSIST_PURPOSE, businessId, logger: dbCallLogger })).object;
  } catch {
    // The model could not be reached or did not answer in the schema: the rule-based rewriter handles common requests.
    source = "rules";
    output = ruleRewrite({ letter, instruction });
  }

  const log = (rejected: boolean, changed: boolean) =>
    appendRecord(db, {
      businessId, event: ACTION_EVENTS.PLAN_LETTER_ASSISTED, actor: "owner",
      detail: { runId, counterpartyId, source, instructionSha256: createHash("sha256").update(instruction, "utf8").digest("hex"), instructionLength: instruction.length, changed, rejected },
    });
  const remaining = Math.max(0, max - used - 1);

  if (output.unclear) {
    await log(false, false);
    return { ok: true, source, letter, changed: false, unclear: output.unclear, remaining };
  }
  const rewritten = letterSchema.safeParse({ subject: output.subject, paragraphs: output.paragraphs });
  if (!rewritten.success) {
    await log(true, false);
    return { ok: false, error: "The assistant returned a letter that could not be used, so nothing was changed. Try again or edit by hand.", remaining };
  }
  const added = newFigures(letter, rewritten.data, termLines);
  if (added.length > 0) {
    await log(true, false);
    return { ok: false, error: `The rewrite introduced ${added.join(", ")}, which ${added.length === 1 ? "is" : "are"} not in your letter or your terms, so nothing was changed. Try again, or edit by hand.`, remaining };
  }
  const changed = canonicalize(rewritten.data) !== canonicalize(letter);
  await log(false, changed);
  return { ok: true, source, letter: rewritten.data, changed, unclear: null, remaining };
}
