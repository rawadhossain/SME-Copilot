// AUTOMATION RUNNER. Owner-defined flows (src/domain/automation.ts) run on the existing monitor pass: after the monitor has evaluated, every enabled automation
// whose trigger matches runs once per trigger event. An automation can only NOTIFY, PREPARE or DRAFT: it creates in-app notifications, starts the existing
// read-only planning run, runs a read-only what-if, or writes a draft letter. It never pays, signs, approves, executes, edits limits, or sends anything out.
// This module must not import the signing, approval, execution, sandbox-write or mandate code (ESLint-enforced, like src/agent).
//
// Two parts. `triggerEvents` and `evaluate` are PURE: they take the snapshot the monitor already built (the engine's forecast, the ledger's open invoices and bills,
// the alert rules' candidates) and decide which events match and which nodes a flow reaches; they recompute no figure. The DB part claims a run (dedupe),
// performs the planned effects, stores the node results and writes one log record. A dry run evaluates on the current books and changes nothing.
//
// Once per situation: a run is keyed by (automation, trigger entity, books date), capped at MAX_RUNS_PER_DAY per automation, and an entity that already ran
// within COOLDOWN_DAYS does not run again (a weekly digest has the date in its entity, so it runs weekly). A `wait` stores its resume date and continues on a
// later monitor pass, re-reading the current books; if the situation no longer applies the run stops.
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { automationRuns, automations, businesses, notifications } from "@/db/schema";
import { automationNameSchema, graphSchema, type Action, type Condition, type FlowGraph, type FlowNode, type NodeOutcome, type NodeResult, type Trigger } from "@/domain/automation";
import { addDays, diffDays, isForecast, owedOf, SEVERITY_RANK, type AlertSeverity, type BillRecord, type CandidateAlert, type InvoiceRecord } from "@/engine";
import { safeName } from "@/engine/alerts";
import { formatMoney, money } from "@/lib/money";
import { getAnalysis } from "./analysis";
import { liveContext, runOne } from "./flight-simulator";
import { computeFundingMatch } from "./funding-match";
import { appendRecord } from "./log";
import { insertNotification, type NotificationKind } from "./notifications";
import { loadPlaybook } from "./playbook";
import { checkShortage, detectShortage } from "./shortage";
import { ACTION_EVENTS, type Db } from "./types";

