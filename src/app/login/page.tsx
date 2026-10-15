"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Btn, ErrorNote, Field, inputClass } from "@/ui/kit";
import { call } from "@/ui/session";

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}

function LoginForm() {
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState("owner@mercer-vale.example");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await call<{ error?: string }>("/api/auth/login", { email, password });
    if (r.ok) { window.location.href = next && next.startsWith("/") ? next : "/room"; return; }
    setError(r.data.error ?? "Sign-in failed.");
    setBusy(false);
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-5xl items-center gap-10 px-6 py-12 md:grid-cols-2">
      <section>
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-accent">Ledgerhand</p>
        <h1 className="display mt-3 text-4xl leading-tight md:text-5xl">Your finance agent investigates and proposes. <span className="text-accent">You sign the limits.</span></h1>
        <ol className="mt-8 space-y-4 text-ink-soft">
          <li className="flex gap-3"><span className="display text-accent">1</span><span><b className="text-ink">The agent proposes.</b> It reads your books and documents, finds a cash shortage and lays out plans. Every number comes from deterministic code.</span></li>
          <li className="flex gap-3"><span className="display text-accent">2</span><span><b className="text-ink">You sign the limits.</b> Nothing happens without your signature, and the signature covers exactly what you read.</span></li>
          <li className="flex gap-3"><span className="display text-accent">3</span><span><b className="text-ink">The system acts inside them.</b> Every step is gated, independently verified and written to a tamper-evident log.</span></li>
        </ol>
        <p className="mt-8 rounded-lg border border-caution/40 bg-caution-soft px-3 py-2 text-sm text-caution">All data here is synthetic. The bank, customers, suppliers and lenders are a sandbox. No real money moves.</p>
      </section>
      <form onSubmit={submit} className="rounded-2xl border border-line bg-panel p-7 shadow-sm" aria-label="Sign in">
        <h2 className="display text-2xl">Sign in</h2>
        <p className="mb-5 text-sm text-ink-soft">Owner account for Mercer &amp; Vale Packaging Ltd (SYNTHETIC).</p>
        <div className="space-y-4">
          <Field label="Email"><input className={inputClass} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password"><input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Btn type="submit" busy={busy} className="w-full">Sign in</Btn>
        </div>
        <details className="mt-5 text-xs text-ink-soft">
          <summary className="cursor-pointer">Demo accounts (synthetic, local only)</summary>
          <p className="mt-2">Owner: owner@mercer-vale.example / Ledger-Owner-2026<br />Second approver: finance@mercer-vale.example / Ledger-Approver-2026</p>
        </details>
      </form>
    </main>
  );
}
