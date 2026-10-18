"use client";
// Shared primitives: Card, Stat/Metric (label, number, delta), Chip (badge), Btn (primary/secondary/ghost), Tabs, Table, Empty (empty state), Skeleton,
// Tooltip, InfoPopover, DeepLink, PageHead (page header), NextStepCard, Modal (dialog). Semantic tones only: good / caution / danger / neutral / accent.
// Press, lift and motion come from the shared classes in globals.css (.press, .lift, .rise), never per component.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { SectionTabs } from "./SectionTabs";

export type Tone = "good" | "caution" | "danger" | "neutral" | "accent";
const TONE: Record<Tone, string> = {
  good: "bg-good-soft text-good border-good/25",
  caution: "bg-caution-soft text-caution border-caution/30",
  danger: "bg-danger-soft text-danger border-danger/25",
  neutral: "bg-neutral-soft text-neutral border-line-strong",
  accent: "bg-accent-soft text-accent border-accent/25",
};
const TEXT: Record<Tone, string> = { good: "text-good", caution: "text-caution", danger: "text-danger", neutral: "text-ink", accent: "text-accent" };

export function Chip({ tone = "neutral", children, pulse }: { tone?: Tone; children: React.ReactNode; pulse?: boolean }) {
  return <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[tone]}`}><span className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? "pulse" : ""}`} aria-hidden />{children}</span>;
}

// A tone is carried by a hairline ring and a faint wash, never a thick coloured edge.
const RING: Record<string, string> = {
  danger: "border-danger/35 bg-panel",
  caution: "border-caution/35 bg-panel",
  good: "border-good/30",
  accent: "border-accent/30",
};

