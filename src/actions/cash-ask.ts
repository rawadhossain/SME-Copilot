// "ASK ABOUT MY CASH" (Rescue My Cash Flow). The owner asks a question in words; the answer is built from facts that DETERMINISTIC code computed
// (the forecast, the shortage causes, the what-if, the stored plans, the signed limits). At most ONE model call, with no tools and no database access, may
// phrase the answer; code rejects it when it contains an amount or percentage that is not in the facts, and then uses the rule-based answer.
// Nothing here writes to the books or the sandbox, signs, approves or executes: a question that asks for an action is declined and pointed at
// Review and sign. The only write is one log record (a fingerprint of the question, never its text).
import { createHash } from "node:crypto";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { ASK_SUGGESTIONS, CASH_ASK_PURPOSE, type AnalysisFacts, type AnalysisTopic, type InsightFacts, type InsightTopic, askOutputSchema, buildAskMessages, checkRewrite, classifyQuestion, detailLines, ruleAnswer, type AskFacts, type AskLedger, type AskPlanFact } from "@/agent";
import { getGateway, type Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { actionRecords, agentRuns, plans } from "@/db/schema";
import type { Lever, PlanView } from "@/domain/plan";
import { appendRecord } from "./log";
import { getAnalysis } from "./analysis";
import { getInsights } from "./insights";
import { getLedgerSummary } from "./ledger";
import { getRoom } from "./room";
import { ACTION_EVENTS, type Db } from "./types";

export const askInputSchema = z.object({ question: z.string().trim().min(1).max(300) });

export const askMaxPerHour = (): number => {
  const n = Number(process.env.CASH_ASK_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
};
const MAX_REPLAN_ROUNDS = 2;

export type AskResult =
  | { ok: true; source: "model" | "rules"; /** True when a model answer was produced but refused (an unsupported figure, or an unusable reply), so the rule-based answer was shown. */ modelRefused: boolean; /** Why (first problem, or the call error): for the live check and the log, not shown to the owner. */ modelNote: string | null; /** The code-written answer the wording is based on (shown only by the live check). */ draftAnswer: string; intent: string; answer: string; unsupported: string | null; details: string[]; evidence: { label: string; href: string }[]; suggestions: string[] }
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

/** Totals and the few largest items from the books. Names and numbers are shown by code only; the model never sees them. */
async function ledgerFacts(db: Db, businessId: string): Promise<AskLedger> {
  const l = await getLedgerSummary(db, businessId);
  type V = (typeof l.invoices)[number];
  const totals = (s: typeof l.receivable) => ({ openCount: s.openCount, outstandingMinor: s.outstandingMinor.toString(), overdueCount: s.overdueCount, overdueMinor: s.overdueMinor.toString(), partlyPaidCount: s.partlyPaidCount, dueIn7Minor: s.dueIn7Minor.toString() });
  const item = (v: V) => ({ number: v.number, counterparty: v.counterpartyName, outstandingMinor: v.outstandingMinor.toString(), dueOn: v.dueOn, overdueDays: v.overdueDays });
  const open = (v: V) => v.outstandingMinor > 0n && !["void", "draft", "paid"].includes(v.state);
  const big = (a: V, b: V) => (a.outstandingMinor < b.outstandingMinor ? 1 : a.outstandingMinor > b.outstandingMinor ? -1 : 0);
  return {
    receivable: totals(l.receivable), payable: totals(l.payable),
    overdueInvoices: l.invoices.filter((v) => open(v) && v.overdueDays > 0).sort(big).slice(0, 3).map(item),
    billsDueSoon: l.bills.filter(open).sort((a, b) => a.dueOn.localeCompare(b.dueOn)).slice(0, 3).map(item),
  };
}

/** The findings as the assistant may see them. Evidence rows (names, bank descriptions) are left out: only code-written wording and figures go in. */
async function gatherInsights(db: Db, businessId: string, topic: InsightTopic | null): Promise<InsightFacts> {
  const r = await getInsights(db, businessId);
  return {
    asOf: r.asOf, status: r.status, headline: r.headline, comparable: r.periods.comparable, comparableReason: r.periods.reason, windowDays: r.periods.windowDays, topic,
    findings: r.findings.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, title: f.title, why: f.why, figures: f.figures, comparison: f.comparison?.label ?? null, uncertainty: f.uncertainty, actions: f.actions.map((a) => a.label) })),
    limits: r.limits,
  };
}

