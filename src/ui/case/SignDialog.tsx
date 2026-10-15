"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Sign a plan. Step 1: read exactly what the signature covers (plain language, built from the same terms that are hashed and signed).
// Step 2: re-enter your password (step-up). A plan with large supplier payments needs a second, different approver.
import { useEffect, useState } from "react";
import { Btn, Chip, ErrorNote, Field, Loading, Modal, Seal, inputClass } from "../kit";
import { dateTime, short } from "../format";
import { call, useSession } from "../session";

export function SignDialog({ open, onClose, runId, planId, onSigned }: { open: boolean; onClose: () => void; runId: string; planId: string | null; onSigned: (authorisationId: string) => void }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const [prev, setPrev] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("finance@mercer-vale.example");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !planId) return;
    setPrev(null); setError(null); setPassword(""); setPassword2("");
    void call(`/api/business/${biz}/plan-authorisations/preview`, { runId, planId }).then((r) => (r.ok ? setPrev(r.data) : setError(r.data.error ?? "Could not prepare the signing summary")));
  }, [open, planId, runId, biz]);

  async function sign() {
    setBusy(true); setError(null);
    const second = prev.needsSecondConfirmation;
    const r = await call(`/api/business/${biz}/plan-authorisations`, { runId, planId, confirmations: second ? 2 : 1, password, ...(second ? { secondApprover: { email, password: password2 } } : {}) });
    setBusy(false);
    if (r.ok) { onSigned(r.data.authorisationId); onClose(); return; }
    setError(r.status === 422 ? `Not signed. Your limits block this plan: ${(r.data.problems?.[0] ?? r.data.gates?.find((g: any) => g.decision === "deny")?.reasons?.[0] ?? "see the mandate page")}` : r.data.error ?? "Could not sign");
  }

  const s = prev?.summary;
  return (
    <Modal open={open} onClose={onClose} title="Sign this plan">
      {!prev && !error && <Loading label="Preparing exactly what you would sign" />}
      {error && !prev && <ErrorNote>{error}</ErrorNote>}
      {prev && (
        <div className="space-y-4 text-sm">
          {prev.denied ? (
            <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-danger"><b>Your limits block this plan, so it cannot be signed.</b><ul className="mt-1 list-disc pl-5">{[...prev.problems, ...prev.gates.filter((g: any) => g.decision === "deny").flatMap((g: any) => g.reasons)].slice(0, 4).map((p: string, i: number) => <li key={i}>{p}</li>)}</ul></div>
          ) : (
            <>
              <p className="text-ink-soft">By signing, you let the system do <b>only</b> the following, and nothing else. It is checked again against your mandate before every step.</p>
              <section>
                <h3 className="mb-1 font-medium">It will ask</h3>
                <ul className="space-y-2">{s.asks.map((a: any, i: number) => (
                  <li key={i} className="rounded-lg border border-line bg-white/70 p-3"><p><b>{a.counterparty}</b>: {a.text}</p><p className="text-xs text-ink-soft">It will accept: {a.accepts}</p></li>))}</ul>
              </section>
              <section><h3 className="mb-1 font-medium">Then</h3><ul className="list-disc space-y-1 pl-5 text-ink-soft">{s.then.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul></section>
              <section><h3 className="mb-1 font-medium text-danger">It will never</h3><ul className="list-disc space-y-1 pl-5 text-ink-soft">{s.never.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul></section>
              <section className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white/70 p-3">
                <Seal>Mandate version {prev.mandateVersion}</Seal><span>Valid until <b>{dateTime(prev.expiresAt)}</b></span>
                <span className="text-xs text-ink-soft">What you sign is fingerprinted: <span className="font-mono">{short(prev.termsHash, 12)}</span></span>
              </section>
              <section className="space-y-3 border-t border-line pt-4">
                <h3 className="font-medium">Confirm it is you</h3>
                <Field label={`Your password (${session?.user.displayName})`}><input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
                {prev.needsSecondConfirmation && (
                  <div className="rounded-lg border border-caution/40 bg-caution-soft p-3">
                    <p className="mb-2 flex items-center gap-2 text-caution"><Chip tone="caution">second confirmation</Chip>This plan can schedule supplier payments above your mandate&apos;s threshold, so a different approver must confirm too.</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Second approver email"><input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
                      <Field label="Their password"><input className={inputClass} type="password" autoComplete="off" value={password2} onChange={(e) => setPassword2(e.target.value)} /></Field>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            {!prev.denied && <Btn busy={busy} disabled={!password || (prev.needsSecondConfirmation && !password2)} onClick={sign}>Sign and authorise</Btn>}
          </div>
        </div>
      )}
    </Modal>
  );
}
