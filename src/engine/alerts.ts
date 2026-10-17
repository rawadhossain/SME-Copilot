// ALERT RULES. Pure and deterministic: no database, no clock, no model. Takes the snapshot the existing detectors already produce (the agreed forecast and
// the shortage detector, the ledger's open invoices and bills, the insight findings, the recovery detection) and returns candidate alerts. Nothing here
// re-implements a detector: shortage, insight and recovery logic stay where they are; these rules only decide what is worth raising and how to say it.
// Titles and details are templates over the figures, in plain words. A name from the books is DATA inside a template, never an instruction.
import { formatMoney, money } from "@/lib/money";
import { diffDays } from "./dates";
import type { Finding } from "./insights";
import { isForecast, owedOf } from "./open";
import type { BillRecord, InvoiceRecord } from "./types";

export type AlertKind = "cash_below_cushion" | "overdue_receivable" | "bill_due_soon" | "insight" | "strategy_off_track";
export type AlertSeverity = "urgent" | "watch" | "info";
export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, watch: 1, urgent: 2 };

export interface CandidateAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** Stable for "the same situation" (kind + subject), never the amounts, so a changed figure updates the alert instead of duplicating it. */
  dedupeKey: string;
  title: string;
  detail: string;
  /** Money as minor-unit strings; everything the title and detail say is in here. */
  figures: Record<string, unknown>;
  /** Where the owner goes next, and the records behind it. */
  refs: { route: string; label: string; [k: string]: unknown };
}

export interface AlertSnapshot {
  asOf: string;
  currency: string;
  reserveMinor: bigint;
  /** The agreed forecast, week by week (1-based). */
  weekly: { index: number; start: string; closingMinor: bigint }[];
  /** The shortage detector's verdict on that forecast. */
  shortage: { shortage: boolean; belowZero: boolean; minBalanceMinor: bigint; minBalanceWeek: number };
  invoices: InvoiceRecord[];
  bills: BillRecord[];
  insights: Pick<Finding, "id" | "kind" | "severity" | "title" | "why" | "figures">[];
  /** Recovery detection for the strategy that was signed and run: its MATERIAL events only. */
  recovery: { strategyId: string | null; events: { kind: string; key: string; text: string; counterpartyId?: string }[]; caseId: string | null };
}

const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** A name from the books, as data: one line, no control characters, bounded. */
export const safeName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "a counterparty";
const bpsText = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const OVERDUE_URGENT_DAYS = 30;
export const OVERDUE_URGENT_SHARE_BPS = 1000; // 10% of open receivables
export const BILL_SOON_DAYS = 7;
export const CASH_URGENT_LEAD_DAYS = 28;

const SEVERITY_OF_FINDING: Record<string, AlertSeverity> = { high: "urgent", medium: "watch", low: "info" };
/** The insight findings that become alerts (the others are covered by the rules above); their own severity is kept. */
const INSIGHT_ALERT_KINDS = new Set(["receipts_concentration", "receipts_decline", "spending_change", "large_payment"]);

