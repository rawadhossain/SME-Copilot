// COPILOT (conversational front door), orchestrator. A sentence becomes a TYPED request, validated by code, executed by the EXISTING read-only engines
// (the Ask rule router, the flight simulator's own function, the funding decision and the product match). The model, when it is asked at all, maps words
// to a closed schema and nothing else; every answer is written here from engine results. The only write is ONE log record per question (copilot.asked:
// a fingerprint and length of the sentence, the request type, whether it was resolved, the source; no free text and no names).
// This file must never import plan authorisation, execution, approvals, sandbox writes, signing, the mandate or the simulator hand-off (ESLint enforces it).
import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { COPILOT_PURPOSE, EXAMPLE_SENTENCES, MAX_SENTENCE, PAGE_HREF, PAGE_LABEL, applyModification, buildCopilotMessages, classifyQuestion, copilotOutputSchema, parseByRules, parseModelOutput, previousScenarioSchema, resolveName, toEvent, toRawOutput, understoodEvent, type CopilotEvent, type CopilotRequest, type NameRef, type UnsupportedReason } from "@/agent";
import { formatMinor } from "@/agent/plan-builder";
import { getGateway, type Gateway } from "@/ai";
import { dbCallLogger } from "@/ai/db-logger";
import { actionRecords } from "@/db/schema";
import { scenarioSchema, type ScenarioInput } from "@/domain/flight-scenario";
import { parseDecimalToMinor } from "@/lib/money";
import { askMaxPerHour, ruleBasedAsk } from "./cash-ask";
import { liveContext, runOne, getSimulatorOptions, type SimulationReport } from "./flight-simulator";
import { assessFundingReadOnly } from "./funding-decision";
import { computeFundingMatch } from "./funding-match";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export const copilotModelMaxPerHour = (): number => {
  const n = Number(process.env.COPILOT_MODEL_PER_HOUR);
  return Number.isFinite(n) && n >= 0 && process.env.COPILOT_MODEL_PER_HOUR !== undefined && process.env.COPILOT_MODEL_PER_HOUR !== "" ? Math.floor(n) : 30;
};

export const copilotInputSchema = z.object({ message: z.string().trim().min(1, "Type a question or a what-if.").max(MAX_SENTENCE, `Please keep it under ${MAX_SENTENCE} characters.`), previous: previousScenarioSchema.optional() });

export interface CopilotLink { label: string; href: string; primary?: boolean }
export interface CopilotResult {
  kind: "scenario" | "funding" | "page" | "ask" | "action_declined" | "clarify" | "unsupported";
  /** How I understood that, in plain words (one line per parsed event). */
  understood: string[];
  answerText: string;
  /** Supporting lines written by code. */
  lines: string[];
  /** The typed events of a scenario; `raw` is the same list in the shape the next question sends back as `previous` for a follow-up. */
  scenario: { events: CopilotEvent[]; raw: unknown[] } | null;
  /** Figures of a scenario, money as strings (minor units) so the screen formats them. */
  summary: Record<string, unknown> | null;
  links: CopilotLink[];
  needsClarification: { question: string; choices: { label: string; message: string | null }[] } | null;
  hypothetical: boolean;
  source: "rules" | "model" | "parser";
}

type Names = { customers: NameRef[]; suppliers: NameRef[] };

const money = (cur: string) => (amount: string): string => {
  try { return formatMinor(parseDecimalToMinor(amount, 2).toString(), cur); } catch { return amount; }
};
const plural = (n: number, a: string, b: string) => (n === 1 ? a : b);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

const blank = (source: CopilotResult["source"]): Omit<CopilotResult, "kind" | "answerText"> => ({ understood: [], lines: [], scenario: null, summary: null, links: [], needsClarification: null, hypothetical: false, source });

