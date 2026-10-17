// "ASK ABOUT MY CASH" (Rescue My Cash Flow). The owner asks a question in words; the answer is built from facts that DETERMINISTIC code computed
// (the forecast, the shortage causes, the what-if, the stored plans, the signed limits). At most ONE model call, with no tools and no database access, may
// phrase the answer; code rejects it when it contains an amount or percentage that is not in the facts, and then uses the rule-based answer.
// Nothing here writes to the books or the sandbox, signs, approves or executes: a question that asks for an action is declined and pointed at
// Review and sign. The only write is one log record (a fingerprint of the question, never its text).
import { createHash } from "node:crypto";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { ASK_SUGGESTIONS, CASH_ASK_PURPOSE, askOutputSchema, buildAskMessages, checkProse, classifyQuestion, claimsIn, collectNumbers, detailLines, ruleAnswer, type AskFacts, type AskPlanFact } from "@/agent";
import { getGateway, type Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { actionRecords, agentRuns, plans } from "@/db/schema";
import type { Lever, PlanView } from "@/domain/plan";
import { appendRecord } from "./log";
import { getRoom } from "./room";
import { ACTION_EVENTS, type Db } from "./types";

export const askInputSchema = z.object({ question: z.string().trim().min(1).max(300) });

export const askMaxPerHour = (): number => {
  const n = Number(process.env.CASH_ASK_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
};
const MAX_REPLAN_ROUNDS = 2;

export type AskResult =
  | { ok: true; source: "model" | "rules"; intent: string; answer: string; unsupported: string | null; details: string[]; evidence: { label: string; href: string }[]; suggestions: string[] }
  | { ok: false; error: string };

const KIND_PHRASE: Record<string, string> = { customer_receipt: "a customer payment", supplier_deposit: "a supplier deposit", supplier_balance: "a supplier balance payment", cost: "a cost", financing: "a financing payment", other: "a payment" };
const askText = (l: Lever): string => {
  switch (l.kind) {
    case "supplier_reduce_deposit": return `lower the supplier deposit to ${l.percentBps / 100}%`;
    case "supplier_defer_balance": return `pay the supplier balance ${l.daysAfterShipment} days after shipment`;
    case "buyer_request_deposit": return `ask the buyer for a ${l.percentBps / 100}% deposit`;
    case "finance_invoice": return `borrow against an invoice (${l.advanceBps / 100}% advance)`;
    case "chase_overdue": return `chase overdue invoices (pay within ${l.payWithinDays} days)`;
    case "early_payment_discount": return `offer ${l.discountBps / 100}% to be paid ${l.daysEarly} days early`;
  }
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function gatherFacts(db: Db, businessId: string, lateDays: number | null): Promise<AskFacts> {
  const room = (await getRoom(db, businessId, lateDays ? { lateDays } : {})) as any;
  const f = room.agreed ?? room.forecast;
  const reason = room.shortage?.reason;
  const commitments: { kind: string; date: string; amountMinor: string }[] = room.commitments ?? [];
  const causes = (room.drivers ?? []).map((d: any) => ({
    what: d.kind === "event"
      ? `${KIND_PHRASE[commitments.find((c) => c.date === d.date && c.amountMinor === d.amountMinor)?.kind ?? "other"]} due ${d.date}`
      : d.kind === "counterparty_delay" ? `${d.invoiceCount} invoice${d.invoiceCount === 1 ? "" : "s"} from a customer who usually pays after the due date` : "the what-if delay you chose",
    improvesLowestPointByMinor: d.effectMinor,
  }));
  // The latest run that has plans, and the root of its chain (for the link).
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.businessId, businessId)).orderBy(asc(agentRuns.startedAt));
  let planRows: { plan: unknown }[] = [];
  let run: (typeof runs)[number] | undefined;
  for (const r of [...runs].reverse()) {
    if (r.lifecycle === "superseded") continue;
    planRows = await db.select({ plan: plans.plan }).from(plans).where(eq(plans.runId, r.id)).orderBy(asc(plans.rank));
    if (planRows.length > 0) { run = r; break; }
  }
  let root = run;
  while (root?.parentRunId) root = runs.find((x) => x.id === root!.parentRunId);
  const reserve = BigInt(room.reserveMinor);
  const planFacts: AskPlanFact[] = planRows.map((row, i) => {
    const p = row.plan as PlanView;
    return {
      n: i + 1, label: p.source === "owner" ? "your edit" : `plan ${i + 1}`, asks: p.levers.map(askText),
      minBalanceMinor: p.metrics.minBalanceMinor, minBalanceWeek: p.metrics.minBalanceWeek, totalCostMinor: p.metrics.totalCostMinor, counterparties: p.metrics.counterpartiesNeeded,
      keepsCushion: BigInt(p.metrics.minBalanceMinor) >= reserve, usesFinance: p.levers.some((l) => l.kind === "finance_invoice"),
      blocked: (p.blockers?.length ?? 0) > 0 || (p.checks ?? []).some((c) => c.decision === "deny"),
    };
  });
  return {
    currency: room.business.currency, reserveMinor: room.reserveMinor,
    forecast: { shortage: !!room.shortage?.shortage, minBalanceMinor: f.minBalanceMinor, minBalanceWeek: f.minBalanceWeek, firstNegativeWeek: f.firstNegativeWeek, shortfallMinor: reason?.shortfallMinor ?? null },
    causes,
    downside: room.downside ? { days: room.downside.days, minBalanceMinor: room.downside.minBalanceMinor, minBalanceWeek: room.downside.minBalanceWeek, firstNegativeWeek: room.downside.firstNegativeWeek } : null,
    doNothing: room.forecast ? { minBalanceMinor: room.forecast.minBalanceMinor, minBalanceWeek: room.forecast.minBalanceWeek } : null,
    plans: planFacts, maxReplanRounds: MAX_REPLAN_ROUNDS,
    evidence: [{ label: "Your cash and its causes", href: "/room" }, ...(root ? [{ label: "The plans and their numbers", href: `/room/case?run=${root.id}` }] : []), { label: "Funding options", href: "/room/funding" }, { label: "The records", href: "/room/safety?tab=records" }],
  };
}

export async function askAboutCash(db: Db, businessId: string, input: unknown, opts: { gateway?: Gateway } = {}): Promise<AskResult> {
  const { question } = askInputSchema.parse(input);
  const since = new Date(Date.now() - 3_600_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.CASH_QUESTION_ASKED), gte(actionRecords.createdAt, since)));
  if (n >= askMaxPerHour()) return { ok: false, error: "You have asked a lot of questions in the last hour. Please try again a little later." };

  const { intent, lateDays } = classifyQuestion(question);
  const facts = await gatherFacts(db, businessId, intent === "late" ? lateDays : null);
  let out = ruleAnswer(intent, facts, lateDays);
  let source: "model" | "rules" = "rules";
  let fellBack = false;
  // Questions that ask for an action, or that no rule understands, are answered by code only: the model is not asked.
  if (intent !== "action" && intent !== "unknown" && !(intent === "late" && !lateDays)) {
    try {
      const gw = opts.gateway ?? getGateway();
      const r = (await gw.generateStructured(askOutputSchema, buildAskMessages({ question, intent, facts }), { purposeId: CASH_ASK_PURPOSE, businessId, logger: dbCallLogger })).object;
      const allowed = new Set<string>();
      collectNumbers(facts, allowed);
      for (const p of facts.plans) for (const a of p.asks) claimsIn(a).percentsBps.forEach((b) => allowed.add(b));
      const checked = checkProse(r.answer, allowed);
      if (checked.removed.length === 0 && r.answer.trim().length > 0) { out = r; source = "model"; } else fellBack = true;
    } catch {
      fellBack = true;
    }
  }
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.CASH_QUESTION_ASKED, actor: "owner",
    detail: { intent, source, fellBack, questionSha256: createHash("sha256").update(question, "utf8").digest("hex"), questionLength: question.length },
  });
  return { ok: true, source, intent, answer: out.answer, unsupported: out.unsupported, details: detailLines(intent, facts, lateDays), evidence: facts.evidence, suggestions: ASK_SUGGESTIONS };
}
