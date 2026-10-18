"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// "Business analysis (cash view)": the books looked at as a business. Every figure and sentence comes from the server (plain code over invoices, bills and bank
// transactions); the browser does no money arithmetic. There is no cost or tax data, so it never says anything about profit or margin.
import { useState } from "react";
import { ErrorNote, Stat, Th } from "./kit";
import { money, pct } from "./format";
import { call, useSession } from "./session";

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function BusinessAnalysis() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [a, setA] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!biz || a || loading) return;
    setLoading(true); setError(null);
    const r = await call(`/api/business/${biz}/analysis`);
    setLoading(false);
    if (r.ok) setA(r.data); else setError(r.data?.error ?? "The analysis could not be loaded right now.");
  }

  return (
    <details className="group rounded-2xl border border-line bg-panel" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void load(); }}>
      <summary className="cursor-pointer list-none px-5 py-4">
        <span className="display text-lg">Business analysis (cash view)</span>
        <span className="mt-1 block text-sm text-ink-soft">How old your unpaid invoices are, how long customers really take to pay, money in and out by month and how long your cash would last. Open it to read it.</span>
      </summary>
      <div className="space-y-5 border-t border-line px-5 py-5">
        {loading && <p className="text-sm text-ink-soft">Working it out from your books…</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
        {a && <AnalysisBody a={a} />}
      </div>
    </details>
  );
}

