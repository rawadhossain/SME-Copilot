"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Invoices & bills: what customers owe the business and what it owes suppliers, with partial payments and a payment history.
// The browser does no money arithmetic: amounts go to the server as typed, and every figure shown comes back from the server's code.
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, Chip, Empty, ErrorNote, Field, Loading, Stat, Th, inputClass, type Tone } from "@/ui/kit";
import { date, money } from "@/ui/format";
import { call, useSession } from "@/ui/session";

type Kind = "invoice" | "bill";
const SEG: Record<Kind, string> = { invoice: "invoices", bill: "bills" };
const STATE: Record<string, [string, Tone]> = {
  open: ["Open", "neutral"], partial: ["Part paid", "caution"], overdue: ["Overdue", "danger"], partial_overdue: ["Part paid, overdue", "danger"],
  paid: ["Paid", "good"], draft: ["Draft", "neutral"], void: ["Void", "neutral"],
};
const FILTERS: [string, string][] = [["open", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["all", "All"]];
const isOpen = (s: string) => ["open", "partial", "overdue", "partial_overdue"].includes(s);
const matches = (f: string, s: string) => (f === "all" ? true : f === "open" ? isOpen(s) || s === "draft" : f === "overdue" ? s === "overdue" || s === "partial_overdue" : s === "paid");
const todayIso = () => new Date().toISOString().slice(0, 10);
/** A minor-unit string as the decimal text a person types (2 decimal places; the server is the one that converts). */
const asTyped = (minor: string) => { const n = BigInt(minor); const s = (n < 0n ? -n : n).toString().padStart(3, "0"); return `${n < 0n ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`; };

export default function View() {
  const { session } = useSession();
  const biz = session?.business.id;
  const isOwner = session?.user.role === "owner";
  const cur = session?.business.currency ?? "GBP";
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("invoice");
  const [filter, setFilter] = useState("open");
  const [focus, setFocus] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/ledger`);
    if (r.ok) setData(r.data); else setErr(r.data?.error ?? "Could not load invoices and bills");
  }, [biz]);
  useEffect(() => { void load(); }, [load]);
  // A link from Today can open a particular record: ?tab=bills&focus=<id>.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "bills") setKind("bill");
    const f = q.get("focus");
    if (f) { setFocus(f); setFilter("all"); }
  }, []);

  if (!session) return null;
  if (err && !data) return <ErrorNote>{err}</ErrorNote>;
  if (!data) return <Loading label="Loading invoices and bills" />;

  const rows: any[] = (kind === "invoice" ? data.invoices : data.bills).filter((d: any) => matches(filter, d.state) || d.id === focus);
  const sum = kind === "invoice" ? data.summary.receivable : data.summary.payable;
  const who = kind === "invoice" ? "customer" : "supplier";
  const bankMatches: any[] = data.bankMatches.filter((m: any) => m.docKind === kind);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-3xl">Invoices & bills</h1>
          <p className="text-sm text-ink-soft">Record what customers owe you and what you owe suppliers. The cash forecast, the shortage check and the assistant all use these records, as of {date(data.asOf)}.</p>
        </div>
        {isOwner && <Btn onClick={() => setAdding((a) => !a)}>{adding ? "Close" : `Add ${kind === "invoice" ? "an invoice" : "a bill"}`}</Btn>}
      </div>

      <div role="tablist" aria-label="Invoices or bills" className="flex gap-1 border-b border-line">
        {(["invoice", "bill"] as Kind[]).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setAdding(false); }} className={`border-b-2 px-4 py-2 text-sm font-medium ${kind === k ? "border-accent text-accent" : "border-transparent text-ink-soft hover:text-ink"}`}>
            {k === "invoice" ? "Invoices (owed to you)" : "Bills (you owe)"}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={kind === "invoice" ? "Still owed to you" : "Still to pay"} value={money(sum.outstandingMinor, cur)} sub={`${sum.openCount} unpaid${sum.partlyPaidCount ? `, ${sum.partlyPaidCount} part paid` : ""}`} />
        <Stat label="Overdue" value={money(sum.overdueMinor, cur)} sub={`${sum.overdueCount} ${kind === "invoice" ? "invoice" : "bill"}${sum.overdueCount === 1 ? "" : "s"}`} tone={sum.overdueCount > 0 ? "danger" : undefined} />
        <Stat label="Due in 7 days" value={money(sum.dueIn7Minor, cur)} sub={`${money(sum.dueIn30Minor, cur)} in 30 days`} />
        <Stat label="Counted in the forecast" value={money(sum.inForecastMinor, cur)} sub={`next ${data.horizonWeeks} weeks${sum.countedElsewhereCount ? `; ${sum.countedElsewhereCount} counted elsewhere` : ""}`} />
      </div>

      {bankMatches.length > 0 && isOwner && <BankMatches matches={bankMatches} biz={biz!} cur={cur} onDone={load} />}
      {adding && isOwner && <AddForm kind={kind} biz={biz!} cps={data.counterparties.filter((c: any) => c.role === who)} cur={cur} onDone={() => { setAdding(false); void load(); }} />}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
        {FILTERS.map(([k, label]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1 text-sm ${filter === k ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-ink-soft"}`}>{label}</button>)}
      </div>

      {rows.length === 0 ? (
        <Empty title={`No ${kind === "invoice" ? "invoices" : "bills"} here`}>{filter === "open" ? `Nothing unpaid. ${isOwner ? `Add ${kind === "invoice" ? "an invoice" : "a bill"} and the forecast picks it up.` : ""}` : "Nothing matches this view."}</Empty>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">{kind === "invoice" ? "Invoices" : "Bills"}</caption>
              <thead><tr><Th>{kind === "invoice" ? "Invoice" : "Bill"}</Th><Th>{kind === "invoice" ? "Customer" : "Supplier"}</Th><Th>Due</Th><Th right>Amount</Th><Th right>Paid</Th><Th right>Still owed</Th><Th>Status</Th><Th>In forecast</Th></tr></thead>
              <tbody>
                {rows.map((d) => <Row key={d.id} d={d} biz={biz!} cur={cur} owner={!!isOwner} open={focus === d.id} onToggle={() => setFocus(focus === d.id ? null : d.id)} onChange={load} cps={data.counterparties.filter((c: any) => c.role === who)} />)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function StateChip({ d }: { d: any }) {
  const [label, tone] = STATE[d.state] ?? [d.state, "neutral" as Tone];
  return <Chip tone={tone}>{label}{d.overdueDays > 0 ? ` · ${d.overdueDays}d` : ""}</Chip>;
}

function Row({ d, biz, cur, owner, open, onToggle, onChange, cps }: { d: any; biz: string; cur: string; owner: boolean; open: boolean; onToggle: () => void; onChange: () => void; cps: any[] }) {
  return (
    <>
      <tr id={`doc-${d.id}`} className={`border-t border-line align-top ${open ? "bg-accent-soft/40" : ""}`}>
        <th scope="row" className="py-2 pl-4 pr-3 text-left font-medium"><button className="text-left text-accent underline" aria-expanded={open} onClick={onToggle}>{d.number}</button></th>
        <td className="py-2 pr-3">{d.counterpartyName}</td>
        <td className="py-2 pr-3 whitespace-nowrap">{date(d.dueOn)}</td>
        <td className="num py-2 pr-3 text-right">{money(d.amountMinor, cur)}</td>
        <td className="num py-2 pr-3 text-right">{BigInt(d.paidMinor) > 0n ? money(d.paidMinor, cur) : "–"}</td>
        <td className="num py-2 pr-3 text-right font-medium">{money(d.outstandingMinor, cur)}</td>
        <td className="py-2 pr-3"><StateChip d={d} /></td>
        <td className="py-2 pr-4 text-xs text-ink-soft">{d.countedIn ? "Counted elsewhere" : d.forecast ? (d.forecast.inWindow ? `Week ${d.forecast.week}, ${date(d.forecast.date)}` : `After the window, ${date(d.forecast.date)}`) : "–"}</td>
      </tr>
      {open && <tr className="border-t border-line bg-accent-soft/20"><td colSpan={8} className="p-4"><Detail d={d} biz={biz} cur={cur} owner={owner} onChange={onChange} cps={cps} /></td></tr>}
    </>
  );
}

function Detail({ d, biz, cur, owner, onChange, cps }: { d: any; biz: string; cur: string; owner: boolean; onChange: () => void; cps: any[] }) {
  const [cands, setCands] = useState<any[]>([]);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [txn, setTxn] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const base = `/api/business/${biz}/ledger/${SEG[d.kind as Kind]}/${d.id}`;
  const canPay = owner && isOpen(d.state);

  useEffect(() => {
    let live = true;
    void call(base).then((r) => { if (live && r.ok) setCands(r.data.bankCandidates ?? []); });
    return () => { live = false; };
  }, [base, d.paidMinor, d.state]);

  async function pay(body: any) {
    setBusy(true); setMsg(null);
    const r = await call(`${base}/payments`, body);
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.data?.error ?? "Could not record the payment" }); return; }
    setAmount(""); setPaidOn(""); setTxn(""); setNote("");
    setMsg({ ok: true, text: (r.data.warnings ?? []).join(" ") || "Payment recorded." });
    onChange();
  }
  async function voidPayment(id: string) {
    const reason = window.prompt("Why is this payment being voided? (kept in the history)");
    if (!reason) return;
    const r = await call(`${base}/payments/${id}/void`, { reason });
    if (!r.ok) setMsg({ ok: false, text: r.data?.error ?? "Could not void the payment" }); else { setMsg({ ok: true, text: "Payment voided. It stays in the history." }); onChange(); }
  }
  async function voidDoc() {
    const reason = window.prompt(`Void this ${d.kind}? It stops counting in the forecast. Reason:`);
    if (!reason) return;
    const r = await call(base, { void: true, reason }, "PATCH");
    if (!r.ok) setMsg({ ok: false, text: r.data?.error ?? "Could not void" }); else onChange();
  }

  return (
    <div className="space-y-4 text-sm">
      {d.countedIn && <p className="rounded-lg border border-line bg-panel px-3 py-2"><b>{d.countedIn.live ? "Not counted twice." : "Check this."}</b> {d.countedIn.text}</p>}
      {d.forecast && !d.countedIn && <p className="text-ink-soft">In the forecast: <b className="num">{money(d.forecast.amountMinor, cur, { signed: true })}</b> on {date(d.forecast.date)}{d.forecast.week ? ` (week ${d.forecast.week})` : ""}. {d.forecast.note}</p>}
      {d.state === "draft" && <p className="text-ink-soft">This invoice is a draft, so it is not in the forecast. Mark it sent to include it.</p>}

      <div>
        <h3 className="font-medium">Payment history</h3>
        {d.legacyPaid ? <p className="text-ink-soft">Marked paid{d.paidOn ? ` on ${date(d.paidOn)}` : ""} when it was imported. No payment details were recorded.</p> : d.payments.length === 0 ? <p className="text-ink-soft">No payments yet.</p> : (
          <ul className="mt-1 divide-y divide-line">
            {d.payments.map((p: any) => (
              <li key={p.id} className={`flex flex-wrap items-baseline justify-between gap-2 py-1.5 ${p.voided ? "text-ink-soft line-through" : ""}`}>
                <span>{date(p.paidOn)} · <span className="num">{money(p.amountMinor, cur)}</span>{p.transactionId ? " · matched to a bank transaction" : ""}{p.note ? ` · ${p.note}` : ""}{p.afterBalanceDate && !p.voided ? " · after the bank balance date" : ""}{p.voided ? ` · voided: ${p.voidReason}` : ""}</span>
                {owner && !p.voided && <button className="text-xs text-accent underline" onClick={() => voidPayment(p.id)}>Void</button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canPay && (
        <form className="rounded-xl border border-line bg-panel p-3" onSubmit={(e) => { e.preventDefault(); void pay({ amount: amount.trim(), ...(paidOn ? { paidOn } : {}), ...(txn ? { transactionId: txn } : {}), ...(note.trim() ? { note: note.trim() } : {}) }); }}>
          <h3 className="font-medium">{d.kind === "invoice" ? "Record a payment received" : "Record a payment made"}</h3>
          <p className="text-xs text-ink-soft">This records a fact. It does not move money. Still owed: <b className="num">{money(d.outstandingMinor, cur)}</b>.</p>
          <div className="mt-2 grid gap-3 md:grid-cols-4">
            <Field label="Amount"><input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={asTyped(d.outstandingMinor)} required /></Field>
            <Field label="Paid on" hint={txn ? "from the bank line" : "default today"}><input type="date" className={inputClass} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} disabled={!!txn} /></Field>
            <Field label="Matches a bank transaction" hint="optional"><select className={inputClass} value={txn} onChange={(e) => setTxn(e.target.value)}><option value="">None</option>{cands.map((c) => <option key={c.id} value={c.id}>{date(c.postedOn)} · {money(c.amountMinor, cur)} · {c.description.slice(0, 28)}</option>)}</select></Field>
            <Field label="Note" hint="optional"><input className={inputClass} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn type="submit" busy={busy}>Record payment</Btn>
            <Btn type="button" variant="secondary" disabled={busy} onClick={() => void pay({ amount: asTyped(d.outstandingMinor), ...(txn ? { transactionId: txn } : {}) })}>Paid in full today</Btn>
          </div>
        </form>
      )}
      {msg && (msg.ok ? <p role="status" className="text-good">{msg.text}</p> : <ErrorNote>{msg.text}</ErrorNote>)}

      {owner && d.state !== "void" && (
        <div className="flex flex-wrap gap-2">
          <Btn variant="secondary" onClick={() => setEditing((e) => !e)}>{editing ? "Close editing" : "Edit details"}</Btn>
          {d.kind === "invoice" && d.state === "draft" && <Btn variant="secondary" onClick={async () => { const r = await call(base, { status: "sent" }, "PATCH"); if (r.ok) onChange(); else setMsg({ ok: false, text: r.data?.error ?? "Could not change" }); }}>Mark sent</Btn>}
          {d.payments.every((p: any) => p.voided) && !d.legacyPaid && <Btn variant="danger" onClick={voidDoc}>Void this {d.kind}</Btn>}
          {d.countedIn && <Btn variant="secondary" onClick={async () => { const r = await call(base, { countedIn: null }, "PATCH"); if (r.ok) onChange(); }}>Count it in the forecast after all</Btn>}
        </div>
      )}
      {editing && <EditForm d={d} base={base} cur={cur} cps={cps} onDone={() => { setEditing(false); onChange(); }} />}
    </div>
  );
}

function EditForm({ d, base, cur, cps, onDone }: { d: any; base: string; cur: string; cps: any[]; onDone: () => void }) {
  const [f, setF] = useState({ number: d.number, issuedOn: d.issuedOn, dueOn: d.dueOn, amount: asTyped(d.amountMinor), counterpartyId: d.counterpartyId });
  const [err, setErr] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<any[] | null>(null);
  const hasPayments = BigInt(d.paidMinor) > 0n;
  async function save(extra: any = {}) {
    setErr(null);
    const body: any = { number: f.number.trim(), issuedOn: f.issuedOn, dueOn: f.dueOn, amount: f.amount.trim(), ...extra };
    if (f.counterpartyId !== d.counterpartyId) body.counterpartyId = f.counterpartyId;
    const r = await call(base, body, "PATCH");
    if (r.ok) return onDone();
    if (r.status === 409 && r.data?.details?.overlaps) setOverlaps(r.data.details.overlaps); else setErr(r.data?.error ?? "Could not save");
  }
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="grid gap-3 md:grid-cols-5">
        <Field label="Number"><input className={inputClass} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field>
        <Field label={d.kind === "invoice" ? "Customer" : "Supplier"} hint={hasPayments ? "locked: has payments" : undefined}><select className={inputClass} value={f.counterpartyId} disabled={hasPayments} onChange={(e) => setF({ ...f, counterpartyId: e.target.value })}>{cps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Issued"><input type="date" className={inputClass} value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} /></Field>
        <Field label="Due"><input type="date" className={inputClass} value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></Field>
        <Field label={`Amount (${cur})`} hint={hasPayments ? `not below ${money(d.paidMinor, cur)}` : undefined}><input className={inputClass} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      </div>
      {err && <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>}
      {overlaps && <Overlaps overlaps={overlaps} cur={cur} onSame={(ref) => save({ countedIn: ref })} onSeparate={() => save({ acknowledgeOverlaps: true })} />}
      <div className="mt-3"><Btn onClick={() => save()}>Save changes</Btn></div>
    </div>
  );
}

function Overlaps({ overlaps, cur, onSame, onSeparate }: { overlaps: any[]; cur: string; onSame: (ref: string) => void; onSeparate: () => void }) {
  return (
    <div role="alert" className="mt-3 rounded-xl border border-caution/40 bg-caution-soft p-3 text-sm">
      <p className="font-medium">The forecast may already count this money.</p>
      <ul className="mt-1 space-y-2">
        {overlaps.map((o) => (
          <li key={o.ref} className="flex flex-wrap items-center justify-between gap-2">
            <span>{o.label} · {date(o.date)} · <span className="num">{money(o.amountMinor, cur)}</span> <Chip tone="caution">{o.type === "order" ? "confirmed order" : o.type === "recurring" ? "recurring commitment" : "scheduled item"}</Chip></span>
            <Btn variant="secondary" onClick={() => onSame(o.ref)}>It is the same: track it, do not count it twice</Btn>
          </li>
        ))}
      </ul>
      <div className="mt-2"><Btn variant="ghost" onClick={onSeparate}>It is a separate amount: count it</Btn></div>
    </div>
  );
}

function AddForm({ kind, biz, cps, cur, onDone }: { kind: Kind; biz: string; cps: any[]; cur: string; onDone: () => void }) {
  const who = kind === "invoice" ? "customer" : "supplier";
  const [f, setF] = useState({ cp: "", newName: "", number: "", issuedOn: todayIso(), dueOn: "", amount: "", draft: false });
  const [err, setErr] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(extra: any = {}) {
    setErr(null); setBusy(true);
    const body: any = { number: f.number.trim(), issuedOn: f.issuedOn, dueOn: f.dueOn, amount: f.amount.trim(), ...(f.cp === "" || f.cp === "__new" ? { newCounterpartyName: f.newName.trim() } : { counterpartyId: f.cp }), ...(kind === "invoice" ? { status: f.draft ? "draft" : "sent" } : {}), ...extra };
    const r = await call(`/api/business/${biz}/ledger/${SEG[kind]}`, body);
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 409 && r.data?.details?.overlaps) setOverlaps(r.data.details.overlaps); else setErr(r.data?.error ?? (r.data?.issues ? "Check the details you entered" : "Could not save"));
  }
  return (
    <Card title={kind === "invoice" ? "Add an invoice" : "Add a bill"} subtitle="Type the amount as on the document, for example 1250.00. The forecast picks it up straight away, unless it is a draft.">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={who === "customer" ? "Customer" : "Supplier"}><select className={inputClass} value={f.cp} onChange={(e) => setF({ ...f, cp: e.target.value })}><option value="">Choose…</option>{cps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="__new">A new {who}…</option></select></Field>
          {(f.cp === "__new" || (f.cp === "" && cps.length === 0)) && <Field label={`New ${who} name`}><input className={inputClass} value={f.newName} maxLength={120} onChange={(e) => setF({ ...f, newName: e.target.value })} required /></Field>}
          <Field label={kind === "invoice" ? "Invoice number" : "Bill reference"}><input className={inputClass} value={f.number} maxLength={60} onChange={(e) => setF({ ...f, number: e.target.value })} required /></Field>
          <Field label={`Amount (${cur})`}><input className={inputClass} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1250.00" required /></Field>
          <Field label="Issued on"><input type="date" className={inputClass} value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} required /></Field>
          <Field label="Due on"><input type="date" className={inputClass} value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} required /></Field>
          {kind === "invoice" && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.draft} onChange={(e) => setF({ ...f, draft: e.target.checked })} /> Draft (not sent yet; kept out of the forecast)</label>}
        </div>
        {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
        {overlaps && <Overlaps overlaps={overlaps} cur={cur} onSame={(ref) => save({ countedIn: ref })} onSeparate={() => save({ acknowledgeOverlaps: true })} />}
        <div className="mt-3"><Btn type="submit" busy={busy}>Save {kind === "invoice" ? "invoice" : "bill"}</Btn></div>
      </form>
    </Card>
  );
}

function BankMatches({ matches, biz, cur, onDone }: { matches: any[]; biz: string; cur: string; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function link(m: any) {
    setErr(null);
    const r = await call(`/api/business/${biz}/ledger/${SEG[m.docKind as Kind]}/${m.docId}/payments`, { amount: asTyped(m.amountMinor), transactionId: m.transactionId });
    if (r.ok) onDone(); else setErr(r.data?.error ?? "Could not record the payment");
  }
  return (
    <Card tone="caution" title="Bank transactions that look like payments" subtitle="These bank lines match an unpaid document exactly (same customer or supplier, same amount) and are not used yet. Confirm to record the payment against the bank line.">
      <ul className="divide-y divide-line text-sm">
        {matches.map((m) => (
          <li key={`${m.docId}-${m.transactionId}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{date(m.postedOn)} · {m.description} · <span className="num">{money(m.amountMinor, cur)}</span> → {m.docKind === "invoice" ? "invoice" : "bill"} {m.number} ({m.counterpartyName})</span>
            <Btn variant="secondary" onClick={() => link(m)}>Record this payment</Btn>
          </li>
        ))}
      </ul>
      {err && <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>}
    </Card>
  );
}
