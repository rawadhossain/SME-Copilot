// Plain-words descriptions of the automation vocabulary, shared by the editor, the list and the test-run view. Pure. Owner text (a message, a scenario name) is
// returned as data in its own field, never joined into a sentence the UI would have to trust.
import type { Action, ActionKind, Condition, ConditionKind, FlowGraph, Step, Trigger, TriggerKind } from "./automation";
import { graphToTree, isCondition, WEEKDAYS } from "./automation";

export type MoneyText = (minor: string) => string;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
export const WEEKDAY_NAME: Record<(typeof WEEKDAYS)[number], string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
export const SEVERITY_NAME = { info: "any", watch: "a keep-an-eye-on-this", urgent: "an urgent" } as const;

export function triggerSentence(t: Trigger, m: MoneyText): string {
  switch (t.kind) {
    case "forecast_below_cushion": return `Cash is forecast to fall below your cushion within ${t.withinWeeks} ${plural(t.withinWeeks, "week", "weeks")}`;
    case "invoice_overdue": return `A customer invoice is ${t.days} ${plural(t.days, "day", "days")} overdue${t.minAmount ? ` and is ${m(t.minAmount)} or more` : ""}`;
    case "bill_due": return `A supplier bill of ${m(t.minAmount)} or more is due within ${t.withinDays} ${plural(t.withinDays, "day", "days")}`;
    case "customer_concentration": return `One customer owes more than ${t.overPercent}% of everything you are owed`;
    case "alert_raised": return t.minSeverity === "info" ? "Any alert is raised" : `${t.minSeverity === "watch" ? "A keep-an-eye-on-this alert or worse" : "An urgent alert"} is raised`;
    case "weekly_digest": return `Every ${WEEKDAY_NAME[t.weekday]}`;
    case "document_confirmed": return "You confirm a document";
  }
}

export function actionSentence(a: Action): string {
  switch (a.kind) {
    case "notify_owner": return "Tell the owner";
    case "notify_approver": return "Tell the approver";
    case "prepare_rescue_plans": return "Prepare rescue plans for you to review (nothing is signed)";
    case "run_simulation": return "Run a what-if and report the result";
    case "draft_customer_reminder": return `Draft a ${a.tone} reminder letter (nothing is sent)`;
    case "add_to_digest": return "Save this for the weekly digest";
    case "suggest_financing_options": return "Add the top financing options to the message (indicative, nothing applied for)";
    case "attach_analysis_snapshot": return "Add the cash analysis figures to the message";
    case "wait": return `Wait ${a.days} ${plural(a.days, "day", "days")}, then look again`;
    case "stop": return "Stop here";
  }
}

export function checkSentence(c: Condition, m: MoneyText, customerName?: (id: string) => string | undefined): string {
  switch (c.kind) {
    case "amount_over": return `The amount is over ${m(c.amountMinor)}`;
    case "days_overdue_over": return `It is more than ${c.days} ${plural(c.days, "day", "days")} overdue`;
    case "customer_is": return `The customer is ${customerName?.(c.customerId) ?? "one particular customer"}`;
    case "balance_after_bill_below_cushion": return "Paying it would leave your cash under the cushion";
    case "severity_at_least": return `The alert is ${c.severity === "urgent" ? "urgent" : c.severity === "watch" ? "at least keep-an-eye-on-this" : "of any severity"}`;
    case "shortage_depth_over": return `The shortfall under the cushion is over ${m(c.amountMinor)}`;
  }
}

/** One line for the list: the trigger, then what happens. */
export function flowSummary(g: FlowGraph, m: MoneyText): string {
  const trig = g.nodes.find((n) => n.type === "trigger");
  const actions = g.nodes.flatMap((n) => (n.type === "action" && n.action.kind !== "stop" && n.action.kind !== "wait" ? [n.action.kind] : []));
  const verbs: Record<string, string> = { notify_owner: "tell you", notify_approver: "tell your approver", prepare_rescue_plans: "prepare rescue plans", run_simulation: "run a what-if", draft_customer_reminder: "draft a reminder", add_to_digest: "save a digest note", suggest_financing_options: "suggest financing options", attach_analysis_snapshot: "add the cash figures" };
  const uniq = [...new Set(actions.map((k) => verbs[k]))];
  const branch = g.nodes.some((n) => n.type === "condition");
  return `When: ${trig && trig.type === "trigger" ? triggerSentence(trig.trigger, m) : ""}. Then ${uniq.length ? uniq.join(", ") : "nothing"}${branch ? ", depending on a check" : ""}.`;
}

// ---------------------------------------------------------------- one-line hints for the pickers

