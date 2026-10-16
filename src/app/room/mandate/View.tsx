"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { Btn, Card, Chip, ErrorNote, Loading, Seal, Stat } from "@/ui/kit";
import { date, money, pct, short } from "@/ui/format";
import { call, useSession } from "@/ui/session";

const KIND: Record<string, string> = {
  "buyer.request_deposit": "Ask a buyer for a deposit", "buyer.request_early_payment": "Offer a buyer an early-payment discount", "buyer.chase_payment": "Ask a buyer to pay overdue invoices",
  "supplier.reduce_deposit": "Ask a supplier to lower a deposit", "supplier.defer_balance": "Ask a supplier to defer a balance", "lender.apply_invoice_finance": "Apply for invoice finance",
};
const PURPOSE: Record<string, string> = { supplier: "supplier payments", loan: "loan repayments", payroll: "payroll", tax: "tax", other: "other payments" };

const clock = () => new Date().toLocaleTimeString("en-GB");
const stamp = () => Date.now().toString(36);

export default function MandatePage() {
  const { session } = useSession();
  const biz = session?.business.id;
  const cur = session?.business.currency ?? "GBP";
  const [info, setInfo] = useState<any>(null);
  const [sandbox, setSandbox] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!biz) return;
    void call(`/api/business/${biz}/mandate`).then((r) => r.ok && setInfo(r.data));
    void call(`/api/business/${biz}/sandbox`).then((r) => r.ok && setSandbox(r.data));
  }, [biz]);
  if (!info) return <Loading />;
  if (!info.present) return <ErrorNote>You have not signed any limits yet, so your assistant can read and propose but every action is denied.</ErrorNote>;
  const m = info.mandate, L = m.limits;
  const kestrel = sandbox?.payees?.find((p: any) => p.name.includes("Kestrel"));
  const customer = sandbox?.counterparties?.find((c: any) => c.role === "customer");

  const attempts: { id: string; title: string; expect: string; request: any }[] = [
    { id: "payee", title: "Pay someone who is not an approved payee", expect: "Denied: only payees you approved can be paid.", request: { kind: "sandbox.schedule_payment", payeeId: "00000000-0000-4000-8000-0000000000aa", amountMinor: "100000", currency: cur, scheduledFor: sandbox?.asOf, purpose: "supplier" } },
    { id: "limit", title: `Pay one cent more than your per-payment limit`, expect: "Denied: above the limit you signed.", request: kestrel && { kind: "sandbox.schedule_payment", payeeId: kestrel.id, amountMinor: (BigInt(L.maxPaymentMinor) + 1n).toString(), currency: cur, scheduledFor: sandbox?.asOf, purpose: "supplier" } },
    { id: "purpose", title: "Pay payroll through the assistant", expect: "Denied: payroll is something your assistant may never pay.", request: kestrel && { kind: "sandbox.schedule_payment", payeeId: kestrel.id, amountMinor: "100000", currency: cur, scheduledFor: sandbox?.asOf, purpose: "payroll" } },
    { id: "discount", title: `Offer a ${pct(L.maxEarlyPaymentDiscountBps + 250)} early-payment discount`, expect: `Denied: your cap is ${pct(L.maxEarlyPaymentDiscountBps)}.`, request: customer && { kind: "sandbox.send_proposal", counterpartyId: customer.id, proposal: { kind: "buyer.request_early_payment", daysEarly: 30, discountBps: L.maxEarlyPaymentDiscountBps + 250 } } },
    { id: "overdraw", title: "Schedule a payment the projected balance cannot cover", expect: "Denied: the balance on that date would fall below your floor.", request: kestrel && { kind: "sandbox.schedule_payment", payeeId: kestrel.id, amountMinor: L.maxPaymentMinor, currency: cur, scheduledFor: sandbox?.asOf, purpose: "supplier" } },
  ];

  async function tryIt(a: (typeof attempts)[number]) {
    if (!a.request) return;
    setBusy(a.id);
    const r = await call(`/api/business/${biz}/actions`, { request: a.request, idempotencyKey: `break-${a.id}-${stamp()}`, createdBy: "agent" });
    setBusy(null);
    const gate = r.data.gate;
    setResults((x) => [{ ...a, ok: r.ok, decision: gate?.decision ?? "error", reasons: gate?.reasons ?? [r.data.error ?? "refused"], at: clock() }, ...x]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="display text-2xl">Your limits</h2><p className="text-ink-soft">The rules you signed for what your assistant may do. They are enforced by code on every action, never by the AI&apos;s own judgement.</p></div>
        <div className="flex items-center gap-2"><Seal>Signed · version {info.version}</Seal>{info.signatureValid ? <Chip tone="good">signature verifies</Chip> : <Chip tone="danger">signature INVALID: all actions denied</Chip>}</div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Largest single payment" value={money(L.maxPaymentMinor, cur)} />
        <Stat label="Largest outflow in a day" value={money(L.maxDailyOutflowMinor, cur)} />
        <Stat label="Bank balance floor" value={money(L.minBankBalanceMinor, cur)} sub="never projected below this" />
        <Stat label="Second confirmation above" value={money(L.requireSecondConfirmationAboveMinor, cur)} sub="a different approver must also sign" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="What your assistant may do" subtitle={`Valid ${date(m.issuedAt)} to ${date(m.expiresAt)}`}>
          <ul className="space-y-1.5 text-sm">
            {L.allowedProposalKinds.map((k: string) => <li key={k} className="flex gap-2"><span className="text-good" aria-hidden>✓</span>{KIND[k] ?? k}</li>)}
          </ul>
          <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm text-ink-soft">
            <li>Early-payment discount: at most {pct(L.maxEarlyPaymentDiscountBps)}.</li>
            <li>Invoice finance: advance up to {pct(L.maxFinanceAdvanceBps)}, fee up to {pct(L.maxFinanceFeeBps)} of the invoice.</li>
            {(L.maxFundingCostBps !== undefined || L.maxFundingAmountMinor !== undefined) && <li>Funding offers you compare: {L.maxFundingCostBps !== undefined && <>estimated yearly cost up to {pct(L.maxFundingCostBps)}</>}{L.maxFundingCostBps !== undefined && L.maxFundingAmountMinor !== undefined && ", "}{L.maxFundingAmountMinor !== undefined && <>up to {money(L.maxFundingAmountMinor, cur)} from one lender</>}. Offers beyond this are flagged, never hidden.</li>}
            <li>New payees: {L.allowNewPayees ? "allowed" : "not allowed. Only payees you approved can be paid."}</li>
          </ul>
        </Card>
        <Card title="What it may never do" subtitle="Hard stops, whatever the plan says.">
          <ul className="space-y-1.5 text-sm">
            {L.forbiddenPurposes.map((p: string) => <li key={p} className="flex gap-2"><span className="text-danger" aria-hidden>✕</span>Pay {PURPOSE[p] ?? p}</li>)}
            <li className="flex gap-2"><span className="text-danger" aria-hidden>✕</span>Pay a payee whose bank details changed, until you approve them again</li>
            <li className="flex gap-2"><span className="text-danger" aria-hidden>✕</span>Act on a plan after it expires, or after your limits change</li>
            <li className="flex gap-2"><span className="text-danger" aria-hidden>✕</span>Obey instructions found in a document or in a reply from the other side</li>
          </ul>
          <p className="mt-3 text-xs text-ink-soft">Signature <span className="font-mono">{short(info.signature, 16)}</span> · signed {date(info.signedAt)} with the owner key held by the server (a development key; see the safety notes).</p>
        </Card>
      </div>

      <Card tone="danger" title="Try to break it" subtitle="Each button asks the system to do something your limits forbid. Watch it say no, and notice that the refusal is recorded in the evidence log.">
        <ul className="space-y-3">
          {attempts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/60 p-3">
              <div><p className="font-medium">{a.title}</p><p className="text-sm text-ink-soft">{a.expect}</p></div>
              <Btn variant="danger" busy={busy === a.id} disabled={!a.request} onClick={() => tryIt(a)}>Try it</Btn>
            </li>
          ))}
        </ul>
        {results.length > 0 && (
          <div className="mt-4 space-y-2" aria-live="polite">
            {results.map((r, i) => (
              <div key={i} className={`rounded-xl border p-3 text-sm ${r.decision === "deny" ? "border-good/40 bg-good-soft" : "border-caution/40 bg-caution-soft"}`}>
                <p className="flex items-center gap-2"><Chip tone={r.decision === "deny" ? "good" : "caution"}>{r.decision === "deny" ? "blocked, as it should be" : r.decision}</Chip><b>{r.title}</b><span className="ml-auto text-xs text-ink-soft">{r.at}</span></p>
                <p className="mt-1 text-ink-soft">{r.reasons[0]}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="How your signature is protected" subtitle="What is and is not protected today">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
          <li>Your signature is made on the server with a <b>test key</b>. Signing needs you signed in, your password again, and (for large payments) a second approver&apos;s password.</li>
          <li>Because the key is on the server, anyone who controls the server could sign. This setup uses made-up data and no real money. In a live deployment the key would live on your device, for example a passkey or a hardware security key, and the server would only check it.</li>
          <li>The evidence log is tamper-evident: a changed or deleted record breaks the hash chain, which you can check under Records.</li>
        </ul>
      </Card>
    </div>
  );
}