export const MAX_RUNS_PER_DAY = 10;
export const COOLDOWN_DAYS = 14;

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const WEEKDAY_OF = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const weekdayOf = (iso: string) => WEEKDAY_OF[new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** Everything the pure part reads: what the monitor pass already computed. */
export interface AutoSnapshot {
  asOf: string;
  currency: string;
  reserveMinor: bigint;
  weekly: { index: number; start: string; closingMinor: bigint }[];
  invoices: InvoiceRecord[];
  bills: BillRecord[];
  /** The alert rules' output for these books (what the monitor would raise). */
  candidates: CandidateAlert[];
  /** Alerts raised or made more serious in THIS pass. */
  raised: { kind: string; severity: AlertSeverity; dedupeKey: string; title: string; detail: string; route: string }[];
  /** Why the monitor ran (e.g. "document_confirmed"). */
  reason: string;
}

/** Values a condition can test. Absent (null) when the event has no such value; a check on an absent value does not hold. */
export interface Facts { amountMinor: bigint | null; daysOverdue: number | null; customerId: string | null; belowCushionAfterBill: boolean | null; severity: AlertSeverity | null; shortfallMinor: bigint | null }
const noFacts: Facts = { amountMinor: null, daysOverdue: null, customerId: null, belowCushionAfterBill: null, severity: null, shortfallMinor: null };

export interface TriggerEvent { entity: string; facts: Facts; title: string; body: string; link: string; invoice?: InvoiceRecord }

const fmt = (s: AutoSnapshot, v: bigint) => formatMoney(money(v, s.currency), EXPONENTS[s.currency] ?? 2);
const severityOf = (s: AutoSnapshot, key: string): AlertSeverity | null => s.candidates.find((c) => c.dedupeKey === key)?.severity ?? null;

/** The week of the forecast a due date falls in (the same lookup the bill alert rule uses). */
function weekFor(s: AutoSnapshot, daysUntilDue: number) {
  return s.weekly[Math.max(0, Math.min(s.weekly.length - 1, Math.floor(Math.max(0, daysUntilDue) / 7)))];
}

export function digestBody(s: AutoSnapshot, savedItems: string[]): string {
  const lines: string[] = [];
  if (s.weekly.length > 0) {
    const low = s.weekly.reduce((a, w) => (w.closingMinor < a.closingMinor ? w : a));
    lines.push(`Lowest balance ahead: ${fmt(s, low.closingMinor)} in the week of ${dayText(low.start)} (your cushion is ${fmt(s, s.reserveMinor)}).`);
  }
  const overdue = s.invoices.filter((i) => isForecast(i) && i.dueOn < s.asOf);
  if (overdue.length > 0) lines.push(`Overdue from customers: ${fmt(s, overdue.reduce((a, i) => a + owedOf(i), 0n))} across ${overdue.length} ${plural(overdue.length, "invoice", "invoices")}.`);
  else lines.push("No customer invoices are overdue.");
  const soon = s.bills.filter((b) => isForecast(b) && diffDays(s.asOf, b.dueOn) <= 7);
  if (soon.length > 0) lines.push(`Bills due within a week: ${soon.length}, ${fmt(s, soon.reduce((a, b) => a + owedOf(b), 0n))} in total.`);
  else lines.push("No bills are due within a week.");
  lines.push(s.candidates.length > 0 ? `${s.candidates.length} ${plural(s.candidates.length, "alert is", "alerts are")} open.` : "No alerts are open.");
  if (savedItems.length > 0) lines.push(`Saved for this digest: ${savedItems.join("; ")}.`);
  return lines.join(" ");
}

// ---------------------------------------------------------------- which events match a trigger (pure)

/** The current events a trigger matches. `preview` (dry run) assumes an event-type trigger (digest day, confirmed document) has just happened. */
export function triggerEvents(t: Trigger, s: AutoSnapshot, preview = false): TriggerEvent[] {
  switch (t.kind) {
    case "forecast_below_cushion": {
      const a = s.candidates.find((c) => c.kind === "cash_below_cushion");
      const first = a?.figures.firstShortWeek as number | null | undefined;
      if (!a || first == null || first > t.withinWeeks) return [];
      return [{ entity: "cushion", facts: { ...noFacts, severity: a.severity, shortfallMinor: BigInt(String(a.figures.shortfallMinor)) }, title: a.title, body: a.detail, link: a.refs.route }];
    }
    case "invoice_overdue": {
      const min = t.minAmount ? BigInt(t.minAmount) : 0n;
      return s.invoices.filter(isForecast).flatMap((i) => {
        const days = diffDays(i.dueOn, s.asOf);
        const owed = owedOf(i);
        if (days < t.days || days < 1 || owed < min) return [];
        const who = safeName(i.counterpartyName);
        return [{
          entity: `invoice:${i.id}`, invoice: i, link: "/room/invoices",
          facts: { ...noFacts, amountMinor: owed, daysOverdue: days, customerId: i.counterpartyId, severity: severityOf(s, `overdue_receivable:${i.counterpartyId}`) },
          title: `${who}'s invoice ${i.number} is ${days} ${plural(days, "day", "days")} overdue`,
          body: `${fmt(s, owed)} was due on ${dayText(i.dueOn)}.`,
        }];
      });
    }
    case "bill_due": {
      const min = BigInt(t.minAmount);
      return s.bills.filter(isForecast).flatMap((b) => {
        const days = diffDays(s.asOf, b.dueOn);
        const owed = owedOf(b);
        if (days > t.withinDays || owed < min) return [];
        const wk = weekFor(s, days);
        const below = wk ? wk.closingMinor < s.reserveMinor : null;
        const who = safeName(b.counterpartyName);
        return [{
          entity: `bill:${b.id}`, link: "/room/invoices",
          facts: { ...noFacts, amountMinor: owed, daysOverdue: days < 0 ? -days : 0, belowCushionAfterBill: below, severity: severityOf(s, `bill_due_soon:${b.id}`) },
          title: days < 0 ? `Your bill from ${who} is overdue` : `Your bill from ${who} is due ${days === 0 ? "today" : `in ${days} ${plural(days, "day", "days")}`}`,
          body: `${fmt(s, owed)} is due on ${dayText(b.dueOn)}.${wk && below !== null ? ` Your balance is forecast to be ${fmt(s, wk.closingMinor)} that week, ${below ? "under" : "above"} your ${fmt(s, s.reserveMinor)} cushion.` : ""}`,
        }];
      });
    }
    case "customer_concentration": {
      const open = s.invoices.filter(isForecast);
      const total = open.reduce((a, i) => a + owedOf(i), 0n);
      if (open.length < 2 || total <= 0n) return [];
      const by = new Map<string, { name: string; total: bigint }>();
      for (const i of open) { const c = by.get(i.counterpartyId) ?? { name: i.counterpartyName, total: 0n }; c.total += owedOf(i); by.set(i.counterpartyId, c); }
      const [cid, top] = [...by.entries()].sort((a, b) => (a[1].total < b[1].total ? 1 : a[1].total > b[1].total ? -1 : a[0] < b[0] ? -1 : 1))[0];
      const bps = Number((top.total * 10_000n) / total);
      if (bps <= t.overPercent * 100) return [];
      return [{
        entity: `customer:${cid}`, link: "/room/analysis",
        facts: { ...noFacts, amountMinor: top.total, customerId: cid },
        title: `${safeName(top.name)} owes ${(bps / 100).toFixed(1).replace(/\.0$/, "")}% of what you are owed`,
        body: `${fmt(s, top.total)} of the ${fmt(s, total)} outstanding. If they pay late, your cash plan is hit harder than if the debt were spread out.`,
      }];
    }
    case "alert_raised": {
      const min = SEVERITY_RANK[t.minSeverity];
      return s.raised.filter((r) => SEVERITY_RANK[r.severity] >= min).map((r) => ({ entity: `alert:${r.dedupeKey}:${r.severity}`, facts: { ...noFacts, severity: r.severity }, title: r.title, body: r.detail, link: r.route }));
    }
    case "weekly_digest":
      if (!preview && weekdayOf(s.asOf) !== t.weekday) return [];
      return [{ entity: `digest:${s.asOf}`, facts: noFacts, title: "Your weekly cash digest", body: "", link: "/room" }];
    case "document_confirmed":
      if (!preview && s.reason !== "document_confirmed") return [];
      return [{ entity: `document:${s.asOf}`, facts: noFacts, title: "A document was confirmed", body: "Your books were updated and checked again.", link: "/room" }];
  }
}

// ---------------------------------------------------------------- conditions and the walk (pure)

function holds(c: Condition, f: Facts): boolean {
  switch (c.kind) {
    case "amount_over": return f.amountMinor !== null && f.amountMinor > BigInt(c.amountMinor);
    case "days_overdue_over": return f.daysOverdue !== null && f.daysOverdue > c.days;
    case "customer_is": return f.customerId === c.customerId;
    case "balance_after_bill_below_cushion": return f.belowCushionAfterBill === true;
    case "severity_at_least": return f.severity !== null && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[c.severity];
    case "shortage_depth_over": return f.shortfallMinor !== null && f.shortfallMinor > BigInt(c.amountMinor);
  }
}

export interface EvalResult {
  steps: NodeResult[];
  /** Actions to perform, in order. The pure part only plans them. */
  effects: { node: string; action: Action }[];
  wait: { node: string; next: string | null; resumeOn: string } | null;
}

/** Walk a flow for one event, from the trigger or from a node after a wait. Pure: nothing is performed here. */
export function evaluate(graph: FlowGraph, ev: TriggerEvent, s: AutoSnapshot, opts: { from?: string; dryRun: boolean }): EvalResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = (id: string, label: "next" | "yes" | "otherwise") => graph.edges.find((e) => e.from === id && e.label === label)?.to ?? null;
  const steps: NodeResult[] = [];
  const effects: EvalResult["effects"] = [];
  let wait: EvalResult["wait"] = null;
  let cur: string | null;
  if (opts.from) cur = opts.from;
  else {
    const trig = graph.nodes.find((n) => n.type === "trigger") as Extract<FlowNode, { type: "trigger" }>;
    steps.push({ node: trig.id, outcome: "ran", summary: `Matched: ${ev.title}${ev.body ? `. ${ev.body}` : ""}` });
    cur = next(trig.id, "next");
  }
  for (let guard = 0; cur && guard <= graph.nodes.length; guard++) {
    const n = byId.get(cur);
    if (!n || n.type === "trigger") break;
    if (n.type === "condition") {
      const results = n.checks.map((c) => holds(c, ev.facts));
      const held = results.filter(Boolean).length;
      const ok = n.mode === "all" ? held === n.checks.length : held > 0;
      steps.push({ node: n.id, outcome: ok ? "yes" : "otherwise", summary: `${held} of ${n.checks.length} ${plural(n.checks.length, "check", "checks")} held (${n.mode === "all" ? "all were needed" : "any was enough"}), so it takes the "${ok ? "yes" : "otherwise"}" branch` });
      cur = next(n.id, ok ? "yes" : "otherwise");
      continue;
    }
    const a = n.action;
    if (a.kind === "stop") { steps.push({ node: n.id, outcome: "stopped", summary: "Stopped here" }); break; }
    if (a.kind === "wait") {
      const resumeOn = addDays(s.asOf, a.days);
      wait = { node: n.id, next: next(n.id, "next"), resumeOn };
      steps.push({ node: n.id, outcome: opts.dryRun ? "would_wait" : "waiting", summary: `${opts.dryRun ? "Would wait" : "Waits"} ${a.days} ${plural(a.days, "day", "days")}, then ${wait.next ? `continues on ${dayText(resumeOn)}` : "ends"}` });
      break;
    }
    effects.push({ node: n.id, action: a });
    steps.push({ node: n.id, outcome: opts.dryRun ? "would_run" : "ran", summary: "" });
    cur = next(n.id, "next");
  }
  return { steps, effects, wait };
}

