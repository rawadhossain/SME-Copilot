"use client";
// Small shared components. Semantic tones only: good / caution / danger / neutral / accent.
import Link from "next/link";
import { useEffect, useRef } from "react";

export type Tone = "good" | "caution" | "danger" | "neutral" | "accent";
const TONE: Record<Tone, string> = {
  good: "bg-good-soft text-good border-good/30",
  caution: "bg-caution-soft text-caution border-caution/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  neutral: "bg-neutral-soft text-neutral border-line-strong",
  accent: "bg-accent-soft text-accent border-accent/30",
};

export function Chip({ tone = "neutral", children, pulse }: { tone?: Tone; children: React.ReactNode; pulse?: boolean }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[tone]}`}><span className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? "pulse" : ""}`} aria-hidden />{children}</span>;
}

export function Card({ title, subtitle, right, children, tone, className = "" }: { title?: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; tone?: Tone; className?: string }) {
  const border = tone === "danger" ? "border-danger/40" : tone === "caution" ? "border-caution/40" : tone === "good" ? "border-good/40" : "border-line";
  return (
    <section className={`rounded-2xl border ${border} bg-panel p-5 shadow-[0_1px_0_rgba(22,32,30,0.04)] ${className}`}>
      {(title || right) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="display text-lg text-ink">{title}</h2>{subtitle && <p className="text-sm text-ink-soft">{subtitle}</p>}</div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  const color = tone === "danger" ? "text-danger" : tone === "good" ? "text-good" : tone === "caution" ? "text-caution" : "text-ink";
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <p className="text-xs uppercase tracking-wide text-ink-soft">{label}</p>
      <p className={`display num mt-1 text-2xl ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-soft">{sub}</p>}
    </div>
  );
}

const BTN = {
  primary: "bg-accent text-white hover:bg-[#0a463e] disabled:bg-accent/40",
  secondary: "border border-line-strong bg-panel text-ink hover:bg-neutral-soft disabled:opacity-50",
  danger: "bg-danger text-white hover:bg-[#8f1e17] disabled:opacity-50",
  ghost: "text-accent hover:bg-accent-soft disabled:opacity-50",
};

export function Btn({ variant = "primary", busy, href, className, children, ...p }: { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean; href?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${BTN[variant]} ${className ?? ""}`;
  if (href) return <Link href={href} className={cls} aria-disabled={busy || p.disabled || undefined}>{busy && <span className="pulse" aria-hidden>●</span>}{children}</Link>;
  return <button {...p} disabled={p.disabled || busy} className={cls}>{busy && <span className="pulse" aria-hidden>●</span>}{children}</button>;
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-panel/60 p-8 text-center">
      <p className="display text-lg">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">{children}</p>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <p className="pulse py-10 text-center text-sm text-ink-soft" role="status">{label}…</p>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="font-medium text-ink">{label}</span>{hint && <span className="ml-2 text-xs text-ink-soft">{hint}</span>}<span className="mt-1 block">{children}</span></label>;
}

export const inputClass = "w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60";

/** A modal built on <dialog>: focus is trapped by the browser and Escape closes it. */
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
        <div className="mb-3 flex items-start justify-between gap-4"><h2 className="display text-xl">{title}</h2><button onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-soft hover:bg-neutral-soft">✕</button></div>
        {open && children}
      </div>
    </dialog>
  );
}

export function Seal({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.6 6.2l1.7 1.7 3.1-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>{children}</span>;
}

export function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th scope="col" className={`py-2 pr-3 text-xs font-medium uppercase tracking-wide text-ink-soft ${right ? "text-right" : "text-left"}`}>{children}</th>;
}
