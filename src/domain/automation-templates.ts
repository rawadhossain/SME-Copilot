// Starter automations ("recipes"), kept in code (not the database). Each is built as a tree and turned into a graph, then checked by the same schema as any
// flow the owner builds. Amounts depend on the currency's minor-unit exponent, so a template is built for a business, not stored.
import { automationInputSchema, treeToGraph, type FlowGraph, type Step, type Tree } from "./automation";

/** The Topic E capability a recipe serves, and the outcome group it is shown under. */
export type RecipeTag = "Cash alerts" | "Collections" | "Financing" | "Analysis";
export interface AutomationTemplate { id: string; name: string; blurb: string; tag: RecipeTag; group: string; build: (exponent: number) => Tree }

const major = (units: number, exponent: number): string => (BigInt(units) * 10n ** BigInt(exponent)).toString();
let seq = 0;
const act = (action: Extract<Step, { action: unknown }>["action"]): Step => ({ id: `x${++seq}`, action });

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "cash_cushion_warning",
    name: "Warn me before cash dips below the cushion",
    blurb: "Tells you early. If it is urgent it also prepares rescue plans and tells your approver.",
    tag: "Cash alerts", group: "Stay ahead of cash",
    build: () => ({
      triggerId: "t", trigger: { kind: "forecast_below_cushion", withinWeeks: 8 },
      steps: [
        act({ kind: "notify_owner" }),
        { id: "x", mode: "all", checks: [{ kind: "severity_at_least", severity: "urgent" }], yes: [act({ kind: "prepare_rescue_plans" }), act({ kind: "notify_approver" })], otherwise: [act({ kind: "add_to_digest" })] },
      ],
    }),
  },
  {
    id: "financing_gap_check",
    name: "Check financing options when a gap is coming",
    blurb: "When a shortfall is forecast, looks up indicative options, prepares rescue plans and tells you.",
    tag: "Financing", group: "Stay ahead of cash",
    build: () => ({
      triggerId: "t", trigger: { kind: "forecast_below_cushion", withinWeeks: 8 },
      steps: [act({ kind: "suggest_financing_options" }), act({ kind: "prepare_rescue_plans" }), act({ kind: "notify_owner" })],
    }),
  },
  {
    id: "big_bill_watch",
    name: "Big bill watch",
    blurb: "Watches large bills due soon. If paying one would squeeze your cash, you and your approver hear about it.",
    tag: "Cash alerts", group: "Stay ahead of cash",
    build: (e) => ({
      triggerId: "t", trigger: { kind: "bill_due", withinDays: 14, minAmount: major(1000, e) },
      steps: [{ id: "x", mode: "all", checks: [{ kind: "balance_after_bill_below_cushion" }], yes: [act({ kind: "notify_owner" }), act({ kind: "notify_approver" })], otherwise: [act({ kind: "add_to_digest" })] }],
    }),
  },
  {
    id: "chase_overdue_invoices",
    name: "Chase overdue invoices",
    blurb: "Drafts a friendly reminder at 7 days late and a firmer one at 14. You approve every draft.",
    tag: "Collections", group: "Get paid sooner",
    build: () => ({
      triggerId: "t", trigger: { kind: "invoice_overdue", days: 7 },
      steps: [
        act({ kind: "draft_customer_reminder", tone: "friendly" }),
        act({ kind: "wait", days: 7 }),
        { id: "x", mode: "all", checks: [{ kind: "days_overdue_over", days: 13 }], yes: [act({ kind: "draft_customer_reminder", tone: "firm" }), act({ kind: "notify_owner" })], otherwise: [act({ kind: "stop" })] },
      ],
    }),
  },
  {
    id: "customer_concentration_warning",
    name: "Customer concentration warning",
    blurb: "Warns you when one customer owes more than half of everything you are owed.",
    tag: "Analysis", group: "Get paid sooner",
    build: () => ({ triggerId: "t", trigger: { kind: "customer_concentration", overPercent: 50 }, steps: [act({ kind: "notify_owner" }), act({ kind: "add_to_digest" })] }),
  },
  {
    id: "weekly_cash_digest",
    name: "Weekly cash digest",
    blurb: "Every Monday: your cash, the lowest point ahead, what is overdue, plus the cash analysis figures.",
    tag: "Analysis", group: "Stay in the loop",
    build: () => ({ triggerId: "t", trigger: { kind: "weekly_digest", weekday: "mon" }, steps: [act({ kind: "attach_analysis_snapshot" }), act({ kind: "notify_owner" })] }),
  },
];

export function buildTemplate(templateId: string, exponent: number): { name: string; graph: FlowGraph } | null {
  const t = AUTOMATION_TEMPLATES.find((x) => x.id === templateId);
  if (!t) return null;
  return { name: t.name, graph: automationInputSchema.parse({ name: t.name, graph: treeToGraph(t.build(exponent)) }).graph };
}