// ---------------------------------------------------------------- the letter (a code template; nothing is sent)

export function reminderDraft(inv: InvoiceRecord, tone: "friendly" | "firm", s: AutoSnapshot, businessName: string): { title: string; body: string } {
  const who = safeName(inv.counterpartyName);
  const days = diffDays(inv.dueOn, s.asOf);
  const amount = fmt(s, owedOf(inv));
  const ask = tone === "friendly"
    ? "If you have already paid, thank you, and please ignore this note. Otherwise we would be grateful if you could arrange payment this week."
    : "Please arrange payment in full within 7 days. If something is wrong with the invoice, tell us now so we can sort it out.";
  return {
    title: `Draft ${tone === "friendly" ? "friendly" : "firm"} reminder to ${who} for invoice ${inv.number}`,
    body: [
      "DRAFT. Nothing has been sent. Read it, change it if you like, and send it yourself.",
      `Subject: Invoice ${inv.number}, ${amount} overdue`,
      `Dear ${who},`,
      `Our records show that invoice ${inv.number} for ${amount}, due on ${dayText(inv.dueOn)}, is now ${days} ${plural(days, "day", "days")} overdue. ${ask}`,
      `Kind regards, ${safeName(businessName)}`,
    ].join("\n\n"),
  };
}

// ---------------------------------------------------------------- performing the planned effects (DB part)

