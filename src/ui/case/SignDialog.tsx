"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Sign a plan, in three steps. 1) Read exactly what the signature covers (plain language, built from the same terms that are hashed and signed).
// 2) Write the proposal letters: a professional first draft per counterparty that you edit like a document; the generated terms stay locked under it.
// 3) Sign: draw your signature and re-enter your password (step-up). A plan with large supplier payments needs a second, different approver.
// The letters and the drawing are bound by the signature: once signed, neither can change.
import { useEffect, useMemo, useState } from "react";
import { Btn, Chip, ErrorNote, Field, Loading, Modal, Seal, inputClass } from "../kit";
import { dateTime, short } from "../format";
import { call, useSession } from "../session";
import { LetterEditor } from "./LetterEditor";
import { SignaturePad } from "./SignaturePad";

const STEPS = ["Review the terms", "Write the proposals", "Sign"] as const;

export function SignDialog({ open, onClose, runId, planId, onSigned }: { open: boolean; onClose: () => void; runId: string; planId: string | null; onSigned: (authorisationId: string) => void }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const [prev, setPrev] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [letters, setLetters] = useState<Record<string, { subject: string; paragraphs: string[] }>>({});
  const [tab, setTab] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("finance@mercer-vale.example");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !planId) return;
    setPrev(null); setError(null); setPassword(""); setPassword2(""); setStep(0); setSignature(null); setLetters({}); setTab(null);
    void call(`/api/business/${biz}/plan-authorisations/preview`, { runId, planId }).then((r) => {
      if (!r.ok) { setError(r.data.error ?? "Could not prepare the signing summary"); return; }
      setPrev(r.data);
      setLetters(JSON.parse(JSON.stringify(r.data.letters ?? {})));
      setTab(r.data.counterparties?.[0]?.id ?? null);
    });
  }, [open, planId, runId, biz]);

  const cps: { id: string; name: string; role: string }[] = prev?.counterparties ?? [];
  const nameOf = (id: string) => (cps.find((c) => c.id === id)?.name ?? "a counterparty").replace(" (SYNTHETIC)", "");
  const dateText = useMemo(() => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), []);
  const lettersOk = cps.length > 0 && cps.every((c) => letters[c.id]?.subject.trim() && letters[c.id]?.paragraphs.some((p) => p.trim()));

  async function sign() {
    setBusy(true); setError(null);
    const second = prev.needsSecondConfirmation;
    const r = await call(`/api/business/${biz}/plan-authorisations`, { runId, planId, confirmations: second ? 2 : 1, password, letters, signatureImage: signature, ...(second ? { secondApprover: { email, password: password2 } } : {}) });
    setBusy(false);
    if (r.ok) { onSigned(r.data.authorisationId); onClose(); return; }
    setError(r.status === 422 ? `Not signed. Your limits block this plan: ${(r.data.problems?.[0] ?? r.data.gates?.find((g: any) => g.decision === "deny")?.reasons?.[0] ?? "see the mandate page")}` : r.data.error ?? "Could not sign");
  }

  const s = prev?.summary;
  const denied = prev?.denied;
  return (
    <Modal open={open} onClose={onClose} title="Sign this plan" wide>
      {!prev && !error && <Loading label="Preparing exactly what you would sign" />}
      {error && !prev && <ErrorNote>{error}</ErrorNote>}
      {prev && (
        <div className="space-y-4 text-sm">
          {!denied && (
            <ol className="grid grid-cols-3 gap-2" aria-label="Signing steps">
              {STEPS.map((label, i) => (
                <li key={label} aria-current={i === step ? "step" : undefined} className={`rounded-lg border px-3 py-1.5 ${i === step ? "border-accent bg-accent-soft text-accent" : i < step ? "border-good/40 bg-good-soft text-good" : "border-line text-ink-soft"}`}><span className="num text-xs opacity-70">{i + 1}</span> <span className="font-medium">{label}</span></li>
              ))}
            </ol>
          )}

          {denied && (
            <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-danger"><b>Your limits block this plan, so it cannot be signed.</b><ul className="mt-1 list-disc pl-5">{[...prev.problems, ...prev.gates.filter((g: any) => g.decision === "deny").flatMap((g: any) => g.reasons)].slice(0, 4).map((p: string, i: number) => <li key={i}>{p}</li>)}</ul></div>
          )}

          {!denied && step === 0 && (
            <>
              <p className="text-ink-soft">By signing, you let the system do <b>only</b> the following, and nothing else. It is checked again against your mandate before every step.</p>
              <section>
                <h3 className="mb-1 font-medium">It will ask</h3>
                <ul className="space-y-2">{s.asks.map((a: any, i: number) => (
                  <li key={i} className="rounded-lg border border-line bg-white/70 p-3"><p><b>{a.counterparty}</b>: {a.text}</p><p className="text-xs text-ink-soft">It will accept: {a.accepts}</p></li>))}</ul>
              </section>
              <section><h3 className="mb-1 font-medium">Then</h3><ul className="list-disc space-y-1 pl-5 text-ink-soft">{s.then.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul></section>
              <section><h3 className="mb-1 font-medium text-danger">It will never</h3><ul className="list-disc space-y-1 pl-5 text-ink-soft">{s.never.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul></section>
            </>
          )}

          {!denied && step === 1 && (
            <>
              <p className="text-ink-soft">Each counterparty receives a short professional letter with the terms underneath. This is a first draft written for you: change any line, add or remove paragraphs. After you sign, the letters cannot be changed (to change one, cancel and start again).</p>
              {cps.length > 1 && (
                <div role="tablist" aria-label="Letters" className="flex flex-wrap gap-2">
                  {cps.map((c) => <button key={c.id} role="tab" aria-selected={tab === c.id} onClick={() => setTab(c.id)} className={`rounded-lg border px-3 py-1.5 text-sm ${tab === c.id ? "border-accent bg-accent-soft font-medium text-accent" : "border-line hover:bg-neutral-soft"}`}>{nameOf(c.id)}</button>)}
                </div>
              )}
              {tab && letters[tab] && (
                <LetterEditor
                  letter={letters[tab]} onChange={(l) => setLetters((p) => ({ ...p, [tab]: l }))} onReset={() => setLetters((p) => ({ ...p, [tab]: JSON.parse(JSON.stringify(prev.letters[tab])) }))}
                  to={nameOf(tab)} from={prev.owner} business={String(prev.business).replace(" (SYNTHETIC)", "")} dateText={dateText} termLines={prev.termLines?.[tab] ?? []}
                />
              )}
              {!lettersOk && <p className="text-xs text-caution">Every letter needs a subject and at least one paragraph.</p>}
            </>
          )}

          {!denied && step === 2 && (
            <>
              <section className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white/70 p-3">
                <Seal>Mandate version {prev.mandateVersion}</Seal><span>Valid until <b>{dateTime(prev.expiresAt)}</b></span>
                <span className="text-xs text-ink-soft">The terms are fingerprinted: <span className="font-mono">{short(prev.termsHash, 12)}</span>. Your letters and your drawn signature are fingerprinted into the same signature.</span>
              </section>
              <section className="space-y-3">
                <h3 className="font-medium">Draw your signature</h3>
                <SignaturePad name={(session?.user.displayName ?? "the owner").replace(/\s*\([^)]*\)\s*$/, "")} onChange={setSignature} />
              </section>
              <section className="space-y-3 border-t border-line pt-4">
                <h3 className="font-medium">Confirm it is you</h3>
                <Field label={`Your password (${session?.user.displayName})`}><input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
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
          <div className="flex justify-between gap-2 pt-1">
            <div>{!denied && step > 0 && <Btn variant="secondary" onClick={() => { setError(null); setStep(step - 1); }}>Back</Btn>}</div>
            <div className="flex gap-2">
              <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
              {!denied && step === 0 && <Btn onClick={() => setStep(1)}>Next: write the proposals</Btn>}
              {!denied && step === 1 && <Btn disabled={!lettersOk} onClick={() => setStep(2)}>Next: sign</Btn>}
              {!denied && step === 2 && <Btn busy={busy} disabled={!signature || !password || (prev.needsSecondConfirmation && !password2)} onClick={sign}>Sign and authorise</Btn>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
