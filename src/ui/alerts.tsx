"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Alerts on Today. The monitor (plain code, no model) raises them; this only shows them. State lives in one provider so the panel on Today and the count
// badges in the header and navigation always agree.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Btn, Card, Chip, DeepLink, type Tone } from "./kit";
import { Icon } from "./icons";
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
  return <Link href="/room" className={`press inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${urgent ? "border-danger/30 bg-danger-soft text-danger" : "border-caution/30 bg-caution-soft text-caution"}`}><Icon name="info" size={13} />{badge} open alert{badge === 1 ? "" : "s"}{urgent ? " · urgent" : ""}</Link>;
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
      right={<Btn variant="ghost" size="sm" className="-mr-2" busy={busy === "check"} onClick={async () => { setBusy("check"); await checkNow(); setBusy(null); }}><Icon name="refresh" size={14} />Check now</Btn>}>
      {open.length === 0 ? (
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-good-soft text-good" aria-hidden><Icon name="check" size={16} /></span>
          <div>
            <p className="font-medium">Nothing needs your attention</p>
            <p className="text-xs text-ink-soft">{lastRunAt ? `Checked ${ago(lastRunAt)}` : "Not checked yet"}{seen.length > 0 ? ` · ${seen.length} seen` : ""}</p>
          </div>
        </div>
      ) : (
        <ul className="-my-1 divide-y divide-line">
          {open.map((a) => {
            const sev = SEVERITY[a.severity] ?? SEVERITY.info;
            const route = a.refs?.route ?? "/room";
            return (
              <li key={a.id} className="py-3.5">
                <Chip tone={sev.tone}>{sev.label}</Chip>
                <p className="mt-2 text-[15px] font-medium leading-snug">{a.title}</p>
                <p className="mt-1 line-clamp-2 text-[13px] text-ink-soft">{a.detail}</p>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <DeepLink href={route}>{a.refs?.label ?? "Open"}</DeepLink>
                  <Btn variant="ghost" size="sm" className="-mr-2 text-ink-soft" busy={busy === a.id} onClick={async () => { setBusy(a.id); await acknowledge(a.id); setBusy(null); }}>Got it</Btn>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open.length > 0 && lastRunAt && <p className="mt-3 text-xs text-ink-soft">Checked {ago(lastRunAt)}</p>}
      {seen.length > 0 && (
        <details className="mt-3 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">Seen ({seen.length})</summary>
          <ul className="mt-2 space-y-2 text-sm">
            {seen.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span><b className="font-medium">{a.title}</b> <span className="text-ink-soft">({(SEVERITY[a.severity] ?? SEVERITY.info).label.toLowerCase()}; seen by {a.acknowledgedBy ?? "someone"})</span></span>
                <DeepLink href={a.refs?.route ?? "/room"}>{a.refs?.label ?? "Open"}</DeepLink>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