/** Read-only text the two "attach" actions add to the notification (or send alone when the flow has no notify step). Null = could not be read. */
interface Extras { financing: string | null; analysis: string | null }
interface Ctx { db: Db; businessId: string; businessName: string; automation: { id: string; name: string }; runId: string | null; snap: AutoSnapshot; ev: TriggerEvent; dryRun: boolean; extras?: Extras; hasNotify?: boolean }
type Done = { outcome: NodeOutcome; summary: string };

async function whatIf(c: Ctx, scenario: Extract<Action, { kind: "run_simulation" }>["scenario"]): Promise<{ title: string; body: string }> {
  const r = runOne(await liveContext(c.db, c.businessId), scenario);
  const name = r.scenario.name;
  return {
    title: `What-if result: ${name}`,
    body: `HYPOTHETICAL. If this happened, your lowest balance would be ${fmt(c.snap, BigInt(r.simulated.minBalanceMinor))} in the week of ${dayText(r.simulated.minBalanceWeekStart)}, `
      + `against ${fmt(c.snap, BigInt(r.live.minBalanceMinor))} today. ${r.simulated.belowReserve ? `That is under your ${fmt(c.snap, BigInt(r.reserveMinor))} cushion.` : `That stays above your ${fmt(c.snap, BigInt(r.reserveMinor))} cushion.`} Nothing has happened and nothing was sent.`,
  };
}

