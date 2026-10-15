"use client";

import { askPassword } from "@/ui/stepup";

import { useState } from "react";
import { formatMoney, money } from "@/lib/money";
import type { ActionView, MandateInfo } from "@/actions/read";
import type { SandboxState } from "@/sandbox";

interface Props {
  businessId: string;
  businessName: string;
  currency: string;
  initialMandate: MandateInfo;
  initialActions: ActionView[];
  initialSandbox: SandboxState;
  initialEvidence: Evidence;
}

interface Evidence {
  records: { chainSeq: string; event: string; actor: string; detail: unknown }[];
  count: number;
  head: { hash: string } | null;
  chain: { ok: boolean };
}

interface Api {
  status: number;
  json: Record<string, unknown>;
}

interface Outcome {
  title: string;
  expectation: string;
  steps: { label: string; status: number; summary: string }[];
  timeline: ActionView["timeline"];
}

const STATUS_STYLE: Record<string, string> = {
  denied: "bg-red-100 text-red-800",
  proposed: "bg-zinc-200 text-zinc-800",
  approved: "bg-blue-100 text-blue-800",
  executed: "bg-emerald-100 text-emerald-800",
  verified: "bg-emerald-200 text-emerald-900",
  verification_failed: "bg-red-200 text-red-900",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-zinc-200 text-zinc-600",
  expired: "bg-zinc-200 text-zinc-600",
  executing: "bg-amber-100 text-amber-800",
};

