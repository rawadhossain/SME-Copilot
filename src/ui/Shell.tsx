"use client";
// The decision-room frame: brand, who is signed in, which (synthetic) business, navigation, and the one-line promise.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Chip, Btn, Loading } from "./kit";
import { NextStep } from "./NextStep";
import { SessionProvider, call, useSession } from "./session";

const NAV = [
  { href: "/room", label: "Today" },
  { href: "/room/commitments", label: "Orders & quotes" },
  { href: "/room/case", label: "Decisions" },
  { href: "/room/funding", label: "Funding" },
  { href: "/room/scoreboard", label: "Results" },
  { href: "/room/mandate", label: "Your limits" },
  { href: "/room/evidence", label: "Proof" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  return <SessionProvider><Frame>{children}</Frame></SessionProvider>;
}

function Frame({ children }: { children: React.ReactNode }) {
  const { session, refresh } = useSession();
  const path = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!session) return <Loading label="Opening your decision room" />;

  async function fresh() {
    setBusy(true);
    const r = await call("/api/demo/clone", {});
    setBusy(false);
    if (r.ok) {
      try { sessionStorage.setItem("ledgerhand.fresh", String(r.data.name ?? "a new demo run")); } catch { /* optional */ }
      window.location.assign("/room/commitments"); // a full reload: every screen starts clean on the new demo run; step 1 of the story is next
    }
  }
  async function switchTo(id: string) {
    await call("/api/auth/business", { businessId: id });
    await refresh();
    router.refresh();
    window.location.reload();
  }
  async function signOut() {
    await call("/api/auth/logout", {});
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-white">Skip to the main content</a>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <Link href="/room" className="display text-xl text-accent">Ledgerhand</Link>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate font-medium">{session.business.name.replace(" (SYNTHETIC)", "")}</span>
            {session.business.isTest && <Chip tone="accent">Demo run</Chip>}
            <Chip tone="caution">Synthetic data</Chip>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2 text-ink-soft">
              <span className="sr-only">Business</span>
              <select aria-label="Business" className="max-w-56 rounded-lg border border-line-strong bg-white px-2 py-1.5 text-sm text-ink" value={session.business.id} onChange={(e) => void switchTo(e.target.value)}>
                {session.businesses.map((b) => <option key={b.id} value={b.id}>{b.isTest ? "Demo run: " : ""}{b.name.replace(" (SYNTHETIC)", "")}</option>)}
              </select>
            </label>
            <Btn variant="secondary" busy={busy} onClick={fresh} title="Creates a new flagged copy of the demo business. Nothing existing is changed or erased.">Start a fresh demo</Btn>
            <span className="text-ink-soft">{session.user.displayName}</span>
            <Btn variant="ghost" onClick={signOut}>Sign out</Btn>
          </div>
        </div>
        <nav aria-label="Decision room" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4">
          {NAV.map((n) => {
            const on = n.href === "/room" ? path === "/room" : path.startsWith(n.href);
            return <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined} className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${on ? "border-accent text-accent" : "border-transparent text-ink-soft hover:text-ink"}`}>{n.label}</Link>;
          })}
        </nav>
      </header>
      <div className="border-b border-line bg-accent-soft/60">
        <p className="mx-auto max-w-7xl px-5 py-2 text-sm text-accent">Ledgerhand watches your cash. <b>It suggests fixes</b> → <b>you approve one</b> → <b>it acts only within the limits you set</b>, then checks its own work.</p>
      </div>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-6 outline-none"><NextStep />{children}</main>
    </div>
  );
}
