"use client";

import { useCallback, useEffect, useState } from "react";
import { Chart } from "@/ui/Chart";
import { Btn, Card, Chip, Disclosure, Empty, ErrorNote, Loading, Stat, Th } from "@/ui/kit";
import { date, money, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";
import { CashHeadline, CauseDocuments, ForecastBasis, GapCauses, LedgerGlance, weekWithDates } from "@/ui/rescue";
import { NextStep } from "@/ui/NextStep";
import { Copilot } from "@/ui/Copilot";
import { FinancialHealth } from "@/ui/insights";
import { AlertsPanel } from "@/ui/alerts";
import { BusinessAnalysis } from "@/ui/analysis";

/* eslint-disable @typescript-eslint/no-explicit-any */
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-3xl">Today</h1>
          <p className="text-ink-soft">{date(room.asOf)}. Where your cash is heading over the next 20 weeks, including the orders and quotes you have confirmed.</p>
        </div>
        <Btn variant="secondary" busy={busy} onClick={check}>Re-check my cash</Btn>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* 1. The cash picture: where you stand, and where it is heading */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="In the bank today" value={money(room.balances.sandboxBankMinor, cur)} sub="practice bank, no real money" />
        <Stat label="Your safety cushion" value={money(room.reserveMinor, cur)} sub="you never want to dip below this" />
        <Stat label="Lowest point ahead" value={money(f.minBalanceMinor, cur)} sub={weekWithDates(f.weeks, f.minBalanceWeek)} tone={BigInt(f.minBalanceMinor) < 0n ? "danger" : BigInt(f.minBalanceMinor) < BigInt(room.reserveMinor) ? "caution" : "good"} />
      </div>

      {running && <Card tone="accent" title={<span className="flex items-center gap-2">Your assistant is investigating <Chip tone="accent" pulse>running</Chip></span>}><p className="text-sm text-ink-soft" role="status">It is reading your books and searching for plans. Open Plans to watch it work.</p></Card>}

      <CashHeadline room={room} cur={cur} latestRunId={latest?.runId ?? null} busy={busy} onAsk={check} />

      <Card title="Your cash, week by week" subtitle={room.agreed ? "With the terms you have agreed (solid), against doing nothing (orange dashed) and without the new orders (grey dashed)." : room.commitments.length ? "With your confirmed orders and quotes (solid) and without them (dashed)." : "Your books only. No orders or quotes have been confirmed yet."}>
        <Chart currency={cur} reserveMinor={room.reserveMinor} series={[
          ...(room.commitments.length ? [{ key: "books", label: "Without the new orders and quotes", weeks: room.booksOnly.weeks, color: "#8b958f", dashed: true }] : []),
          ...(room.agreed ? [{ key: "nothing", label: "If you had done nothing", weeks: doNothing.weeks, color: "#b45309", dashed: true, firstNegativeWeek: doNothing.firstNegativeWeek }] : []),
          ...(room.downside ? [{ key: "late", label: `If customers pay ${room.downside.days} days late`, weeks: room.downside.weeks, color: "#7c3aed", dashed: true, firstNegativeWeek: room.downside.firstNegativeWeek }] : []),
          { key: "with", label: room.agreed ? "With your agreed plan" : room.commitments.length ? "With confirmed orders and quotes" : "Your books", weeks: f.weeks, color: "#0d5a50", firstNegativeWeek: neg },
        ]} />
      </Card>

      {/* 2. What needs attention now */}
      <AlertsPanel />

      {/* 3. Ask */}
      {biz && (
        <Card title="Ask Copilot">
          <Copilot />
        </Card>
      )}

      {/* 4. The next step, only when it adds something beyond the alerts */}
      <NextStep />

      {room.commitments.length === 0 && cases.length === 0 && (
        <Card title="How Ledgerhand works" subtitle="Four steps. You stay in charge of every one that matters.">
          <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["1. You add an order or quote", "Paste a customer order or a supplier quote. It is read, and you confirm what it says."],
              ["2. It spots trouble early", "Your cash is projected 20 weeks ahead. If you would run short, it tells you when and why."],
              ["3. It suggests fixes, you choose", "It asks suppliers, customers or lenders for better terms, only inside limits you set."],
              ["4. It acts, then proves it", "Everything is checked separately and written to a record nobody can quietly change."],
            ].map(([t, d]) => <li key={t} className="rounded-xl border border-line bg-paper p-3"><p className="font-medium">{t}</p><p className="mt-1 text-ink-soft">{d}</p></li>)}
          </ol>
        </Card>
      )}

      {/* 5. Details: everything behind the picture, one line each until opened */}
      <section aria-labelledby="today-details" className="space-y-3">
        <h2 id="today-details" className="display text-lg text-ink-soft">Details</h2>
        {biz && <FinancialHealth biz={biz} cur={cur} busy={busy} latestRunId={latest?.runId ?? null} onPlanSearch={check} />}
        <BusinessAnalysis />
        <GapCauses room={room} cur={cur} />
        <ForecastBasis room={room} cur={cur} />
        <CauseDocuments room={room} cur={cur} />
        <LedgerGlance room={room} cur={cur} />
        <Disclosure title="Orders and quotes you have confirmed" takeaway={room.commitments.length === 0 ? "Nothing to plan around yet" : `${room.commitments.length} counted in the forecast`} subtitle="Each one is already counted in the forecast above."
        right={<Btn variant="secondary" href="/room/commitments">Add an order or quote</Btn>}>
        {room.commitments.length === 0 ? (
          <Empty title="Nothing to plan around yet" action={<Btn href="/room/commitments">Upload a purchase order or quote</Btn>}>Your assistant starts when a new order or quote is confirmed, or when the forecast shows a shortage.</Empty>
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr><Th>Date</Th><Th>What</Th><Th right>Amount</Th><Th>Confidence</Th></tr></thead>
            <tbody>
              {room.commitments.map((c: any) => (
                <tr key={c.ref} className="border-t border-line"><td className="py-2 pr-3 whitespace-nowrap">{date(c.date)}</td><td className="pr-3">{c.label}</td>
                  <td className={`num pr-3 text-right ${BigInt(c.amountMinor) < 0n ? "text-danger" : "text-good"}`}>{money(c.amountMinor, cur, { signed: true })}</td><td className="text-ink-soft">{c.confidence}</td></tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Disclosure>
        <Disclosure title="What if customers pay late?" takeaway={room.downside ? `If customers pay ${room.downside.days} days late, your lowest point is ${money(room.downside.minBalanceMinor, cur)}` : "See how much a late payer would hurt"} subtitle="Customers often pay later than their terms. See how much that would hurt."
        right={<label className="flex items-center gap-2 text-sm"><span className="text-ink-soft">Customers pay</span>
          <select aria-label="How late customers pay" className="rounded-lg border border-line-strong bg-white px-2 py-1.5 text-sm" value={late} onChange={(e) => setLate(Number(e.target.value))}>
            <option value={0}>on time</option>{[7, 14, 21, 30].map((d) => <option key={d} value={d}>{d} days late</option>)}
          </select></label>}>
        {!room.downside ? <p className="text-sm text-ink-soft">Pick a delay to add a line to the chart above and see your lowest point.</p> : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Lowest point" value={money(room.downside.minBalanceMinor, cur)} sub={`${week(room.downside.minBalanceWeek)} · ${money((BigInt(room.downside.minBalanceMinor) - BigInt(f.minBalanceMinor)).toString(), cur, { signed: true })} against on time`} tone={BigInt(room.downside.minBalanceMinor) < 0n ? "danger" : BigInt(room.downside.minBalanceMinor) < BigInt(room.reserveMinor) ? "caution" : "good"} />
            <Stat label="First below zero" value={week(room.downside.firstNegativeWeek)} tone={room.downside.firstNegativeWeek ? "danger" : "good"} />
            <Stat label="Weeks below zero" value={room.downside.weeksBelowZero} tone={room.downside.weeksBelowZero ? "danger" : "good"} />
            <Stat label="Closing balance" value={money(room.downside.closingMinor, cur)} />
          </div>
        )}
      </Disclosure>
      </section>
    </div>
  );
}