export function AnalysisBody({ a }: { a: any }) {
  const cur = a.currency;
  const r = a.receivables, p = a.payables, pb = a.paymentBehaviour, rw = a.runway, mc = a.monthlyCash;
  const late = pb.averageDaysLate;
  return (
    <>
      <p className="rounded-xl border border-line bg-white/60 p-3 text-sm"><b>Cash, not profit.</b> Based on your invoices, bills and bank transactions. It does not include costs of goods or tax, so it shows cash, not profit.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Owed to you" value={money(r.totalMinor, cur)} sub={r.count === 0 ? "nothing unpaid" : `${r.count} unpaid invoice${r.count === 1 ? "" : "s"}; ${pct(r.overdueShareBps)} is past its due date`} />
        <Stat label="You owe" value={money(p.totalMinor, cur)} sub={p.count === 0 ? "no unpaid bills" : `${p.count} unpaid bill${p.count === 1 ? "" : "s"}${p.overdueMinor !== "0" ? `; ${pct(p.overdueShareBps)} is past its due date` : ""}`} />
        <Stat label="Customers pay you" value={late === null ? "Not enough data yet" : late > 0 ? `${dayWord(late)} late` : late < 0 ? `${dayWord(-late)} early` : "on the due date"}
          sub={late === null ? pb.reason : `on average, over ${pb.settledCount} invoices paid in the last ${pb.window.days} days`} tone={late !== null && late > 0 ? "caution" : undefined} />
        <Stat label="Cash runway" value={rw.burning === null ? "Not enough data yet" : rw.burning ? `about ${rw.months} month${rw.months === 1 ? "" : "s"}` : "Your cash is not shrinking month to month"}
          sub={rw.burning === null ? rw.reason : rw.burning ? `at the pace of the last ${rw.monthsUsed} months (${money(rw.monthlyBurnMinor, cur)} more out than in each month)` : `over the last ${rw.monthsUsed} complete months`} tone={rw.burning === true ? "caution" : undefined} />
      </div>

      {a.observations.length > 0 && (
        <section><h3 className="display text-base">What stands out</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{a.observations.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Ageing title="What customers owe you, by how overdue" ag={r} cur={cur} noun="invoices" />
        <Ageing title="What you owe suppliers, by how overdue" ag={p} cur={cur} noun="bills" />
      </div>

      <section>
        <h3 className="display text-base">Money in and out, month by month</h3>
        {mc.months.length === 0 ? <p className="mt-1 text-sm text-ink-soft">Not enough data yet: {mc.reason}</p> : (
          <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[30rem] text-sm">
            <thead><tr><Th>Month</Th><Th right>Money in from customers</Th><Th right>Money out</Th><Th right>Difference</Th></tr></thead>
            <tbody>
              {mc.months.map((m: any) => <MonthRow key={m.month} label={monthName(m.month)} m={m} cur={cur} />)}
              {mc.partialMonth && <MonthRow label={`${monthName(mc.partialMonth.month)} so far (incomplete)`} m={mc.partialMonth} cur={cur} muted />}
            </tbody>
          </table></div>
        )}
        <p className="mt-2 text-xs text-ink-soft">Complete calendar months only. Transfers between your own accounts and loan money received are not counted as customer money. “Money out” includes loan repayments.</p>
      </section>

      <section>
        <h3 className="display text-base">Your customers</h3>
        {pb.customers.length === 0 ? <p className="mt-1 text-sm text-ink-soft">Not enough data yet: no customer has an unpaid or recently paid invoice.</p> : (
          <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
            <thead><tr><Th>Customer</Th><Th right>Owes you</Th><Th right>Past due</Th><Th right>Usually pays</Th><Th right>Share of what you are owed</Th></tr></thead>
            <tbody>{pb.customers.map((c: any) => (
              <tr key={c.customerId} className="border-t border-line align-top">
                <td className="py-1.5 pr-3">{c.name}</td>
                <td className="num py-1.5 pr-3 text-right">{money(c.openMinor, cur)}</td>
                <td className="num py-1.5 pr-3 text-right">{c.overdueMinor === "0" ? "–" : <>{money(c.overdueMinor, cur)}<div className="text-xs text-ink-soft">oldest {dayWord(c.oldestDaysOverdue)} overdue</div></>}</td>
                <td className="py-1.5 pr-3 text-right">{c.averageDaysLate === null ? <span className="text-ink-soft">not enough paid invoices</span> : c.averageDaysLate > 0 ? `${dayWord(c.averageDaysLate)} late` : c.averageDaysLate < 0 ? `${dayWord(-c.averageDaysLate)} early` : "on time"}<div className="text-xs text-ink-soft">{c.settledCount} paid invoice{c.settledCount === 1 ? "" : "s"}</div></td>
                <td className="num py-1.5 text-right">{pct(c.shareOfOpenBps)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        {pb.trend && <p className="mt-2 text-sm">In the last 90 days customers paid {pb.trend.recentAverage > 0 ? `${dayWord(pb.trend.recentAverage)} after` : pb.trend.recentAverage < 0 ? `${dayWord(-pb.trend.recentAverage)} before` : "on"} the due date on average, against {pb.trend.priorAverage > 0 ? `${dayWord(pb.trend.priorAverage)} after` : pb.trend.priorAverage < 0 ? `${dayWord(-pb.trend.priorAverage)} before` : "on"} in the 90 days before.</p>}
        {!pb.trend && <p className="mt-2 text-xs text-ink-soft">No trend yet: {pb.trendReason}</p>}
        {a.concentration.topShareOfReceiptsBps === null && <p className="mt-1 text-xs text-ink-soft">Too few customers for a concentration figure{a.concentration.customersWithReceipts > 0 ? ` (${a.concentration.customersWithReceipts} with receipts; at least 4 are needed)` : ""}.</p>}
      </section>

      <section className="text-sm">
        <h3 className="display text-base">Put together</h3>
        <p className="mt-1">Cash in the bank {money(a.workingCapital.cashMinor, cur)} + owed to you {money(a.workingCapital.receivablesMinor, cur)} − you owe {money(a.workingCapital.payablesMinor, cur)} = <b className="num">{money(a.workingCapital.netMinor, cur)}</b>. <span className="text-ink-soft">{a.workingCapital.meaning}</span></p>
      </section>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">How this is calculated</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
          <li>Days customers take to be paid (days sales outstanding): {a.dso.formula}. {a.dso.days === null ? a.dso.reason : `It comes to ${a.dso.days} days (${money(a.dso.openMinor, cur)} open, ${money(a.dso.documentedMinor, cur)} invoiced in ${a.dso.documents} invoices).`}</li>
          <li>Days you take to pay (days payable outstanding): {a.dpo.formula}. {a.dpo.days === null ? a.dpo.reason : `It comes to ${a.dpo.days} days.`}</li>
          {a.limits.map((l: string, i: number) => <li key={i}>{l}</li>)}
          <li>As of {a.asOf}.</li>
        </ul>
      </details>
    </>
  );
}

function Ageing({ title, ag, cur, noun }: { title: string; ag: any; cur: string; noun: string }) {
  return (
    <section>
      <h3 className="display text-base">{title}</h3>
      <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[20rem] text-sm">
        <thead><tr><Th>How overdue</Th><Th right>Amount</Th><Th right>{noun === "invoices" ? "Invoices" : "Bills"}</Th></tr></thead>
        <tbody>
          {ag.buckets.map((b: any) => (
            <tr key={b.bucket} className="border-t border-line">
              <td className="py-1.5 pr-3">{b.label}</td>
              <td className="num py-1.5 pr-3 text-right">{money(b.amountMinor, cur)}</td>
              <td className="num py-1.5 text-right">{b.count}</td>
            </tr>))}
          <tr className="border-t border-line font-medium"><td className="py-1.5 pr-3">Total unpaid</td><td className="num py-1.5 pr-3 text-right">{money(ag.totalMinor, cur)}</td><td className="num py-1.5 text-right">{ag.count}</td></tr>
        </tbody>
      </table></div>
    </section>
  );
}

function MonthRow({ label, m, cur, muted }: { label: string; m: any; cur: string; muted?: boolean }) {
  const neg = BigInt(m.netMinor) < 0n;
  return (
    <tr className={`border-t border-line ${muted ? "text-ink-soft" : ""}`}>
      <td className="py-1.5 pr-3">{label}</td>
      <td className="num py-1.5 pr-3 text-right">{money(m.inMinor, cur)}</td>
      <td className="num py-1.5 pr-3 text-right">{money(m.outMinor, cur)}</td>
      <td className={`num py-1.5 text-right ${muted ? "" : neg ? "text-danger" : "text-good"}`}>{money(m.netMinor, cur, { signed: true })}{neg ? " (more out than in)" : ""}</td>
    </tr>
  );
}
