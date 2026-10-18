"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Chart } from "@/ui/Chart";
import { Btn, Chip, Disclosure, Empty, ErrorNote, Loading, Metric, PageHead, Th, type Tone } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { date, money, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";
import { CauseDocuments, ForecastBasis, GapCauses, pictureOf } from "@/ui/rescue";
import { NextStep } from "@/ui/NextStep";
import { FinancialHealth } from "@/ui/insights";
import { AlertsPanel } from "@/ui/alerts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const LIFECYCLE: Record<string, string> = { running: "Working", needs_replan: "Needs a new plan", exhausted: "No plan fits", superseded: "Replaced" };
const stagger = (i: number) => ({ "--i": i }) as React.CSSProperties;

export default function CashDesk() {
  const { session } = useSession();
  const biz = session?.business.id;
  const cur = session?.business.currency ?? "GBP";
  const [room, setRoom] = useState<any>(null);
  const [cases, setCases] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [late, setLate] = useState(0); // 0 = off; otherwise "if customers pay this many days late"

  const load = useCallback(async () => {
    if (!biz) return;
    const [r, c] = await Promise.all([call(`/api/business/${biz}/room${late ? `?lateDays=${late}` : ""}`), call(`/api/business/${biz}/cases`)]);
    if (r.ok) setRoom(r.data); else setError(r.data.error ?? "Could not load the cash desk");
    if (c.ok) setCases(c.data);
  }, [biz, late]);
  useEffect(() => { void load(); }, [load]);

  // While a planning run is working, show its live state (steps are saved as they happen).
  const anyRunning = cases.some((c) => c.status === "running");
  useEffect(() => {
    if ((!busy && !anyRunning) || !biz) return;
    const t = setInterval(async () => { const c = await call(`/api/business/${biz}/cases`); if (c.ok) { setCases(c.data); if (!c.data.some((x: any) => x.status === "running")) void load(); } }, 1000);
    return () => clearInterval(t);
  }, [busy, anyRunning, biz, load]);

  async function check() {
    setBusy(true);
    setError(null);
    const r = await call(`/api/business/${biz}/shortage-check`, {});
    setBusy(false);
    if (!r.ok) setError(r.data.error ?? "The shortage check failed");
    await load();
  }

  if (!room) return error ? <ErrorNote>{error}</ErrorNote> : <Loading label="Reading your books" />;
  const doNothing = room.forecast;
  const f = room.agreed ?? room.forecast; // the headline is the forecast WITH any terms already agreed; "do nothing" stays as a comparison line
  const roots = cases.filter((c) => !c.parentRunId);
  const latest = roots.filter((c) => c.lifecycle !== "superseded").at(-1) ?? roots.at(-1);
  const running = cases.find((c) => c.status === "running");
  const neg = f.firstNegativeWeek;
  const { sh, reason, below0, tone } = pictureOf(room);
  const g = room.ledger;
  const lowTone: Tone = BigInt(f.minBalanceMinor) < 0n ? "danger" : BigInt(f.minBalanceMinor) < BigInt(room.reserveMinor) ? "caution" : "good";
  const status = running ? { label: "Investigating", tone: "accent" as Tone } : sh.shortage ? { label: below0 ? "Urgent" : "Watch", tone: tone as Tone } : { label: "On track", tone: "good" as Tone };
  const headline = running ? "Your assistant is working on it" : sh.shortage ? (below0 ? `Cash goes below zero in ${week(reason.firstNegativeWeek ?? reason.minBalanceWeek)}` : `Cash dips under your cushion in ${week(reason.minBalanceWeek)}`) : `Cash stays above your cushion for ${room.horizonWeeks} weeks`;
  const detail = sh.shortage ? `${money(reason.shortfallMinor, cur)} short of your cushion at the lowest point.` : `Lowest point is ${money(f.minBalanceMinor, cur)} in ${week(f.minBalanceWeek)}.`;
  const overduePct = g && BigInt(g.openInvoiceMinor) > 0n ? Number((BigInt(g.overdueMinor) * 1000n) / BigInt(g.openInvoiceMinor)) / 10 : 0;

  return (
    <div className="grid items-start gap-x-6 gap-y-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      {/* ===== MAIN: the cash story ===== */}
      <div className="min-w-0 space-y-6">
        <PageHead title="Today" sub={`${date(room.asOf)} · ${session?.business.name.replace(" (SYNTHETIC)", "")}`}
          actions={<Btn variant="secondary" busy={busy} onClick={check}><Icon name="refresh" size={16} />Re-check my cash</Btn>} />
        {error && <ErrorNote>{error}</ErrorNote>}

        <section className="surface rise" style={stagger(1)} aria-label="Cash outlook">
          <div className="flex flex-wrap items-center justify-between gap-4 p-6 pb-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <Chip tone={status.tone} pulse={!!running}>{status.label}</Chip>
                <h2 className="display text-[22px] leading-snug" role="status">{headline}</h2>
              </div>
              <p className="mt-1 text-[15px] text-ink-soft"><span className="num">{detail}</span></p>
            </div>
            {sh.shortage && (latest?.runId
              ? <Btn href={`/room/case?run=${latest.runId}`}>See my options<Icon name="arrow" size={16} /></Btn>
              : <Btn onClick={check} busy={busy}>Find me options<Icon name="arrow" size={16} /></Btn>)}
          </div>
          <div className="strip grid-cols-3 !rounded-none !border-x-0 !shadow-none">
            <Metric label="In the bank today" value={money(room.balances.sandboxBankMinor, cur)} />
            <Metric label="Lowest point ahead" value={money(f.minBalanceMinor, cur)} tone={lowTone} sub={week(f.minBalanceWeek)} />
            <Metric label="Safety cushion" value={money(room.reserveMinor, cur)} />
          </div>
          <div className="p-6 pt-5">
            <Chart flows currency={cur} reserveMinor={room.reserveMinor} height={270} series={[
              ...(room.commitments.length ? [{ key: "books", label: "Without the new orders and quotes", weeks: room.booksOnly.weeks, color: "#8b958f", dashed: true }] : []),
              ...(room.agreed ? [{ key: "nothing", label: "If you had done nothing", weeks: doNothing.weeks, color: "#c2701a", dashed: true, firstNegativeWeek: doNothing.firstNegativeWeek }] : []),
              ...(room.downside ? [{ key: "late", label: `If customers pay ${room.downside.days} days late`, weeks: room.downside.weeks, color: "#7c5cd6", dashed: true, firstNegativeWeek: room.downside.firstNegativeWeek }] : []),
              { key: "with", label: room.agreed ? "With your agreed plan" : room.commitments.length ? "With confirmed orders and quotes" : "Your books", weeks: f.weeks, color: "#1d5a4c", firstNegativeWeek: neg },
            ]} />
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="surface rise p-5" style={stagger(2)} aria-label="Invoices and bills">
            <div className="flex items-center justify-between gap-3">
              <h2 className="display text-[16px]">Invoices &amp; bills</h2>
              <Link href="/room/invoices" className="press -mr-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-accent hover:bg-accent-soft">Open<Icon name="arrow" size={14} /></Link>
            </div>
            {!g || (g.openInvoiceCount === 0 && g.billsDueSoonCount === 0) ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-ink-soft"><Icon name="check" size={15} className="text-good" />All clear for the next two weeks</p>
            ) : (
              <>
                <p className="mt-3 flex items-baseline gap-2"><span className="display num text-[26px] leading-none">{money(g.openInvoiceMinor, cur)}</span><span className="text-sm text-ink-soft">owed to you</span></p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-accent-soft" role="img" aria-label={`${overduePct}% overdue`}>
                  <div className="h-full bg-danger" style={{ width: `${overduePct}%`, transition: "width var(--dur-slow) var(--ease-out)" }} />
                </div>
                <dl className="mt-3 flex justify-between gap-4 text-sm">
                  <div><dt className="text-ink-soft">Overdue</dt><dd className="num font-medium text-danger">{money(g.overdueMinor, cur)} <span className="font-normal text-ink-soft">· {g.overdueCount}</span></dd></div>
                  <div className="text-right"><dt className="text-ink-soft">Bills due in 2 weeks</dt><dd className="num font-medium">{money(g.billsDueSoonMinor, cur)}</dd></div>
                </dl>
              </>
            )}
          </section>

          <section className="surface rise p-5" style={stagger(3)} aria-label="If customers pay late">
            <h2 className="display text-[16px]">If customers pay late</h2>
            <div role="group" aria-label="How late customers pay" className="seg mt-3">
              {[0, 7, 14, 21, 30].map((d) => <button key={d} type="button" aria-pressed={late === d} className="seg-item" onClick={() => setLate(d)}>{d === 0 ? "On time" : `${d}d`}</button>)}
            </div>
            {!room.downside ? (
              <p className="mt-4 text-sm text-ink-soft">Pick a delay to see it on the chart</p>
            ) : (
              <div className="mt-4">
                <p className="flex items-baseline gap-2"><span className={`display num text-[26px] leading-none ${BigInt(room.downside.minBalanceMinor) < 0n ? "text-danger" : BigInt(room.downside.minBalanceMinor) < BigInt(room.reserveMinor) ? "text-caution" : "text-good"}`}>{money(room.downside.minBalanceMinor, cur)}</span><span className="text-sm text-ink-soft">lowest point</span></p>
                <p className="mt-1.5 text-sm text-ink-soft"><span className="num">{money((BigInt(room.downside.minBalanceMinor) - BigInt(f.minBalanceMinor)).toString(), cur, { signed: true })}</span> against on time · {room.downside.firstNegativeWeek ? <span className="text-danger">below zero from {week(room.downside.firstNegativeWeek)}</span> : "never below zero"}</p>
              </div>
            )}
          </section>
        </div>

        <section className="rise" style={stagger(4)} aria-labelledby="today-details">
          <h2 id="today-details" className="display mb-2 text-[16px]">Details</h2>
          <div className="flat-list">
            {biz && <FinancialHealth biz={biz} cur={cur} busy={busy} latestRunId={latest?.runId ?? null} onPlanSearch={check} />}
            <Link href="/room/analysis" className="row-hover flex items-center justify-between gap-3 border-t border-line px-5 py-3.5"><span><span className="display block text-[15px]">Business analysis</span><span className="block text-sm text-ink-soft">Customers, overdue and runway</span></span><Icon name="arrow" size={16} className="text-ink-soft" /></Link>
            <GapCauses room={room} cur={cur} />
            <ForecastBasis room={room} cur={cur} />
            <CauseDocuments room={room} cur={cur} />
            {roots.length > 0 && (
              <Disclosure title="Recent plans" takeaway={`${roots.length} so far`}>
                <ul className="-my-1 divide-y divide-line">
                  {roots.slice(-5).reverse().map((c: any) => (
                    <li key={c.runId}>
                      <Link href={`/room/case?run=${c.runId}`} className="row-hover -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-sm">
                        <span><span className="block font-medium">{date(c.startedAt)}</span><span className="block text-xs text-ink-soft">{LIFECYCLE[c.lifecycle] ?? String(c.lifecycle).replace(/_/g, " ")}</span></span>
                        <Icon name="arrow" size={14} className="text-ink-soft" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            <Disclosure title="Orders and quotes you have confirmed" takeaway={room.commitments.length === 0 ? "None yet" : `${room.commitments.length} counted in the forecast`}
              right={<Btn variant="secondary" href="/room/commitments">Add an order or quote</Btn>}>
              {room.commitments.length === 0 ? (
                <Empty title="Nothing to plan around yet" action={<Btn href="/room/commitments">Upload a purchase order or quote</Btn>}>Add an order or quote to start.</Empty>
              ) : (
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead><tr><Th>Date</Th><Th>What</Th><Th right>Amount</Th><Th>Confidence</Th></tr></thead>
                  <tbody>
                    {room.commitments.map((c: any) => (
                      <tr key={c.ref} className="row-hover border-t border-line"><td className="whitespace-nowrap py-2 pr-3">{date(c.date)}</td><td className="pr-3">{c.label}</td>
                        <td className={`num pr-3 text-right ${BigInt(c.amountMinor) < 0n ? "text-danger" : "text-good"}`}>{money(c.amountMinor, cur, { signed: true })}</td><td className="text-ink-soft">{c.confidence}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Disclosure>
          </div>
        </section>
      </div>

      {/* ===== RAIL: what needs you ===== */}
      <aside className="rise min-w-0 space-y-6" style={stagger(2)} aria-label="Attention">
        <NextStep />
        <AlertsPanel />
      </aside>
    </div>
  );
}
