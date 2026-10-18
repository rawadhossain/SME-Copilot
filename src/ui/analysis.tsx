"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Analysis: the books looked at as a business. Every figure and sentence comes from the server (plain code over invoices, bills and bank
// transactions); the browser does no money arithmetic. There is no cost or tax data, so it never says anything about profit or margin.
// Laid out as a short reading: the headline finding, the four numbers behind it, then who owes what and how cash moved, with the full tables one click away.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ErrorNote, Loading, Metric, PageHead, Th, type Tone } from "./kit";
import { money, pct } from "./format";
import { call, useSession } from "./session";

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const monthShort = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const BUCKET = ["#8fbf7a", "#e3c766", "#e39b55", "#d1613f", "#a33a36"];

export function BusinessAnalysis() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [a, setA] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!biz) return;
    void call(`/api/business/${biz}/analysis`).then((r) => { if (r.ok) setA(r.data); else setError(r.data?.error ?? "The analysis could not be loaded right now."); });
  }, [biz]);
  return (
    <div className="space-y-6">
      <PageHead title="Analysis" sub="Cash, not profit" back={{ href: "/room/invoices", label: "Books" }} info="How your customers pay and how long your cash lasts. Costs of goods and tax are not in these records." />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!a && !error && <Loading label="Working it out from your books" />}
      {a && <AnalysisBody a={a} />}
    </div>
  );
}

