// BUSINESS ANALYSIS (cash view). Pure and deterministic: no database, no clock, no model, no randomness; integer minor units; the as-of date is passed in.
// Built only from what the books hold: invoices and bills (with what is still outstanding and when they were settled) and classified bank transactions.
// There is NO cost-of-goods, tax or margin data, so nothing here claims a margin or a profit; `limits` says so. It reuses the ledger's own rules
// (isForecast / owedOf for what is open, the loader's settled date for what is paid) and the insights' transaction classifier, and re-implements neither.
import { formatMoney, money } from "@/lib/money";
import { safeName } from "./alerts";
import { addDays, diffDays } from "./dates";
import { classifyTransaction, type TxCategory } from "./insights";
import { isForecast, owedOf } from "./open";
import type { BillRecord, InvoiceRecord } from "./types";

export const BUCKETS = ["not_yet_due", "1_30", "31_60", "61_90", "over_90"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const DSO_WINDOW_DAYS = 90;
export const DSO_MIN_DOCUMENTS = 3;
export const BEHAVIOUR_WINDOW_DAYS = 180;
export const BEHAVIOUR_TREND_DAYS = 90;
export const BEHAVIOUR_MIN_SETTLED = 3;
export const MONTHS_SHOWN = 6;
export const RUNWAY_MONTHS = 3;
export const RUNWAY_MIN_MONTHS = 2;

export interface AnalysisTx { postedOn: string; amount: bigint; description: string; counterpartyRole: "customer" | "supplier" | "lender" | null; counterpartyId?: string | null; counterpartyName?: string | null }

export interface AnalysisInput {
  asOf: string;
  currency: string;
  invoices: InvoiceRecord[];
  bills: BillRecord[];
  transactions: AnalysisTx[];
  /** The opening bank balance the forecast uses. */
  openingBalanceMinor: bigint;
}

export interface AgeingBucket { bucket: Bucket; label: string; amountMinor: bigint; count: number }
export interface Ageing {
  buckets: AgeingBucket[];
  totalMinor: bigint;
  count: number;
  /** Past its due date (1 day or more). */
  overdueMinor: bigint;
  overdueShareBps: number;
  /** More than 30 days past due (the same line the Funding profile uses). */
  over30Minor: bigint;
  over30ShareBps: number;
}

export interface Days { days: number | null; reason: string | null; openMinor: bigint; documentedMinor: bigint; documents: number; window: { from: string; to: string; days: number }; formula: string }
export interface CustomerRow { customerId: string; name: string; openMinor: bigint; overdueMinor: bigint; oldestDaysOverdue: number; shareOfOpenBps: number; settledCount: number; averageDaysLate: number | null }
export interface PaymentBehaviour {
  window: { from: string; to: string; days: number };
  settledCount: number;
  averageDaysLate: number | null;
  reason: string | null;
  trend: { recentAverage: number; priorAverage: number; changeDays: number; recentCount: number; priorCount: number; recent: { from: string; to: string }; prior: { from: string; to: string } } | null;
  trendReason: string | null;
  customers: CustomerRow[];
}
export interface MonthRow { month: string; inMinor: bigint; outMinor: bigint; netMinor: bigint; outByCategory: Record<string, bigint> }
export interface MonthlyCash { availableMonths: number; months: MonthRow[]; partialMonth: MonthRow | null; reason: string | null; firstTransactionOn: string | null }
export type Runway = { burning: true; months: number; monthlyBurnMinor: bigint; balanceMinor: bigint; monthsUsed: number } | { burning: false; monthsUsed: number; averageNetMinor: bigint } | { burning: null; reason: string };
export const MIN_CUSTOMERS_FOR_CONCENTRATION = 4;
export interface Concentration { customersWithReceipts: number; top: { customerId: string; name: string; receivedMinor: bigint; shareOfReceiptsBps: number; openMinor: bigint; shareOfOpenBps: number }[]; topShareOfReceiptsBps: number | null; topShareOfOpenBps: number | null; receiptsMonths: number; receiptsReason: string | null }

export interface AnalysisResult {
  v: 1;
  asOf: string;
  currency: string;
  receivables: Ageing;
  payables: Ageing;
  dso: Days;
  dpo: Days;
  paymentBehaviour: PaymentBehaviour;
  monthlyCash: MonthlyCash;
  runway: Runway;
  concentration: Concentration;
  workingCapital: { cashMinor: bigint; receivablesMinor: bigint; payablesMinor: bigint; netMinor: bigint; meaning: string };
  observations: string[];
  limits: string[];
}

export const ANALYSIS_LIMITS = [
  "This is a cash view built from your invoices, bills and bank transactions. It does not include the cost of goods, tax, wages accruals or any other cost data, so it shows cash, not profit or margin.",
  "Ageing counts only what is still outstanding; paid and void documents are left out, as are items already counted in a confirmed order.",
  `Days to be paid use invoices issued in the last ${DSO_WINDOW_DAYS} days; payment behaviour uses invoices settled in the last ${BEHAVIOUR_WINDOW_DAYS} days.`,
  "The runway uses the recent monthly pace; one large one-off payment, such as a tax bill, can make a month look worse than usual.",
  "Monthly figures use only complete calendar months that the bank history fully covers; transfers between your own accounts are left out, and loan money received is not counted as customer money.",
];

const BUCKET_LABEL: Record<Bucket, string> = { not_yet_due: "Not yet due", "1_30": "1 to 30 days overdue", "31_60": "31 to 60 days overdue", "61_90": "61 to 90 days overdue", over_90: "More than 90 days overdue" };
const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
const bpsOf = (a: bigint, b: bigint): number => (b > 0n ? Number((a * 10_000n) / b) : 0);
/** Integer average, rounded half up (toward the larger value on a .5). */
const avgInt = (xs: number[]): number => Math.floor((2 * xs.reduce((a, b) => a + b, 0) + xs.length) / (2 * xs.length));

export function bucketOf(dueOn: string, asOf: string): Bucket {
  const d = dueOn < asOf ? diffDays(dueOn, asOf) : 0;
  return d <= 0 ? "not_yet_due" : d <= 30 ? "1_30" : d <= 60 ? "31_60" : d <= 90 ? "61_90" : "over_90";
}

function ageing(docs: (InvoiceRecord | BillRecord)[], asOf: string): Ageing {
  const open = docs.filter(isForecast);
  const buckets: AgeingBucket[] = BUCKETS.map((b) => {
    const rows = open.filter((d) => bucketOf(d.dueOn, asOf) === b);
    return { bucket: b, label: BUCKET_LABEL[b], amountMinor: sum(rows.map(owedOf)), count: rows.length };
  });
  const total = sum(buckets.map((b) => b.amountMinor));
  const over30 = sum(buckets.filter((b) => b.bucket === "31_60" || b.bucket === "61_90" || b.bucket === "over_90").map((b) => b.amountMinor));
  const overdue = total - buckets[0].amountMinor;
  return { buckets, totalMinor: total, count: open.length, overdueMinor: overdue, overdueShareBps: bpsOf(overdue, total), over30Minor: over30, over30ShareBps: bpsOf(over30, total) };
}

function daysOutstanding(open: bigint, docs: (InvoiceRecord | BillRecord)[], asOf: string, noun: string): Days {
  const from = addDays(asOf, -(DSO_WINDOW_DAYS - 1));
  const issued = docs.filter((d) => d.issuedOn >= from && d.issuedOn <= asOf);
  const face = sum(issued.map((d) => d.amount));
  const window = { from, to: asOf, days: DSO_WINDOW_DAYS };
  const formula = `open ${noun} ÷ ${noun === "receivables" ? "invoiced" : "billed"} in the last ${DSO_WINDOW_DAYS} days × ${DSO_WINDOW_DAYS}`;
  const base = { openMinor: open, documentedMinor: face, documents: issued.length, window, formula };
  if (issued.length < DSO_MIN_DOCUMENTS || face <= 0n) return { ...base, days: null, reason: `Not enough ${noun === "receivables" ? "invoices" : "bills"} in the last ${DSO_WINDOW_DAYS} days (${issued.length}; at least ${DSO_MIN_DOCUMENTS} are needed).` };
  const days = Number((open * BigInt(DSO_WINDOW_DAYS) * 2n + face) / (face * 2n));
  return { ...base, days, reason: null };
}

const monthOf = (iso: string) => iso.slice(0, 7);
const monthStart = (m: string) => `${m}-01`;
const prevMonth = (m: string): string => { const y = Number(m.slice(0, 4)); const mo = Number(m.slice(5, 7)); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; };

export function analyse(input: AnalysisInput): AnalysisResult {
  const { asOf, currency } = input;
  const m = (v: bigint) => formatMoney(money(v, currency), 2);
  const pct1 = (bps: number) => `${Math.floor((bps + 5) / 10) / 10}%`;
  const invoices = input.invoices;
  const bills = input.bills;

  // ---- ageing of what is still outstanding
  const receivables = ageing(invoices, asOf);
  const payables = ageing(bills, asOf);
  const openInv = invoices.filter(isForecast);

  // ---- days to be paid / to pay
  const dso = daysOutstanding(receivables.totalMinor, invoices, asOf, "receivables");
  const dpo = daysOutstanding(payables.totalMinor, bills, asOf, "payables");

  // ---- how customers actually pay: invoices settled in the window, days from the due date (positive = late)
  const wFrom = addDays(asOf, -(BEHAVIOUR_WINDOW_DAYS - 1));
  const rFrom = addDays(asOf, -(BEHAVIOUR_TREND_DAYS - 1));
  const pTo = addDays(asOf, -BEHAVIOUR_TREND_DAYS);
  const settled = invoices.filter((i) => i.status === "paid" && i.paidOn && i.paidOn >= wFrom && i.paidOn <= asOf).map((i) => ({ i, late: diffDays(i.dueOn, i.paidOn as string) }));
  const recent = settled.filter((s) => (s.i.paidOn as string) >= rFrom);
  const prior = settled.filter((s) => (s.i.paidOn as string) < rFrom);
  const trend = recent.length >= BEHAVIOUR_MIN_SETTLED && prior.length >= BEHAVIOUR_MIN_SETTLED
    ? (() => { const r = avgInt(recent.map((s) => s.late)); const p = avgInt(prior.map((s) => s.late)); return { recentAverage: r, priorAverage: p, changeDays: r - p, recentCount: recent.length, priorCount: prior.length, recent: { from: rFrom, to: asOf }, prior: { from: wFrom, to: pTo } }; })()
    : null;
  const names = new Map<string, string>();
  for (const i of invoices) names.set(i.counterpartyId, i.counterpartyName);
  const customerIds = [...new Set([...openInv.map((i) => i.counterpartyId), ...settled.map((s) => s.i.counterpartyId)])];
  const customers: CustomerRow[] = customerIds.map((id) => {
    const open = openInv.filter((i) => i.counterpartyId === id);
    const overdue = open.filter((i) => i.dueOn < asOf);
    const mine = settled.filter((s) => s.i.counterpartyId === id);
    const openMinor = sum(open.map(owedOf));
    return {
      customerId: id, name: safeName(names.get(id) ?? ""), openMinor, overdueMinor: sum(overdue.map(owedOf)), oldestDaysOverdue: overdue.length > 0 ? Math.max(...overdue.map((i) => diffDays(i.dueOn, asOf))) : 0,
      shareOfOpenBps: bpsOf(openMinor, receivables.totalMinor), settledCount: mine.length, averageDaysLate: mine.length > 0 ? avgInt(mine.map((s) => s.late)) : null,
    };
  }).sort((a, b) => (a.openMinor === b.openMinor ? (a.customerId < b.customerId ? -1 : 1) : a.openMinor > b.openMinor ? -1 : 1));
  const paymentBehaviour: PaymentBehaviour = {
    window: { from: wFrom, to: asOf, days: BEHAVIOUR_WINDOW_DAYS }, settledCount: settled.length,
    averageDaysLate: settled.length >= BEHAVIOUR_MIN_SETTLED ? avgInt(settled.map((s) => s.late)) : null,
    reason: settled.length >= BEHAVIOUR_MIN_SETTLED ? null : `Only ${settled.length} invoice${settled.length === 1 ? " was" : "s were"} settled in the last ${BEHAVIOUR_WINDOW_DAYS} days (at least ${BEHAVIOUR_MIN_SETTLED} are needed).`,
    trend,
    trendReason: trend ? null : `Comparing the last ${BEHAVIOUR_TREND_DAYS} days with the ${BEHAVIOUR_TREND_DAYS} before needs at least ${BEHAVIOUR_MIN_SETTLED} settled invoices in each (${recent.length} and ${prior.length}).`,
    customers: customers.slice(0, 10),
  };

  // ---- money in and out by complete calendar month (the existing classifier; transfers left out)
  const txs = input.transactions.filter((t) => t.postedOn <= asOf).map((t) => ({ ...t, category: classifyTransaction(t) as TxCategory })).filter((t) => t.category !== "transfer");
  const all = input.transactions.filter((t) => t.postedOn <= asOf);
  const first = all.length > 0 ? all.reduce((d, t) => (t.postedOn < d ? t.postedOn : d), all[0].postedOn) : null;
  const rowFor = (month: string): MonthRow => {
    const rows = txs.filter((t) => monthOf(t.postedOn) === month);
    const inn = sum(rows.filter((t) => t.category === "customer_receipt").map((t) => t.amount));
    const outRows = rows.filter((t) => t.amount < 0n);
    const out = sum(outRows.map((t) => -t.amount));
    const by: Record<string, bigint> = {};
    for (const t of outRows) by[t.category] = (by[t.category] ?? 0n) + -t.amount;
    return { month, inMinor: inn, outMinor: out, netMinor: inn - out, outByCategory: by };
  };
  const months: MonthRow[] = [];
  if (first) for (let mo = prevMonth(monthOf(asOf)); months.length < MONTHS_SHOWN && monthStart(mo) >= first; mo = prevMonth(mo)) months.unshift(rowFor(mo));
  const asOfMonth = monthOf(asOf);
  const partialMonth = first && txs.some((t) => monthOf(t.postedOn) === asOfMonth) ? rowFor(asOfMonth) : null;
  const monthlyCash: MonthlyCash = {
    availableMonths: months.length, months, partialMonth, firstTransactionOn: first,
    reason: first === null ? "There are no bank transactions yet." : months.length === 0 ? `The bank history starts on ${first}, so no complete calendar month is covered yet.` : null,
  };

  // ---- runway: bank balance over the recent average monthly net outflow
  const used = months.slice(-RUNWAY_MONTHS);
  let runway: Runway;
  if (used.length < RUNWAY_MIN_MONTHS) runway = { burning: null, reason: `Fewer than ${RUNWAY_MIN_MONTHS} complete months of bank history, so there is no monthly pace to base a runway on.` };
  else {
    const net = sum(used.map((r) => r.netMinor));
    const avg = net / BigInt(used.length); // toward zero
    if (avg >= 0n) runway = { burning: false, monthsUsed: used.length, averageNetMinor: avg };
    else {
      const burn = -avg;
      const bal = input.openingBalanceMinor > 0n ? input.openingBalanceMinor : 0n;
      runway = { burning: true, months: Number(bal / burn), monthlyBurnMinor: burn, balanceMinor: input.openingBalanceMinor, monthsUsed: used.length };
    }
  }

  // ---- concentration: top three customers by money received (complete months) and by open balance
  const receiptTx = txs.filter((t) => t.category === "customer_receipt" && t.counterpartyId && months.some((r) => r.month === monthOf(t.postedOn)));
  const received = new Map<string, bigint>();
  for (const t of receiptTx) { received.set(t.counterpartyId as string, (received.get(t.counterpartyId as string) ?? 0n) + t.amount); if (t.counterpartyName) names.set(t.counterpartyId as string, t.counterpartyName); }
  const totalReceived = sum([...received.values()]);
  const topIds = [...new Set([...received.keys(), ...customers.map((c) => c.customerId)])]
    .map((id) => ({ id, rec: received.get(id) ?? 0n, open: customers.find((c) => c.customerId === id)?.openMinor ?? 0n }))
    .sort((a, b) => (a.rec === b.rec ? (a.open === b.open ? (a.id < b.id ? -1 : 1) : a.open > b.open ? -1 : 1) : a.rec > b.rec ? -1 : 1)).slice(0, 3);
  const top = topIds.map((x) => ({ customerId: x.id, name: safeName(names.get(x.id) ?? ""), receivedMinor: x.rec, shareOfReceiptsBps: bpsOf(x.rec, totalReceived), openMinor: x.open, shareOfOpenBps: bpsOf(x.open, receivables.totalMinor) }));
  const enough = received.size >= MIN_CUSTOMERS_FOR_CONCENTRATION;
  const concentration: Concentration = {
    customersWithReceipts: received.size, top, receiptsMonths: months.length, receiptsReason: months.length === 0 || totalReceived === 0n ? "No customer receipts in a complete month yet." : !enough ? `Too few customers for a concentration figure (${received.size}; at least ${MIN_CUSTOMERS_FOR_CONCENTRATION} are needed).` : null,
    topShareOfReceiptsBps: enough && totalReceived > 0n ? bpsOf(sum(top.map((x) => x.receivedMinor)), totalReceived) : null,
    topShareOfOpenBps: receivables.totalMinor > 0n ? bpsOf(sum(top.map((x) => x.openMinor)), receivables.totalMinor) : null,
  };

  const workingCapital = {
    cashMinor: input.openingBalanceMinor, receivablesMinor: receivables.totalMinor, payablesMinor: payables.totalMinor,
    netMinor: input.openingBalanceMinor + receivables.totalMinor - payables.totalMinor,
    meaning: "That is what you would have if everything open were settled today.",
  };

  // ---- observations: fixed rules, templated sentences, no judgement words
  const obs: string[] = [];
  const plural = (n: number, a: string, b: string) => (n === 1 ? a : b);
  if (paymentBehaviour.averageDaysLate !== null) {
    const a = paymentBehaviour.averageDaysLate;
    obs.push(a > 0 ? `Customers pay you on average ${a} ${plural(a, "day", "days")} after the due date.` : a < 0 ? `Customers pay you on average ${-a} ${plural(-a, "day", "days")} before the due date.` : "Customers pay you on average on the due date.");
  }
  const worst = [...customers].filter((c) => c.overdueMinor > 0n).sort((a, b) => (a.overdueMinor === b.overdueMinor ? (a.customerId < b.customerId ? -1 : 1) : a.overdueMinor > b.overdueMinor ? -1 : 1))[0];
  if (worst) obs.push(`${worst.name} owes ${m(worst.overdueMinor)} past its due date, ${pct1(bpsOf(worst.overdueMinor, receivables.totalMinor))} of everything owed to you, and is ${worst.oldestDaysOverdue} ${plural(worst.oldestDaysOverdue, "day", "days")} overdue.`);
  if (receivables.overdueMinor > 0n) obs.push(`${pct1(receivables.overdueShareBps)} of what customers owe you (${m(receivables.overdueMinor)}) is past its due date.`);
  if (runway.burning === true) obs.push(`At the pace of the last ${runway.monthsUsed} months, your bank balance would last about ${runway.months} ${plural(runway.months, "month", "months")}.`);
  else if (runway.burning === false) obs.push(`Over the last ${runway.monthsUsed} complete months, more money came in from customers than went out, by ${m(runway.averageNetMinor)} a month on average.`);
  if (concentration.topShareOfReceiptsBps !== null && top.length > 0) obs.push(`Your top ${top.length} ${plural(top.length, "customer", "customers")} made up ${pct1(concentration.topShareOfReceiptsBps)} of the customer money received over the last ${concentration.receiptsMonths} complete ${plural(concentration.receiptsMonths, "month", "months")}.`);
  if (payables.overdueMinor > 0n) obs.push(`You owe suppliers ${m(payables.totalMinor)}, of which ${m(payables.overdueMinor)} is past its due date.`);

  return {
    v: 1, asOf, currency, receivables, payables, dso, dpo, paymentBehaviour, monthlyCash, runway, concentration, workingCapital,
    observations: obs.slice(0, 5), limits: ANALYSIS_LIMITS,
  };
}