export default function ActionsView({ businessId, businessName, currency, initialMandate, initialActions, initialSandbox, initialEvidence }: Props) {
  const [mandate, setMandate] = useState(initialMandate);
  const [actions, setActions] = useState(initialActions);
  const [sandbox, setSandbox] = useState(initialSandbox);
  const [log, setLog] = useState(initialEvidence.records.slice(-10).reverse());
  const [head, setHead] = useState<{ count: number; hash: string | null; ok: boolean } | null>({ count: initialEvidence.count, hash: initialEvidence.head?.hash ?? null, ok: initialEvidence.chain.ok });
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState(false);
  const fm = (minor: string) => formatMoney(money(BigInt(minor), currency), 2);
  const base = `/api/business/${businessId}`;

  async function call(path: string, method = "GET", body?: unknown): Promise<Api> {
    const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  async function refresh() {
    const [a, m, s, e] = await Promise.all([call(`${base}/actions`), call(`${base}/mandate`), call(`${base}/sandbox`), call(`${base}/evidence`)]);
    if (a.status === 200) setActions(a.json as unknown as ActionView[]);
    if (m.status === 200) setMandate(m.json as unknown as MandateInfo);
    if (s.status === 200) setSandbox(s.json as unknown as SandboxState);
    if (e.status === 200) {
      const ev = e.json as { records: { chainSeq: string; event: string; actor: string; detail: unknown }[]; count: number; head: { hash: string } | null; chain: { ok: boolean } };
      setLog(ev.records.slice(-10).reverse());
      setHead({ count: ev.count, hash: ev.head?.hash ?? null, ok: ev.chain.ok });
    }
  }

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const propose = (request: unknown, key: string) => call(`${base}/actions`, "POST", { request, idempotencyKey: key, createdBy: "agent" });
  const kestrel = sandbox.payees.find((p) => p.name.startsWith("Kestrel"));
  const cp = (prefix: string) => sandbox.counterparties.find((c) => c.name.startsWith(prefix));
  const payKestrel = (amountMinor: string, extra: Record<string, unknown> = {}) =>
    ({ kind: "sandbox.schedule_payment", payeeId: kestrel?.id ?? "", amountMinor, currency, scheduledFor: sandbox.asOf ?? "", purpose: "supplier", ...extra });

  const samples: { label: string; run: () => Promise<Api> }[] = [
    { label: "Propose: ask Kestrel to cut the deposit to 15%", run: () => propose({ kind: "sandbox.send_proposal", counterpartyId: cp("Kestrel")?.id, proposal: { kind: "supplier.reduce_deposit", percentBps: 1500 } }, "demo-kestrel-15") },
    { label: "Propose: pay Kestrel 28,800 (deposit)", run: () => propose(payKestrel("2880000"), "demo-kestrel-pay-28800") },
    { label: "Propose: invoice finance at 80% (fee 2.0% of the invoice)", run: () => propose({ kind: "sandbox.submit_application", lenderId: cp("Clearwater")?.id, invoiceAmountMinor: "18000000", advanceBps: 8000 }, "demo-finance-80") },
  ];

  async function addOutcome(o: Outcome) {
    setOutcomes((prev) => [o, ...prev]);
  }

  const summarise = (r: Api) => {
    const j = r.json as { error?: string; gate?: { decision?: string; reasons?: string[] }; proposal?: { status?: string; id?: string } };
    if (j.error) return j.error;
    if (j.gate) return `${j.gate.decision}: ${(j.gate.reasons ?? []).join("; ")}`;
    return JSON.stringify(j).slice(0, 200);
  };

  async function withTimeline(id: string | undefined): Promise<ActionView["timeline"]> {
    if (!id) return [];
    const a = await call(`${base}/actions`);
    return a.status === 200 ? ((a.json as unknown as ActionView[]).find((x) => x.id === id)?.timeline ?? []) : [];
  }

  const breaks: { label: string; run: () => Promise<void> }[] = [
    {
      label: "Pay an unapproved payee",
      run: async () => {
        const r = await propose({ ...payKestrel("100000"), payeeId: crypto.randomUUID() }, "break-unapproved");
        const id = (r.json as { proposal?: { id: string } }).proposal?.id;
        await addOutcome({ title: "Pay an unapproved payee", expectation: "denied: not on the approved list", steps: [{ label: "propose", status: r.status, summary: summarise(r) }], timeline: await withTimeline(id) });
      },
    },
    {
      label: "Pay over the per-payment limit (70,001)",
      run: async () => {
        const r = await propose(payKestrel("7000100"), "break-over-limit");
        const id = (r.json as { proposal?: { id: string } }).proposal?.id;
        await addOutcome({ title: "Pay 70,001 (limit is 70,000)", expectation: "denied: per-payment limit", steps: [{ label: "propose", status: r.status, summary: summarise(r) }], timeline: await withTimeline(id) });
      },
    },
    {
      label: "Propose a 4% discount",
      run: async () => {
        const r = await propose({ kind: "sandbox.send_proposal", counterpartyId: cp("Northgate")?.id, proposal: { kind: "buyer.request_early_payment", daysEarly: 30, discountBps: 400 } }, "break-discount-4");
        const id = (r.json as { proposal?: { id: string } }).proposal?.id;
        await addOutcome({ title: "Offer a 4% early-payment discount (limit 1.5%)", expectation: "denied: discount above the mandate maximum", steps: [{ label: "propose", status: r.status, summary: summarise(r) }], timeline: await withTimeline(id) });
      },
    },
    {
      label: "Payment that drops the bank below the floor (40,000)",
      run: async () => {
        const r = await propose(payKestrel("4000000"), "break-floor");
        const id = (r.json as { proposal?: { id: string } }).proposal?.id;
        await addOutcome({ title: "Pay 40,000 (bank floor is 5,000)", expectation: "denied: bank balance below the floor", steps: [{ label: "propose", status: r.status, summary: summarise(r) }], timeline: await withTimeline(id) });
      },
    },
    {
      label: "Replay an approved action with a modified amount",
      run: async () => {
        const target = actions.find((a) => a.kind === "sandbox.schedule_payment" && a.status !== "denied");
        if (!target) return addOutcome({ title: "Replay with a modified amount", expectation: "needs an existing payment action first", steps: [{ label: "skipped", status: 0, summary: "Propose and approve a payment first (use the Propose buttons)." }], timeline: [] });
        const amount = (BigInt((target.payload as { amountMinor: string }).amountMinor) + 100n).toString();
        const r = await propose({ ...(target.payload as Record<string, unknown>), amountMinor: amount, payeeBankDetailsHash: undefined }, target.idempotencyKey);
        await addOutcome({ title: "Replay an approved action's key with +1.00", expectation: "409: idempotency key reused with a different action", steps: [{ label: "propose (same key, bigger amount)", status: r.status, summary: summarise(r) }], timeline: await withTimeline(target.id) });
      },
    },
    {
      label: "Execute an approval twice",
      run: async () => {
        const target = actions.find((a) => ["executed", "verified"].includes(a.status));
        if (!target) return addOutcome({ title: "Execute twice", expectation: "needs an executed action first", steps: [{ label: "skipped", status: 0, summary: "Execute an action first, then try this again." }], timeline: [] });
        const r = await call(`/api/actions/${target.id}/execute`, "POST");
        await addOutcome({ title: "Execute an already executed action", expectation: "refused: the approval can be used once", steps: [{ label: "execute again", status: r.status, summary: summarise(r) }], timeline: await withTimeline(target.id) });
      },
    },
    {
      label: "Change Kestrel's bank details, then try to pay",
      run: async () => {
        if (!kestrel) return;
        const c = await call(`${base}/payees/${kestrel.id}/bank-details`, "POST", { accountRef: "SBX-GB00-KPM-9999", changedBy: "attacker (simulated)" });
        const r = await propose(payKestrel("100000"), `break-bank-change-${Date.now().toString(36)}`);
        const id = (r.json as { proposal?: { id: string } }).proposal?.id;
        await addOutcome({
          title: "Change Kestrel's bank details, then pay",
          expectation: "payee becomes unapproved; payment denied until the owner re-approves",
          steps: [{ label: "change bank details", status: c.status, summary: c.status === 200 ? "payee is now unapproved" : summarise(c) }, { label: "propose payment", status: r.status, summary: summarise(r) }],
          timeline: await withTimeline(id),
        });
      },
    },
  ];

  async function restoreKestrel() {
    if (!kestrel) return;
    await call(`${base}/payees/${kestrel.id}/bank-details`, "POST", { accountRef: "SBX-GB00-KPM-0001", changedBy: "owner" });
    await call(`${base}/payees/${kestrel.id}/approve`, "POST", { approvedBy: "owner", password: askPassword("re-approve the payee") ?? "" });
  }

  async function act(a: ActionView, step: "approve" | "execute" | "verify" | "cancel") {
    const body = step === "approve" ? { approvedBy: "Demo Owner", password: askPassword("approve this action") ?? "", confirmations: a.gateResult.requiresSecondConfirmation ? 2 : 1 } : step === "cancel" ? { cancelledBy: "Demo Owner" } : undefined;
    const r = await call(`/api/actions/${a.id}/${step}`, "POST", body);
    if (r.status >= 400) await addOutcome({ title: `${step} ${a.kind}`, expectation: "", steps: [{ label: step, status: r.status, summary: summarise(r) }], timeline: [] });
  }

  const L = mandate.present ? (mandate.mandate.limits as Record<string, unknown>) : null;
  const money0 = (v: unknown) => fm(String(v));

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Actions and limits
        <span className="ml-3 rounded bg-amber-200 px-2 py-0.5 align-middle text-xs font-medium text-amber-900">SYNTHETIC DATA</span>
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        {businessName}. Everything an agent does goes through one pipeline: propose, gate decision, owner approval bound to the exact action, execution, independent verification. Every step is written to the hash-chained log. The gate is code driven by a signed mandate; no model decides what is allowed.
      </p>
      <div className="mt-2"><button className="rounded border border-zinc-400 px-2 py-1 text-xs" disabled={busy} onClick={() => guarded(async () => undefined)}>Refresh</button></div>

      <section className="mt-5 rounded border border-zinc-300 p-3 text-sm">
        <h2 className="font-medium">Owner-signed mandate</h2>
        {!mandate.present || !L ? <p className="text-red-600">No active mandate: every external and money action is denied.</p> : (
          <>
            <p>
              Version {mandate.version}, valid {mandate.mandate.issuedAt.slice(0, 10)} to {mandate.mandate.expiresAt.slice(0, 10)}. Signature:{" "}
              {mandate.signatureValid ? <b className="text-emerald-700">valid (Ed25519, verified with the public key)</b> : <b className="text-red-700">INVALID: {mandate.reason}</b>}
            </p>
            <ul className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              <li>Max early-payment discount: {Number(L.maxEarlyPaymentDiscountBps) / 100}%</li>
              <li>Max per payment: {money0(L.maxPaymentMinor)}</li>
              <li>Max outflow per day: {money0(L.maxDailyOutflowMinor)}</li>
              <li>Bank balance floor: {money0(L.minBankBalanceMinor)}</li>
              <li>Forbidden purposes: {(L.forbiddenPurposes as string[]).join(", ")}</li>
              <li>New payees allowed: {String(L.allowNewPayees)}</li>
              <li>Max invoice-finance advance: {Number(L.maxFinanceAdvanceBps) / 100}%</li>
              <li>Max finance fee: {Number(L.maxFinanceFeeBps) / 100}% (the lender fee is a % of the invoice face value)</li>
              <li>Two confirmations above: {money0(L.requireSecondConfirmationAboveMinor)}</li>
              <li>Allowed proposals: {(L.allowedProposalKinds as string[]).length} kinds</li>
            </ul>
            <p className="mt-1 text-xs text-zinc-500">A simplified stand-in for verifiable-credential style mandates (such as AP2): the limits are signed, verified on every evaluation, and enforced in code, not in prompts. Dev keys only.</p>
          </>
        )}
        <p className="mt-2">Sandbox bank: <b className="tabular-nums">{sandbox.banks[0] ? fm(sandbox.banks[0].balanceMinor) : "-"}</b>. Payees: {sandbox.payees.map((p) => `${p.name.split(" ")[0]} (${p.approved ? "approved" : "UNAPPROVED"})`).join(", ")}</p>
        {head && <p className="text-xs text-zinc-500">Log: {head.count} records, chain {head.ok ? "verified" : "BROKEN"}, head {head.hash?.slice(0, 16)}...</p>}
      </section>

      <section className="mt-5">
        <h2 className="text-lg font-medium">Propose an action (as the agent will)</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {samples.map((s) => (
            <button key={s.label} disabled={busy} className="rounded border border-zinc-400 px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => guarded(async () => { await s.run(); })}>{s.label}</button>
          ))}
        </div>
      </section>

      <section className="mt-5">
        <h2 className="text-lg font-medium">Actions</h2>
        {actions.length === 0 && <p className="text-sm text-zinc-500">None yet.</p>}
        {actions.map((a) => (
          <div key={a.id} className="mt-2 rounded border border-zinc-300 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[a.status] ?? "bg-zinc-200"}`}>{a.status}</span>
              <b>{describe(a, currency)}</b>
              <span className="text-xs text-zinc-500">by {a.createdBy}</span>
            </div>
            <p className="mt-1">
              Gate: <b>{a.gateResult.decision}</b> ({a.gateResult.tier}){a.gateResult.requiresSecondConfirmation ? ", two confirmations needed" : ""}. {a.gateResult.reasons.join(" ")}
            </p>
            <details className="text-xs text-zinc-600">
              <summary className="cursor-pointer">limits checked, payload hash</summary>
              <ul>{a.gateResult.limitsChecked.map((l, i) => <li key={i}>{l.ok ? "ok" : "FAIL"} {l.limit}: {l.value} (bound {l.bound})</li>)}</ul>
              <p className="font-mono">payload {a.payloadHash.slice(0, 24)}...</p>
            </details>
            <ol className="mt-1 list-decimal pl-5 text-xs">
              {a.timeline.map((t) => <li key={t.chainSeq}>{t.event} <span className="text-zinc-500">({t.actor})</span></li>)}
            </ol>
            <div className="mt-2 flex flex-wrap gap-2">
              {a.status === "proposed" && <button disabled={busy} className="rounded border border-blue-500 px-2 py-1 text-xs" onClick={() => guarded(() => act(a, "approve"))}>Approve as owner{a.gateResult.requiresSecondConfirmation ? " (2 confirmations)" : ""}</button>}
              {a.status === "approved" && <button disabled={busy} className="rounded border border-emerald-600 px-2 py-1 text-xs" onClick={() => guarded(() => act(a, "execute"))}>Execute</button>}
              {["executed", "verified", "verification_failed"].includes(a.status) && <button disabled={busy} className="rounded border border-emerald-600 px-2 py-1 text-xs" onClick={() => guarded(() => act(a, "verify"))}>Verify</button>}
              {["proposed", "approved"].includes(a.status) && <button disabled={busy} className="rounded border border-zinc-400 px-2 py-1 text-xs" onClick={() => guarded(() => act(a, "cancel"))}>Cancel</button>}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-6 rounded border-2 border-red-300 p-3">
        <h2 className="text-lg font-medium text-red-800">Try to break it</h2>
        <p className="text-sm text-zinc-600">Each button attempts something the mandate forbids. The expected result is a refusal; the log shows what happened.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {breaks.map((b) => (
            <button key={b.label} disabled={busy} className="rounded border border-red-400 px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => guarded(b.run)}>{b.label}</button>
          ))}
          <button disabled={busy} className="rounded border border-emerald-600 px-3 py-1.5 text-sm" onClick={() => guarded(restoreKestrel)}>Owner: restore and re-approve Kestrel</button>
        </div>
        {outcomes.map((o, i) => (
          <div key={i} className="mt-3 rounded bg-zinc-50 p-2 text-sm dark:bg-zinc-900">
            <p className="font-medium">{o.title} <span className="font-normal text-zinc-500">(expected: {o.expectation})</span></p>
            {o.steps.map((s, j) => <p key={j}><span className="font-mono text-xs">[{s.status}]</span> {s.label}: {s.summary}</p>)}
            {o.timeline.length > 0 && <p className="text-xs text-zinc-500">log: {o.timeline.map((t) => t.event).join(" > ")}</p>}
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Latest log entries</h2>
        <ul className="text-xs">
          {log.map((r) => <li key={r.chainSeq}><span className="font-mono">#{r.chainSeq}</span> {r.event} <span className="text-zinc-500">({r.actor})</span></li>)}
        </ul>
        <p className="text-xs text-zinc-500">Full export with the chain head: <a className="underline" href={`${base}/evidence`}>/api/business/.../evidence</a></p>
      </section>
    </div>
  );
}

function describe(a: ActionView, currency: string): string {
  const p = a.payload as Record<string, unknown>;
  const m = (v: unknown) => formatMoney(money(BigInt(String(v)), currency), 2);
  switch (a.kind) {
    case "sandbox.schedule_payment": return `Pay ${m(p.amountMinor)} (${String(p.purpose)}) on ${String(p.scheduledFor)}`;
    case "sandbox.submit_application": return `Invoice-finance application: ${m(p.invoiceAmountMinor)} invoice, advance ${Number(p.advanceBps) / 100}%`;
    case "sandbox.send_proposal": return `Proposal: ${String((p.proposal as { kind: string }).kind)} ${JSON.stringify(p.proposal)}`;
    case "sandbox.cancel_payment": return "Cancel a scheduled payment";
    default: return a.kind;
  }
}