const REASON_TEXT: Record<UnsupportedReason, string> = {
  off_topic: "That is outside what I can look at: your cash, your invoices and bills, your funding options and what-if scenarios.",
  unclear: "I couldn't understand that.",
  needs_cost_data: "I can't say anything about profit or margin: your records hold invoices, bills and bank transactions but no cost-of-goods or tax data, so I can only describe your cash.",
  out_of_range: "I couldn't use one of the numbers in that: a late payment can be 1 to 90 days, paying less 1 to 100 percent, and a bill can fall due 0 to 26 weeks ahead.",
  too_many_events: "That is more than 6 changes at once, which is the most a scenario can hold. Try fewer.",
  other: "I couldn't understand that.",
};

function unsupported(reason: UnsupportedReason, source: CopilotResult["source"]): CopilotResult {
  const withExamples = reason === "unclear" || reason === "other" || reason === "off_topic";
  return { ...blank(source), kind: "unsupported", answerText: REASON_TEXT[reason], lines: withExamples ? ["Try a sentence like:", ...EXAMPLE_SENTENCES.map((s) => `“${s}”`)] : [] };
}

/** The real names of the people the owner could have meant, listed by code as data; each choice resubmits the sentence with that name in it. */
function clarification(kind: "customer" | "supplier", mention: string, res: { status: "ambiguous"; matches: string[] } | { status: "none" }, all: NameRef[], sentence: string): CopilotResult {
  const names = res.status === "ambiguous" ? res.matches : all.map((n) => n.name).sort();
  const re = new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const swap = (name: string): string | null => (re.test(sentence) ? sentence.replace(re, name.replace(/\s*\(synthetic\)/i, "")) : null);
  mention = sentence.match(re)?.[0] ?? mention; // shown as the owner typed it
  const question = res.status === "ambiguous"
    ? `Which ${kind} do you mean by “${mention}”? ${names.length} of your ${kind}s match.`
    : `I couldn't find a ${kind} called “${mention}” in your books. Your ${kind}s are listed below; pick one and I will run it.`;
  return { ...blank("rules"), kind: "clarify", answerText: question, needsClarification: { question, choices: names.map((n) => ({ label: n, message: swap(n) })) } };
}

/** Resolves every name in the events against the books; the first problem becomes a clarifying question (and nothing runs). */
function resolveEvents(events: CopilotEvent[], names: Names, sentence: string, asOf: string): { ok: true; shocks: ScenarioInput["shocks"]; shown: { customer?: string; supplier?: string }[] } | { ok: false; result: CopilotResult } {
  const shocks: ScenarioInput["shocks"] = [];
  const shown: { customer?: string; supplier?: string }[] = [];
  for (const e of events) {
    if (e.type === "unexpected_expense") {
      shocks.push({ kind: "unexpected_expense", amount: e.amount, dueOn: e.date ?? addDays(asOf, 7 * (e.weeksAhead ?? 0)), label: e.label });
      shown.push({});
      continue;
    }
    const isSupplier = e.type === "supplier_refuses";
    const mention = isSupplier ? e.supplier : e.customer;
    const list = isSupplier ? names.suppliers : names.customers;
    const r = resolveName(mention, list);
    if (r.status !== "ok") return { ok: false, result: clarification(isSupplier ? "supplier" : "customer", mention, r, list, sentence) };
    if (e.type === "customer_late") shocks.push({ kind: "customer_late", counterpartyId: r.id, days: e.days });
    else if (e.type === "customer_pays_less") shocks.push({ kind: "customer_short", counterpartyId: r.id, shortBps: Math.round(e.percent * 100) });
    else shocks.push({ kind: "supplier_refuses", counterpartyId: r.id, lever: e.deferral && e.lowerDeposit ? "both" : e.deferral ? "supplier_defer_balance" : "supplier_reduce_deposit" });
    shown.push(isSupplier ? { supplier: r.name } : { customer: r.name });
  }
  return { ok: true, shocks, shown };
}