const oneDecimal = (n: number) => n.toFixed(1).replace(/\.0$/, "");

/** The top eligible synthetic products from the existing funding match (read-only: no log record, nothing applied for). */
async function financingText(c: Ctx): Promise<string> {
  const m = await computeFundingMatch(c.db, c.businessId);
  const top = m.match.results.filter((r) => r.verdict === "eligible").sort((x, y) => x.rank - y.rank).slice(0, 3);
  const head = "Financing options (indicative, made-up lenders, not a quote; nothing is applied for).";
  if (top.length === 0) return `${head} No product is a clean match right now.`;
  return `${head} ${top.map((r) => `${r.lenderName}, ${r.label}: ${fmt(c.snap, r.sizedAmountMinor ?? r.maxQualifyingMinor)}${r.annualisedCostBps !== null ? ` at about ${oneDecimal(r.annualisedCostBps / 100)}% a year` : ""}`).join("; ")}.`;
}

/** The headline figures of the cash analysis (read-only; the engine computes them, nothing here does arithmetic that matters). */
async function analysisText(c: Ctx): Promise<string> {
  const a = await getAnalysis(c.db, c.businessId);
  const lines = [
    `Owed to you: ${fmt(c.snap, a.receivables.totalMinor)} across ${a.receivables.count} ${plural(a.receivables.count, "invoice", "invoices")}.`,
    `Overdue: ${oneDecimal(a.receivables.overdueShareBps / 100)}% of that (${fmt(c.snap, a.receivables.overdueMinor)}).`,
  ];
  const late = a.paymentBehaviour.averageDaysLate;
  if (late !== null) lines.push(`Customers pay ${late} ${plural(late, "day", "days")} late on average.`);
  if (a.runway.burning === true) lines.push(`Runway: about ${oneDecimal(a.runway.months)} ${plural(a.runway.months, "month", "months")} at the recent pace.`);
  return `Cash analysis (cash, not profit). ${lines.join(" ")}`;
}

async function gatherExtras(c: Ctx, effects: EvalResult["effects"]): Promise<Extras> {
  const wants = (k: Action["kind"]) => effects.some((e) => e.action.kind === k);
  return {
    financing: wants("suggest_financing_options") ? await financingText(c).catch(() => null) : null,
    analysis: wants("attach_analysis_snapshot") ? await analysisText(c).catch(() => null) : null,
  };
}

