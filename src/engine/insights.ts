// FINANCIAL INTELLIGENCE & EARLY WARNING. PURE: plain records in, findings out. No database, no clock, no model, no floating point for money.
// Every finding states what was compared (two equal windows), the amounts and dates behind it, and what is uncertain. A comparison is made only
// when the history covers both windows; otherwise it is reported as unavailable. Nothing here calculates profit, margin or revenue: the records
// hold cash movements and invoices, not cost of sales. Transactions carry no category in the source data, so categories come from FIXED RULES
// (classifyTransaction) and are labelled as rule-based. Nothing here acts: it names the screens and the existing planner lever that relate.
import { formatMoney, money } from "@/lib/money";
import { addDays, diffDays } from "./dates";
import { owedOf } from "./open";
import { DEFAULT_OVERDUE, type BillRecord, type EngineInput, type InvoiceRecord } from "./types";

export const WINDOW_DAYS = 28;

/** Every threshold in one place; a finding fires only on these explicit rules. */
export const INSIGHT_RULES = {
  /** Cash: net movement is negative and at least this share (bps) of the larger of money in / money out worse than the window before. */
  netWorseningBps: 1000,
  /** Money in from customers fell by at least this much (bps) against the window before. */
  receiptsFallBps: 2500,
  receiptsFallHighBps: 5000,
  minPriorReceiptCount: 2,
  /** Overdue receivables: rose by at least this much (bps), or are old, or are a large share of what is outstanding. */
  overdueRiseBps: 2500,
  overdueOldDays: 30,
  overdueVeryOldDays: 60,
  overdueShareBps: 2000,
  overdueShareHighBps: 4000,
  /** Bills falling due in the next window against the window just gone. */
  billsRiseBps: 2500,
  /** Concentration: the biggest customer's share of what is outstanding (needs at least two open invoices). */
  concentrationBps: 5000,
  concentrationHighBps: 7000,
  /** Spending change in a rule-based category, and the smallest move that matters (share of the earlier window's total money out). */
  spendRiseBps: 3000,
  spendRiseMediumBps: 6000,
  spendMaterialBps: 500,
  /** One payment this many times its usual size (needs at least this many earlier payments of the same kind). */
  outlierMultipleBps: 15000,
  outlierMinHistory: 4,
  outlierMaterialBps: 200,
  /** Fewest cash movements in the earlier window for a comparison to mean anything. */
  minWindowTransactions: 3,
  /** The newest transaction may be at most this many days before the as-of date, or the latest window is incomplete. */
  maxStaleDays: 7,
} as const;

export type TxCategory = "customer_receipt" | "supplier_payment" | "payroll" | "rent" | "tax" | "loan_repayment" | "other_in" | "other_out" | "transfer";

export const CATEGORY_LABEL: Record<TxCategory, string> = {
  customer_receipt: "payments from customers", supplier_payment: "payments to suppliers", payroll: "payroll", rent: "rent", tax: "tax payments",
  loan_repayment: "loan repayments", other_in: "other money in", other_out: "other money out", transfer: "transfers between your own accounts",
};

export interface InsightTx {
  id: string;
  postedOn: string;
  amount: bigint; // signed: positive in, negative out
  description: string;
  /** Role of the linked counterparty, when the transaction is linked to one. */
  counterpartyRole: "customer" | "supplier" | "lender" | null;
}

/** Fixed, ordered rules. Anything that cannot be recognised stays "other money in/out": it is never called revenue or a cost of sales. */
export function classifyTransaction(t: Pick<InsightTx, "amount" | "description" | "counterpartyRole">): TxCategory {
  const d = t.description.toLowerCase();
  if (/\b(transfer|own account|internal|sweep)\b/.test(d)) return "transfer";
  if (t.counterpartyRole === "customer" && t.amount > 0n) return "customer_receipt";
  if (t.counterpartyRole === "supplier" && t.amount < 0n) return "supplier_payment";
  if (t.amount < 0n) {
    if (/\b(payroll|salary|salaries|wages)\b/.test(d)) return "payroll";
    if (/\brent\b/.test(d)) return "rent";
    if (/\b(vat|hmrc|paye|corporation tax|tax)\b/.test(d)) return "tax";
    if (/\b(loan|repayment|instalment|installment)\b/.test(d) || t.counterpartyRole === "lender") return "loan_repayment";
    return "other_out";
  }
  return "other_in";
}

export type Severity = "high" | "medium" | "low";
export type FindingKind = "forecast_shortfall" | "cash_deterioration" | "receipts_decline" | "overdue_receivables" | "bills_overdue" | "bills_rising" | "receipts_concentration" | "spending_change" | "large_payment";

