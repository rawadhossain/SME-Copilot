// OWNER AUTOMATIONS (vocabulary). An automation is a small flow: one trigger, optional conditions with two labelled branches, and actions. The vocabulary is
// CLOSED: every node is a zod strict object (unknown keys are rejected) in a discriminated union, and there is no node that pays, signs, approves, executes,
// changes the mandate or limits, or sends anything to a counterparty. An action can only NOTIFY, PREPARE or DRAFT.
// Owner-written text (a notification message, at most 200 characters) is DATA: length-limited, no control characters, shown escaped, never put in a prompt.
// Pure: zod only. The graph rules (one trigger, no cycles, every node reachable, labelled branches, at most 20 nodes, at least one action) are checked here
// and again by the server before anything is stored.
import { z } from "zod";
import { scenarioSchema } from "./flight-scenario";

export const MAX_NODES = 20;
export const MAX_MESSAGE_CHARS = 200;

/** Money in a trigger or condition is an integer count of minor units, as digits. */
const minorAmount = z.string().regex(/^\d{1,15}$/, "An amount is a whole number of minor units");
const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "A node id is lowercase letters, digits and underscores");
const noControl = /^[^\u0000-\u001f\u007f]*$/;
const message = z.string().max(MAX_MESSAGE_CHARS).regex(noControl, "No control characters");

export const SEVERITIES = ["info", "watch", "urgent"] as const;
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const triggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("forecast_below_cushion"), withinWeeks: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.literal("invoice_overdue"), days: z.number().int().min(1).max(120), minAmount: minorAmount.optional() }),
  z.strictObject({ kind: z.literal("bill_due"), withinDays: z.number().int().min(1).max(60), minAmount: minorAmount }),
  z.strictObject({ kind: z.literal("customer_concentration"), overPercent: z.number().int().min(10).max(90) }),
  z.strictObject({ kind: z.literal("alert_raised"), minSeverity: z.enum(SEVERITIES) }),
  z.strictObject({ kind: z.literal("weekly_digest"), weekday: z.enum(WEEKDAYS) }),
  z.strictObject({ kind: z.literal("document_confirmed") }),
]);
export type Trigger = z.output<typeof triggerSchema>;
export type TriggerKind = Trigger["kind"];

export const conditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("amount_over"), amountMinor: minorAmount }),
  z.strictObject({ kind: z.literal("days_overdue_over"), days: z.number().int().min(0).max(365) }),
  z.strictObject({ kind: z.literal("customer_is"), customerId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("balance_after_bill_below_cushion") }),
  z.strictObject({ kind: z.literal("severity_at_least"), severity: z.enum(SEVERITIES) }),
  z.strictObject({ kind: z.literal("shortage_depth_over"), amountMinor: minorAmount }),
]);
export type Condition = z.output<typeof conditionSchema>;
export type ConditionKind = Condition["kind"];

export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("notify_owner"), message: message.optional() }),
  z.strictObject({ kind: z.literal("notify_approver"), message: message.optional() }),
  /** Starts the existing planning run (the one a shortage starts). It only proposes plans; nothing is signed or executed. */
  z.strictObject({ kind: z.literal("prepare_rescue_plans") }),
  /** A stored hypothetical scenario, run read-only and summarised into the notification. */
  z.strictObject({ kind: z.literal("run_simulation"), scenario: scenarioSchema }),
  /** A DRAFT letter from a code template with the real invoice figures. Nothing is sent. */
  z.strictObject({ kind: z.literal("draft_customer_reminder"), tone: z.enum(["friendly", "firm"]) }),
  z.strictObject({ kind: z.literal("add_to_digest") }),
  /** READ-ONLY: runs the existing funding match and puts the top eligible products (indicative, synthetic) into the notification. Nothing is applied for. */
  z.strictObject({ kind: z.literal("suggest_financing_options") }),
  /** READ-ONLY: puts the headline analysis figures (owed to you, overdue share, average days late, runway) into the notification or digest. */
  z.strictObject({ kind: z.literal("attach_analysis_snapshot") }),
  z.strictObject({ kind: z.literal("wait"), days: z.number().int().min(1).max(30) }),
  z.strictObject({ kind: z.literal("stop") }),
]);
export type Action = z.output<typeof actionSchema>;
export type ActionKind = Action["kind"];

export const EDGE_LABELS = ["next", "yes", "otherwise"] as const;
export type EdgeLabel = (typeof EDGE_LABELS)[number];

export const nodeSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: nodeId, type: z.literal("trigger"), trigger: triggerSchema }),
  z.strictObject({ id: nodeId, type: z.literal("condition"), mode: z.enum(["all", "any"]), checks: z.array(conditionSchema).min(1).max(6) }),
  z.strictObject({ id: nodeId, type: z.literal("action"), action: actionSchema }),
]);
export type FlowNode = z.output<typeof nodeSchema>;