function scenarioAnswer(report: SimulationReport, viewerRole: string, understood: string[], events: CopilotEvent[], scenarioInput: ScenarioInput, source: CopilotResult["source"]): CopilotResult {
  const cur = report.currency;
  const m = (v: string | bigint) => formatMinor(v.toString(), cur);
  const live = report.live, sim = report.simulated;
  const ev = report.evaluation as unknown as { verdict: string; recommendedId: string | null; candidates: { id: string; outcome: string; leverText: string[]; costMinor: bigint; counterparties: number; stillShortMinor: bigint }[] };
  const rec = ev.candidates.find((c) => c.id === ev.recommendedId) ?? null;
  const parts = [
    `Hypothetical, not verified. Your lowest balance on today's books is ${m(live.minBalanceMinor)} (week ${live.minBalanceWeek}); in this scenario it is ${m(sim.minBalanceMinor)} (week ${sim.minBalanceWeek}).`,
    sim.firstBelowReserveWeek === null
      ? `Every week stays at or above your ${m(report.reserveMinor)} cushion.`
      : `The balance first falls below your ${m(report.reserveMinor)} cushion in week ${sim.firstBelowReserveWeek}${sim.firstNegativeWeek ? ` and below zero in week ${sim.firstNegativeWeek}` : ""}.`,
    ev.verdict === "no_shortage" ? "Nothing needs to be done in this scenario."
      : rec && rec.outcome === "resolves" ? `The recommended response closes the gap: ${rec.leverText.join("; ")} (cost ${m(rec.costMinor)}; ${rec.counterparties} ${plural(rec.counterparties, "party is", "parties are")} asked).`
      : rec && rec.outcome === "reduces" ? `The best response only reduces the gap: ${rec.leverText.join("; ")} (cost ${m(rec.costMinor)}); it still leaves the balance ${m(rec.stillShortMinor)} short of your cushion.`
      : "Nothing within your limits closes this.",
  ];
  const href = `/room/simulator?scenario=${b64url(scenarioInput)}`;
  const eligible = !!rec && (rec.outcome === "resolves" || rec.outcome === "reduces") && viewerRole === "owner";
  return {
    ...blank(source), kind: "scenario", understood, answerText: parts.join(" "), hypothetical: true, scenario: { events, raw: toRawOutput({ type: "simulate_scenario", events }).events ?? [] },
    summary: {
      currency: cur, liveLowestMinor: live.minBalanceMinor, liveLowestWeek: live.minBalanceWeek, scenarioLowestMinor: sim.minBalanceMinor, scenarioLowestWeek: sim.minBalanceWeek, reserveMinor: report.reserveMinor,
      firstBelowReserveWeek: sim.firstBelowReserveWeek, firstNegativeWeek: sim.firstNegativeWeek, verdict: ev.verdict,
      recommended: rec ? { outcome: rec.outcome, actions: rec.leverText, costMinor: rec.costMinor.toString(), parties: rec.counterparties, stillShortMinor: rec.stillShortMinor.toString() } : null,
      eligibleForPlans: eligible,
    },
    links: [{ label: "Open full results in Simulator", href, primary: !eligible }, ...(eligible ? [{ label: "Review this strategy in Plans", href, primary: true }] : [])],
  };
}

async function recentCount(db: Db, businessId: string, extra = sql`true`): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(actionRecords).where(and(eq(actionRecords.businessId, businessId), eq(actionRecords.event, ACTION_EVENTS.COPILOT_ASKED), gte(actionRecords.createdAt, since), extra));
  return n;
}

