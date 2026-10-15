"use client";
// Weekly closing-balance chart (inline SVG, no library). Lines: do nothing, selected/executed plan; zero and reserve rules; the first
// negative week is marked. Every point is focusable and carries a text label for keyboard and screen-reader use.
import { useState } from "react";
import { money, date } from "./format";

export interface Week { index: number; start: string; closing: string }
export interface Series { key: string; label: string; weeks: Week[]; color: string; dashed?: boolean; firstNegativeWeek?: number | null }

export function Chart({ series, reserveMinor, currency }: { series: Series[]; reserveMinor: string; currency: string }) {
  const [focus, setFocus] = useState<{ s: string; w: Week } | null>(null);
  const W = 860, H = 300, L = 64, R = 16, T = 16, B = 34;
  const all = series.flatMap((s) => s.weeks.map((w) => Number(BigInt(w.closing)) / 100));
  const reserve = Number(BigInt(reserveMinor)) / 100;
  const lo = Math.min(0, ...all) * 1.08, hi = Math.max(reserve, ...all, 1) * 1.08;
  const n = Math.max(...series.map((s) => s.weeks.length), 2);
  const x = (i: number) => L + ((i - 1) / (n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = 5;
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks);
  const path = (s: Series) => s.weeks.map((w, i) => `${i === 0 ? "M" : "L"}${x(w.index).toFixed(1)},${y(Number(BigInt(w.closing)) / 100).toFixed(1)}`).join(" ");
  const fmt = (v: number) => money(BigInt(Math.round(v * 100)), currency, { compact: true });
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projected closing balance by week" className="w-full">
        {y(0) <= H - B && <rect x={L} y={y(0)} width={W - L - R} height={Math.max(0, H - B - y(0))} fill="var(--danger-soft)" opacity="0.55" />}
        {tickVals.map((v, i) => (<g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" /><text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--ink-soft)" className="num">{fmt(v)}</text></g>))}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--danger)" strokeWidth="1.4" />
        <text x={W - R} y={y(0) - 5} textAnchor="end" fontSize="11" fill="var(--danger)">zero</text>
        <line x1={L} x2={W - R} y1={y(reserve)} y2={y(reserve)} stroke="var(--caution)" strokeWidth="1.3" strokeDasharray="5 4" />
        <text x={W - R} y={y(reserve) - 5} textAnchor="end" fontSize="11" fill="var(--caution)">your reserve {fmt(reserve)}</text>
        {Array.from({ length: n }, (_, i) => i + 1).filter((i) => i === 1 || i % 2 === 0).map((i) => (<text key={i} x={x(i)} y={H - 12} textAnchor="middle" fontSize="11" fill="var(--ink-soft)">{i}</text>))}
        <text x={L} y={H - 1} fontSize="10" fill="var(--ink-soft)">week</text>
        {series.map((s) => (<path key={s.key} d={path(s)} fill="none" stroke={s.color} strokeWidth={s.dashed ? 2 : 2.8} strokeDasharray={s.dashed ? "6 4" : undefined} strokeLinejoin="round" />))}
        {series.map((s) => s.firstNegativeWeek ? (
          <g key={`neg-${s.key}`}><circle cx={x(s.firstNegativeWeek)} cy={y(0)} r="6" fill="var(--danger)" /><text x={x(s.firstNegativeWeek)} y={y(0) + 20} textAnchor="middle" fontSize="11" fill="var(--danger)">first negative: week {s.firstNegativeWeek}</text></g>
        ) : null)}
        {series.flatMap((s) => s.weeks.map((w) => {
          const label = `${s.label}, week ${w.index} from ${date(w.start)}: ${money(w.closing, currency)}`;
          return <circle key={`${s.key}-${w.index}`} cx={x(w.index)} cy={y(Number(BigInt(w.closing)) / 100)} r={focus?.s === s.key && focus.w.index === w.index ? 6 : 3.2} fill={s.color} tabIndex={0} role="img" aria-label={label}
            onFocus={() => setFocus({ s: s.key, w })} onMouseEnter={() => setFocus({ s: s.key, w })} onBlur={() => setFocus(null)} onMouseLeave={() => setFocus(null)} />;
        }))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-soft">
        {series.map((s) => (<span key={s.key} className="inline-flex items-center gap-2"><svg width="26" height="8" aria-hidden><line x1="0" x2="26" y1="4" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dashed ? "5 3" : undefined} /></svg>{s.label}</span>))}
        <span className="num ml-auto min-h-5 text-ink" aria-live="polite">{focus ? `${series.find((s) => s.key === focus.s)?.label}: week ${focus.w.index} (${date(focus.w.start)}) closes at ${money(focus.w.closing, currency)}` : "Hover or tab to a point for the exact balance"}</span>
      </figcaption>
    </figure>
  );
}