async function perform(c: Ctx, a: Action): Promise<Done> {
  const { db, businessId, snap, ev } = c;
  const note = (a.kind === "notify_owner" || a.kind === "notify_approver") && a.message ? a.message : null;
  const note1 = async (role: "owner" | "approver", kind: NotificationKind, title: string, body: string, link = ev.link, n: string | null = null) => {
    if (c.dryRun) return;
    await insertNotification(db, { businessId, role, kind, title, body, note: n, link, automationId: c.automation.id, runId: c.runId });
  };
  switch (a.kind) {
    case "notify_owner":
    case "notify_approver": {
      const role = a.kind === "notify_owner" ? "owner" : "approver";
      const who = role === "owner" ? "the owner" : "the approver";
      const title = ev.title;
      let body = ev.body;
      let kind: NotificationKind = "notice";
      const extra = [c.extras?.analysis, c.extras?.financing].filter((x): x is string => !!x);
      if (ev.entity.startsWith("digest:")) {
        // The digest gathers what other steps saved for it, and uses them up.
        const items = c.dryRun ? [] : await db.select({ id: notifications.id, title: notifications.title }).from(notifications).where(and(eq(notifications.businessId, businessId), eq(notifications.kind, "digest_item"), sql`${notifications.readAt} is null`));
        body = digestBody(snap, items.map((i) => i.title));
        kind = "digest";
        if (!c.dryRun && items.length > 0) await db.update(notifications).set({ readAt: new Date() }).where(inArray(notifications.id, items.map((i) => i.id)));
      }
      if (extra.length > 0) body = [body, ...extra].filter(Boolean).join("\n\n");
      await note1(role, kind, title, body, ev.link, note);
      return { outcome: c.dryRun ? "would_run" : "ran", summary: `${c.dryRun ? "Would tell" : "Told"} ${who}: ${title}` };
    }
    case "add_to_digest":
      await note1("owner", "digest_item", ev.title, ev.body);
      return { outcome: c.dryRun ? "would_run" : "ran", summary: `${c.dryRun ? "Would save" : "Saved"} this for the weekly digest` };
    case "suggest_financing_options":
    case "attach_analysis_snapshot": {
      const isFin = a.kind === "suggest_financing_options";
      const text = isFin ? c.extras?.financing : c.extras?.analysis;
      if (!text) return { outcome: "failed", summary: isFin ? "The financing options could not be read right now, so none were added" : "The analysis figures could not be read right now, so none were added" };
      if (!c.hasNotify) await note1("owner", "notice", isFin ? "Financing options to look at" : "Your cash analysis", text, isFin ? "/room/funding" : "/room/analysis");
      return { outcome: c.dryRun ? "would_run" : "ran", summary: `${c.dryRun ? "Would add" : "Added"} to ${c.hasNotify ? "the message" : "a new message"}: ${text}` };
    }
    case "draft_customer_reminder": {
      if (!ev.invoice) return { outcome: "skipped", summary: "There is no invoice to write about" };
      const d = reminderDraft(ev.invoice, a.tone, snap, c.businessName);
      await note1("owner", "draft_reminder", d.title, d.body, "/room/invoices");
      return { outcome: c.dryRun ? "would_run" : "ran", summary: `${c.dryRun ? "Would draft" : "Drafted"} a ${a.tone} reminder for invoice ${ev.invoice.number}. Nothing is sent` };
    }
    case "run_simulation": {
      try {
        const w = await whatIf(c, a.scenario);
        await note1("owner", "simulation", w.title, w.body, "/room/simulator");
        return { outcome: c.dryRun ? "would_run" : "ran", summary: `${c.dryRun ? "Would report" : "Reported"} a what-if: ${w.title.replace("What-if result: ", "")}` };
      } catch {
        return { outcome: "failed", summary: "The what-if no longer fits your books, so it was not run" };
      }
    }
    case "prepare_rescue_plans": {
      try {
        if (!(await loadPlaybook(db, businessId)).autoPrepare) return { outcome: "skipped", summary: "Your playbook says you start planning yourself, so nothing was prepared" };
        // Dry run only looks (the detector is read-only). A real run calls exactly what the shortage trigger calls.
        if (c.dryRun) {
          const d = await detectShortage(db, businessId, { source: "api" });
          return d.shortage ? { outcome: "would_run", summary: "Would start the planning run for the forecast shortfall. Nothing is signed or sent" } : { outcome: "skipped", summary: "No shortfall right now, so there would be nothing to prepare" };
        }
        const r = await checkShortage(db, businessId, { source: "api" });
        if (r.status === "no_shortage") return { outcome: "skipped", summary: "No shortfall right now, so there was nothing to prepare" };
        if (r.status === "existing_run") return { outcome: "ran", summary: "Plans for this forecast were already prepared" };
        const n = r.run?.plans.length ?? 0;
        await note1("owner", "plans_prepared", `${n} rescue ${plural(n, "plan is", "plans are")} ready for you to review`, "An automation prepared options for the forecast shortfall. Nothing is signed, sent or paid until you review and sign a plan.", "/room/case");
        return { outcome: "ran", summary: `Prepared ${n} ${plural(n, "plan", "plans")} for you to review. Nothing was signed or sent` };
      } catch {
        return { outcome: "failed", summary: "Planning could not finish" };
      }
    }
    default:
      return { outcome: "skipped", summary: "Nothing to do" };
  }
}

async function runEffects(c: Ctx, r: EvalResult): Promise<NodeResult[]> {
  const steps = r.steps.map((s) => ({ ...s }));
  c.hasNotify = r.effects.some((e) => e.action.kind === "notify_owner" || e.action.kind === "notify_approver");
  c.extras = await gatherExtras(c, r.effects);
  for (const e of r.effects) {
    let done: Done;
    try { done = await perform(c, e.action); } catch { done = { outcome: "failed", summary: "This step could not finish" }; }
    const st = steps.find((s) => s.node === e.node);
    if (st) { st.outcome = done.outcome; st.summary = done.summary; }
  }
  return steps;
}