/** Mapping words to a typed request: ONE model call (no tools), validated; the offline parser when the model is unavailable or returns something unusable. */
async function toTypedRequest(db: Db, businessId: string, sentence: string, previous: CopilotEvent[] | null, names: Names, asOf: string, gateway?: Gateway): Promise<{ request: CopilotRequest; source: "model" | "parser"; modelCalled: boolean }> {
  let modelCalled = false;
  if ((await recentCount(db, businessId, sql`${actionRecords.detail}->>'modelCalled' = 'true'`)) < copilotModelMaxPerHour()) {
    modelCalled = true;
    try {
      const gw = gateway ?? getGateway();
      const out = (await gw.generateStructured(copilotOutputSchema, buildCopilotMessages({ sentence, previous, customers: names.customers.map((n) => n.name), suppliers: names.suppliers.map((n) => n.name), asOf }), { purposeId: COPILOT_PURPOSE, businessId, logger: dbCallLogger })).object;
      const checked = parseModelOutput(out, asOf);
      if (checked.ok) return { request: checked.value, source: "model", modelCalled };
    } catch {
      /* no recording, a provider error or a reply outside the schema: the parser below */
    }
  }
  return { request: parseByRules(sentence, asOf, { previous, names: [...names.customers, ...names.suppliers].map((n) => n.name) }), source: "parser", modelCalled };
}

