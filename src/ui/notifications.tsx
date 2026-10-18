"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// The header bell: how many notifications are unread, and a small list in plain words. In-app only (sandbox): nothing is emailed. The server decides who
// sees what (addressed to them or to their role). Automation text is data, so it is rendered as text (React escapes it) and never as markup.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ago } from "./alerts";
import { Icon } from "./icons";
import { Chip, DeepLink, type Tone } from "./kit";
import { call, useSession } from "./session";

const KIND: Record<string, { label: string; tone: Tone }> = {
  notice: { label: "Heads-up", tone: "caution" },
  digest: { label: "Weekly digest", tone: "accent" },
  draft_reminder: { label: "Draft letter", tone: "neutral" },
  simulation: { label: "What-if", tone: "accent" },
  plans_prepared: { label: "Plans ready", tone: "good" },
};

export function NotificationBell() {
  const { session } = useSession();
  const biz = session?.business.id;
  const path = usePathname();
  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/notifications`);
    if (r.ok) { setItems(r.data.notifications); setUnread(r.data.unread); }
  }, [biz]);
  useEffect(() => { void load(); }, [load, path]);
  useEffect(() => { const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  // Other screens (for example Automations, after you decide on a draft) ask the bell to look again.
  useEffect(() => { const on = () => void load(); window.addEventListener("notifications-changed", on); return () => window.removeEventListener("notifications-changed", on); }, [load]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  async function read(ids: string[] | "all") {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/notifications/read`, ids === "all" ? { all: true } : { ids });
    if (r.ok) await load();
  }
  function toggle(n: any) {
    setOpenId((cur) => (cur === n.id ? null : n.id));
    if (!n.readAt) void read([n.id]);
  }
  async function copy(n: any) {
    try { await navigator.clipboard.writeText(n.body); setCopied(n.id); setTimeout(() => setCopied(null), 1600); } catch { /* the text is on screen to select */ }
  }

  if (!session) return null;
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="press relative grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-white text-ink-soft hover:border-accent/50 hover:text-ink">
        <Icon name="bell" size={17} />
        {unread > 0 && <span aria-hidden className="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold leading-[18px] text-white">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="fade-in absolute right-0 top-11 z-40 w-[420px] max-w-[calc(100vw-2rem)] glass-pop overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div><p className="display text-[15px]">Notifications</p><p className="text-xs text-ink-soft">In-app only (sandbox). Nothing is emailed.</p></div>
            <button type="button" disabled={unread === 0} onClick={() => void read("all")} className="press rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent-soft disabled:text-ink-soft/60 disabled:hover:bg-transparent">Mark all read</button>
          </div>
          <ul className="max-h-[min(460px,70vh)] divide-y divide-line overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-soft">Nothing yet. Notifications from your automations and checks appear here.</li>}
            {items.map((n) => {
              const k = KIND[n.kind] ?? KIND.notice;
              const on = openId === n.id;
              return (
                <li key={n.id} className={n.readAt ? "" : "bg-accent-soft/40"}>
                  <button type="button" onClick={() => toggle(n)} aria-expanded={on} className="row-hover flex w-full items-start gap-3 px-4 py-3 text-left">
                    <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-accent"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2"><Chip tone={k.tone}>{k.label}</Chip>{n.resolution && <Chip tone="neutral">{n.resolution === "sent_sandbox" ? "Sent (sandbox)" : "Discarded"}</Chip>}<span className="text-xs text-ink-soft">{ago(n.createdAt)}</span></span>
                      <span className={`mt-1 block text-sm ${n.readAt ? "text-ink" : "font-medium text-ink"}`}>{n.title}</span>
                      {!on && n.kind !== "draft_reminder" && <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-soft">{n.body}</span>}
                    </span>
                  </button>
                  {on && (
                    <div className="space-y-2 px-4 pb-3 pl-9">
                      <p className={`whitespace-pre-line text-[13px] text-ink-soft ${n.kind === "draft_reminder" ? "rounded-lg border border-line bg-panel-quiet p-3 text-ink" : ""}`}>{n.body}</p>
                      {n.note && <p className="text-[13px] text-ink"><span className="text-ink-soft">Your note: </span>{n.note}</p>}
                      <div className="flex items-center gap-3 text-[13px]">
                        <DeepLink href={n.link}>Open</DeepLink>
                        {n.kind === "draft_reminder" && <button type="button" onClick={() => void copy(n)} className="font-medium text-accent hover:underline">{copied === n.id ? "Copied" : "Copy the draft"}</button>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