const parseGraph = (g: unknown): FlowGraph | null => { const p = graphSchema.safeParse(g); return p.success ? p.data : null; };
const triggerOf = (g: FlowGraph): Trigger => (g.nodes.find((n) => n.type === "trigger") as Extract<FlowNode, { type: "trigger" }>).trigger;

async function nameOf(db: Db, businessId: string): Promise<string> {
  const [b] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId));
  return b?.name ?? "";
}

// ---------------------------------------------------------------- the monitor hook

export interface PassResult { fired: number; resumed: number; skipped: number }

/** Called by the monitor after its pass. Best effort per automation: one failing flow never stops another, and the monitor never fails because of this. */
export async function runAutomationsAfterMonitor(db: Db, businessId: string, snap: AutoSnapshot): Promise<PassResult> {
  const out: PassResult = { fired: 0, resumed: 0, skipped: 0 };
  const rows = await db.select().from(automations).where(and(eq(automations.businessId, businessId), eq(automations.status, "enabled")));
  if (rows.length === 0 && !(await hasWaiting(db, businessId))) return out;
  const businessName = await nameOf(db, businessId);

  // 1. Continue runs that were waiting and are due. Disabled, edited or no-longer-true: stop them.
  const waiting = await db.select().from(automationRuns).where(and(eq(automationRuns.businessId, businessId), eq(automationRuns.status, "waiting"), isNotNull(automationRuns.resumeNode)));
  for (const run of waiting) {
    if (!run.resumeOn || run.resumeOn > snap.asOf) continue;
    try {
      const auto = rows.find((r) => r.id === run.automationId && r.version === run.version);
      const graph = auto ? parseGraph(auto.graph) : null;
      // Claim it: only one pass can take a waiting run.
      const claimed = await db.update(automationRuns).set({ resumeNode: null }).where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, "waiting"), eq(automationRuns.resumeNode, run.resumeNode!))).returning({ id: automationRuns.id });
      if (claimed.length === 0) continue;
      const before = (run.results as NodeResult[]) ?? [];
      const ev = graph ? triggerEvents(triggerOf(graph), snap).find((e) => e.entity === run.entity) : undefined;
      if (!auto || !graph || !ev) {
        const why = !auto ? "The automation was changed or turned off, so this run stopped" : "The situation no longer applies, so this run stopped";
        await finishRun(db, businessId, run.id, run.automationId, run.version, run.entity, "stopped", [...before, { node: run.resumeNode!, outcome: "stopped", summary: why }], null);
        out.skipped++;
        continue;
      }
      const r = evaluate(graph, ev, snap, { from: run.resumeNode!, dryRun: false });
      const steps = await runEffects({ db, businessId, businessName, automation: { id: auto.id, name: auto.name }, runId: run.id, snap, ev, dryRun: false }, r);
      await finishRun(db, businessId, run.id, run.automationId, run.version, run.entity, r.wait ? "waiting" : "done", [...before, ...steps], r.wait);
      out.resumed++;
    } catch {
      await db.update(automationRuns).set({ status: "failed", finishedAt: new Date(), resumeNode: null }).where(eq(automationRuns.id, run.id)).catch(() => {});
    }
  }

  // 2. Start new runs for events that match now.
  for (const auto of rows) {
    try {
      const graph = parseGraph(auto.graph);
      if (!graph) continue;
      const events = triggerEvents(triggerOf(graph), snap);
      if (events.length === 0) continue;
      const [{ n: today }] = await db.select({ n: sql<number>`count(*)::int` }).from(automationRuns).where(and(eq(automationRuns.automationId, auto.id), eq(automationRuns.day, snap.asOf)));
      let used = today;
      for (const ev of events) {
        if (used >= MAX_RUNS_PER_DAY) { out.skipped++; continue; }
        const recent = await db.select({ id: automationRuns.id }).from(automationRuns).where(and(eq(automationRuns.automationId, auto.id), eq(automationRuns.entity, ev.entity), gte(automationRuns.day, addDays(snap.asOf, -COOLDOWN_DAYS)))).limit(1);
        if (recent.length > 0) { out.skipped++; continue; }
        const [claim] = await db.insert(automationRuns).values({
          businessId, automationId: auto.id, automationName: auto.name, version: auto.version, dedupeKey: `${ev.entity}@${snap.asOf}`, entity: ev.entity, day: snap.asOf, status: "done", results: [],
        }).onConflictDoNothing().returning({ id: automationRuns.id });
        if (!claim) { out.skipped++; continue; }
        used++;
        try {
          const r = evaluate(graph, ev, snap, { dryRun: false });
          const steps = await runEffects({ db, businessId, businessName, automation: { id: auto.id, name: auto.name }, runId: claim.id, snap, ev, dryRun: false }, r);
          await finishRun(db, businessId, claim.id, auto.id, auto.version, ev.entity, r.wait ? "waiting" : "done", steps, r.wait);
          out.fired++;
        } catch {
          await db.update(automationRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(automationRuns.id, claim.id));
        }
      }
    } catch { /* this automation only */ }
  }
  return out;
}