export function Card({ title, subtitle, right, children, tone, className = "" }: { title?: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; tone?: Tone; className?: string }) {
  const ring = tone && tone !== "neutral" ? RING[tone] : "border-line bg-panel";
  return (
    <section className={`rounded-2xl border ${ring} p-5 shadow-soft ${className}`}>
      {(title || right) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="display text-[17px] text-ink">{title}</h2>{subtitle && <p className="mt-0.5 max-w-prose text-sm text-ink-soft">{subtitle}</p>}</div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** A Card that is a native <details>: the title and a one-line takeaway are always visible, the body opens on demand. A link to #id opens it. */
export function Disclosure({ title, takeaway, chip, subtitle, right, tone, open, id, children }: { title: React.ReactNode; takeaway?: React.ReactNode; chip?: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode; tone?: Tone; open?: boolean; id?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (id && typeof window !== "undefined" && window.location.hash === `#${id}` && ref.current) { ref.current.open = true; ref.current.scrollIntoView({ block: "start" }); } }, [id]);
  const ring = tone && tone !== "neutral" ? RING[tone].split(" ")[0] : "border-line";
  return (
    <details ref={ref} id={id} open={open} className={`group scroll-mt-24 rounded-2xl border ${ring} bg-panel shadow-soft`}>
      <summary className="row-hover flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-3.5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0"><span className="display block text-[15px] text-ink">{title}</span>{takeaway && <span className="block text-sm text-ink-soft">{takeaway}</span>}</span>
        <span className="flex items-center gap-2">{chip}<Icon name="chevron" size={16} className="text-ink-soft transition-transform duration-200 group-open:rotate-180" /></span>
      </summary>
      <div className="border-t border-line px-5 pb-5 pt-4">
        {subtitle && <p className="mb-3 text-sm text-ink-soft">{subtitle}</p>}
        {right && <div className="mb-3">{right}</div>}
        {children}
      </div>
    </details>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4 shadow-soft">
      <p className="text-[13px] font-medium text-ink-soft">{label}</p>
      <p className={`display num mt-1 text-2xl ${TEXT[tone ?? "neutral"]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-soft">{sub}</p>}
    </div>
  );
}

/** A figure inside a grouped strip: no box of its own, so related numbers read as one statement. */
export function Figure({ label, value, sub, tone, badge }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; badge?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">{label}{badge}</p>
      <p className={`display num mt-1 truncate text-[28px] leading-tight ${TEXT[tone ?? "neutral"]}`}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-ink-soft">{sub}</p>}
    </div>
  );
}

const BTN = {
  primary: "bg-accent text-white shadow-[0_1px_2px_rgb(21_68_57/0.3),0_1px_0_rgb(255_255_255/0.14)_inset] hover:bg-accent-strong disabled:bg-accent/40 disabled:shadow-none",
  secondary: "border border-line-strong bg-panel text-ink hover:border-accent/40 hover:bg-accent-soft/60 disabled:opacity-50",
  danger: "bg-danger text-white hover:brightness-90 disabled:opacity-50",
  ghost: "text-accent hover:bg-accent-soft disabled:opacity-50",
};

/** The head every screen shares: a title, one line of context, and the page's main actions. */
export function PageHead({ title, sub, actions, back, info, tabs = true }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; back?: { href: string; label: string }; info?: React.ReactNode; tabs?: boolean }) {
  return (
    <div className="rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {back && <Link href={back.href} className="press -ml-2 mb-1 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-ink-soft hover:bg-accent-soft hover:text-accent"><Icon name="back" size={14} />Back to {back.label}</Link>}
        <h1 className="display text-[28px] leading-tight">{title}</h1>
        {(sub || info) && <p className="mt-0.5 max-w-3xl text-[15px] text-ink-soft">{sub}{info && <span className="ml-1.5 inline-block align-middle"><InfoPopover label="More about this page">{info}</InfoPopover></span>}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      {tabs && <SectionTabs />}
    </div>
  );
}

/** One figure: small label, large value, optional context. Used inside a .strip or on its own. */
export function Metric({ label, value, sub, tone, delta }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; delta?: { text: string; tone?: Tone } }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className={`display num mt-0.5 truncate text-[24px] leading-tight ${TEXT[tone ?? "neutral"]}`}>{value}</p>
      {(sub || delta) && <p className="mt-0.5 flex items-center gap-2 truncate text-xs text-ink-soft">{delta && <span className={`num font-medium ${TEXT[delta.tone ?? "neutral"]}`}>{delta.text}</span>}{sub}</p>}
    </div>
  );
}

export function Spinner() {
  return <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />;
}

export function Btn({ variant = "primary", size = "md", busy, href, className, children, ...p }: { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "md" | "sm"; busy?: boolean; href?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `press inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium disabled:cursor-not-allowed ${size === "sm" ? "h-8 px-3" : "h-10 px-4"} ${BTN[variant]} ${className ?? ""}`;
  if (href) return <Link href={href} className={cls} aria-disabled={busy || p.disabled || undefined}>{busy && <Spinner />}{children}</Link>;
  return <button {...p} disabled={p.disabled || busy} aria-busy={busy || undefined} className={cls}>{busy && <Spinner />}{children}</button>;
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-panel-quiet p-8 text-center">
      <p className="display text-lg">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="fade-in rounded-lg border border-danger/35 bg-danger-soft px-3 py-2 text-sm text-danger">{children}</p>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="space-y-4 py-4">
      <span className="skeleton block h-8 w-48" aria-hidden />
      <span className="skeleton block h-24 w-full" aria-hidden />
      <span className="skeleton block h-56 w-full" aria-hidden />
      <p className="flex items-center justify-center gap-2 text-sm text-ink-soft"><Spinner />{label}…</p>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="font-medium text-ink">{label}</span>{hint && <span className="ml-2 text-xs text-ink-soft">{hint}</span>}<span className="mt-1 block">{children}</span></label>;
}

export const inputClass = "h-10 w-full rounded-xl border border-line-strong bg-white px-3 text-sm text-ink placeholder:text-ink-soft/60 transition-[border-color,box-shadow] duration-150 hover:border-accent/40";

/** A modal built on <dialog>: focus is trapped by the browser and Escape closes it. Enter and exit are animated in globals.css. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} aria-label={title} className={wide ? "wide" : undefined}>
      <div className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4"><h2 className="display text-xl">{title}</h2><button onClick={onClose} aria-label="Close" className="press rounded-lg p-1.5 text-ink-soft hover:bg-neutral-soft hover:text-ink"><Icon name="close" size={16} /></button></div>
        {open && children}
      </div>
    </dialog>
  );
}

export function Seal({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.6 6.2l1.7 1.7 3.1-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>{children}</span>;
}

export function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th scope="col" className={`py-2.5 pr-3 text-xs font-medium text-ink-soft first:pl-4 last:pr-4 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

// ---------------------------------------------------------------- more primitives

export { PageHead as PageHeader, Chip as Badge, Empty as EmptyState };

/** Segmented tabs: one control for every tab row. Controlled; arrow keys move between tabs. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: React.ReactNode }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="seg">
      {tabs.map((t, i) => (
        <button key={t.id} role="tab" type="button" aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} className="seg-item" onClick={() => onChange(t.id)}
          onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length; onChange(tabs[n].id); (e.currentTarget.parentElement?.querySelectorAll("button")[n] as HTMLElement | undefined)?.focus(); } }}>{t.label}</button>
      ))}
    </div>
  );
}

/** A card-framed table with a tinted head. Pass <Th> cells in head and rows as children. */
export function Table({ caption, head, children, min = "46rem" }: { caption: string; head: React.ReactNode; children: React.ReactNode; min?: string }) {
  return (
    <div className="surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: min }}>
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-panel-quiet"><tr>{head}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <span className={`skeleton block ${className}`} aria-hidden />;
}

/** A short label on hover or keyboard focus. For longer help use InfoPopover. */
export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span role="tooltip" className="glass-pop pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-max max-w-64 -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-xs text-ink opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">{text}</span>
    </span>
  );
}

/** The home of every explanation: a small (i) next to the thing it explains. Opens on click, closes on Escape or a click elsewhere. */
export function InfoPopover({ children, label = "More information" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex align-middle">
      <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="press grid h-6 w-6 place-items-center rounded-full text-ink-soft hover:bg-neutral-soft hover:text-ink"><Icon name="info" size={15} /></button>
      {open && <span role="dialog" aria-label={label} className="glass-pop fade-in absolute left-0 top-7 z-30 block w-72 max-w-[80vw] rounded-xl p-3 text-left text-[13px] font-normal leading-snug text-ink">{children}</span>}
    </span>
  );
}

/** Every link that continues a task (alert, notification, answer, result) looks like this. */
export function DeepLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return <Link href={href} className={`press group inline-flex items-center gap-1 rounded-lg text-sm font-medium text-accent hover:text-accent-strong ${className}`}>{children}<Icon name="arrow" size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" /></Link>;
}

/** The one persistent "what now?" card: where you are in the loop (status, next step, review and sign, result), one sentence, one button. */
const LOOP = ["Status", "Next step", "Sign", "Result"];
export function NextStepCard({ at, text, cta, href }: { at: 0 | 1 | 2 | 3; text: string; cta: string; href: string }) {
  return (
    <section role="status" aria-label="Your next step" className="rounded-2xl border border-accent/25 bg-gradient-to-b from-accent-soft to-white p-5 shadow-soft">
      <ol className="flex items-center gap-1.5" aria-label="Where you are">
        {LOOP.map((l, i) => (
          <li key={l} className="flex flex-1 flex-col gap-1.5" aria-current={i === at ? "step" : undefined}>
            <span className={`h-1 rounded-full ${i < at ? "bg-accent/60" : i === at ? "bg-accent" : "bg-accent/15"}`} />
            <span className={`text-[11px] leading-none ${i === at ? "font-semibold text-accent" : "text-ink-soft"}`}>{l}</span>
          </li>
        ))}
      </ol>
      <h2 className="display mt-4 text-[17px]">Your next step</h2>
      <p className="mt-1 text-sm text-ink-soft">{text}</p>
      <Btn href={href} className="mt-4 w-full">{cta}<Icon name="arrow" size={16} /></Btn>
    </section>
  );
}

/** One compact line for the honesty labels (synthetic data, not a quote, hypothetical): same look on every page. */
export function Note({ children, tone = "neutral" }: { children: React.ReactNode; tone?: Tone }) {
  return <p className={`inline-flex items-center gap-1.5 text-xs ${tone === "neutral" ? "text-ink-soft" : TEXT[tone]}`}><Icon name="info" size={13} />{children}</p>;
}

/** A limit as a small visual: a bar of used against allowed, one figure, one line. pct is presentation only (null = nothing used to show). */
export function Gauge({ label, allowed, used, pct, line }: { label: string; allowed: React.ReactNode; used?: React.ReactNode; pct: number | null; line?: React.ReactNode }) {
  const p = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const tone = pct !== null && pct >= 100 ? "danger" : pct !== null && pct >= 80 ? "caution" : "good";
  const fill = tone === "danger" ? "bg-danger" : tone === "caution" ? "bg-caution" : "bg-good";
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className="display num mt-0.5 truncate text-[22px] leading-tight">{allowed}</p>
      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-neutral-soft" role="meter" aria-label={`${label}: used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${p}%`, transition: "width var(--dur-slow) var(--ease-out)" }} />
      </div>
      <p className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-soft"><span className="num truncate">{used}</span>{pct !== null && <span className={`num font-medium ${tone === "danger" ? "text-danger" : tone === "caution" ? "text-caution" : "text-good"}`}>{Math.round(p)}%</span>}</p>
      {line && <p className="mt-0.5 truncate text-xs text-ink-soft">{line}</p>}
    </div>
  );
}
