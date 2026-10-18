"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Financial flight simulator. Everything on this page is HYPOTHETICAL: the server recomputes the forecast and every strategy on a copy of the
// books; the browser does no money arithmetic and nothing here can sign, send or run anything. Acting on a strategy means going to Plans and
// using the normal shortage check and Review and sign.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Btn, Card, Chip, ErrorNote, Field, Loading, Stat, Th, inputClass, type Tone } from "@/ui/kit";
import { Chart, type Series } from "@/ui/Chart";
import { date, money, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";
import { scenarioSchema } from "@/domain/flight-scenario";

type Ev = { key: number; kind: "customer_late" | "customer_short" | "supplier_refuses" | "unexpected_expense"; cp: string; days: string; pct: string; lever: string; amount: string; dueOn: string; label: string };
let nextKey = 1;
const ev = (p: Partial<Ev>): Ev => ({ key: nextKey++, kind: "customer_late", cp: "", days: "14", pct: "20", lever: "supplier_defer_balance", amount: "", dueOn: "", label: "Unexpected bill", ...p });
const KINDS: [Ev["kind"], string][] = [["customer_late", "A customer pays late"], ["customer_short", "A customer pays less than expected"], ["supplier_refuses", "A supplier refuses"], ["unexpected_expense", "An unexpected bill or expense"]];
const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  resolves: { label: "Resolves it", tone: "good" }, reduces: { label: "Only reduces it", tone: "caution" }, no_help: { label: "Does not help", tone: "neutral" },
  unacceptable: { label: "Unacceptable cost or risk", tone: "danger" }, blocked: { label: "Not available", tone: "danger" },
};
const toShock = (e: Ev) => e.kind === "customer_late" ? { kind: e.kind, counterpartyId: e.cp, days: Number(e.days) }
  : e.kind === "customer_short" ? { kind: e.kind, counterpartyId: e.cp, shortBps: Math.round(Number(e.pct) * 100) }
  : e.kind === "supplier_refuses" ? { kind: e.kind, counterpartyId: e.cp, lever: e.lever }
  : { kind: e.kind, amount: e.amount.trim(), dueOn: e.dueOn, label: e.label.trim() || "Unexpected bill" };

/** What is wrong with an event, in words, before anything is sent. */
function problem(e: Ev, n: number): string | null {
  const at = `Event ${n}: `;
  if (e.kind === "unexpected_expense") {
    if (!/^[0-9][0-9,]*(.[0-9]{1,2})?$/.test(e.amount.trim()) || Number(e.amount.replace(/,/g, "")) <= 0) return `${at}enter the amount of the bill, for example 20000.00.`;
    if (!e.dueOn) return `${at}choose the date it falls due.`;
    return null;
  }
  if (!e.cp) return `${at}choose ${e.kind === "supplier_refuses" ? "a supplier" : "a customer"}.`;
  if (e.kind === "customer_late" && !(Number.isInteger(Number(e.days)) && Number(e.days) >= 1 && Number(e.days) <= 90)) return `${at}days late must be a whole number from 1 to 90.`;
  if (e.kind === "customer_short" && !(Number(e.pct) > 0 && Number(e.pct) <= 100)) return `${at}the shortfall must be more than 0% and at most 100%.`;
  return null;
}

