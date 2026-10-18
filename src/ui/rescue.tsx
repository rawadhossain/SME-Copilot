"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Rescue My Cash Flow, questions 1 and 2: "What is happening to my cash?" and "Why, and how urgent is it?"
// Presentational only. Every figure arrives from the engine through /api/business/[id]/room; nothing is calculated or worded by a model here.
import Link from "next/link";
import { useState } from "react";
import { Btn, Card, Chip, Disclosure, ErrorNote, Th, inputClass } from "./kit";
import { call } from "./session";
import { date, money, week } from "./format";
import { outcomeVerdict } from "./outcome";
import { ASK_SUGGESTED_QUESTIONS } from "@/lib/ask-suggestions";

const KIND_LABEL: Record<string, [string, string]> = {
  actual: ["In the bank", "A real balance."],
  confirmed: ["Confirmed", "Invoices and bills paid on their due dates."],
  estimate: ["Expected", "Money you are owed, moved to when the customer usually pays."],
  assumption: ["Planned", "Your confirmed orders and quotes (and any what-if you chose)."],
};

/** Link to one invoice or bill on the Invoices & bills page. */
export const docHref = (d: { kind: string; id: string }) => `/room/invoices?${d.kind === "bill" ? "tab=bills&" : ""}focus=${d.id}`;

/** "week 5 (3 to 9 Nov)": the week number with the dates it covers, from the forecast's own week table. */
export function weekWithDates(weeks: any[] | undefined, n: number | null | undefined): string {
  if (n === null || n === undefined) return "none";
  const w = weeks?.find((x) => x.index === n);
  return w ? `${week(n)} (${date(w.start)} to ${date(w.end)})` : week(n);
}

function pictureOf(room: any) {
  const f = room.agreed ?? room.forecast;
  const sh = room.shortage;
  const reason = sh.reason;
  const below0 = reason?.kind === "below_zero";
  const tone: "danger" | "caution" | "good" = sh.shortage ? (below0 ? "danger" : "caution") : "good";
  const drivers: any[] = room.drivers ?? [];
  const when = weekWithDates(f.weeks, reason?.minBalanceWeek ?? f.minBalanceWeek);
  return { f, sh, reason, below0, tone, drivers, when };
}

/** The verdict: are you heading for a shortage, in one card. */
export function CashHeadline({ room, cur, latestRunId, busy, onAsk }: { room: any; cur: string; latestRunId: string | null; busy: boolean; onAsk: () => void }) {
  const { f, sh, reason, below0, tone, when } = pictureOf(room);
  return (
      <Card tone={tone} title={
        <span className="flex flex-wrap items-center gap-2" role="status">
          {sh.shortage ? (below0 ? "You are heading for a cash shortage" : "You are heading below your safety cushion") : `No shortage in the next ${room.horizonWeeks} weeks`}
          <Chip tone={tone}>{sh.shortage ? (below0 ? "Urgent: cash runs out" : "Watch: below cushion") : "On track"}</Chip>
        </span>}
        right={sh.shortage ? (latestRunId ? <Btn href={`/room/case?run=${latestRunId}`}>See my options</Btn> : <Btn onClick={onAsk} busy={busy}>Find me options</Btn>) : undefined}>
        {sh.shortage ? (
          <>
            <p className="text-sm">
              Your cash is lowest in <b>{when}</b>, at <b className="num">{money(reason.minBalanceMinor, cur)}</b>.
              {reason.firstNegativeWeek && <> It first goes below zero in <b>{weekWithDates(f.weeks, reason.firstNegativeWeek)}</b>.</>}
              {" "}That is <b className="num">{money(reason.shortfallMinor, cur)}</b> short of your safety cushion of <span className="num">{money(room.reserveMinor, cur)}</span>.
            </p>
            <p className="mt-2 text-xs text-ink-soft">Worked out by fixed code from your own records. It is a forecast, not a promise: part of it rests on expected dates, shown below. Nothing happens until you approve it.</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">Your projected balance stays above your safety cushion. Lowest point: <b className="num">{money(f.minBalanceMinor, cur)}</b> in {when}. {room.commitments.length === 0 ? "Add a purchase order or a supplier quote and the check runs again." : ""}</p>
        )}
      </Card>
  );
}