export function evaluateAlerts(s: AlertSnapshot): CandidateAlert[] {
  const m = (v: bigint) => formatMoney(money(v, s.currency), EXPONENTS[s.currency] ?? 2);
  const out: CandidateAlert[] = [];

  // 1. Cash below the safety cushion (from the shortage detector's forecast).
  if (s.shortage.shortage) {
    const first = s.weekly.find((w) => w.closingMinor < s.reserveMinor);
    const leadDays = first ? Math.max(0, diffDays(s.asOf, first.start)) : 0;
    const lowestWeek = s.weekly.find((w) => w.index === s.shortage.minBalanceWeek);
    const gap = s.reserveMinor - s.shortage.minBalanceMinor;
    const firstNegative = s.weekly.find((w) => w.closingMinor < 0n);
    const urgent = s.shortage.belowZero || leadDays < CASH_URGENT_LEAD_DAYS;
    out.push({
      kind: "cash_below_cushion", severity: urgent ? "urgent" : "watch", dedupeKey: "cash_below_cushion",
      title: s.shortage.belowZero ? `Your cash is forecast to run out in week ${firstNegative?.index ?? s.shortage.minBalanceWeek}` : "Your cash is forecast to fall below your safety cushion",
      detail: `The lowest balance is ${m(s.shortage.minBalanceMinor)} in week ${s.shortage.minBalanceWeek}${lowestWeek ? ` (week of ${day(lowestWeek.start)})` : ""}, ${m(gap)} under your ${m(s.reserveMinor)} cushion. ${leadDays === 0 ? "The first week under it is this week." : `The first week under it starts in ${leadDays} ${plural(leadDays, "day", "days")}.`}`,
      figures: {
        currency: s.currency, lowestBalanceMinor: s.shortage.minBalanceMinor.toString(), lowestWeek: s.shortage.minBalanceWeek, lowestWeekStart: lowestWeek?.start ?? null,
        shortfallMinor: gap.toString(), reserveMinor: s.reserveMinor.toString(), leadDays, belowZero: s.shortage.belowZero, firstShortWeek: first?.index ?? null, firstNegativeWeek: firstNegative?.index ?? null,
      },
      refs: { route: "/room/funding", label: "See how to close the gap" },
    });
  }

  // 2. Overdue receivables: one alert per customer, not per invoice.
  const open = s.invoices.filter(isForecast);
  const totalOpen = open.reduce((a, i) => a + owedOf(i), 0n);
  const byCustomer = new Map<string, { name: string; overdue: InvoiceRecord[] }>();
  for (const i of open) {
    if (i.dueOn >= s.asOf) continue;
    const c = byCustomer.get(i.counterpartyId) ?? { name: i.counterpartyName, overdue: [] };
    c.overdue.push(i);
    byCustomer.set(i.counterpartyId, c);
  }
  for (const [id, c] of byCustomer) {
    const owed = c.overdue.reduce((a, i) => a + owedOf(i), 0n);
    const oldest = Math.max(...c.overdue.map((i) => diffDays(i.dueOn, s.asOf)));
    const shareBps = totalOpen > 0n ? Number((owed * 10_000n) / totalOpen) : 0;
    const urgent = oldest > OVERDUE_URGENT_DAYS && shareBps >= OVERDUE_URGENT_SHARE_BPS;
    const name = safeName(c.name);
    out.push({
      kind: "overdue_receivable", severity: urgent ? "urgent" : "watch", dedupeKey: `overdue_receivable:${id}`,
      title: `${name} has ${c.overdue.length} overdue ${plural(c.overdue.length, "invoice", "invoices")}`,
      detail: `${m(owed)} is overdue, the oldest by ${oldest} ${plural(oldest, "day", "days")}. That is ${bpsText(shareBps)} of everything customers owe you.`,
      figures: { currency: s.currency, customerId: id, customerName: name, overdueMinor: owed.toString(), invoiceCount: c.overdue.length, oldestDaysOverdue: oldest, shareOfReceivablesBps: shareBps },
      refs: { route: "/room/invoices", label: "Open invoices & bills", customerId: id, invoiceIds: c.overdue.map((i) => i.id).sort() },
    });
  }

  // 3. A bill due within a week (or already past due) that the forecast shows the cushion cannot absorb. Bills that fit comfortably are not raised (noise).
  for (const b of s.bills.filter(isForecast)) {
    const days = diffDays(s.asOf, b.dueOn);
    if (days > BILL_SOON_DAYS) continue;
    const wk = s.weekly[Math.max(0, Math.min(s.weekly.length - 1, Math.floor(days / 7)))];
    if (!wk || wk.closingMinor >= s.reserveMinor) continue;
    const name = safeName(b.counterpartyName);
    out.push({
      kind: "bill_due_soon", severity: "urgent", dedupeKey: `bill_due_soon:${b.id}`,
      title: days < 0 ? `Your bill from ${name} is overdue` : `Your bill from ${name} is due ${days === 0 ? "today" : `in ${days} ${plural(days, "day", "days")}`}`,
      detail: `${m(owedOf(b))} ${days < 0 ? "was due" : "is due"} on ${day(b.dueOn)}. Your balance is forecast to be ${m(wk.closingMinor)} that week, under your ${m(s.reserveMinor)} cushion.`,
      figures: { currency: s.currency, billId: b.id, supplierName: name, amountMinor: owedOf(b).toString(), dueOn: b.dueOn, daysUntilDue: days, weekClosingMinor: wk.closingMinor.toString(), reserveMinor: s.reserveMinor.toString() },
      refs: { route: "/room/invoices", label: "Open invoices & bills", billId: b.id },
    });
  }

  // 4. Insight findings that carry their own severity.
  for (const f of s.insights.filter((x) => INSIGHT_ALERT_KINDS.has(x.kind))) {
    out.push({
      kind: "insight", severity: SEVERITY_OF_FINDING[f.severity] ?? "info", dedupeKey: `insight:${f.id}`, title: f.title, detail: f.why,
      figures: { currency: s.currency, findingKind: f.kind, items: f.figures },
      refs: { route: "/room", label: "See the details on Today", findingId: f.id },
    });
  }

  // 5. The signed strategy is going off track (late receipt, broken promise, refusal, failed run, forecast worse than promised).
  if (s.recovery.events.length > 0) {
    const n = s.recovery.events.length;
    out.push({
      kind: "strategy_off_track", severity: "urgent", dedupeKey: `strategy_off_track:${s.recovery.strategyId ?? "current"}`,
      title: "Your agreed plan is going off track",
      detail: `${s.recovery.events[0].text}${n > 1 ? ` ${n - 1} more ${plural(n - 1, "change was", "changes were")} found.` : ""}`,
      figures: { currency: s.currency, eventCount: n, events: s.recovery.events.map((e) => ({ kind: e.kind, text: e.text })) },
      refs: { route: "/room/case", label: "Review the plan", caseId: s.recovery.caseId },
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));
}