export function AnalysisBody({ a }: { a: any }) {
  const cur = a.currency;
  const r = a.receivables, p = a.payables, pb = a.paymentBehaviour, rw = a.runway, mc = a.monthlyCash;
  const late = pb.averageDaysLate;
  const headline = late !== null && late > 0 ? `Customers pay you ${dayWord(late)} late on average`
    : rw.burning ? `At the current pace your cash lasts about ${rw.months} month${rw.months === 1 ? "" : "s"}`
    : late !== null && late <= 0 ? "Customers pay you on time" : "Your cash position looks steady";
  const headTone: Tone = (late !== null && late > 0) || rw.burning ? "caution" : "good";
  return (
    <>
      <section className="surface rise p-6" style={{ "--i": 1 } as React.CSSProperties} aria-label="In short">
        <h2 className="display text-[22px] leading-snug">{headline}</h2>
        {a.observations.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-[15px] text-ink-soft">
            {a.observations.slice(0, 3).map((o: string, i: number) => <li key={i} className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />{o}</li>)}
          </ul>
        )}
        {a.observations.length > 3 && <details className="mt-2 text-sm text-ink-soft"><summary className="cursor-pointer text-accent">{a.observations.length - 3} more</summary><ul className="mt-1.5 space-y-1.5">{a.observations.slice(3).map((o: string, i: number) => <li key={i} className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" aria-hidden />{o}</li>)}</ul></details>}
        <div className="strip mt-5 grid-cols-2 lg:grid-cols-4">
          <Metric label="Owed to you" value={money(r.totalMinor, cur)} sub={r.count === 0 ? "nothing unpaid" : `${r.count} invoice${r.count === 1 ? "" : "s"} · ${pct(r.overdueShareBps)} overdue`} />
          <Metric label="You owe" value={money(p.totalMinor, cur)} sub={p.count === 0 ? "no unpaid bills" : `${p.count} bill${p.count === 1 ? "" : "s"}${p.overdueMinor !== "0" ? ` · ${pct(p.overdueShareBps)} overdue` : ""}`} />
          <Metric label="Customers pay" value={late === null ? "Not enough data" : late > 0 ? `${dayWord(late)} late` : late < 0 ? `${dayWord(-late)} early` : "on time"} tone={late !== null && late > 0 ? headTone : undefined}
            sub={late === null ? pb.reason : `average of ${pb.settledCount} paid invoices`} />
          <Metric label="Cash runway" value={rw.burning === null ? "Not enough data" : rw.burning ? `~${rw.months} month${rw.months === 1 ? "" : "s"}` : "Not shrinking"} tone={rw.burning === true ? "caution" : undefined}
            sub={rw.burning === null ? rw.reason : rw.burning ? `${money(rw.monthlyBurnMinor, cur)} more out than in each month` : `last ${rw.monthsUsed} full months`} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Ageing title="Who owes you" ag={r} cur={cur} noun="invoice" />
        <Ageing title="Who you owe" ag={p} cur={cur} noun="bill" />
      </div>

      <section className="surface p-6" aria-label="Money in and out">
        <h2 className="display text-[17px]">Money in and out</h2>
        {mc.months.length === 0 ? <p className="mt-2 text-sm text-ink-soft">Not enough data yet: {mc.reason}</p> : (
          <>
            <MonthlyBars months={mc.months} cur={cur} />
            <details className="mt-3 text-sm"><summary className="cursor-pointer text-accent">See the numbers</summary>
              <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[30rem] text-sm">
                <thead className="bg-panel-quiet"><tr><Th>Month</Th><Th right>In from customers</Th><Th right>Out</Th><Th right>Difference</Th></tr></thead>
                <tbody>
                  {mc.months.map((m: any) => <MonthRow key={m.month} label={monthName(m.month)} m={m} cur={cur} />)}
                  {mc.partialMonth && <MonthRow label={`${monthName(mc.partialMonth.month)} so far`} m={mc.partialMonth} cur={cur} muted />}
                </tbody>
              </table></div>
              <p className="mt-2 text-xs text-ink-soft">Complete calendar months. Transfers between your own accounts and loan money received are not counted as customer money; “out” includes loan repayments.</p>
            </details>
          </>
        )}
      </section>

      <section className="surface overflow-hidden" aria-label="Your customers">
        <div className="flex items-baseline justify-between gap-3 px-6 pb-3 pt-5">
          <h2 className="display text-[17px]">Your customers</h2>
          {pb.trend && <p className="text-sm text-ink-soft">Last 90 days: pay {pb.trend.recentAverage > 0 ? `${dayWord(pb.trend.recentAverage)} late` : pb.trend.recentAverage < 0 ? `${dayWord(-pb.trend.recentAverage)} early` : "on time"}, against {pb.trend.priorAverage > 0 ? `${dayWord(pb.trend.priorAverage)} late` : pb.trend.priorAverage < 0 ? `${dayWord(-pb.trend.priorAverage)} early` : "on time"} before</p>}
        </div>
        {pb.customers.length === 0 ? <p className="px-6 pb-6 text-sm text-ink-soft">Not enough data yet: no customer has an unpaid or recently paid invoice.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-panel-quiet"><tr><Th>Customer</Th><Th right>Owes you</Th><Th right>Past due</Th><Th right>Usually pays</Th><Th right>Share</Th></tr></thead>
            <tbody>{pb.customers.map((c: any) => (
              <tr key={c.customerId} className="row-hover border-t border-line align-top">
                <td className="py-3 pl-4 pr-3 font-medium">{c.name.replace(/\s*\(SYNTHETIC\)/i, "")}</td>
                <td className="num py-3 pr-3 text-right">{money(c.openMinor, cur)}</td>
                <td className="num py-3 pr-3 text-right">{c.overdueMinor === "0" ? <span className="text-ink-soft">–</span> : <span className="text-danger">{money(c.overdueMinor, cur)}<span className="block text-xs text-ink-soft">oldest {dayWord(c.oldestDaysOverdue)}</span></span>}</td>
                <td className="py-3 pr-3 text-right">{c.averageDaysLate === null ? <span className="text-ink-soft">not enough history</span> : c.averageDaysLate > 0 ? <span className="text-caution">{dayWord(c.averageDaysLate)} late</span> : c.averageDaysLate < 0 ? `${dayWord(-c.averageDaysLate)} early` : "on time"}<span className="block text-xs text-ink-soft">{c.settledCount} paid</span></td>
                <td className="num py-3 pr-4 text-right">{pct(c.shareOfOpenBps)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        {a.concentration.topShareOfReceiptsBps === null && <p className="border-t border-line px-6 py-3 text-xs text-ink-soft">Too few customers for a concentration figure{a.concentration.customersWithReceipts > 0 ? ` (${a.concentration.customersWithReceipts} with receipts; at least 4 are needed)` : ""}.</p>}
      </section>

      <section className="surface p-6" aria-label="Put together">
        <h2 className="display text-[17px]">Put together</h2>
        <p className="num mt-2 text-[15px]">{money(a.workingCapital.cashMinor, cur)} <span className="text-ink-soft">in the bank</span> + {money(a.workingCapital.receivablesMinor, cur)} <span className="text-ink-soft">owed to you</span> − {money(a.workingCapital.payablesMinor, cur)} <span className="text-ink-soft">you owe</span> = <b className="text-[17px]">{money(a.workingCapital.netMinor, cur)}</b></p>
        <p className="mt-1 text-sm text-ink-soft">{a.workingCapital.meaning}</p>
        <details className="mt-4 text-sm"><summary className="cursor-pointer text-accent">How this is calculated</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
            <li>Days customers take to pay (DSO): {a.dso.formula}. {a.dso.days === null ? a.dso.reason : `It comes to ${a.dso.days} days (${money(a.dso.openMinor, cur)} open, ${money(a.dso.documentedMinor, cur)} invoiced in ${a.dso.documents} invoices).`}</li>
            <li>Days you take to pay (DPO): {a.dpo.formula}. {a.dpo.days === null ? a.dpo.reason : `It comes to ${a.dpo.days} days.`}</li>
            {a.limits.map((l: string, i: number) => <li key={i}>{l}</li>)}
            <li>As of {a.asOf}.</li>
          </ul>
        </details>
      </section>

      <p className="text-sm text-ink-soft">Something here worth acting on? <Link href="/room/invoices" className="text-accent hover:underline">Open Invoices &amp; bills</Link> to chase it, or ask Copilot.</p>
    </>
  );
}

/** One stacked bar for how overdue the unpaid amounts are, with the buckets listed under it. */
function Ageing({ title, ag, cur, noun }: { title: string; ag: any; cur: string; noun: string }) {
  const total = BigInt(ag.totalMinor);
  return (
    <section className="surface p-6" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3"><h2 className="display text-[17px]">{title}</h2><p className="num text-sm text-ink-soft">{money(ag.totalMinor, cur)} · {ag.count} {noun}{ag.count === 1 ? "" : "s"}</p></div>
      {total === 0n ? <p className="mt-4 text-sm text-ink-soft">Nothing unpaid.</p> : (
        <>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-neutral-soft" role="img" aria-label={`${title} by how overdue`}>
            {ag.buckets.map((b: any, i: number) => BigInt(b.amountMinor) > 0n && <div key={b.bucket} title={`${b.label}: ${money(b.amountMinor, cur)}`} style={{ width: `${Number((BigInt(b.amountMinor) * 1000n) / total) / 10}%`, background: BUCKET[Math.min(i, BUCKET.length - 1)] }} />)}
          </div>
          <ul className="mt-4 space-y-2 text-sm">
            {ag.buckets.map((b: any, i: number) => (
              <li key={b.bucket} className={`flex items-center justify-between gap-3 ${BigInt(b.amountMinor) === 0n ? "text-ink-soft/60" : ""}`}>
                <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: BUCKET[Math.min(i, BUCKET.length - 1)] }} aria-hidden />{b.label}</span>
                <span className="num">{money(b.amountMinor, cur)}<span className="ml-2 text-xs text-ink-soft">{b.count}</span></span>
              </li>))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Money in against money out for each full month. */
function MonthlyBars({ months, cur }: { months: any[]; cur: string }) {
  const max = Math.max(1, ...months.flatMap((m) => [Number(BigInt(m.inMinor) / 100n), Number(BigInt(m.outMinor) / 100n)]));
  const W = 960, H = 190, B = 24, bw = Math.min(34, (W / months.length) * 0.24);
  const x = (i: number) => (W / months.length) * (i + 0.5);
  const h = (v: string) => (Number(BigInt(v) / 100n) / max) * (H - B - 8);
  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Money in and out by month">
        <line x1="0" x2={W} y1={H - B} y2={H - B} stroke="var(--line)" />
        {months.map((m, i) => (
          <g key={m.month}>
            <title>{`${monthName(m.month)}: in ${money(m.inMinor, cur)}, out ${money(m.outMinor, cur)}`}</title>
            <rect x={x(i) - bw - 2} y={H - B - h(m.inMinor)} width={bw} height={h(m.inMinor)} rx="3" fill="#4f9a6f" />
            <rect x={x(i) + 2} y={H - B - h(m.outMinor)} width={bw} height={h(m.outMinor)} rx="3" fill="#cbbf9e" />
            <text x={x(i)} y={H - 7} textAnchor="middle" fontSize="11" fill="var(--ink-soft)">{monthShort(m.month)}</text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 flex gap-5 text-[13px] text-ink-soft"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#4f9a6f]" />In from customers</span><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#cbbf9e]" />Out</span></figcaption>
    </figure>
  );
}

function MonthRow({ label, m, cur, muted }: { label: string; m: any; cur: string; muted?: boolean }) {
  const neg = BigInt(m.netMinor) < 0n;
  return (
    <tr className={`border-t border-line ${muted ? "text-ink-soft" : ""}`}>
      <td className="py-2 pl-4 pr-3">{label}</td>
      <td className="num py-2 pr-3 text-right">{money(m.inMinor, cur)}</td>
      <td className="num py-2 pr-3 text-right">{money(m.outMinor, cur)}</td>
      <td className={`num py-2 pr-4 text-right ${muted ? "" : neg ? "text-danger" : "text-good"}`}>{money(m.netMinor, cur, { signed: true })}</td>
    </tr>
  );
}