export async function askCopilot(db: Db, businessId: string, input: unknown, opts: { gateway?: Gateway; viewerRole?: string } = {}): Promise<CopilotResult> {
  const parsed = copilotInputSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("invalid", parsed.error.issues.map((i) => i.message).join(" "));
  const { message } = parsed.data;
  const sim = await getSimulatorOptions(db, businessId).catch(() => null);
  if (!sim) throw new ActionError("not_found", "Business not found");
  if ((await recentCount(db, businessId)) >= askMaxPerHour()) throw new ActionError("refused", "You have asked a lot of questions in the last hour. Please try again a little later.");

  // The previous scenario the client sends back is revalidated in full.
  let previous: CopilotEvent[] | null = null;
  if (parsed.data.previous) {
    const evs: CopilotEvent[] = [];
    for (const e of parsed.data.previous.events) { const c = toEvent(e, sim.asOf); if (!c.ok) throw new ActionError("invalid", "The previous scenario is not valid."); evs.push(c.value); }
    previous = evs;
  }
  const names: Names = { customers: sim.customers, suppliers: sim.suppliers };
  const cur = sim.currency;

  let result: CopilotResult;
  let type = "unsupported";
  let source: CopilotResult["source"] = "rules";
  let modelCalled = false;

  const cls = classifyQuestion(message);
  const askOwned = ["why_short", "plan_compare", "ledger", "refusal", "data_quality", "insights", "analysis"];
  // The Ask router recognises words like "bill" or "refuses"; a sentence with the exact shape of a typed scenario (or a scenario with a number out of range) is the
  // Copilot's, so the rule parser is asked first and only to decide who owns the sentence. It never answers by itself here.
  const shape = parseByRules(message, sim.asOf, { previous, names: [...names.customers, ...names.suppliers].map((n) => n.name) });
  const isTyped = shape.type === "simulate_scenario" || shape.type === "modify_scenario" || shape.type === "funding_question" || (shape.type === "unsupported" && (shape.reason === "out_of_range" || shape.reason === "too_many_events"));
  if (cls.intent === "action") {
    type = "action_request";
    result = { ...blank("rules"), kind: "action_declined", answerText: "I can't do that. Copilot only reads your books and explains; it never pays, signs, sends, approves, executes or changes your limits. To act, open Plans and use Review and sign: you read the terms, confirm with your password, and your signed limits are checked.", links: [{ label: "Open Plans", href: PAGE_HREF.plans, primary: true }] };
  } else if (askOwned.includes(cls.intent) && !isTyped) {
    type = `ask:${cls.intent}`;
    const a = await ruleBasedAsk(db, businessId, message);
    result = { ...blank("rules"), kind: "ask", answerText: a.answer, lines: a.details, links: a.evidence.map((e, i) => ({ label: e.label, href: e.href, primary: i === 0 })) };
  } else {
    const typed = await toTypedRequest(db, businessId, message, previous, names, sim.asOf, opts.gateway);
    modelCalled = typed.modelCalled;
    source = typed.source;
    const r = typed.request;
    type = r.type;
    if (r.type === "simulate_scenario" || r.type === "modify_scenario") {
      const events = r.type === "modify_scenario" && previous ? applyModification(previous, r.events) : r.events;
      if (!events) result = unsupported("too_many_events", source);
      else {
        const resolved = resolveEvents(events, names, message, sim.asOf);
        if (!resolved.ok) result = { ...resolved.result, source };
        else {
          const shocks = resolved.shocks;
          const scenario = scenarioSchema.safeParse({ name: "Copilot scenario", shocks });
          if (!scenario.success) result = unsupported("unclear", source);
          else {
            const understood = events.map((e, i) => understoodEvent(e, resolved.shown[i], money(cur)));
            try {
              const report = runOne(await liveContext(db, businessId), scenario.data);
              result = scenarioAnswer(report, opts.viewerRole ?? "approver", understood, events, scenario.data, source);
            } catch (e) {
              result = { ...blank(source), kind: "unsupported", understood, answerText: `I couldn't run that: ${e instanceof ActionError ? e.message : "it did not fit your books"}.` };
            }
          }
        }
      }
    } else if (r.type === "funding_question") {
      const [fa, match] = await Promise.all([assessFundingReadOnly(db, businessId), computeFundingMatch(db, businessId)]);
      const d = fa.decision;
      const m = (v: bigint) => formatMinor(v.toString(), d.currency);
      const eligible = match.match.results.filter((x) => x.verdict === "eligible");
      result = {
        ...blank(source), kind: "funding", understood: ["You asked whether you need to borrow and what financing could fit"],
        answerText: `${d.recommendation.headline}${d.need.needed ? ` Your deepest gap is ${m(d.need.peakShortfallMinor)} in week ${d.need.peakWeek}.` : ""}${eligible.length > 0 ? ` From the example lender catalogue you may qualify for ${eligible.length} ${plural(eligible.length, "product", "products")} (indicative terms, not quotes).` : ""}`,
        lines: d.recommendation.reasons.slice(0, 3),
        summary: { currency: d.currency, needed: d.need.needed, peakShortfallMinor: d.need.peakShortfallMinor.toString(), recommendation: d.recommendation.kind, eligibleProducts: eligible.length },
        links: [{ label: "Open Funding", href: PAGE_HREF.funding, primary: true }],
      };
    } else if (r.type === "open_page") {
      result = { ...blank(source), kind: "page", understood: [`You want to see ${PAGE_LABEL[r.page]}`], answerText: `Here is ${PAGE_LABEL[r.page]}.`, links: [{ label: `Open ${PAGE_LABEL[r.page]}`, href: PAGE_HREF[r.page], primary: true }] };
    } else if (r.type === "action_request") {
      result = { ...blank(source), kind: "action_declined", answerText: "I can't do that. Copilot only reads your books and explains; it never pays, signs, sends, approves, executes or changes your limits. To act, open Plans and use Review and sign.", links: [{ label: "Open Plans", href: PAGE_HREF.plans, primary: true }] };
    } else {
      // The Ask router owned "late" and "borrowing" questions before; when nothing typed came out of one, its generic answer is better than nothing.
      if ((cls.intent === "late" || cls.intent === "avoid_borrowing") && ["unclear", "other", "off_topic"].includes(r.reason)) {
        const a = await ruleBasedAsk(db, businessId, message);
        type = `ask:${cls.intent}`;
        result = { ...blank("rules"), kind: "ask", answerText: a.answer, lines: a.details, links: a.evidence.map((e, i) => ({ label: e.label, href: e.href, primary: i === 0 })) };
        source = "rules";
      } else result = unsupported(r.reason, source);
    }
  }
  result.source = source;

  await appendRecord(db, {
    businessId, event: ACTION_EVENTS.COPILOT_ASKED, actor: "owner",
    detail: { questionSha256: createHash("sha256").update(message, "utf8").digest("hex"), questionLength: message.length, type, resolved: result.kind !== "unsupported" && result.kind !== "clarify", source, modelCalled },
  });
  return result;
}