export default function View() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [opts, setOpts] = useState<any>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [name, setName] = useState("My scenario");
  const [res, setRes] = useState<{ report: any; comparison: any } | null>(null);
  const [last, setLast] = useState<{ name: string; shocks: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hand, setHand] = useState<{ id: string; busy: boolean; review?: any; refused?: { reasons: string[]; fallback: string }; ack: boolean; error?: string; done?: { caseUrl: string; unchanged: boolean } } | null>(null);

  const [note, setNote] = useState<string | null>(null);
  const deepLinkDone = useRef(false);

  // A link from the Copilot: ?scenario=<base64url JSON>. It is validated with the SAME schema the simulator's POST uses; an invalid or oversized one is
  // ignored with a plain message. A valid one fills the form and runs once.
  useEffect(() => {
    if (!opts || !biz || deepLinkDone.current) return;
    deepLinkDone.current = true;
    const raw = new URLSearchParams(window.location.search).get("scenario");
    if (!raw) return;
    if (raw.length > 4000) { setNote("The scenario in that link was too large, so it was ignored."); return; }
    try {
      const bytes = Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const parsed = scenarioSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!parsed.success) { setNote("The scenario in that link was not valid, so it was ignored."); return; }
      const sc = parsed.data;
      setEvents(sc.shocks.map((x: any) => ev(x.kind === "customer_late" ? { kind: x.kind, cp: x.counterpartyId, days: String(x.days) }
        : x.kind === "customer_short" ? { kind: x.kind, cp: x.counterpartyId, pct: String(x.shortBps / 100) }
        : x.kind === "supplier_refuses" ? { kind: x.kind, cp: x.counterpartyId, lever: x.lever }
        : { kind: x.kind, amount: x.amount, dueOn: x.dueOn, label: x.label })));
      setName(sc.name ?? "Copilot scenario");
      setNote("Scenario from the Copilot, run once. Change anything and run it again if you like.");
      const sc2 = { name: sc.name ?? "Copilot scenario", shocks: sc.shocks };
      void (async () => {
        setBusy(true); setError(null);
        const r = await call(`/api/business/${biz}/simulate`, { scenario: sc2 });
        setBusy(false);
        if (!r.ok) { setError(r.data?.error ?? "The simulation failed"); return; }
        setRes(r.data); setLast(sc2);
      })();
    } catch { setNote("The scenario in that link could not be read, so it was ignored."); }
  }, [opts, biz]);

  useEffect(() => {
    if (!biz) return;
    call(`/api/business/${biz}/simulate`).then((r) => { if (r.ok) setOpts(r.data); else setError(r.data?.error ?? "Could not load"); });
  }, [biz]);

  if (!opts) return error ? <ErrorNote>{error}</ErrorNote> : <Loading label="Loading the simulator" />;
  const cust = opts.customers as { id: string; name: string }[];
  const sups = opts.suppliers as { id: string; name: string }[];
  const major = opts.majorCustomerId ?? cust[0]?.id ?? "";
  const inDays = (n: number) => new Date(Date.parse(`${opts.asOf}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const PRESETS: { label: string; name: string; events: Ev[] }[] = [
    { label: "Major customer 14 days late", name: "Major customer 14 days late", events: [ev({ kind: "customer_late", cp: major, days: "14" })] },
    { label: "Major customer 21 days late", name: "Major customer 21 days late", events: [ev({ kind: "customer_late", cp: major, days: "21" })] },
    { label: "Customer pays 20% less", name: "Customer pays 20% less", events: [ev({ kind: "customer_short", cp: major, pct: "20" })] },
    { label: "Supplier refuses to defer", name: "Supplier refuses to defer", events: [ev({ kind: "supplier_refuses", cp: sups[0]?.id ?? "", lever: "supplier_defer_balance" })] },
    { label: "Unexpected bill", name: "Unexpected bill", events: [ev({ kind: "unexpected_expense", amount: "20000.00", dueOn: inDays(14), label: "Unexpected bill" })] },
    { label: "Combined crisis: late customer + supplier refuses", name: "Combined crisis", events: [ev({ kind: "customer_late", cp: major, days: "21" }), ev({ kind: "supplier_refuses", cp: sups[0]?.id ?? "", lever: "supplier_defer_balance" })] },
  ];
  const set = (key: number, p: Partial<Ev>) => setEvents((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function run() {
    if (!biz || events.length === 0) return;
    const bad = events.map((e, i) => problem(e, i + 1)).find((p) => p);
    if (bad) { setError(bad); return; }
    await execute({ name, shocks: events.map(toShock) });
  }

  async function execute(scenario: { name: string; shocks: any[] }) {
    if (!biz) return;
    setBusy(true); setError(null);
    const body: any = { scenario };
    if (last && JSON.stringify(last.shocks) !== JSON.stringify(scenario.shocks)) body.compareWith = last;
    const r = await call(`/api/business/${biz}/simulate`, body);
    setBusy(false);
    if (!r.ok) { setError(r.data?.error ?? "The simulation failed"); return; }
    setRes(r.data); setLast(scenario);
  }

  const isOwner = session?.user.role === "owner";
  const handBody = (id: string, extra: object = {}) => ({ simulationId: res?.report.simulationId, scenario: last, strategyId: id, ...extra });
  async function review(id: string) {
    if (!biz || !res || !last) return;
    setHand({ id, busy: true, ack: false });
    const r = await call(`/api/business/${biz}/simulate/handoff`, handBody(id));
    if (!r.ok) { setHand({ id, busy: false, ack: false, error: r.data?.error ?? "Could not check this strategy" }); return; }
    if (r.data.ok === false) setHand({ id, busy: false, ack: false, refused: { reasons: r.data.reasons, fallback: r.data.fallback } });
    else setHand({ id, busy: false, ack: false, review: r.data.review });
  }
  async function addToPlans() {
    if (!biz || !hand?.review) return;
    setHand({ ...hand, busy: true, error: undefined });
    const r = await call(`/api/business/${biz}/simulate/handoff`, handBody(hand.id, { commit: true, acknowledge: hand.ack }));
    if (!r.ok) { setHand({ ...hand, busy: false, error: r.data?.error ?? "The plan was not added" }); return; }
    if (r.data.ok === false) { setHand({ id: hand.id, busy: false, ack: false, refused: { reasons: r.data.reasons, fallback: r.data.fallback } }); return; }
    setHand({ ...hand, busy: false, done: { caseUrl: r.data.caseUrl, unchanged: r.data.unchanged } });
  }
  const report = res?.report;
  const cur = opts.currency;
  const ev2 = report?.evaluation;
  const rec = ev2?.candidates.find((c: any) => c.id === ev2.recommendedId) ?? null;
  const series: Series[] = report ? [
    { key: "live", label: "Today's books (actual)", color: "#2f6f5e", weeks: report.live.weeklyClosing.map((c: string, i: number) => ({ index: i + 1, start: report.live.weekStarts[i], closing: c })) },
    { key: "sim", label: "Scenario, no action (hypothetical)", color: "#be123c", weeks: report.simulated.weeklyClosing.map((c: string, i: number) => ({ index: i + 1, start: report.simulated.weekStarts[i], closing: c })), firstNegativeWeek: report.simulated.firstNegativeWeek, dashed: true },
    ...(rec ? [{ key: "rec", label: "Recommended response (hypothetical)", color: "#6d28d9", weeks: rec.weeklyClosing.map((c: string, i: number) => ({ index: i + 1, start: report.simulated.weekStarts[i], closing: c })) }] : []),
  ] : [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="display text-3xl">Simulator</h1>
        <p className="text-sm text-ink-soft">Try a crisis on a copy of your books before it happens. Nothing here is real: no payment, agreement or approval is created, and your books are not changed.</p>
      </header>

      <Card title="1. Choose what could go wrong" subtitle="Pick a starting point, then change any assumption and run it again.">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => <Btn key={p.label} variant="secondary" onClick={() => { setEvents(p.events); setName(p.name); }}>{p.label}</Btn>)}
          <Btn variant="ghost" onClick={() => setEvents((xs) => [...xs, ev({ cp: major })])}>+ Add an event</Btn>
        </div>
        {events.length > 0 && (
          <div className="mt-4 space-y-3">
            <Field label="Scenario name"><input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
            {events.map((e) => (
              <div key={e.key} className="grid gap-3 rounded-xl border border-line p-3 md:grid-cols-5">
                <Field label="Event"><select className={inputClass} value={e.kind} onChange={(x) => set(e.key, { kind: x.target.value as Ev["kind"], cp: x.target.value === "supplier_refuses" ? (sups[0]?.id ?? "") : (e.cp && cust.some((c) => c.id === e.cp) ? e.cp : major) })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                {e.kind !== "unexpected_expense" && <Field label={e.kind === "supplier_refuses" ? "Supplier" : "Customer"}><select className={inputClass} value={e.cp} onChange={(x) => set(e.key, { cp: x.target.value })}>{(e.kind === "supplier_refuses" ? sups : cust).map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === opts.majorCustomerId ? " (largest)" : ""}</option>)}</select></Field>}
                {e.kind === "customer_late" && <Field label="Days late"><input className={inputClass} inputMode="numeric" value={e.days} onChange={(x) => set(e.key, { days: x.target.value })} /></Field>}
                {e.kind === "customer_short" && <Field label="Pays this % less"><input className={inputClass} inputMode="decimal" value={e.pct} onChange={(x) => set(e.key, { pct: x.target.value })} /></Field>}
                {e.kind === "supplier_refuses" && <Field label="Refuses"><select className={inputClass} value={e.lever} onChange={(x) => set(e.key, { lever: x.target.value })}><option value="supplier_defer_balance">A payment deferral</option><option value="supplier_reduce_deposit">A lower deposit</option><option value="both">Both</option></select></Field>}
                {e.kind === "unexpected_expense" && <>
                  <Field label="What"><input className={inputClass} value={e.label} maxLength={60} onChange={(x) => set(e.key, { label: x.target.value })} /></Field>
                  <Field label={`Amount (${cur})`}><input className={inputClass} inputMode="decimal" value={e.amount} onChange={(x) => set(e.key, { amount: x.target.value })} placeholder="20000.00" /></Field>
                  <Field label="Due on"><input type="date" className={inputClass} value={e.dueOn} min={opts.asOf} onChange={(x) => set(e.key, { dueOn: x.target.value })} /></Field>
                </>}
                <div className="flex items-end"><Btn variant="ghost" onClick={() => setEvents((xs) => xs.filter((x) => x.key !== e.key))}>Remove</Btn></div>
              </div>
            ))}
            <Btn onClick={run} busy={busy}>{last ? "Run again with these assumptions" : "Run the simulation"}</Btn>
          </div>
        )}
        {note && <p className="mt-3 text-sm" role="status">{note}</p>}
        {error && <div className="mt-3" aria-live="polite"><ErrorNote>{error}</ErrorNote></div>}
      </Card>

      {report && (
        <>
          <div role="note" className="rounded-xl border-2 border-dashed border-caution/60 bg-caution-soft p-3 text-sm text-caution">
            <p className="font-semibold">HYPOTHETICAL RESULT · {report.scenario.name} · not verified</p>
            <ul className="mt-1 list-disc pl-5">{report.notices.map((n: string) => <li key={n}>{n}</li>)}</ul>
          </div>

          {res?.comparison && (
            <Card title={`What changed from "${res.comparison.previousName}"`} subtitle="The whole forecast and every strategy were recomputed from scratch with the new assumption." tone={res.comparison.changed ? "accent" : undefined}>
              <ul className="list-disc space-y-1 pl-5 text-sm">{res.comparison.lines.map((l: string) => <li key={l}>{l}</li>)}</ul>
            </Card>
          )}

          <div className="grid gap-3 md:grid-cols-4">
            <Stat label="Lowest balance today (actual)" value={money(report.live.minBalanceMinor, cur)} sub={`${week(report.live.minBalanceWeek)}`} tone={report.live.belowReserve ? "caution" : "good"} />
            <Stat label="Lowest in this scenario" value={money(report.simulated.minBalanceMinor, cur)} sub={`${week(report.simulated.minBalanceWeek)}, week of ${date(report.simulated.minBalanceWeekStart)}`} tone={report.simulated.belowZero ? "danger" : report.simulated.belowReserve ? "caution" : "good"} />
            <Stat label="Shortfall against your cushion" value={money(report.simulated.gapMinor, cur)} sub={`cushion ${money(report.reserveMinor, cur)}`} tone={report.simulated.gapMinor === "0" ? "good" : "danger"} />
            <Stat label="Cushion first breached" value={report.simulated.firstBelowReserveWeek ? week(report.simulated.firstBelowReserveWeek) : "never"} sub={report.simulated.firstNegativeWeek ? `cash runs out in ${week(report.simulated.firstNegativeWeek)}` : "cash stays above zero"} tone={report.simulated.firstBelowReserveWeek ? "danger" : "good"} />
          </div>

          <Card title="What happens, and why" subtitle="Figures are computed by the same forecast engine as your real forecast.">
            <ul className="list-disc space-y-1 pl-5 text-sm">{report.causes.lines.map((l: string) => <li key={l}>{l}</li>)}</ul>
            <details className="mt-3 text-sm"><summary className="cursor-pointer text-accent">What moved in the forecast</summary>
              <ul className="mt-2 space-y-1">{report.causes.changedItems.map((c: any, i: number) => <li key={`${i}-${c.label}`}>{c.label}: {c.before ? `${money(c.before.amountMinor, cur)} on ${date(c.before.date)}` : "not expected"} → {c.after ? `${money(c.after.amountMinor, cur)} on ${date(c.after.date)}` : "gone"}</li>)}</ul>
              <p className="mt-2 text-xs text-ink-soft">Assumed: {report.scenario.assumptions.join(" ")}</p>
            </details>
            <div className="mt-4"><Chart series={series} reserveMinor={report.reserveMinor} currency={cur} /></div>
          </Card>

          <Card title="Strategies compared in this scenario" subtitle="Each one was recomputed with its own timing, fees, repayments, your signed limits and the permission gate. Counterparty acceptance is not guaranteed for any of them.">
            {ev2.candidates.length === 0 ? <p className="text-sm">{ev2.whyPreferred.join(" ")}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead><tr><Th>Strategy</Th><Th>Result</Th><Th right>Lowest balance</Th><Th right>Still short</Th><Th right>Cost</Th><Th right>Borrowed / repaid</Th><Th right>Parties</Th><Th>If customers slip 14 more days</Th></tr></thead>
                  <tbody>
                    <tr className="border-t border-line align-top"><td className="py-2 pr-3 font-medium">Do nothing</td><td><Chip tone={ev2.nothing.outcome === "resolves" ? "good" : "danger"}>{ev2.nothing.outcome === "resolves" ? "No shortage" : "Shortage"}</Chip></td><td className="num px-2 text-right">{money(ev2.nothing.minBalanceMinor, cur)}</td><td className="num px-2 text-right">{money(ev2.nothing.stillShortMinor, cur)}</td><td className="num px-2 text-right">–</td><td className="px-2 text-right">–</td><td className="px-2 text-right">0</td><td className="num px-2">{money(ev2.nothing.stressMinBalanceMinor, cur)}</td></tr>
                    {ev2.candidates.map((c: any) => (
                      <tr key={c.id} className={`border-t border-line align-top ${c.id === ev2.recommendedId ? "bg-accent-soft/40" : ""}`}>
                        <td className="py-2 pr-3"><p className="font-medium">{c.title}{c.id === ev2.recommendedId && <span className="ml-2"><Chip tone="accent">Recommended</Chip></span>}</p>
                          {isOwner && (c.outcome === "resolves" || c.outcome === "reduces") && <Btn variant="secondary" className="mt-1 !px-3 !py-1 text-xs" disabled={hand?.busy} onClick={() => review(c.id)}>Review this strategy in Plans</Btn>}
                          <ul className="text-xs text-ink-soft">{c.leverText.map((t: string) => <li key={t}>{t}</li>)}</ul>
                          <details className="text-xs"><summary className="cursor-pointer text-accent">Why this result · what could go wrong</summary>
                            <ul className="mt-1 list-disc pl-4">{[...c.reasons, ...c.risks].map((t: string) => <li key={t}>{t}</li>)}</ul></details></td>
                        <td className="px-2"><Chip tone={OUTCOME[c.outcome].tone}>{OUTCOME[c.outcome].label}</Chip></td>
                        <td className="num px-2 text-right">{money(c.minBalanceMinor, cur)}</td><td className="num px-2 text-right">{money(c.stillShortMinor, cur)}</td><td className="num px-2 text-right">{money(c.costMinor, cur)}</td>
                        <td className="num px-2 text-right">{c.borrows ? `${money(c.advanceMinor, cur)} / ${money(c.repaymentMinor, cur)}` : "–"}</td><td className="px-2 text-right">{c.counterparties}</td>
                        <td className="num px-2">{money(c.stressMinBalanceMinor, cur)} <span className="text-xs text-ink-soft">{c.holdsUnderStress ? "holds" : "does not hold"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {hand && (
            <Card title="Review this strategy in Plans" subtitle="Nothing is signed, sent or scheduled by this step. It only adds an unsigned proposal to Plans, recalculated on your real books." tone="accent">
              {hand.busy && !hand.review && !hand.refused && <Loading label="Rechecking against your real books" />}
              {hand.error && <ErrorNote>{hand.error}</ErrorNote>}
              {hand.refused && <div className="text-sm"><p className="font-medium">This strategy cannot be taken into Plans.</p><ul className="list-disc pl-5">{hand.refused.reasons.map((r) => <li key={r}>{r}</li>)}</ul><p className="mt-2">{hand.refused.fallback} <Link className="text-accent underline" href="/room/case">Open Plans</Link></p></div>}
              {hand.review && (() => { const rv = hand.review; return (
                <div className="space-y-3 text-sm">
                  <p className="font-medium">{rv.strategy.leverText.join("; ")}</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg border border-line p-3"><p className="text-xs uppercase tracking-wide text-ink-soft">In the simulation (hypothetical)</p><p>Lowest balance {money(rv.simulated.nowStrategyLowestMinor, cur)}; cost {money(rv.simulated.nowCostMinor, cur)}</p></div>
                    <div className="rounded-lg border border-line p-3"><p className="text-xs uppercase tracking-wide text-ink-soft">Recalculated on your real books today</p><p>With these terms: lowest balance {money(rv.realBooks.planLowestMinor, cur)} (week {rv.realBooks.planLowestWeek}); cost {money(rv.realBooks.costMinor, cur)}; {rv.realBooks.keepsCushion ? "keeps" : "does not keep"} your {money(rv.realBooks.reserveMinor, cur)} cushion. Doing nothing: {money(rv.realBooks.doNothingLowestMinor, cur)}.</p></div>
                  </div>
                  {rv.changes.length > 0 && <div><p className="font-medium">What changed since you ran the simulation</p><ul className="list-disc pl-5">{rv.changes.map((c: string) => <li key={c}>{c}</li>)}</ul></div>}
                  {rv.realBooks.warnings.length > 0 && <ul className="list-disc pl-5 text-caution">{rv.realBooks.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul>}
                  <ul className="list-disc pl-5 text-ink-soft">{rv.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
                  {rv.mustAcknowledge.length > 0 && !hand.done && <label className="flex items-start gap-2 rounded-lg bg-caution-soft p-3"><input type="checkbox" className="mt-1" checked={hand.ack} onChange={(e) => setHand({ ...hand, ack: e.target.checked })} /><span>{rv.mustAcknowledge.join(" ")} I have read this.</span></label>}
                  {hand.done ? <p className="rounded-lg bg-good-soft p-3">{hand.done.unchanged ? "This plan was already in Plans. " : "Added to Plans as an unsigned proposal. "}Nothing has been signed, sent or run. <Link className="text-accent underline" href={hand.done.caseUrl}>Open it in Plans to review and sign</Link>.</p>
                    : <div className="flex gap-2"><Btn busy={hand.busy} disabled={rv.mustAcknowledge.length > 0 && !hand.ack} onClick={addToPlans}>Add to Plans as an unsigned proposal</Btn><Btn variant="ghost" onClick={() => setHand(null)}>Cancel</Btn></div>}
                </div>); })()}
            </Card>
          )}

          <Card title={rec ? "Recommended response" : "Recommendation"} tone={rec ? "accent" : undefined}>
            {rec && <p className="mb-2 text-sm font-medium">{rec.leverText.join("; ")}</p>}
            <ul className="list-disc space-y-1 pl-5 text-sm">{ev2.whyPreferred.map((l: string) => <li key={l}>{l}</li>)}</ul>
            {ev2.strategy && (
              <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
                <div><h3 className="font-medium">It relies on</h3><ul className="list-disc pl-5">{ev2.strategy.assumptions.map((l: string) => <li key={l}>{l}</li>)}</ul></div>
                <div><h3 className="font-medium">What could still go wrong</h3><ul className="list-disc pl-5">{[...ev2.strategy.risks, ...(ev2.strategy.ifRefused ?? [])].map((l: string) => <li key={l}>{l}</li>)}</ul></div>
                {((ev2.strategy.known?.length ?? 0) > 0 || (ev2.strategy.untested?.length ?? 0) > 0) && <div className="md:col-span-2"><h3 className="font-medium">What counterparties have said, and what is assumed</h3><ul className="list-disc pl-5">{[...(ev2.strategy.known ?? []), ...(ev2.strategy.untested ?? [])].map((l: string) => <li key={l}>{l}</li>)}</ul></div>}
              </div>
            )}
            <p className="mt-4 rounded-lg bg-neutral-soft p-3 text-sm">This is a simulation. To act on a real shortage, open <Link className="text-accent underline" href="/room/case">Plans</Link>: the planner re-checks your real books, you review and sign, the permission gate and any second approver apply, and only then is anything sent to the sandbox and checked independently.</p>
          </Card>

          <Card title="What this simulation does not cover"><ul className="list-disc space-y-1 pl-5 text-sm">{report.limits.map((l: string) => <li key={l}>{l}</li>)}</ul></Card>
        </>
      )}
    </div>
  );
}
