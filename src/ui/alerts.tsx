"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Alerts on Today. The monitor (plain code, no model) raises them; this only shows them. State lives in one provider so the panel on Today and the count
// badges in the header and navigation always agree.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Btn, Card, Chip, type Tone } from "./kit";
import { call, useSession } from "./session";

interface AlertsState {
  alerts: any[];
  lastRunAt: string | null;
  loaded: boolean;
  /** Open urgent + watch alerts: what the badges count. */
  badge: number;
  reload: () => Promise<void>;
  acknowledge: (id: string) => Promise<boolean>;
  checkNow: () => Promise<void>;
}
const Ctx = createContext<AlertsState>({ alerts: [], lastRunAt: null, loaded: false, badge: 0, reload: async () => {}, acknowledge: async () => false, checkNow: async () => {} });
export const useAlerts = () => useContext(Ctx);

export function AlertsProvider({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const path = usePathname();
  const [data, setData] = useState<{ alerts: any[]; lastRunAt: string | null; loaded: boolean }>({ alerts: [], lastRunAt: null, loaded: false });

  const reload = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/alerts`);
    if (r.ok) setData({ alerts: r.data.alerts, lastRunAt: r.data.lastRunAt, loaded: true });
  }, [biz]);
  useEffect(() => { void reload(); }, [reload, path]); // fresh on every screen change; the server decides whether the monitor needs to run

  const acknowledge = useCallback(async (id: string) => {
    const r = await call(`/api/alerts/${id}/acknowledge`, {});
    if (r.ok) await reload();
    return r.ok;
  }, [reload]);
  const checkNow = useCallback(async () => {
    if (!biz) return;
    await call(`/api/business/${biz}/monitor/run`, {});
    await reload();
  }, [biz, reload]);

  const badge = data.alerts.filter((a) => a.status === "open" && (a.severity === "urgent" || a.severity === "watch")).length;
  const value = useMemo(() => ({ ...data, badge, reload, acknowledge, checkNow }), [data, badge, reload, acknowledge, checkNow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A small count for the header and the Today tab: open urgent and watch alerts. */
export function AlertBadge({ label }: { label: string }) {
  const { badge } = useAlerts();
  if (badge === 0) return null;
  return <span aria-label={`${badge} ${label}`} className="ml-1.5 inline-grid min-w-5 place-items-center rounded-full bg-danger px-1.5 text-xs font-semibold leading-5 text-white">{badge}</span>;
}

/** Header reminder on every screen: how many alerts are open (urgent or watch), linking to Today where they are listed. */
export function HeaderAlerts() {
  const { badge, alerts } = useAlerts();
  if (badge === 0) return null;
  const urgent = alerts.some((a) => a.status === "open" && a.severity === "urgent");
  return <Link href="/room" className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${urgent ? "border-danger/40 bg-danger/10 text-danger" : "border-caution/40 bg-caution/10 text-caution"}`}>{badge} open alert{badge === 1 ? "" : "s"}{urgent ? " · urgent" : ""}</Link>;
}

const SEVERITY: Record<string, { label: string; tone: Tone }> = {
  urgent: { label: "Urgent", tone: "danger" },
  watch: { label: "Keep an eye on this", tone: "caution" },
  info: { label: "For your information", tone: "neutral" },
};

/** "3 minutes ago", "2 hours ago": real time since the alert first appeared. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function AlertsPanel() {
  const { alerts, lastRunAt, loaded, acknowledge, checkNow } = useAlerts();
  const [busy, setBusy] = useState<string | null>(null);
  const open = alerts.filter((a) => a.status === "open");
  const seen = alerts.filter((a) => a.status === "acknowledged");
  if (!loaded) return null;

  return (
    <Card title="Alerts" tone={open.some((a) => a.severity === "urgent") ? "danger" : open.length > 0 ? "caution" : "good"}
      subtitle="Things the assistant noticed in your books. It checks automatically; it never acts on them by itself, except to prepare a recovery for you to review."
      right={<Btn variant="ghost" busy={busy === "check"} onClick={async () => { setBusy("check"); await checkNow(); setBusy(null); }}>Check now</Btn>}>
      {open.length === 0 ? (
        <div>
          <p className="font-medium">Nothing needs your attention</p>
          <p className="text-sm text-ink-soft">{lastRunAt ? `Last checked ${ago(lastRunAt)}.` : "Not checked yet."}{seen.length > 0 ? ` ${seen.length} earlier alert${seen.length === 1 ? " is" : "s are"} under “Seen”.` : ""}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {open.map((a) => {
            const sev = SEVERITY[a.severity] ?? SEVERITY.info;
            const route = a.refs?.route ?? "/room";
            return (
              <li key={a.id} className="rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <Chip tone={sev.tone}>{sev.label}</Chip>
                    <p className="mt-2 font-medium">{a.title}</p>
                    <p className="mt-1 text-sm">{a.detail}</p>
                    <p className="mt-1 text-xs text-ink-soft">First noticed {ago(a.firstSeenAt)}.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Btn href={route}>{a.refs?.label ?? "Open"}</Btn>
                    <Btn variant="secondary" busy={busy === a.id} onClick={async () => { setBusy(a.id); await acknowledge(a.id); setBusy(null); }}>Got it</Btn>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open.length > 0 && lastRunAt && <p className="mt-3 text-xs text-ink-soft">Last checked {ago(lastRunAt)}.</p>}
      {seen.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Seen ({seen.length})</summary>
          <ul className="mt-2 space-y-2 text-sm">
            {seen.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-2">
                <span><b>{a.title}</b> <span className="text-ink-soft">({(SEVERITY[a.severity] ?? SEVERITY.info).label.toLowerCase()}; marked as seen by {a.acknowledgedBy ?? "someone"})</span></span>
                <a href={a.refs?.route ?? "/room"} className="text-accent underline">{a.refs?.label ?? "Open"}</a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