/** A figure behind a finding. Money is a minor-unit string; the screen and the assistant both read these, so no number lives only in prose. */
export type Figure =
  | { label: string; kind: "money"; amountMinor: string }
  | { label: string; kind: "percent"; bps: number }
  | { label: string; kind: "count"; value: number }
  | { label: string; kind: "date"; value: string }
  | { label: string; kind: "text"; value: string };

export interface EvidenceRow { label: string; date: string | null; amountMinor: string | null; note: string | null }
export interface FindingAction { kind: "forecast" | "plan_search" | "funding" | "orders"; label: string; href: string | null; note: string | null }

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  /** Why it matters, in plain words, written by code from the figures. */
  why: string;
  figures: Figure[];
  /** What was compared with what; null for a finding that is a state, not a comparison. */
  comparison: { label: string; current: { from: string; to: string }; prior: { from: string; to: string } } | null;
  /** The records behind it (up to a handful, largest first). */
  evidence: EvidenceRow[];
  /** What this does not tell you. Always present, may be a single line. */
  uncertainty: string[];
  actions: FindingAction[];
  /** Used only for ordering (largest amount involved). */
  materialityMinor: string;
}

export type HealthStatus = "needs_attention" | "watch" | "steady" | "not_enough_history";

export interface WindowFlow { from: string; to: string; inMinor: string; outMinor: string; netMinor: string; transactionCount: number; byCategory: Record<string, string> }

export interface InsightsResult {
  asOf: string;
  currency: string;
  status: HealthStatus;
  headline: string;
  periods: {
    windowDays: number;
    current: { from: string; to: string };
    prior: { from: string; to: string };
    /** false when the history does not cover both windows, or the newest transaction is too old; `reason` says why. */
    comparable: boolean;
    reason: string | null;
    historyFrom: string | null;
    historyTo: string | null;
  };
  metrics: {
    openingBalanceMinor: string;
    current: WindowFlow;
    prior: WindowFlow | null;
    outstandingReceivablesMinor: string;
    openInvoiceCount: number;
    overdueReceivablesMinor: string;
    overdueInvoiceCount: number;
    billsDueNextWindowMinor: string;
    billsDueLastWindowMinor: string;
    overdueBillsMinor: string;
    overdueBillCount: number;
  };
  findings: Finding[];
  /** What this view cannot tell the owner, always shown. */
  limits: string[];
}

export interface ForecastSignal {
  shortage: boolean;
  belowZero: boolean;
  minBalanceMinor: string;
  minBalanceWeek: number;
  minWeekStart: string | null;
  firstNegativeWeek: number | null;
  reserveMinor: string;
}

