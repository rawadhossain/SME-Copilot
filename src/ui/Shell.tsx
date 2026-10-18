"use client";
// The app frame: brand, which business, navigation, who is signed in. Demo and developer tools are not here (see /dev).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Btn, Loading } from "./kit";
import { SectionTabs, groupOf, navGroups } from "./SectionTabs";
import { AlertBadge, AlertsProvider, HeaderAlerts } from "./alerts";
import { CopilotDrawer } from "./CopilotDrawer";
import { SessionProvider, call, useSession } from "./session";

export function Shell({ children }: { children: React.ReactNode }) {
  return <SessionProvider><AlertsProvider><Frame>{children}</Frame></AlertsProvider></SessionProvider>;
}

function Frame({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const path = usePathname();
  if (!session) return <Loading label="Opening Ledgerhand" />;

  async function signOut() {
    await call("/api/auth/logout", {});
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload on purpose: it resets all signed-in state
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-white">Skip to the main content</a>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <Link href="/room" className="display text-xl text-accent">Ledgerhand</Link>
          <span className="truncate text-sm font-medium">{session.business.name.replace(" (SYNTHETIC)", "")}</span>
          <HeaderAlerts />
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            <CopilotDrawer />
            <span className="text-ink-soft">{session.user.displayName}</span>
            <Btn variant="ghost" onClick={signOut}>Sign out</Btn>
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4">
          {navGroups(session.user.role).map((g) => {
            const on = groupOf(path, navGroups(session.user.role))?.id === g.id;
            return <Link key={g.id} href={g.href} aria-current={on ? "page" : undefined} className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${on ? "border-accent text-accent" : "border-transparent text-ink-soft hover:text-ink"}`}>{g.label}{g.id === "today" && <AlertBadge label="alerts need your attention" />}</Link>;
          })}
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-6 outline-none"><SectionTabs />{children}</main>
      {session.business.isSynthetic && (
        <footer className="mx-auto max-w-7xl px-5 pb-8 text-xs text-ink-soft">Sample company with made-up data. No real money moves and no real bank or lender is contacted.{session.demoTools && <> <Link href="/dev" className="underline">Demo tools</Link></>}</footer>
      )}
    </div>
  );
}