/** The causes of the gap (only when there is one), as a disclosure. */
export function GapCauses({ room, cur }: { room: any; cur: string }) {
  const { sh, drivers } = pictureOf(room);
  return (
    <>
      {sh.shortage && (
        <Disclosure title="Why this is happening" takeaway={drivers[0] ? `Biggest cause: ${drivers[0].label}` : "No single cause stands out"} subtitle="Each cause taken out on its own: how much higher your lowest point would be without it. Causes can overlap, so they need not add up.">
          {drivers.length === 0 ? <p className="text-sm text-ink-soft">{(room.causeDocuments ?? []).length > 0 ? "No single order or late payer explains it. The gap comes from the invoices and bills listed below." : "No single cause stands out. The gap comes from the balance of all payments in and out."}</p> : (
            <ul className="divide-y divide-line text-sm">
              {drivers.map((d: any) => (
                <li key={d.label} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2">
                  <div>
                    <p className="font-medium">{d.label}</p>
                    <p className="text-xs text-ink-soft">
                      {d.kind === "event" && d.date && <>From your orders and agreed terms, {date(d.date)}, <span className="num">{money(d.amountMinor, cur, { signed: true })}</span> · {d.confidence} confidence</>}
                      {d.kind === "counterparty_delay" && <>From the payment history on {d.invoiceCount} invoice{d.invoiceCount === 1 ? "" : "s"}: they usually pay after the due date, so the forecast expects the money later.</>}
                      {d.kind === "downside_delay" && <>A what-if assumption you chose, not a fact.</>}
                    </p>
                    {(d.documents ?? []).length > 0 && <p className="mt-1 text-xs">Open: {d.documents.map((x: any, i: number) => <span key={x.id}>{i > 0 && ", "}<Link href={docHref(x)} className="text-accent underline">Invoice {x.number}</Link></span>)}</p>}
                  </div>
                  <p className="num text-right font-medium text-good">+{money(d.effectMinor, cur)}</p>
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      )}
    </>
  );
}

/** The biggest invoices and bills counted before the lowest point (only when there is a gap), as a disclosure. */
export function CauseDocuments({ room, cur }: { room: any; cur: string }) {
  const { sh } = pictureOf(room);
  return (
    <>
      {sh.shortage && (room.causeDocuments ?? []).length > 0 && (
        <Disclosure title="Invoices and bills behind this" takeaway={`${room.causeDocuments.length} item${room.causeDocuments.length === 1 ? "" : "s"} counted before your lowest point`} subtitle={`The biggest invoices and bills counted before your lowest point. Open one to see its payments, or to record a payment you have already received or made.`}>
          <ul className="divide-y divide-line text-sm">
            {room.causeDocuments.map((it: any) => (
              <li key={it.document.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span>{date(it.date)} · <Link href={docHref(it.document)} className="text-accent underline">{it.label}</Link> <Chip tone={it.kind === "estimate" || it.kind === "assumption" ? "caution" : "neutral"}>{KIND_LABEL[it.kind]?.[0] ?? it.kind}</Chip></span>
                <span className={`num ${BigInt(it.amountMinor) < 0n ? "text-danger" : "text-good"}`}>{money(it.amountMinor, cur, { signed: true })}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </>
  );
}

export function CashPicture({ room, cur, latestRunId, busy, onAsk }: { room: any; cur: string; latestRunId: string | null; busy: boolean; onAsk: () => void }) {
  return (
    <div className="space-y-6">
      <CashHeadline room={room} cur={cur} latestRunId={latestRunId} busy={busy} onAsk={onAsk} />
      <GapCauses room={room} cur={cur} />
      <CauseDocuments room={room} cur={cur} />
      <LedgerGlance room={room} cur={cur} />
      <ForecastBasis room={room} cur={cur} />
    </div>
  );
}

/** Overdue invoices and bills due soon, with a link to the full list. */
export function LedgerGlance({ room, cur }: { room: any; cur: string }) {
  const g = room.ledger;
  if (!g) return null;
  const empty = g.openInvoiceCount === 0 && g.billsDueSoonCount === 0;
  return (
    <Disclosure title="Invoices and bills" takeaway={empty ? "Nothing unpaid and nothing due soon" : `${money(g.openInvoiceMinor, cur)} owed to you${g.overdueCount > 0 ? `, ${g.overdueCount} overdue` : ""}; ${money(g.billsDueSoonMinor, cur)} in bills due soon`} subtitle="What customers still owe you and what you owe suppliers. The forecast uses these records." right={<Btn variant="secondary" href="/room/invoices">Open invoices & bills</Btn>}>
      {empty ? <p className="text-sm text-ink-soft">No unpaid invoices and no bills due in the next two weeks.</p> : (
        <ul className="space-y-1 text-sm">
          <li><b className="num">{money(g.openInvoiceMinor, cur)}</b> owed to you across {g.openInvoiceCount} invoice{g.openInvoiceCount === 1 ? "" : "s"}{g.overdueCount > 0 && <>, of which <b className="num text-danger">{money(g.overdueMinor, cur)}</b> is overdue ({g.overdueCount})</>}.</li>
          <li><b className="num">{money(g.billsDueSoonMinor, cur)}</b> in {g.billsDueSoonCount} bill{g.billsDueSoonCount === 1 ? "" : "s"} due within two weeks.</li>
        </ul>
      )}
    </Disclosure>
  );
}

/** How firm is the forecast: one plain line, what is missing, and the build-up behind a disclosure. */
export function ForecastBasis({ room, cur }: { room: any; cur: string }) {
  const basis = room.basis;
  const gaps: string[] = room.gaps ?? [];
  const notes: string[] = room.notes ?? [];
  if (!basis) return null;
  const items: any[] = basis.lowestWeekItems ?? [];
  const rows: any[] = basis.rows.filter((r: any) => r.count > 0);
  const summary = rows.map((r) => `${r.count} ${KIND_LABEL[r.kind][0].toLowerCase()}`).join(", ");
  return (
    <Disclosure title="How sure is this forecast?" takeaway={gaps.length === 0 ? "Nothing is missing" : `${gaps.length} thing${gaps.length === 1 ? "" : "s"} to check`} subtitle={`Up to the lowest point (${week(basis.throughWeek)}) it counts ${summary} item${rows.reduce((n, r) => n + r.count, 0) === 1 ? "" : "s"}. It is a forecast, not a promise.`}
      chip={gaps.length === 0 ? <Chip tone="good">nothing missing</Chip> : <Chip tone="caution">{gaps.length} to check</Chip>}>
      {(gaps.length > 0 || notes.length > 0) && <ul className="space-y-1 text-sm">{[...gaps, ...notes].map((g) => <li key={g} className="flex gap-2"><span aria-hidden>▲</span><span>{g}</span></li>)}</ul>}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-accent">See what it is built from</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="sr-only">Cash in and out before the lowest point, by how certain it is</caption>
            <thead><tr><Th>Kind</Th><Th right>Money in</Th><Th right>Money out</Th><Th right>Items</Th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.kind} className="border-t border-line align-top">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">{KIND_LABEL[r.kind][0]}<span className="block text-xs font-normal text-ink-soft">{KIND_LABEL[r.kind][1]}</span></th>
                  <td className="num py-2 pr-3 text-right text-good">{money(r.inMinor, cur)}</td><td className="num py-2 pr-3 text-right text-danger">{money(r.outMinor, cur)}</td><td className="num py-2 text-right">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length > 0 && (
          <>
            <h3 className="mt-3 text-sm font-medium">The biggest items in the lowest week</h3>
            <ul className="mt-1 divide-y divide-line text-sm">
              {items.map((it, i) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>{date(it.date)} · {it.document ? <Link href={docHref(it.document)} className="text-accent underline">{it.label}</Link> : it.label} <Chip tone={it.kind === "estimate" || it.kind === "assumption" ? "caution" : "neutral"}>{KIND_LABEL[it.kind]?.[0] ?? it.kind}</Chip></span>
                  <span className={`num ${BigInt(it.amountMinor) < 0n ? "text-danger" : "text-good"}`}>{money(it.amountMinor, cur, { signed: true })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </Disclosure>
  );
}

// ---------------------------------------------------------------- question 5: has it worked, and can I verify it?

/** The final summary of one executed authorisation. It separates what was attempted, what ran, and what the independent check confirmed. */
export function OutcomeSummary({ auth, reason, doNothing, agreed, reserveMinor, cur, exportBase }: { auth: any; reason: any; doNothing: any; agreed: any; reserveMinor: string | null; cur: string; exportBase: string }) {
  const ex = auth.execution;
  const { attempted, executed, verified, failed, verifiedOk, keeps, achieved } = outcomeVerdict(auth, agreed, reserveMinor);
  const rolledBack = (ex?.outcome?.compensated?.length ?? 0) > 0;
  const branches: any[] = ex?.outcome?.branches ?? [];
  const risks: string[] = [];
  if (!verifiedOk) risks.push(ex?.status === "verification_failed" ? "The independent check found a mismatch between the practice bank and the agreed terms. Treat the plan as not confirmed." : "The independent check has not confirmed this plan.");
  if (failed > 0) risks.push(`${failed} action${failed === 1 ? "" : "s"} failed or ${failed === 1 ? "was" : "were"} stopped by your limits.`);
  if (rolledBack) risks.push(ex.outcome.compensated.every((c: any) => c.ok) ? "Agreements were withdrawn (rolled back) because the plan could not complete." : "A withdrawal failed during roll-back. See the records before relying on the outcome.");
  if (keeps === false) risks.push(`Even with the agreed terms, cash stays below your safety cushion by ${money((BigInt(reserveMinor!) - BigInt(agreed.minBalanceMinor)).toString(), cur)}.`);
  const open = branches.filter((b) => ["needs_replan", "pending", "failed"].includes(b.status) && !b.withdrawn).length;
  if (open > 0) risks.push(`${open} request${open === 1 ? " is" : "s are"} still unanswered or refused.`);
  if (verifiedOk) risks.push("Payments stay scheduled in the practice bank until its end-of-day job, so the plan can still be withdrawn until then.");
  const head = achieved ? "It worked, and an independent check confirms it." : verifiedOk ? "Carried out and checked, but the goal is only partly met." : "Not confirmed. Do not treat this as fixed.";
  const tone = achieved ? "good" : verifiedOk ? "caution" : "danger";
  return (
    <Card tone={tone} title={<span role="status" className="flex flex-wrap items-center gap-2">{head}<Chip tone={tone}>{achieved ? "verified" : verifiedOk ? "verified, partly met" : "not verified"}</Chip></span>}
      subtitle="The outcome, taken from what the practice bank holds and the separate check, not from what the assistant reported.">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <section aria-label="The original problem"><h3 className="font-medium">The problem</h3>
          <p className="text-ink-soft">{reason ? <>Lowest balance <b className="num">{money(reason.minBalanceMinor, cur)}</b> in {week(reason.minBalanceWeek)}{reason.firstNegativeWeek ? `, below zero from ${week(reason.firstNegativeWeek)}` : ""}.</> : doNothing ? <>Doing nothing would leave your lowest balance at <b className="num">{money(doNothing.minBalanceMinor, cur)}</b> in {week(doNothing.minBalanceWeek)}.</> : "A new order or quote started this case."}</p></section>
        <section aria-label="The result"><h3 className="font-medium">The result</h3>
          <p className="text-ink-soft">{agreed && doNothing ? <>Lowest balance moves from <b className="num">{money(doNothing.minBalanceMinor, cur)}</b> (doing nothing) to <b className="num">{money(agreed.minBalanceMinor, cur)}</b> with the terms actually agreed. {keeps === true ? "Your safety cushion is kept." : keeps === false ? "Your safety cushion is not fully restored." : ""}</> : "The agreed terms are not available yet."}</p></section>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["Attempted", attempted, "actions started"], ["Executed", executed, rolledBack ? "ran, then were withdrawn" : "ran in the practice bank"], ["Verified", verified, "confirmed by the separate check"], ["Failed or stopped", failed, "did not complete"]] as const).map(([k, n, sub]) => (
          <div key={k} className="rounded-xl border border-line bg-white/70 p-3"><dt className="text-xs uppercase tracking-wide text-ink-soft">{k}</dt><dd className="display num text-2xl">{n}</dd><dd className="text-xs text-ink-soft">{sub}</dd></div>
        ))}
      </dl>
      {risks.length > 0 && <div className="mt-3"><h3 className="text-sm font-medium">Still to keep in mind</h3><ul className="mt-1 space-y-1 text-sm">{risks.map((r) => <li key={r} className="flex gap-2"><span aria-hidden>▲</span><span>{r}</span></li>)}</ul></div>}
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <a className="rounded-lg border border-line-strong bg-panel px-3 py-2 font-medium text-accent hover:bg-neutral-soft" href={`${exportBase}?format=html`} download>Download the evidence (readable)</a>
        <a className="rounded-lg border border-line-strong bg-panel px-3 py-2 font-medium text-accent hover:bg-neutral-soft" href={`${exportBase}?format=json`} download>Evidence data (JSON)</a>
        <Btn variant="ghost" href="/room/safety?tab=records">Read the audit trail</Btn>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- "Ask about my cash"

const SUGGESTED = ASK_SUGGESTED_QUESTIONS;

/** A small contextual assistant. It reads facts computed by the engine and cannot sign, approve, pay or send: those only happen through Review and sign. */
export function AskCash({ biz }: { biz: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(text: string) {
    if (!text.trim()) return;
    setBusy(true); setErr(null); setQ(text);
    const r = await call(`/api/business/${biz}/ask`, { question: text });
    setBusy(false);
    if (!r.ok) { setErr(r.data?.error ?? "Could not answer that. Please try again."); return; }
    if (!r.data.ok) { setErr(r.data.error); return; }
    setRes(r.data);
  }
  return (
    <Card title="Ask about your cash" subtitle="Answers come from your own records and the same calculations as the screens above. This box cannot sign, approve, pay or send anything.">
      <form onSubmit={(e) => { e.preventDefault(); void go(q); }} className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="ask-cash">Your question</label>
        <input id="ask-cash" className={`${inputClass} flex-1`} maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example: why am I running short of cash?" />
        <Btn type="submit" busy={busy} disabled={!q.trim()}>Ask</Btn>
      </form>
      <div className="mt-2 flex flex-wrap gap-2" aria-label="Suggested questions">
        {SUGGESTED.map((s) => <button key={s} type="button" disabled={busy} onClick={() => void go(s)} className="rounded-full border border-line-strong bg-panel px-3 py-1 text-xs text-ink-soft hover:bg-neutral-soft disabled:opacity-50">{s}</button>)}
      </div>
      <div aria-live="polite" className="mt-3">
        {err && <ErrorNote>{err}</ErrorNote>}
        {res && (
          <div className="rounded-xl border border-line bg-white/70 p-4 text-sm">
            <p>{res.answer}</p>
            {res.unsupported && <p className="mt-2 text-xs text-caution">▲ {res.unsupported}</p>}
            {res.details?.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-xs text-accent">The figures behind this answer</summary><ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-soft">{res.details.map((d: string) => <li key={d}>{d}</li>)}</ul></details>}
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">See: {res.evidence.map((e: any) => <Link key={e.href} className="text-accent underline" href={e.href}>{e.label}</Link>)}</p>
            <p className="mt-2 text-xs text-ink-soft">{res.source === "model" ? "Worded by the assistant from these facts; every amount in it was checked against them." : "Answered directly from your records (no AI wording)."} Forecasts are estimates, not promises.</p>
          </div>
        )}
      </div>
    </Card>
  );
}