export interface InsightsInput {
  engine: Pick<EngineInput, "asOf" | "currency" | "openingBalance" | "reserve" | "invoices" | "bills" | "overdue">;
  transactions: InsightTx[];
  forecast: ForecastSignal;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
/** Basis points of a over b, rounded down; 0 when b is not positive. */
const bpsOf = (a: bigint, b: bigint): number => (b > 0n ? Number((a * 10000n) / b) : 0);
const pctText = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;

/** Whole-percent-style ratio check without floats: a >= b * (10000 + bps) / 10000. */
const atLeastRaisedBy = (now: bigint, then: bigint, bps: number): boolean => now * 10000n >= then * BigInt(10000 + bps);

export function computeInsights(input: InsightsInput): InsightsResult {
  const { engine: e, forecast: fc } = input;
  const cur = e.currency;
  const fmt = (v: bigint | string): string => formatMoney(money(BigInt(v), cur), 2);
  const asOf = e.asOf;
  const curWin = { from: addDays(asOf, -(WINDOW_DAYS - 1)), to: asOf };
  const priorWin = { from: addDays(asOf, -(2 * WINDOW_DAYS - 1)), to: addDays(asOf, -WINDOW_DAYS) };
  const R = INSIGHT_RULES;

  // ----- the cash movements, classified by rule
  const txs = input.transactions.map((t) => ({ ...t, category: classifyTransaction(t) })).sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.id.localeCompare(b.id));
  const real = txs.filter((t) => t.category !== "transfer");
  const historyFrom = txs.length > 0 ? txs[0].postedOn : null;
  const historyTo = txs.length > 0 ? txs[txs.length - 1].postedOn : null;
  const inWin = (w: { from: string; to: string }) => real.filter((t) => t.postedOn >= w.from && t.postedOn <= w.to);
  const flow = (w: { from: string; to: string }): WindowFlow => {
    const rows = inWin(w);
    const by: Record<string, bigint> = {};
    for (const t of rows) by[t.category] = (by[t.category] ?? 0n) + abs(t.amount);
    const inn = sum(rows.filter((t) => t.amount > 0n).map((t) => t.amount));
    const out = sum(rows.filter((t) => t.amount < 0n).map((t) => -t.amount));
    return { from: w.from, to: w.to, inMinor: inn.toString(), outMinor: out.toString(), netMinor: (inn - out).toString(), transactionCount: rows.length, byCategory: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.toString()])) };
  };
  const curFlow = flow(curWin);
  const priorFlow = flow(priorWin);
  let comparable = true;
  let reason: string | null = null;
  if (historyFrom === null || historyTo === null) { comparable = false; reason = "There are no bank transactions yet, so cash movements cannot be compared."; }
  else if (historyFrom > priorWin.from) { comparable = false; reason = `The bank history starts on ${historyFrom}; comparing the last ${WINDOW_DAYS} days with the ${WINDOW_DAYS} before needs history from ${priorWin.from}.`; }
  else if (diffDays(historyTo, asOf) > R.maxStaleDays) { comparable = false; reason = `The newest bank transaction is ${historyTo}, more than ${R.maxStaleDays} days before ${asOf}, so the latest ${WINDOW_DAYS} days are incomplete.`; }
  else if (priorFlow.transactionCount < R.minWindowTransactions) { comparable = false; reason = `Only ${priorFlow.transactionCount} cash movement${priorFlow.transactionCount === 1 ? "" : "s"} in the earlier ${WINDOW_DAYS} days, too few to compare against.`; }
  const period = { label: `${curWin.from} to ${curWin.to} against ${priorWin.from} to ${priorWin.to}`, current: curWin, prior: priorWin };

  // ----- receivables and bills, rebuilt as at a date from the records (needs the paid date of every paid item)
  const invoices = e.invoices;
  const bills = e.bills;
  // The earlier position is rebuilt from paid dates; a partly paid invoice has no date for its part-payments here, so then no trend is claimed.
  const paidDatesKnown = invoices.every((i) => (i.status === "open" ? i.outstanding === undefined : !!i.paidOn));
  const openAt = (i: InvoiceRecord | BillRecord, d: string): boolean => i.issuedOn <= d && (i.status === "open" || (!!i.paidOn && i.paidOn > d));
  const overdueAt = (d: string): InvoiceRecord[] => invoices.filter((i) => openAt(i, d) && i.dueOn < d);
  const outstanding = invoices.filter((i) => i.status === "open" && i.issuedOn <= asOf);
  const outstandingTotal = sum(outstanding.map(owedOf));
  const overdueNow = outstanding.filter((i) => i.dueOn < asOf);
  const overdueNowTotal = sum(overdueNow.map(owedOf));
  const thenDate = addDays(asOf, -WINDOW_DAYS);
  const overdueThen = paidDatesKnown ? overdueAt(thenDate) : null;
  const overdueThenTotal = overdueThen ? sum(overdueThen.map((i) => i.amount)) : null;

  const openBills = bills.filter((b) => b.status === "open");
  const overdueBills = openBills.filter((b) => b.dueOn < asOf && b.issuedOn <= asOf);
  const nextWin = { from: asOf, to: addDays(asOf, WINDOW_DAYS - 1) };
  const lastWin = { from: addDays(asOf, -WINDOW_DAYS), to: addDays(asOf, -1) };
  const dueIn = (w: { from: string; to: string }) => bills.filter((b) => b.dueOn >= w.from && b.dueOn <= w.to);
  const billsNext = dueIn(nextWin);
  const billsLast = dueIn(lastWin);
  const billsNextTotal = sum(billsNext.map((b) => (b.status === "open" ? owedOf(b) : b.amount)));
  const billsLastTotal = sum(billsLast.map((b) => (b.status === "open" ? owedOf(b) : b.amount)));

  const od = e.overdue ?? DEFAULT_OVERDUE;
  const findings: Finding[] = [];
  const shortage = fc.shortage;
  const plannerNote = (levers: string): string | null => (shortage ? `The rescue planner can use this: ${levers}.` : null);
  const forecastAction: FindingAction = { kind: "forecast", label: "See the cash forecast", href: "/room", note: null };
  const planAction = (levers: string): FindingAction[] => (shortage ? [{ kind: "plan_search", label: "Look for a rescue plan", href: null, note: plannerNote(levers) }] : []);
  const inv = (i: InvoiceRecord): EvidenceRow => ({ label: `Invoice ${i.number}, ${i.counterpartyName}`, date: i.dueOn, amountMinor: owedOf(i).toString(), note: i.dueOn < asOf ? `${diffDays(i.dueOn, asOf)} days overdue` : `due in ${diffDays(asOf, i.dueOn)} days` });
  const bill = (b: BillRecord): EvidenceRow => ({ label: `Bill ${b.reference}, ${b.counterpartyName}`, date: b.dueOn, amountMinor: owedOf(b).toString(), note: b.dueOn < asOf ? `${diffDays(b.dueOn, asOf)} days overdue` : `due in ${diffDays(asOf, b.dueOn)} days` });
  const bigFirst = <T extends { amount: bigint }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));

  // 1. The existing forecast says cash will run short: the finding that connects everything else to the rescue flow.
  if (shortage) {
    const reserve = BigInt(fc.reserveMinor);
    const low = BigInt(fc.minBalanceMinor);
    findings.push({
      id: "forecast_shortfall", kind: "forecast_shortfall", severity: fc.belowZero ? "high" : "medium",
      title: fc.belowZero ? "Your cash is forecast to run out" : "Your cash is forecast to dip below your safety cushion",
      why: fc.belowZero
        ? `The forecast's lowest point is ${fmt(low)} in week ${fc.minBalanceWeek}${fc.minWeekStart ? ` (from ${fc.minWeekStart})` : ""}${fc.firstNegativeWeek ? `, and cash first goes below zero in week ${fc.firstNegativeWeek}` : ""}. Your safety cushion is ${fmt(reserve)}.`
        : `The forecast's lowest point is ${fmt(low)} in week ${fc.minBalanceWeek}${fc.minWeekStart ? ` (from ${fc.minWeekStart})` : ""}, ${fmt(reserve - low)} under your safety cushion of ${fmt(reserve)}.`,
      figures: [{ label: "Lowest forecast balance", kind: "money", amountMinor: low.toString() }, { label: "Safety cushion", kind: "money", amountMinor: reserve.toString() }, { label: "Lowest week", kind: "count", value: fc.minBalanceWeek }, ...(reserve > low ? [{ label: "Short of the cushion by", kind: "money" as const, amountMinor: (reserve - low).toString() }] : [])],
      comparison: null, evidence: [],
      uncertainty: ["This is the existing forecast: money still to arrive is expected, not guaranteed, and the dates of late-paying customers are estimates."],
      actions: [{ kind: "plan_search", label: "Look for a rescue plan", href: null, note: "Searches for plans inside your signed limits. Nothing runs until you sign." }, { kind: "funding", label: "Compare funding options", href: "/room/funding", note: null }, forecastAction],
      materialityMinor: (reserve > low ? reserve - low : 0n).toString(),
    });
  }

  if (comparable) {
    const inC = BigInt(curFlow.inMinor), outC = BigInt(curFlow.outMinor), netC = BigInt(curFlow.netMinor);
    const inP = BigInt(priorFlow.inMinor), outP = BigInt(priorFlow.outMinor), netP = BigInt(priorFlow.netMinor);
    const unclassified = sum(real.filter((t) => t.category === "other_in" || t.category === "other_out").map((t) => abs(t.amount)));
    const unclassifiedNote = unclassified > 0n ? `Some movements could not be classified (${fmt(unclassified)} over the whole history) and are counted as other money in or out.` : null;

    // 2. Cash deterioration: net movement negative and clearly worse than before.
    const worse = netP - netC;
    const base = inP > outP ? inP : outP;
    if (netC < 0n && worse > 0n && bpsOf(worse, base) >= R.netWorseningBps) {
      findings.push({
        id: "cash_deterioration", kind: "cash_deterioration", severity: outC * 4n >= inC * 5n ? "high" : "medium",
        title: "More cash is going out than coming in, and it is worse than before",
        why: `In the last ${WINDOW_DAYS} days ${fmt(inC)} came in and ${fmt(outC)} went out, a net ${fmt(netC)}. In the ${WINDOW_DAYS} days before it was ${fmt(netP)} (${fmt(inP)} in, ${fmt(outP)} out).`,
        figures: [{ label: "Money in, latest period", kind: "money", amountMinor: inC.toString() }, { label: "Money out, latest period", kind: "money", amountMinor: outC.toString() }, { label: "Net, latest period", kind: "money", amountMinor: netC.toString() }, { label: "Money in, earlier period", kind: "money", amountMinor: inP.toString() }, { label: "Money out, earlier period", kind: "money", amountMinor: outP.toString() }, { label: "Net, earlier period", kind: "money", amountMinor: netP.toString() }],
        comparison: period, evidence: [],
        uncertainty: ["Two 28-day windows are a short view: one large payment or receipt landing on either side of the boundary moves this.", "Net cash movement is not profit.", ...(unclassifiedNote ? [unclassifiedNote] : [])],
        actions: [forecastAction, ...planAction("slower supplier payments, earlier customer payments")], materialityMinor: worse.toString(),
      });
    }

    // 3. Money in from customers fell.
    const rcC = BigInt(curFlow.byCategory.customer_receipt ?? "0"), rcP = BigInt(priorFlow.byCategory.customer_receipt ?? "0");
    const rcPCount = inWin(priorWin).filter((t) => t.category === "customer_receipt").length;
    if (rcPCount >= R.minPriorReceiptCount && rcP > rcC && bpsOf(rcP - rcC, rcP) >= R.receiptsFallBps) {
      const fall = bpsOf(rcP - rcC, rcP);
      findings.push({
        id: "receipts_decline", kind: "receipts_decline", severity: fall >= R.receiptsFallHighBps ? "high" : "medium",
        title: "Payments from customers have fallen",
        why: `Customers paid ${fmt(rcC)} in the last ${WINDOW_DAYS} days, down ${pctText(fall)} from ${fmt(rcP)} in the ${WINDOW_DAYS} days before.`,
        figures: [{ label: "Customer payments, latest period", kind: "money", amountMinor: rcC.toString() }, { label: "Customer payments, earlier period", kind: "money", amountMinor: rcP.toString() }, { label: "Fall", kind: "percent", bps: fall }, { label: "Customer payments in the earlier period", kind: "count", value: rcPCount }],
        comparison: period,
        evidence: bigFirst(inWin(curWin).filter((t) => t.category === "customer_receipt").map((t) => ({ amount: t.amount, row: { label: t.description, date: t.postedOn, amountMinor: t.amount.toString(), note: null } as EvidenceRow }))).slice(0, 5).map((x) => x.row),
        uncertainty: ["Invoices are paid in lumps, so a fall can be timing rather than lost business. The records do not say which."],
        actions: [forecastAction, ...planAction("asking customers to pay sooner"), { kind: "funding", label: "Compare funding options", href: "/room/funding", note: null }], materialityMinor: (rcP - rcC).toString(),
      });
    }

    // 4. Spending change in a rule-based category (rent, tax and loan repayments are fixed or lumpy and are not compared).
    const compared: TxCategory[] = ["supplier_payment", "payroll", "other_out"];
    for (const cat of compared) {
      const a = BigInt(curFlow.byCategory[cat] ?? "0"), b = BigInt(priorFlow.byCategory[cat] ?? "0");
      const rise = a - b;
      const risen = b > 0n ? atLeastRaisedBy(a, b, R.spendRiseBps) : a > 0n;
      if (!risen || bpsOf(rise, outP) < R.spendMaterialBps) continue;
      const bps = b > 0n ? bpsOf(rise, b) : null;
      findings.push({
        id: `spending_change:${cat}`, kind: "spending_change", severity: bps !== null && bps >= R.spendRiseMediumBps ? "medium" : "low",
        title: `Spending on ${CATEGORY_LABEL[cat]} is up`,
        why: b > 0n ? `${CATEGORY_LABEL[cat][0].toUpperCase()}${CATEGORY_LABEL[cat].slice(1)} were ${fmt(a)} in the last ${WINDOW_DAYS} days, up ${pctText(bps ?? 0)} from ${fmt(b)} in the ${WINDOW_DAYS} days before.` : `There was ${fmt(a)} of ${CATEGORY_LABEL[cat]} in the last ${WINDOW_DAYS} days and none in the ${WINDOW_DAYS} days before.`,
        figures: [{ label: "Latest period", kind: "money", amountMinor: a.toString() }, { label: "Earlier period", kind: "money", amountMinor: b.toString() }, { label: "Increase", kind: "money", amountMinor: rise.toString() }, ...(bps !== null ? [{ label: "Increase", kind: "percent" as const, bps }] : [])],
        comparison: period,
        evidence: bigFirst(inWin(curWin).filter((t) => t.category === cat).map((t) => ({ amount: abs(t.amount), row: { label: t.description, date: t.postedOn, amountMinor: abs(t.amount).toString(), note: null } as EvidenceRow }))).slice(0, 5).map((x) => x.row),
        uncertainty: ["Category comes from fixed rules on the bank description, not from a ledger.", cat === "supplier_payment" ? "Supplier payments are lumpy: one extra payment inside the window can explain the rise." : "Timing of payments around the window boundary can explain part of the rise."],
        actions: [forecastAction, ...planAction("later supplier payments")], materialityMinor: rise.toString(),
      });
    }

    // 5. One payment much larger than that payment's usual size (same description once numbers are removed).
    const keyOf = (d: string) => d.toLowerCase().split(/\s+/).filter((w) => !/\d/.test(w)).join(" ");
    const outs = real.filter((t) => t.amount < 0n);
    const seen = new Set<string>();
    for (const t of bigFirst(outs.filter((x) => x.postedOn >= curWin.from && x.postedOn <= curWin.to).map((x) => ({ ...x, amount: abs(x.amount) })))) {
      const key = keyOf(t.description);
      if (key === "" || seen.has(key)) continue;
      const history = outs.filter((x) => x.postedOn < curWin.from && keyOf(x.description) === key).map((x) => abs(x.amount));
      if (history.length < R.outlierMinHistory) continue;
      const usual = [...history].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[(history.length - 1) >> 1];
      if (usual <= 0n || t.amount * 10000n < usual * BigInt(R.outlierMultipleBps)) continue;
      if (bpsOf(t.amount - usual, outP) < R.outlierMaterialBps) continue;
      seen.add(key);
      findings.push({
        id: `large_payment:${t.id}`, kind: "large_payment", severity: "low",
        title: "A payment was larger than usual",
        why: `A payment on ${t.postedOn} was ${fmt(t.amount)}. The usual amount for payments with the same description is ${fmt(usual)} (the middle of ${history.length} earlier ones).`,
        figures: [{ label: "This payment", kind: "money", amountMinor: t.amount.toString() }, { label: "Usual amount", kind: "money", amountMinor: usual.toString() }, { label: "Earlier payments of this kind", kind: "count", value: history.length }, { label: "Date", kind: "date", value: t.postedOn }],
        comparison: null, evidence: [{ label: t.description, date: t.postedOn, amountMinor: t.amount.toString(), note: `usual ${fmt(usual)}` }],
        uncertainty: ["Payments are matched by description with numbers removed; two different things with the same wording would be mixed. A larger bill is not necessarily a mistake."],
        actions: [forecastAction], materialityMinor: (t.amount - usual).toString(),
      });
    }
  }

  // 6. Overdue receivables: rising, old, or a large share of what is outstanding.
  if (overdueNow.length > 0) {
    const oldest = Math.max(...overdueNow.map((i) => diffDays(i.dueOn, asOf)));
    const share = bpsOf(overdueNowTotal, outstandingTotal);
    const rising = overdueThenTotal === null ? false : overdueThenTotal === 0n ? true : atLeastRaisedBy(overdueNowTotal, overdueThenTotal, R.overdueRiseBps);
    if (rising || oldest > R.overdueOldDays || share >= R.overdueShareBps) {
      const high = share >= R.overdueShareHighBps || oldest > R.overdueVeryOldDays;
      const trend = overdueThenTotal === null ? "" : ` ${WINDOW_DAYS} days ago ${overdueThen!.length === 0 ? "none were overdue" : `${overdueThen!.length} invoice${overdueThen!.length === 1 ? " was" : "s were"} overdue, totalling ${fmt(overdueThenTotal)}`}.`;
      findings.push({
        id: "overdue_receivables", kind: "overdue_receivables", severity: high ? "high" : "medium",
        title: rising ? "More of what customers owe you is overdue" : "Customers owe you overdue invoices",
        why: `${overdueNow.length} invoice${overdueNow.length === 1 ? " is" : "s are"} past due, totalling ${fmt(overdueNowTotal)} (${pctText(share)} of the ${fmt(outstandingTotal)} outstanding); the oldest is ${oldest} days overdue.${trend}`,
        figures: [{ label: "Overdue now", kind: "money", amountMinor: overdueNowTotal.toString() }, { label: "Overdue invoices", kind: "count", value: overdueNow.length }, { label: "Total outstanding", kind: "money", amountMinor: outstandingTotal.toString() }, { label: "Share of outstanding", kind: "percent", bps: share }, { label: "Oldest, days overdue", kind: "count", value: oldest }, ...(overdueThenTotal !== null ? [{ label: `Overdue ${WINDOW_DAYS} days ago`, kind: "money" as const, amountMinor: overdueThenTotal.toString() }] : [])],
        comparison: overdueThenTotal === null ? null : { label: `overdue on ${asOf} against overdue on ${thenDate}`, current: { from: asOf, to: asOf }, prior: { from: thenDate, to: thenDate } },
        evidence: bigFirst(overdueNow).slice(0, 5).map(inv),
        uncertainty: [overdueThenTotal === null ? `The paid date of some paid invoices is missing, so the position ${WINDOW_DAYS} days ago cannot be rebuilt and no trend is claimed.` : "The earlier position is rebuilt from invoice and paid dates.", `The forecast assumes overdue invoices arrive ${od.delayDays} to ${od.longDelayDays} days after today unless the customer's own pattern says later; the records do not say any customer has agreed to pay.`],
        actions: [forecastAction, ...planAction("asking overdue customers to pay within a set number of days"), { kind: "funding", label: "Compare funding against invoices", href: "/room/funding", note: null }], materialityMinor: overdueNowTotal.toString(),
      });
    }
  }

  // 7. Bills already past due.
  if (overdueBills.length > 0) {
    const total = sum(overdueBills.map((b) => owedOf(b)));
    const oldest = Math.max(...overdueBills.map((b) => diffDays(b.dueOn, asOf)));
    findings.push({
      id: "bills_overdue", kind: "bills_overdue", severity: oldest > R.overdueVeryOldDays ? "high" : "medium",
      title: "Some supplier bills are past their due date",
      why: `${overdueBills.length} bill${overdueBills.length === 1 ? " is" : "s are"} unpaid and past due, totalling ${fmt(total)}; the oldest is ${oldest} days overdue.`,
      figures: [{ label: "Overdue bills", kind: "money", amountMinor: total.toString() }, { label: "Count", kind: "count", value: overdueBills.length }, { label: "Oldest, days overdue", kind: "count", value: oldest }],
      comparison: null, evidence: bigFirst(overdueBills).slice(0, 5).map(bill),
      uncertainty: ["A bill can be unpaid in the books but paid or agreed with the supplier outside them; the records do not show that."],
      actions: [forecastAction, ...planAction("agreeing later payment of a supplier balance")], materialityMinor: total.toString(),
    });
  }

  // 8. Bills falling due are rising.
  if (billsLastTotal > 0n && atLeastRaisedBy(billsNextTotal, billsLastTotal, R.billsRiseBps)) {
    const rise = bpsOf(billsNextTotal - billsLastTotal, billsLastTotal);
    const exceeds = billsNextTotal > e.openingBalance;
    findings.push({
      id: "bills_rising", kind: "bills_rising", severity: exceeds ? "high" : "medium",
      title: "More supplier bills fall due soon than in the last four weeks",
      why: `${billsNext.length} bill${billsNext.length === 1 ? "" : "s"} totalling ${fmt(billsNextTotal)} fall due in the next ${WINDOW_DAYS} days, up ${pctText(rise)} from ${fmt(billsLastTotal)} that fell due in the last ${WINDOW_DAYS} days.${exceeds ? ` That is more than the ${fmt(e.openingBalance)} in your books today.` : ""}`,
      figures: [{ label: "Bills due, next period", kind: "money", amountMinor: billsNextTotal.toString() }, { label: "Bills due, last period", kind: "money", amountMinor: billsLastTotal.toString() }, { label: "Increase", kind: "percent", bps: rise }, { label: "Balance in your books today", kind: "money", amountMinor: e.openingBalance.toString() }],
      comparison: { label: `bills due ${nextWin.from} to ${nextWin.to} against ${lastWin.from} to ${lastWin.to}`, current: nextWin, prior: lastWin },
      evidence: bigFirst(billsNext).slice(0, 5).map(bill),
      uncertainty: ["Only bills already on record are counted; bills not yet received are not. Both windows count bills by due date, whether or not they are paid.", "Money arriving in the same weeks is not netted off here; the forecast does that."],
      actions: [forecastAction, ...planAction("agreeing later payment of a supplier balance, or a smaller deposit")], materialityMinor: (billsNextTotal - billsLastTotal).toString(),
    });
  }

  // 9. Expected receipts concentrated in one customer.
  if (outstanding.length >= 2 && outstandingTotal > 0n) {
    const byCustomer = new Map<string, { name: string; total: bigint; rows: InvoiceRecord[] }>();
    for (const i of outstanding) {
      const c = byCustomer.get(i.counterpartyId) ?? { name: i.counterpartyName, total: 0n, rows: [] };
      c.total += owedOf(i); c.rows.push(i);
      byCustomer.set(i.counterpartyId, c);
    }
    const top = [...byCustomer.values()].sort((a, b) => (a.total < b.total ? 1 : a.total > b.total ? -1 : a.name.localeCompare(b.name)))[0];
    const share = bpsOf(top.total, outstandingTotal);
    if (share >= R.concentrationBps) {
      const late = top.rows.filter((i) => i.dueOn < asOf).length;
      findings.push({
        id: "receipts_concentration", kind: "receipts_concentration", severity: share >= R.concentrationHighBps ? "medium" : "low",
        title: "Most of the money you are owed depends on one customer",
        why: `One customer owes ${fmt(top.total)} across ${top.rows.length} invoice${top.rows.length === 1 ? "" : "s"}, ${pctText(share)} of the ${fmt(outstandingTotal)} outstanding.${late > 0 ? ` ${late} of those ${late === 1 ? "is" : "are"} already past due.` : ""}`,
        figures: [{ label: "Owed by the biggest customer", kind: "money", amountMinor: top.total.toString() }, { label: "Total outstanding", kind: "money", amountMinor: outstandingTotal.toString() }, { label: "Share", kind: "percent", bps: share }, { label: "Open invoices from them", kind: "count", value: top.rows.length }],
        comparison: null, evidence: bigFirst(top.rows).slice(0, 5).map(inv),
        uncertainty: ["This counts invoices already issued. Future orders and the forecast's expected new invoices are not included.", "Concentration is a risk, not a loss: nothing here says this customer will pay late."],
        actions: [forecastAction, { kind: "orders", label: "See orders and quotes", href: "/room/commitments", note: null }], materialityMinor: top.total.toString(),
      });
    }
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  // Most severe first; at equal severity the forecast shortfall (the one with a rescue flow) leads, then the larger amount.
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || Number(b.kind === "forecast_shortfall") - Number(a.kind === "forecast_shortfall") || (BigInt(a.materialityMinor) < BigInt(b.materialityMinor) ? 1 : BigInt(a.materialityMinor) > BigInt(b.materialityMinor) ? -1 : 0) || a.id.localeCompare(b.id));

  const hasHigh = findings.some((f) => f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");
  const status: HealthStatus = hasHigh ? "needs_attention" : hasMedium ? "watch" : !comparable && findings.length === 0 ? "not_enough_history" : "steady";
  const n = findings.length;
  const headline = status === "needs_attention" ? `${findings.filter((f) => f.severity === "high").length} thing${findings.filter((f) => f.severity === "high").length === 1 ? "" : "s"} need${findings.filter((f) => f.severity === "high").length === 1 ? "s" : ""} your attention${n > 1 ? `, ${n} finding${n === 1 ? "" : "s"} in all` : ""}.`
    : status === "watch" ? `Nothing urgent, but ${n} thing${n === 1 ? "" : "s"} worth watching.`
    : status === "not_enough_history" ? "Not enough history to compare periods yet. No warnings from the records available."
    : n > 0 ? `Steady. ${n} minor note${n === 1 ? "" : "s"}.` : "Steady. Nothing in your records stands out.";

  const limits = [
    "Profit and margins are not calculated: your records hold cash movements and invoices, not the cost of what you sold.",
    "Bank transactions carry no category in the source data. Categories are assigned by fixed rules from the description and the linked customer or supplier, so treat them as a guide.",
    "Transfers between your own accounts are excluded from money in and out only when their description says so.",
    `Periods are compared only when the bank history covers both ${WINDOW_DAYS}-day windows.`,
    `Only ${cur} records are included.`,
  ];

  return {
    asOf, currency: cur, status, headline,
    periods: { windowDays: WINDOW_DAYS, current: curWin, prior: priorWin, comparable, reason, historyFrom, historyTo },
    metrics: {
      openingBalanceMinor: e.openingBalance.toString(), current: curFlow, prior: comparable ? priorFlow : null,
      outstandingReceivablesMinor: outstandingTotal.toString(), openInvoiceCount: outstanding.length, overdueReceivablesMinor: overdueNowTotal.toString(), overdueInvoiceCount: overdueNow.length,
      billsDueNextWindowMinor: billsNextTotal.toString(), billsDueLastWindowMinor: billsLastTotal.toString(),
      overdueBillsMinor: sum(overdueBills.map((b) => owedOf(b))).toString(), overdueBillCount: overdueBills.length,
    },
    findings, limits,
  };
}