export const TRIGGER_HINT: Record<TriggerKind, string> = {
  forecast_below_cushion: "Your cash forecast dips under the cushion you keep",
  invoice_overdue: "A customer has not paid by the due date",
  bill_due: "A supplier bill above a size you choose is coming up",
  customer_concentration: "Too much of what you are owed sits with one customer",
  alert_raised: "Your books raise an alert of the severity you choose",
  weekly_digest: "Once a week, on the day you choose",
  document_confirmed: "You confirm an uploaded document",
};
export const ACTION_HINT: Record<ActionKind, string> = {
  notify_owner: "A message in your bell. Nothing leaves the app",
  notify_approver: "A message in your approver's bell",
  prepare_rescue_plans: "Starts the planning run. You review and sign any plan yourself",
  run_simulation: "Tries a made-up scenario on a copy of your books",
  draft_customer_reminder: "Writes a reminder letter. Nothing is sent until you approve it",
  add_to_digest: "Keeps a line for your weekly digest",
  suggest_financing_options: "Looks up indicative options. Nothing is applied for",
  attach_analysis_snapshot: "Adds owed to you, overdue share, days late and runway",
  wait: "Pauses, then looks at your books again",
  stop: "Ends the flow here",
};
export const CONDITION_HINT: Record<ConditionKind, string> = {
  amount_over: "Only continue for bigger amounts",
  days_overdue_over: "Only continue once it is later than this",
  customer_is: "Only continue for one particular customer",
  balance_after_bill_below_cushion: "Only continue if paying would squeeze your cash",
  severity_at_least: "Only continue for alerts at least this serious",
  shortage_depth_over: "Only continue for deeper shortfalls",
};

// ---------------------------------------------------------------- the one-sentence summary

const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The trigger as the middle of a sentence: "an invoice is 7 days overdue". */
export function triggerPhrase(t: Trigger, m: MoneyText): string {
  switch (t.kind) {
    case "forecast_below_cushion": return `cash is forecast to dip below your cushion within ${t.withinWeeks} ${plural(t.withinWeeks, "week", "weeks")}`;
    case "invoice_overdue": return `an invoice is ${t.days} ${plural(t.days, "day", "days")} overdue${t.minAmount ? ` and is ${m(t.minAmount)} or more` : ""}`;
    case "bill_due": return `a bill of ${m(t.minAmount)} or more is due within ${t.withinDays} ${plural(t.withinDays, "day", "days")}`;
    case "customer_concentration": return `one customer owes more than ${t.overPercent}% of what you are owed`;
    case "alert_raised": return t.minSeverity === "info" ? "any alert is raised" : t.minSeverity === "watch" ? "a keep-an-eye-on-this alert or worse is raised" : "an urgent alert is raised";
    case "weekly_digest": return `it is ${WEEKDAY_NAME[t.weekday]}`;
    case "document_confirmed": return "you confirm a document";
  }
}

function verbOf(a: Action): string {
  switch (a.kind) {
    case "notify_owner": return "tell you";
    case "notify_approver": return "tell your approver";
    case "prepare_rescue_plans": return "prepare rescue plans for you to review";
    case "run_simulation": return "run a what-if";
    case "draft_customer_reminder": return `draft a ${a.tone} reminder`;
    case "add_to_digest": return "save a note for the digest";
    case "suggest_financing_options": return "suggest financing options";
    case "attach_analysis_snapshot": return "add the cash analysis figures";
    case "wait": return `wait ${a.days} ${plural(a.days, "day", "days")}, then look again`;
    case "stop": return "stop";
  }
}

function stepsPhrase(steps: Step[], m: MoneyText, customerName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length) parts.push(join(run)); run = []; };
  for (const s of steps) {
    if (!isCondition(s)) { if (s.action.kind === "wait") { flush(); parts.push(verbOf(s.action)); } else run.push(verbOf(s.action)); continue; }
    flush();
    const cs = s.checks.map((c) => lc(checkSentence(c, m, customerName)));
    const checks = cs.length <= 1 ? cs.join("") : `${cs.slice(0, -1).join(", ")} ${s.mode === "any" ? "or" : "and"} ${cs[cs.length - 1]}`;
    const yes = stepsPhrase(s.yes, m, customerName);
    const otherwise = stepsPhrase(s.otherwise, m, customerName);
    parts.push(`if ${checks}, ${yes || "do nothing"}${otherwise ? `; otherwise ${otherwise}` : ""}`);
  }
  flush();
  return parts.join(", then ");
}

/** The whole flow in one plain sentence, e.g. "When an invoice is 7 days overdue, draft a friendly reminder and tell you." Pure; owner text never appears. */
export function flowSentence(g: FlowGraph, m: MoneyText, customerName?: (id: string) => string | undefined): string {
  const tree = graphToTree(g);
  if (!tree) return flowSummary(g, m);
  const body = stepsPhrase(tree.steps, m, customerName);
  const lead = tree.trigger.kind === "weekly_digest" ? `Every ${WEEKDAY_NAME[tree.trigger.weekday]}` : `When ${triggerPhrase(tree.trigger, m)}`;
  return `${lead}, ${body || "do nothing yet"}.`;
}
