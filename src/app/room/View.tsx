"use client";

import { useCallback, useEffect, useState } from "react";
import { Chart } from "@/ui/Chart";
import { Btn, Card, Chip, Empty, ErrorNote, Loading, Stat, Th } from "@/ui/kit";
import { date, money, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function CashDesk() {
  const { session } = useSession();
  const biz = session?.business.id;
  const cur = session?.business.currency ?? "GBP";
  const [room, setRoom] = useState<any>(null);
  const [cases, setCases] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!biz) return;
    const [r, c] = await Promise.all([call(`/api/business/${biz}/room`), call(`/api/business/${biz}/cases`)]);
    if (r.ok) setRoom(r.data); else setError(r.data.error ?? "Could not load the cash desk");
    if (c.ok) setCases(c.data);
  }, [biz]);
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
  const f = room.forecast;
  const sh = room.shortage;
  const roots = cases.filter((c) => !c.parentRunId);
  const latest = roots.filter((c) => c.lifecycle !== "superseded").at(-1) ?? roots.at(-1);
  const running = cases.find((c) => c.status === "running");
  const neg = f.firstNegativeWeek;
  const tone = sh.shortage ? (sh.reason.kind === "below_zero" ? "danger" : "caution") : "good";

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="In the bank today" value={money(room.balances.sandboxBankMinor, cur)} sub="practice bank, no real money" />
        <Stat label="In your books" value={money(room.balances.booksMinor, cur)} sub="where the forecast starts" />
        <Stat label="Your safety cushion" value={money(room.reserveMinor, cur)} sub="you never want to dip below this" />
        <Stat label="Lowest point ahead" value={money(f.minBalanceMinor, cur)} sub={`${week(f.minBalanceWeek)}${neg ? ` · first below zero: ${week(neg)}` : ""}`} tone={BigInt(f.minBalanceMinor) < 0n ? "danger" : BigInt(f.minBalanceMinor) < BigInt(room.reserveMinor) ? "caution" : "good"} />
      </div>

      {running && <Card tone="accent" title={<span className="flex items-center gap-2">The agent is investigating <Chip tone="accent" pulse>running</Chip></span>}><p className="text-sm text-ink-soft">It is reading your books and searching for plans. Open Decisions to watch it work.</p></Card>}

      {sh.shortage ? (
        <Card tone={tone} title={<span className="flex flex-wrap items-center gap-2">{sh.reason.kind === "below_zero" ? "Heads up: you would run out of cash" : "Heads up: you would dip below your safety cushion"} <Chip tone={tone}>{sh.reason.kind === "below_zero" ? "below zero" : "below cushion"}</Chip></span>}
          right={latest ? <Btn href={`/room/case?run=${latest.runId}`}>See the options</Btn> : <Btn onClick={check} busy={busy}>Ask the agent for options</Btn>}>
          <p className="text-sm">
            Lowest balance <b className="num">{money(sh.reason.minBalanceMinor, cur)}</b> in {week(sh.reason.minBalanceWeek)}.
            {sh.reason.firstNegativeWeek && <> First below zero in {week(sh.reason.firstNegativeWeek)}.</>} You would be short of your cushion by <b className="num">{money(sh.reason.shortfallMinor, cur)}</b>.
          </p>
          <p className="mt-1 text-xs text-ink-soft">Found by a fixed calculation on your numbers, not by the AI. The agent can only suggest; nothing happens until you approve.</p>
        </Card>
      ) : (
        <Card tone="good" title={<span className="flex items-center gap-2">No shortage in the next 20 weeks <Chip tone="good">healthy</Chip></span>}>
          <p className="text-sm text-ink-soft">Your projected balance stays above your reserve. {room.commitments.length === 0 ? "Add a purchase order or a supplier quote and the check runs again." : ""}</p>
        </Card>
      )}

      {sh.shortage && room.drivers?.length > 0 && (
        <Card title="What is causing the gap" subtitle="Each item taken out on its own, and how much higher your lowest point would be without it.">
          <ul className="divide-y divide-line text-sm">
            {room.drivers.map((d: any) => (
              <li key={d.label} className="flex items-center justify-between gap-3 py-2"><span>{d.label}</span><span className="num font-medium text-good">+{money(d.effectMinor, cur)}</span></li>
            ))}
          </ul>
        </Card>
      )}
      {room.commitments.length === 0 && cases.length === 0 && (
        <Card title="How Ledgerhand works" subtitle="Four steps. You stay in charge of every one that matters.">
          <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["1. You add an order or quote", "Drop in a customer order or supplier quote. It is read, and you confirm what it says."],
              ["2. It spots trouble early", "Your cash is projected 20 weeks ahead. If you would run short, it tells you when and why."],
              ["3. It suggests fixes, you choose", "It negotiates only inside limits you set: for example, delay a supplier payment or ask a customer for a deposit."],
              ["4. It acts, then proves it", "Everything is checked by a separate verifier and written to a tamper-evident log you can export."],
            ].map(([t, d]) => <li key={t} className="rounded-xl border border-line bg-paper p-3"><p className="font-medium">{t}</p><p className="mt-1 text-ink-soft">{d}</p></li>)}
          </ol>
        </Card>
      )}

      <Card title="Your cash, week by week" subtitle={room.commitments.length ? "With your confirmed commitments (solid) and without them (dashed)." : "Your books only. No commitments have been confirmed yet."}>
        <Chart currency={cur} reserveMinor={room.reserveMinor} series={[
          ...(room.commitments.length ? [{ key: "books", label: "Without the new commitments", weeks: room.booksOnly.weeks, color: "#8b958f", dashed: true }] : []),
          { key: "with", label: room.commitments.length ? "With confirmed commitments (do nothing)" : "Do nothing", weeks: f.weeks, color: "#0d5a50", firstNegativeWeek: neg },
        ]} />
      </Card>

      <Card title="Orders and quotes you have confirmed" subtitle="Each one is already counted in the forecast above."
        right={<Btn variant="secondary" href="/room/commitments">Add an order or quote</Btn>}>
        {room.commitments.length === 0 ? (
          <Empty title="Nothing to plan around yet" action={<Btn href="/room/commitments">Upload a purchase order or quote</Btn>}>The agent starts when a new commitment is confirmed, or when the forecast shows a shortage.</Empty>
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
      </Card>
    </div>
  );
}
