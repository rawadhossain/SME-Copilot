"use client";
// The app frame: brand, which business, navigation, who is signed in. Demo and developer tools are not here (see /dev).
// Desktop layout: a floating frosted sidebar inset from the window edges with the five areas, and a glass bar on top that carries what is global:
// where you are (a breadcrumb), alerts, notifications, Ask Copilot and the account menu, always in the same place. The area's tabs sit under each page title (PageHead).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loading } from "./kit";
import { Icon, type IconName } from "./icons";
import { groupOf, navGroups } from "./SectionTabs";
import { AlertBadge, AlertsProvider, HeaderAlerts } from "./alerts";
import { CopilotDrawer } from "./CopilotDrawer";
import { NotificationBell } from "./notifications";
import { SessionProvider, call, useSession } from "./session";

const ICON: Record<string, IconName> = { today: "today", books: "books", plans: "plans", ahead: "ahead", safety: "safety" };

export function Shell({ children }: { children: React.ReactNode }) {
  return <SessionProvider><AlertsProvider><Frame>{children}</Frame></AlertsProvider></SessionProvider>;
}

/** The company card at the foot of the sidebar. With more than one company it opens a short list; choosing one uses the existing switch API. */
function Company() {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  if (!session) return null;
  const name = session.business.name.replace(" (SYNTHETIC)", "");
  const others = session.businesses.filter((b) => b.id !== session.business.id);
  async function pick(id: string) {
    const r = await call("/api/auth/business", { businessId: id });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload on purpose: it resets all signed-in state
    if (r.ok) window.location.assign("/room");
  }
  const inner = (
    <>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-sm font-semibold text-accent" aria-hidden>{name[0]}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
        {session.business.isSynthetic && <span className="block text-xs text-ink-soft">Sample data</span>}
      </span>
      {others.length > 0 && <Icon name="chevron" size={15} className="shrink-0 text-ink-soft" />}
    </>
  );
  return (
    <div ref={box} className="relative">
      {others.length > 0 ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox" className="glass-card press flex w-full items-center gap-3 p-2.5">{inner}</button>
      ) : <div className="glass-card flex items-center gap-3 p-2.5">{inner}</div>}
      {open && (
        <ul role="listbox" aria-label="Switch company" className="glass-pop fade-in absolute bottom-full left-0 right-0 z-40 mb-2 rounded-2xl p-1.5">
          {others.map((b) => <li key={b.id}><button type="button" role="option" aria-selected={false} onClick={() => void pick(b.id)} className="row-hover w-full truncate rounded-xl px-3 py-2 text-left text-sm">{b.name.replace(" (SYNTHETIC)", "")}</button></li>)}
        </ul>
      )}
    </div>
  );
}

/** The signed-in person: initials in the top bar, opening a small menu with their name, role and Sign out. */
function AvatarMenu({ who, role, initials, onSignOut }: { who: string; role: string; initials: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-label={`Account menu for ${who}`}
        className="press grid h-9 w-9 place-items-center rounded-full bg-accent text-xs font-semibold text-white shadow-soft hover:bg-accent-strong">{initials}</button>
      {open && (
        <div role="menu" aria-label="Account" className="glass-pop fade-in absolute right-0 top-11 z-40 w-56 rounded-2xl p-1.5">
          <div className="px-3 py-2"><p className="truncate text-sm font-medium text-ink">{who}</p><p className="text-xs capitalize text-ink-soft">{role}</p></div>
          <button type="button" role="menuitem" onClick={onSignOut} className="row-hover flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm"><Icon name="signout" size={16} className="text-ink-soft" />Sign out</button>
        </div>
      )}
    </div>
  );
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

  const groups = navGroups(session.user.role);
  const current = groupOf(path, groups);
  const who = session.user.displayName.replace(/\s*\(.*\)$/, "");
  const initials = who.split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();

  const tab = current?.tabs.length ? current.tabs.find((t) => path === t.href || path.startsWith(`${t.href}/`)) : undefined;

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-white">Skip to the main content</a>

      <aside className="sidebar-glass fixed bottom-[var(--sidebar-gap)] left-[var(--sidebar-gap)] top-[var(--sidebar-gap)] z-30 flex w-[var(--sidebar-w)] flex-col px-3 py-4">
        <Link href="/room" className="press mb-6 flex items-center gap-2.5 rounded-xl px-2 py-1">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-[#2b7563] to-accent text-white shadow-[0_1px_2px_rgb(21_68_57/0.35),0_1px_0_rgb(255_255_255/0.2)_inset]" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 19V9M12 19V5M19 19v-7" /></svg>
          </span>
          <span className="display text-[17px] text-ink">Ledgerhand</span>
        </Link>

        <nav aria-label="Main" className="flex flex-col gap-1">
          {groups.map((g) => {
            const on = current?.id === g.id;
            return (
              <Link key={g.id} href={g.href} aria-current={on ? "page" : undefined} className="nav-item">
                <Icon name={ICON[g.id] ?? "today"} className={on ? "text-accent" : ""} />
                <span className="flex-1">{g.label}</span>
                {g.id === "today" && <AlertBadge label="alerts need your attention" />}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <Company />
        </div>
      </aside>

      <div className="pl-[calc(var(--sidebar-w)+var(--sidebar-gap)*2)]">
        <header className="glass sticky top-0 z-20">
          <div className="mx-auto flex h-16 max-w-[1280px] items-center gap-3 px-8">
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              <ol className="flex items-center gap-2 truncate text-[14px] text-ink-soft">
                {current && tab ? (
                  <>
                    <li><Link href={current.href} className="rounded-md hover:text-ink">{current.label}</Link></li>
                    <li aria-hidden className="text-ink-soft/60">/</li>
                    <li aria-current="page" className="truncate font-medium text-ink">{tab.label}</li>
                  </>
                ) : <li aria-current="page" className="truncate font-medium text-ink">{current?.label ?? "Ledgerhand"}</li>}
              </ol>
            </nav>
            <div className="flex shrink-0 items-center gap-2.5">
              <HeaderAlerts />
              <NotificationBell />
              <CopilotDrawer />
              <AvatarMenu who={who} role={session.user.role} initials={initials} onSignOut={signOut} />
            </div>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-[1280px] px-8 pb-12 pt-8 outline-none">{children}</main>
        {session.business.isSynthetic && (
          <footer className="mx-auto max-w-[1280px] px-8 pb-8 text-xs text-ink-soft">Sample company, made-up data. No real money moves and no real bank or lender is contacted.{session.demoTools && <> <Link href="/dev" className="underline">Demo tools</Link></>}</footer>
        )}
      </div>
    </div>
  );
}