export const edgeSchema = z.strictObject({ from: nodeId, to: nodeId, label: z.enum(EDGE_LABELS) });
export type FlowEdge = z.output<typeof edgeSchema>;

/** Which conditions mean something for which trigger (the value must exist on the event). A mismatch is refused when the flow is saved. */
export const CONDITION_FITS: Record<ConditionKind, readonly TriggerKind[]> = {
  amount_over: ["invoice_overdue", "bill_due", "customer_concentration"],
  days_overdue_over: ["invoice_overdue", "bill_due"],
  customer_is: ["invoice_overdue", "customer_concentration"],
  balance_after_bill_below_cushion: ["bill_due"],
  severity_at_least: ["forecast_below_cushion", "invoice_overdue", "bill_due", "alert_raised"],
  shortage_depth_over: ["forecast_below_cushion"],
};
/** The letter is about one invoice, so only an overdue-invoice trigger can carry it. */
export const DRAFT_FITS: readonly TriggerKind[] = ["invoice_overdue"];

const baseGraph = z.strictObject({ nodes: z.array(nodeSchema).min(1).max(MAX_NODES), edges: z.array(edgeSchema).max(MAX_NODES * 2) });
export type FlowGraph = z.output<typeof baseGraph>;

/** Every problem with the graph's shape, in plain words; empty means valid. Pure. */
export function graphProblems(g: FlowGraph): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) out.push(`Two steps share the id "${n.id}".`);
    ids.add(n.id);
  }
  const triggers = g.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) out.push(triggers.length === 0 ? "A flow needs a trigger." : "A flow has exactly one trigger.");
  if (!g.nodes.some((n) => n.type === "action")) out.push("A flow needs at least one action.");

  const outgoing = new Map<string, FlowEdge[]>();
  const incoming = new Map<string, number>();
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) { out.push("A connection points at a step that does not exist."); continue; }
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  for (const n of g.nodes) {
    const es = outgoing.get(n.id) ?? [];
    const labels = es.map((e) => e.label);
    if (new Set(labels).size !== labels.length) out.push(`Step "${n.id}" has two connections with the same label.`);
    if (n.type === "condition") {
      if (!labels.includes("yes")) out.push(`The condition "${n.id}" needs a "yes" branch.`);
      if (labels.some((l) => l === "next")) out.push(`The condition "${n.id}" can only branch as "yes" or "otherwise".`);
    } else if (labels.some((l) => l !== "next")) out.push(`Step "${n.id}" can only continue with "next".`);
    if (n.type === "action" && n.action.kind === "stop" && es.length > 0) out.push(`"Stop" cannot be followed by anything.`);
    if (n.type === "trigger" && (incoming.get(n.id) ?? 0) > 0) out.push("Nothing can lead back into the trigger.");
    if (n.type === "trigger" && es.length === 0) out.push("The trigger must lead somewhere.");
  }

  const trigger = triggers[0]?.type === "trigger" ? triggers[0] : null;
  if (trigger) {
    for (const n of g.nodes) {
      if (n.type === "condition") for (const c of n.checks) if (!CONDITION_FITS[c.kind].includes(trigger.trigger.kind)) out.push(`The check "${c.kind}" does not apply to the trigger "${trigger.trigger.kind}".`);
      if (n.type === "action" && n.action.kind === "draft_customer_reminder" && !DRAFT_FITS.includes(trigger.trigger.kind)) out.push("A reminder can only be drafted from an overdue-invoice trigger.");
    }
    // Reachability from the trigger, and cycles (depth-first with a colour per node).
    const seen = new Set<string>();
    const walk = (id: string) => { if (seen.has(id)) return; seen.add(id); for (const e of outgoing.get(id) ?? []) walk(e.to); };
    walk(trigger.id);
    for (const n of g.nodes) if (!seen.has(n.id)) out.push(`Step "${n.id}" can never be reached from the trigger.`);
  }
  const state = new Map<string, 1 | 2>();
  let cyclic = false;
  const visit = (id: string) => {
    if (cyclic) return;
    state.set(id, 1);
    for (const e of outgoing.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 1) { cyclic = true; return; }
      if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const n of g.nodes) if (!state.has(n.id)) visit(n.id);
  if (cyclic) out.push("The flow loops back on itself. A flow can only move forward.");
  return out;
}

export const graphSchema = baseGraph.superRefine((g, ctx) => {
  for (const message of graphProblems(g)) ctx.addIssue({ code: "custom", message });
});

export const automationNameSchema = z.string().trim().min(1).max(80).regex(noControl, "No control characters");
export const automationInputSchema = z.strictObject({ name: automationNameSchema, graph: graphSchema });
export const automationStatuses = ["draft", "enabled", "disabled"] as const;
export type AutomationStatus = (typeof automationStatuses)[number];