/** The business analysis as the assistant may see it: figures and wording from code; only the top customers' names. */
async function gatherAnalysis(db: Db, businessId: string, topic: AnalysisTopic): Promise<AnalysisFacts> {
  const a = await getAnalysis(db, businessId);
  const ag = (x: typeof a.receivables) => ({ totalMinor: x.totalMinor.toString(), count: x.count, overdueMinor: x.overdueMinor.toString(), overdueShareBps: x.overdueShareBps, buckets: x.buckets.map((b) => ({ label: b.label, amountMinor: b.amountMinor.toString(), count: b.count })) });
  const days = (d: typeof a.dso) => ({ days: d.days, reason: d.reason, windowDays: d.window.days, formula: d.formula });
  const r = a.runway;
  return {
    asOf: a.asOf, currency: a.currency, topic, receivables: ag(a.receivables), payables: ag(a.payables), dso: days(a.dso), dpo: days(a.dpo),
    payment: { averageDaysLate: a.paymentBehaviour.averageDaysLate, settledCount: a.paymentBehaviour.settledCount, windowDays: a.paymentBehaviour.window.days, reason: a.paymentBehaviour.reason, trend: a.paymentBehaviour.trend ? { recentAverage: a.paymentBehaviour.trend.recentAverage, priorAverage: a.paymentBehaviour.trend.priorAverage } : null },
    runway: r.burning === null ? { burning: null, reason: r.reason } : r.burning ? { burning: true, months: r.months, monthlyBurnMinor: r.monthlyBurnMinor.toString(), balanceMinor: r.balanceMinor.toString(), monthsUsed: r.monthsUsed } : { burning: false, monthsUsed: r.monthsUsed, averageNetMinor: r.averageNetMinor.toString() },
    customers: a.paymentBehaviour.customers.slice(0, 3).map((c) => ({ name: c.name, openMinor: c.openMinor.toString(), overdueMinor: c.overdueMinor.toString(), oldestDaysOverdue: c.oldestDaysOverdue, shareOfOpenBps: c.shareOfOpenBps })),
    months: a.monthlyCash.months.map((m) => ({ month: m.month, inMinor: m.inMinor.toString(), outMinor: m.outMinor.toString(), netMinor: m.netMinor.toString() })),
    limits: a.limits,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function gatherFacts(db: Db, businessId: string, lateDays: number | null, withLedger = false, insights: { topic: InsightTopic | null } | null = null, analysis: AnalysisTopic | null = null): Promise<AskFacts> {
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
    ...(withLedger ? { ledger: await ledgerFacts(db, businessId) } : {}),
    ...(insights ? { insights: await gatherInsights(db, businessId, insights.topic) } : {}),
    ...(analysis ? { analysis: await gatherAnalysis(db, businessId, analysis) } : {}),
    plans: planFacts, maxReplanRounds: MAX_REPLAN_ROUNDS, asOf: room.asOf, dataGaps: room.gaps ?? [], dataNotes: room.notes ?? [],
    evidence: [{ label: "Your cash and its causes", href: "/room" }, ...(root ? [{ label: "The plans and their numbers", href: `/room/case?run=${root.id}` }] : []), { label: "Funding options", href: "/room/funding" }, ...(insights ? [{ label: "Financial health and warnings", href: "/room#financial-health" }] : []), ...(withLedger ? [{ label: "Invoices & bills", href: "/room/invoices" }] : []), { label: "The records", href: "/room/safety?tab=records" }],
  };
}

export async function askAboutCash(db: Db, businessId: string, input: unknown, opts: { gateway?: Gateway } = {}): Promise<AskResult> {
  const { question } = askInputSchema.parse(input);
  const since = new Date(Date.now() - 3_600_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.CASH_QUESTION_ASKED), gte(actionRecords.createdAt, since)));
  if (n >= askMaxPerHour()) return { ok: false, error: "You have asked a lot of questions in the last hour. Please try again a little later." };

  const { intent, lateDays, weekAsked, topic, analysisTopic } = classifyQuestion(question);
  const facts = await gatherFacts(db, businessId, intent === "late" ? lateDays : null, intent === "ledger", intent === "insights" ? { topic } : null, intent === "analysis" ? analysisTopic : null);
  // The answer is written by code from the facts. A model may only REWORD it (it sees the question and that draft, never the facts); the rewording is used
  // only if every figure in it is already in the draft and it claims no action. Anything else, or any failure, and the code-written answer is shown.
  const draft = ruleAnswer(intent, facts, lateDays, weekAsked);
  let out = draft;
  let source: "model" | "rules" = "rules";
  let fellBack = false;
  let modelNote: string | null = null;
  // Questions that ask for an action, or that no rule understands, are answered by code only: the model is not asked.
  if (intent !== "action" && intent !== "unknown" && !(intent === "late" && !lateDays)) {
    try {
      const gw = opts.gateway ?? getGateway();
      const r = (await gw.generateStructured(askOutputSchema, buildAskMessages({ question, intent, draft: draft.answer }), { purposeId: CASH_ASK_PURPOSE, businessId, logger: dbCallLogger })).object;
      const checked = checkRewrite(r.answer, draft.answer);
      if (checked.ok) { out = { answer: r.answer, unsupported: draft.unsupported }; source = "model"; } else { fellBack = true; modelNote = checked.problems.join("; "); }
    } catch (e) {
      fellBack = true;
      modelNote = `model call failed: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`;
    }
  }
  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.CASH_QUESTION_ASKED, actor: "owner",
    detail: { intent, source, fellBack, modelNote: modelNote ? modelNote.replace(/[0-9]/g, "#").slice(0, 160) : null, questionSha256: createHash("sha256").update(question, "utf8").digest("hex"), questionLength: question.length },
  });
  return { ok: true, source, modelRefused: fellBack, modelNote, draftAnswer: draft.answer, intent, answer: out.answer, unsupported: out.unsupported, details: detailLines(intent, facts, lateDays), evidence: facts.evidence, suggestions: ASK_SUGGESTIONS };
}