async function hasWaiting(db: Db, businessId: string): Promise<boolean> {
  const r = await db.select({ id: automationRuns.id }).from(automationRuns).where(and(eq(automationRuns.businessId, businessId), eq(automationRuns.status, "waiting"))).limit(1);
  return r.length > 0;
}

async function finishRun(db: Db, businessId: string, runId: string, automationId: string, version: number, entity: string, status: "done" | "waiting" | "stopped", steps: NodeResult[], wait: EvalResult["wait"]) {
  const waiting = status === "waiting" && wait;
  await db.update(automationRuns).set({
    status: waiting && !wait.next ? "done" : status, finishedAt: waiting && wait.next ? null : new Date(), results: steps,
    resumeOn: waiting && wait.next ? wait.resumeOn : null, resumeNode: waiting && wait.next ? wait.next : null,
  }).where(eq(automationRuns.id, runId));
  // Ids, version and outcomes only: no owner text, no free text.
  await appendRecord(db, { businessId, event: ACTION_EVENTS.AUTOMATION_RAN, actor: "system", detail: { automationId, runId, version, entity, status, nodes: steps.map((s) => ({ node: s.node, outcome: s.outcome })) } });
}

// ---------------------------------------------------------------- dry run

export interface DryRunResult {
  /** How many events match the trigger on the current books. */
  matched: number;
  /** Up to five of them, each with what every node would do. Nothing was changed. */
  examples: { entity: string; title: string; body: string; link: string; nodes: NodeResult[] }[];
  /** The trigger node result when nothing matches, so the screen can still say why. */
  note: string;
  changesNothing: true;
}

/** Evaluate a flow on the current books. Writes nothing: no run, no notification, no log record, no planning run. */
export async function dryRunFlow(db: Db, businessId: string, name: string, graphInput: unknown, snap: AutoSnapshot): Promise<DryRunResult> {
  automationNameSchema.parse(name);
  const graph = graphSchema.parse(graphInput);
  const trigger = triggerOf(graph);
  const events = triggerEvents(trigger, snap, true);
  const businessName = await nameOf(db, businessId);
  const examples: DryRunResult["examples"] = [];
  for (const ev of events.slice(0, 5)) {
    const r = evaluate(graph, ev, snap, { dryRun: true });
    const steps = await runEffects({ db, businessId, businessName, automation: { id: "dry-run", name }, runId: null, snap, ev, dryRun: true }, r);
    const reached = new Set(steps.map((s) => s.node));
    const rest: NodeResult[] = graph.nodes.filter((n) => !reached.has(n.id)).map((n) => ({ node: n.id, outcome: "later", summary: "Not reached in this example" }));
    examples.push({ entity: ev.entity, title: ev.title, body: ev.body, link: ev.link, nodes: [...steps, ...rest] });
  }
  return {
    matched: events.length, examples, changesNothing: true,
    note: events.length === 0 ? "Nothing in your books matches this trigger right now, so the flow would not run today." : `${events.length} ${plural(events.length, "thing matches", "things match")} right now.`,
  };
}