/** What a run did at one node. The summary is a code template; nothing the owner typed appears in it. */
export const NODE_OUTCOMES = ["ran", "would_run", "yes", "otherwise", "waiting", "would_wait", "skipped", "stopped", "failed", "later"] as const;
export type NodeOutcome = (typeof NODE_OUTCOMES)[number];
export interface NodeResult { node: string; outcome: NodeOutcome; summary: string }

// ---------------------------------------------------------------- the tree view (what the editor edits)

/** A flow as the editor shows it: a trigger, then steps; a condition owns its two branches. Every template is of this shape. */
export type Step = { id: string; action: Action } | { id: string; mode: "all" | "any"; checks: Condition[]; yes: Step[]; otherwise: Step[] };
export interface Tree { triggerId: string; trigger: Trigger; steps: Step[] }

export const isCondition = (s: Step): s is Extract<Step, { checks: Condition[] }> => "checks" in s;

/** Graph to tree; null when the graph is not tree-shaped (a step with two parents), which the editor then shows read-only. */
export function graphToTree(g: FlowGraph): Tree | null {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  const parents = new Map<string, number>();
  for (const e of g.edges) { out.set(e.from, [...(out.get(e.from) ?? []), e]); parents.set(e.to, (parents.get(e.to) ?? 0) + 1); }
  if ([...parents.values()].some((n) => n > 1)) return null;
  const trigger = g.nodes.find((n) => n.type === "trigger");
  if (!trigger || trigger.type !== "trigger") return null;
  const chain = (fromId: string | undefined, label: EdgeLabel): Step[] => {
    const steps: Step[] = [];
    let cur = fromId ? (out.get(fromId) ?? []).find((e) => e.label === label)?.to : undefined;
    while (cur) {
      const n = byId.get(cur);
      if (!n || n.type === "trigger") break;
      if (n.type === "condition") { steps.push({ id: n.id, mode: n.mode, checks: n.checks, yes: chain(n.id, "yes"), otherwise: chain(n.id, "otherwise") }); break; }
      steps.push({ id: n.id, action: n.action });
      cur = (out.get(n.id) ?? []).find((e) => e.label === "next")?.to;
    }
    return steps;
  };
  return { triggerId: trigger.id, trigger: trigger.trigger, steps: chain(trigger.id, "next") };
}

/** Tree to graph. Ids are renumbered s1, s2, ... so the editor never has to manage them. */
export function treeToGraph(t: Tree): FlowGraph {
  const nodes: FlowNode[] = [{ id: "t", type: "trigger", trigger: t.trigger }];
  const edges: FlowEdge[] = [];
  let n = 0;
  const lay = (steps: Step[], from: string, label: EdgeLabel) => {
    let prev = from;
    let lab = label;
    for (const s of steps) {
      const id = `s${++n}`;
      edges.push({ from: prev, to: id, label: lab });
      lab = "next";
      if (isCondition(s)) {
        nodes.push({ id, type: "condition", mode: s.mode, checks: s.checks });
        lay(s.yes, id, "yes");
        lay(s.otherwise, id, "otherwise");
        return;
      }
      nodes.push({ id, type: "action", action: s.action });
      prev = id;
    }
  };
  lay(t.steps, "t", "next");
  return { nodes, edges };
}

// ---------------------------------------------------------------- plain words

export const TRIGGER_TITLE: Record<TriggerKind, string> = {
  forecast_below_cushion: "Cash is forecast to dip below the cushion",
  invoice_overdue: "A customer invoice is overdue",
  bill_due: "A supplier bill is coming due",
  customer_concentration: "One customer owes too large a share",
  alert_raised: "An alert is raised",
  weekly_digest: "Every week on a chosen day",
  document_confirmed: "A document is confirmed",
};
export const ACTION_TITLE: Record<ActionKind, string> = {
  notify_owner: "Tell the owner",
  notify_approver: "Tell the approver",
  prepare_rescue_plans: "Prepare rescue plans for review",
  run_simulation: "Run a what-if and report it",
  draft_customer_reminder: "Draft a reminder letter",
  add_to_digest: "Add to the weekly digest",
  suggest_financing_options: "Suggest financing options",
  attach_analysis_snapshot: "Add the cash analysis figures",
  wait: "Wait",
  stop: "Stop here",
};
export const CONDITION_TITLE: Record<ConditionKind, string> = {
  amount_over: "The amount is over",
  days_overdue_over: "It is overdue by more than",
  customer_is: "The customer is",
  balance_after_bill_below_cushion: "Paying it leaves cash under the cushion",
  severity_at_least: "The severity is at least",
  shortage_depth_over: "The shortfall under the cushion is over",
};
