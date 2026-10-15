"use client";

import { askPassword } from "@/ui/stepup";

import { useState } from "react";
import { formatMoney, money } from "@/lib/money";
import type { SandboxState } from "@/sandbox";

type Canned = { label: string; run: (s: SandboxState) => Promise<Response> | null };

export default function SandboxConsole({ initial }: { initial: SandboxState }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string>("");
  const biz = state.business.id;
  const fm = (minor: string, cur = state.business.currency) => formatMoney(money(BigInt(minor), cur), 2);
  const cp = (prefix: string) => state.counterparties.find((c) => c.name.startsWith(prefix));
  // Every button goes through the same pipeline as the agent will: propose, gate, owner approval, execute, verify.
  // A denied action stays denied. Nothing here bypasses the gate.
  const act = (request: unknown, key: string) =>
    fetch(`/api/business/${biz}/console`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, idempotencyKey: key.slice(0, 100), password: askPassword("act as the owner") ?? "" }) });
  const propose = (who: string, proposal: { kind: string } & Record<string, unknown>) => {
    const c = cp(who);
    return c ? act({ kind: "sandbox.send_proposal", counterpartyId: c.id, proposal }, `console-${c.id.slice(0, 8)}-${JSON.stringify(proposal)}`) : null;
  };

  const canned: Canned[] = [
    { label: "Ask Northgate for a 20% deposit", run: () => propose("Northgate", { kind: "buyer.request_deposit", percentBps: 2000 }) },
    { label: "Ask Kestrel to cut the deposit to 15%", run: () => propose("Kestrel", { kind: "supplier.reduce_deposit", percentBps: 1500 }) },
    { label: "Ask Kestrel to defer the balance 30 days", run: () => propose("Kestrel", { kind: "supplier.defer_balance", daysAfterShipment: 30 }) },
    { label: "Ask Northgate to pay 30 days early for 1.5%", run: () => propose("Northgate", { kind: "buyer.request_early_payment", daysEarly: 30, discountBps: 150 }) },
    { label: "Ask Quickbuy (hostile) for a 20% deposit", run: () => propose("Quickbuy", { kind: "buyer.request_deposit", percentBps: 2000 }) },
    {
      label: "Apply for invoice finance at 80% (180,000 invoice; the lender fee is 2.0% of the invoice face value, GBP 3,600)",
      run: () => {
        const l = cp("Clearwater");
        return l ? act({ kind: "sandbox.submit_application", lenderId: l.id, invoiceAmountMinor: "18000000", advanceBps: 8000 }, "console-invoice-finance-80") : null;
      },
    },
    {
      label: "Schedule 28,800 to Kestrel (deposit) for the as-of date",
      run: (s) => {
        const p = s.payees.find((x) => x.name.startsWith("Kestrel"));
        return p && s.asOf ? act({ kind: "sandbox.schedule_payment", payeeId: p.id, amountMinor: "2880000", currency: s.business.currency, scheduledFor: s.asOf, purpose: "supplier" }, "console-kestrel-deposit") : null;
      },
    },
    {
      label: "Run the bank's due-payments job (as of date)",
      run: (s) => (s.asOf ? fetch(`/api/business/${biz}/sandbox/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asOf: s.asOf }) }) : null),
    },
  ];

  async function fire(c: Canned) {
    setBusy(true);
    try {
      const res = c.run(state);
      if (!res) {
        setLast("Nothing to do (missing counterparty, payee or date).");
        return;
      }
      const r = await res;
      const data = await r.json();
      setLast(`${c.label}: ${r.ok ? "ok" : `error ${r.status}`}\n${JSON.stringify(data, null, 2).slice(0, 900)}`);
      const fresh = await fetch(`/api/business/${biz}/sandbox`);
      if (fresh.ok) setState(await fresh.json());
    } catch (e) {
      setLast(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const name = (id: string | null) => state.counterparties.find((c) => c.id === id)?.name ?? "-";
  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Sandbox console
        <span className="ml-3 rounded bg-amber-200 px-2 py-0.5 align-middle text-xs font-medium text-amber-900">SYNTHETIC DATA</span>
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        {state.business.name}. A manual console that the agent will replace. It bypasses nothing: every button goes through the permission gate, owner approval, execution and independent verification (see /demo/actions). Anything outside the signed limits is denied. As-of date: {state.asOf ?? "-"}.
      </p>

      <div className="mt-4 rounded border border-zinc-300 p-3 text-sm">
        <h2 className="font-medium">Sandbox bank</h2>
        {state.banks.map((b) => (
          <p key={b.id}>{b.name}: <b className="tabular-nums">{fm(b.balanceMinor, b.currency)}</b></p>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {canned.map((c) => (
          <button key={c.label} disabled={busy} onClick={() => fire(c)} className="rounded border border-zinc-400 px-3 py-1.5 text-sm disabled:opacity-50">{c.label}</button>
        ))}
      </div>
      {last && <pre className="mt-3 max-h-56 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{last}</pre>}

      <section className="mt-6">
        <h2 className="text-lg font-medium">Counterparties</h2>
        <ul className="text-sm">
          {state.counterparties.map((c) => (
            <li key={c.id}>{c.name} <span className="text-zinc-500">({c.role}, {c.temperament})</span></li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Payees</h2>
        <table className="w-full text-sm"><tbody>
          {state.payees.map((p) => (
            <tr key={p.id} className="border-b border-zinc-200">
              <td className="py-1 pr-2">{p.name}</td>
              <td className="py-1 pr-2 font-mono text-xs">{p.accountRef}</td>
              <td className="py-1">{p.approved ? <span className="text-emerald-700">approved</span> : <span className="text-red-600">not approved</span>} <span className="text-zinc-500">({p.createdVia})</span></td>
            </tr>
          ))}
        </tbody></table>
        <p className="text-xs text-zinc-500">Only Kestrel and the lender are approved payees. Nobody else.</p>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Payments</h2>
        {state.payments.length === 0 ? <p className="text-sm text-zinc-500">None yet.</p> : (
          <table className="w-full text-sm tabular-nums"><tbody>
            {state.payments.map((p) => (
              <tr key={p.id} className="border-b border-zinc-200">
                <td className="py-1 pr-2">{p.scheduledFor}</td>
                <td className="py-1 pr-2">{state.payees.find((x) => x.id === p.payeeId)?.name}</td>
                <td className="py-1 pr-2 text-right">{fm(p.amountMinor, p.currency)}</td>
                <td className="py-1 pr-2">{p.status}{p.failureReason ? ` (${p.failureReason})` : ""}</td>
                <td className="py-1 font-mono text-xs">{p.reference}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Threads</h2>
        {state.threads.length === 0 ? <p className="text-sm text-zinc-500">None yet.</p> : state.threads.map((t) => (
          <div key={t.id} className="mt-2 rounded border border-zinc-300 p-2 text-sm">
            <p className="font-medium">{name(t.counterpartyId)}: {t.topic} <span className="text-zinc-500">[{t.status}]</span></p>
            {t.messages.map((m) => (
              <div key={m.id} className="mt-1">
                <span className={m.direction === "inbound" ? "font-medium text-red-700" : "font-medium"}>{m.direction === "inbound" ? "IN" : "OUT"}</span>{" "}
                {m.untrusted && <span className="rounded bg-red-100 px-1 text-xs font-semibold text-red-800">UNTRUSTED</span>} {m.body}
                <span className="block font-mono text-xs text-zinc-500">{JSON.stringify(m.structured)}</span>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Applications</h2>
        {state.applications.length === 0 ? <p className="text-sm text-zinc-500">None yet.</p> : state.applications.map((a) => (
          <div key={a.id} className="mt-1 rounded border border-zinc-300 p-2 text-sm">
            {a.reference}: {a.kind} for {fm(a.requestedAmountMinor, a.currency)} to {name(a.lenderId)}: <b>{a.status}</b>
            <span className="block font-mono text-xs text-zinc-500">{JSON.stringify(a.offer)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
