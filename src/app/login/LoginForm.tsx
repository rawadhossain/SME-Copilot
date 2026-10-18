"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Btn, ErrorNote, Field, inputClass, Note } from "@/ui/kit";
import { call } from "@/ui/session";

export default function LoginForm({ demo }: { demo: boolean }) {
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState(demo ? "owner@mercer-vale.example" : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await call<{ error?: string }>("/api/auth/login", { email, password });
    if (r.ok) { window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/room"; return; }
    setError(r.data.error ?? "Sign-in failed.");
    setBusy(false);
  }

  const points = [
    ["Watches and suggests", "Reads your books, spots a cash gap early, lays out fixes. Every figure is calculated."],
    ["You set limits and sign", "Nothing happens without your signature."],
    ["Acts only inside them", "Every step is checked and written to a record nobody can quietly change."],
  ];
  return (
    <main className="mx-auto grid min-h-screen max-w-5xl items-center gap-12 px-6 py-12 md:grid-cols-[1.1fr_1fr]">
      <section>
        <p className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight text-ink">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-[#2b7563] to-accent text-white shadow-[0_1px_2px_rgb(21_68_57/0.35),0_1px_0_rgb(255_255_255/0.2)_inset]" aria-hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 19V9M12 19V5M19 19v-7" /></svg></span>
          Ledgerhand
        </p>
        <h1 className="display mt-8 text-4xl leading-[1.1] md:text-[44px]">Know where your cash is heading. <span className="text-accent">You stay in charge.</span></h1>
        <ul className="mt-8 space-y-4">
          {points.map(([t, d], i) => (
            <li key={t} className="flex items-start gap-3.5">
              <span className="num grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">{i + 1}</span>
              <span className="text-[15px] text-ink-soft"><b className="font-medium text-ink">{t}.</b> {d}</span>
            </li>
          ))}
        </ul>
        {demo && <div className="mt-8"><Note>Demonstration with made-up data. No real money moves.</Note></div>}
      </section>
      <form onSubmit={submit} className="glass-pop rounded-3xl p-8" aria-label="Sign in">
        <h2 className="display text-2xl">Sign in</h2>
        <p className="mb-6 mt-1 text-sm text-ink-soft">Use the email and password for your account.</p>
        <div className="space-y-4">
          <Field label="Email"><input className={inputClass} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password"><input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!demo || email !== ""} /></Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Btn type="submit" busy={busy} className="w-full">Sign in</Btn>
        </div>
        {demo && (
          <details className="mt-5 text-xs text-ink-soft">
            <summary className="cursor-pointer">Demo accounts (made-up, local only)</summary>
            <p className="mt-2">Owner: owner@mercer-vale.example / Ledger-Owner-2026<br />Second approver: finance@mercer-vale.example / Ledger-Approver-2026</p>
          </details>
        )}
      </form>
    </main>
  );
}
