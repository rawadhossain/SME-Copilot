"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Second approvals: plans the owner has already confirmed, waiting for a DIFFERENT person. The approver signs in as themselves, reads exactly
// what the plan will do, and confirms with their own password. Nobody types another person's password.
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, Chip, Empty, ErrorNote, Field, Loading, inputClass } from "@/ui/kit";
import { dateTime } from "@/ui/format";
import { call, useSession } from "@/ui/session";

export default function Approvals() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [list, setList] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "good" | "danger"; text: string } | null>(null);
  const load = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/approvals`);
    if (r.ok) setList(r.data); else setMsg({ tone: "danger", text: r.data?.error ?? "Could not load" });
  }, [biz]);
  useEffect(() => { void load(); }, [load]);
  if (!session || list === null) return msg ? <ErrorNote>{msg.text}</ErrorNote> : <Loading />;
  const isApprover = session.user.role === "approver";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-3xl">Approvals</h1>
        <p className="text-ink-soft">Large plans need two different people. The owner has already confirmed these. {isApprover ? "Read what each one will do, then confirm or decline it with your own password." : "A different approver must confirm them; you cannot give the second approval yourself."}</p>
      </div>
      {msg && <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${msg.tone === "good" ? "border-good/40 bg-good-soft text-good" : "border-danger/40 bg-danger-soft text-danger"}`}>{msg.text}</p>}
      {list.length === 0 && <Empty title="Nothing is waiting">When the owner signs a plan that needs a second person, it appears here for an approver to confirm.</Empty>}
      {list.map((p) => <Pending key={p.id} p={p} isApprover={isApprover} onDone={async (tone, text) => { setMsg({ tone, text }); await load(); }} />)}
    </div>
  );
}

function Pending({ p, isApprover, onDone }: { p: any; isApprover: boolean; onDone: (tone: "good" | "danger", text: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = p.summary;
  async function decide(decision: "approve" | "decline") {
    setBusy(decision); setError(null);
    const r = await call(`/api/plan-authorisations/${p.id}/second-approval`, { password, decision });
    setBusy(null);
    if (r.ok && r.data.status === "authorised") await onDone("good", "Confirmed. The plan is now signed and the owner can run it.");
    else if (r.ok && r.data.status === "declined") await onDone("good", "Declined. Nothing will be sent or paid for this plan.");
    else if (r.ok && r.data.status === "expired") await onDone("danger", "This plan expired before it could be confirmed. The owner needs to sign it again.");
    else setError(r.data?.error ?? "That did not work");
  }
  return (
    <Card title="A plan is waiting for a second approval" subtitle={`First confirmed by ${p.firstConfirmedName ?? "the owner"} on ${dateTime(p.firstConfirmedAt)} · expires ${dateTime(p.expiresAt)}`} tone="caution" right={<Chip tone="caution">second approval</Chip>}>
      <div className="space-y-4 text-sm">
        <section><h3 className="font-medium">What it will ask for</h3>
          <ul className="mt-1 space-y-1.5">{s.asks.map((a: any, i: number) => <li key={i}><b>{a.counterparty}</b>: {a.text} <span className="text-ink-soft">{a.accepts}</span></li>)}</ul></section>
        <section><h3 className="font-medium">If everyone agrees</h3><ul className="mt-1 list-disc space-y-1 pl-5">{s.then.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul></section>
        <section><h3 className="font-medium">What it will never do</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">{s.never.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul></section>
        <p className="text-xs text-ink-soft">The plan&apos;s fingerprint is <span className="font-mono">{p.termsHash.slice(0, 12)}…</span>; it is the same one the owner signed, so you are confirming exactly what they saw.</p>
        {isApprover && p.canConfirm ? (
          <div className="rounded-lg border border-line bg-white/70 p-3">
            <div className="max-w-sm"><Field label="Your own password"><input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field></div>
            {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
            <div className="mt-3 flex flex-wrap gap-3">
              <Btn busy={busy === "approve"} disabled={!password || busy !== null} onClick={() => decide("approve")}>Confirm this plan</Btn>
              <Btn variant="secondary" busy={busy === "decline"} disabled={!password || busy !== null} onClick={() => decide("decline")}>Decline</Btn>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-line bg-white/70 p-3 text-ink-soft">{isApprover ? "You gave the first confirmation for this plan, so a different approver must give the second." : "This needs a person with an approver account. Ask them to sign in and open Approvals."}</p>
        )}
      </div>
    </Card>
  );
}
