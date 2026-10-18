"use client";
// Weekly closing-balance chart (inline SVG, no library). Lines: do nothing, selected/executed plan; zero and reserve rules; the first
// negative week is marked. Beneath the line, optional bars show money in and out for the same weeks (from the forecast's own weekly
// table). Move over the chart for a crosshair and one tooltip. Every point is also focusable and carries a text label for keyboard and
// screen-reader use. Every line is a projection, never a recorded balance.
import { useState } from "react";
import { Icon } from "./icons";
import { money, date } from "./format";

export interface Week { index: number; start: string; closing: string; inflow?: string; outflow?: string }
export interface Series { key: string; label: string; weeks: Week[]; color: string; dashed?: boolean; firstNegativeWeek?: number | null }

const K = { grid: "rgb(28 37 33 / 0.07)", text: "var(--ink-soft)", zero: "var(--danger)", reserve: "var(--caution)", cross: "var(--line-strong)", dot: "var(--panel)", inn: "#4f9a6f", out: "#cbbf9e", zone: "var(--danger-soft)", zoneOpacity: 0.7 };

export function Chart({ series, reserveMinor, currency, flows = false, height = 300 }: { series: Series[]; reserveMinor: string; currency: string; flows?: boolean; height?: number }) {
  const total = Math.max(...series.map((s) => s.weeks.length), 2);
  const ranges = [8, 13, total].filter((n, i, a) => n <= total && a.indexOf(n) === i);
  const [range, setRange] = useState(total);
  const [hover, setHover] = useState<number | null>(null); // week index under the pointer or focus
  const n = Math.min(range, total);

  const mainFull = series[series.length - 1];
  const hasFlows = flows && mainFull?.weeks.some((w) => w.inflow !== undefined);
  const FH = hasFlows ? 64 : 0; // height of the money in / out strip
  const W = 860, L = 60, R = 16, T = 16, B = 30, H = height + FH + (hasFlows ? 10 : 0);
  const lineBottom = height - B;
  const visible = series.map((s) => ({ ...s, weeks: s.weeks.filter((w) => w.index <= n) }));
  const all = visible.flatMap((s) => s.weeks.map((w) => Number(BigInt(w.closing)) / 100));
  const reserve = Number(BigInt(reserveMinor)) / 100;
  const lo = Math.min(0, ...all) * 1.08, hi = Math.max(reserve, ...all, 1) * 1.08;
  const x = (i: number) => L + ((i - 1) / Math.max(n - 1, 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (lineBottom - T);
  const ticks = 2; // three y labels: light gridlines, few labels
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks);
  const pts = (s: Series) => s.weeks.map((w) => `${x(w.index).toFixed(1)},${y(Number(BigInt(w.closing)) / 100).toFixed(1)}`);
  const path = (s: Series) => pts(s).map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");
  const fmt = (v: number) => money(BigInt(Math.round(v * 100)), currency, { compact: true });
  const main = visible[visible.length - 1];
  const areaPath = main && main.weeks.length > 1 ? `${path(main)} L${x(main.weeks[main.weeks.length - 1].index).toFixed(1)},${y(lo)} L${x(main.weeks[0].index).toFixed(1)},${y(lo)} Z` : null;

  // money in / out strip: bars grow up (in) and down (out) from a shared baseline
  const flowMax = hasFlows ? Math.max(1, ...main.weeks.flatMap((w) => [Number(BigInt(w.inflow ?? "0")) / 100, Number(BigInt(w.outflow ?? "0")) / 100])) : 1;
  const fTop = lineBottom + B - 6, fMid = fTop + FH / 2 + 4;
  const barW = Math.min(18, ((W - L - R) / Math.max(n, 1)) * 0.5);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((vx - L) / (W - L - R)) * (n - 1)) + 1;
    setHover(vx < L - 8 || vx > W - R + 8 ? null : Math.min(n, Math.max(1, i)));
  };

  const rows = hover ? visible.map((s) => ({ s, w: s.weeks.find((w) => w.index === hover) })).filter((r): r is { s: typeof visible[number]; w: Week } => !!r.w) : [];
  const weekStart = rows[0]?.w.start;
  const flowWeek = hover && hasFlows ? main.weeks.find((w) => w.index === hover) : undefined;
  const pct = hover ? (x(hover) / W) * 100 : 0;
  // the lowest point of the main line, marked and labelled
  const low = main && main.weeks.length > 0 ? main.weeks.reduce((a, w) => (BigInt(w.closing) < BigInt(a.closing) ? w : a)) : null;
  const lowY = low ? y(Number(BigInt(low.closing)) / 100) : 0;
  const lowBelow = low ? lowY < T + 22 : false;

  return (
    <figure>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft"><Icon name="info" size={13} />Projection from your records, not a promise</span>
        {ranges.length > 1 && (
          <div role="group" aria-label="Weeks shown" className="inline-flex gap-0.5 rounded-lg bg-neutral-soft p-0.5">
            {ranges.map((r) => (
              <button key={r} type="button" aria-pressed={n === r} onClick={() => setRange(r)}
                className={`press rounded-md px-2.5 py-1 text-xs font-medium ${n === r ? "bg-panel text-ink shadow-soft" : "text-ink-soft hover:text-ink"}`}>{r === total ? `All ${r} weeks` : `${r} weeks`}</button>
            ))}
          </div>
        )}
      </div>
      <div className="relative" onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projected closing balance by week" className="w-full touch-pan-y" onPointerMove={onMove}>
          <defs>
            <linearGradient id="area-l" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={main?.color ?? "#1d5a4c"} stopOpacity={0.2} /><stop offset="1" stopColor={main?.color ?? "#1d5a4c"} stopOpacity="0" /></linearGradient>
          </defs>
          {y(0) <= lineBottom && <rect x={L} y={y(0)} width={W - L - R} height={Math.max(0, lineBottom - y(0))} fill={K.zone} opacity={K.zoneOpacity} />}
          {tickVals.map((v, i) => (<g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={K.grid} strokeWidth="1" /><text x={L - 10} y={y(v) + 4} textAnchor="end" fontSize="11" fill={K.text} className="num">{fmt(v)}</text></g>))}
          {lo < 0 && <><line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke={K.zero} strokeWidth="1" opacity="0.7" /><text x={W - R} y={y(0) - 5} textAnchor="end" fontSize="11" fill={K.zero}>zero</text></>}
          <line x1={L} x2={W - R} y1={y(reserve)} y2={y(reserve)} stroke={K.reserve} strokeWidth="1.4" strokeDasharray="6 5" />
          <text x={W - R} y={y(reserve) - 6} textAnchor="end" fontSize="11" fontWeight="500" fill={K.reserve} stroke="var(--panel)" strokeWidth="4" paintOrder="stroke">Safety cushion {fmt(reserve)}</text>
          {hover && <line x1={x(hover)} x2={x(hover)} y1={T} y2={hasFlows ? fTop + FH : lineBottom} stroke={K.cross} strokeWidth="1" />}
          <g key={`${n}-lines`}>
            {areaPath && <path d={areaPath} fill="url(#area-l)" className="chart-area" />}
            {visible.map((s) => (<path key={s.key} d={path(s)} pathLength={1} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.6 : 2.6} strokeDasharray={s.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" className={s.dashed ? "chart-area" : "draw-line"} />))}
          </g>
          {visible.map((s) => s.firstNegativeWeek && s.firstNegativeWeek <= n ? (
            <g key={`neg-${s.key}`}><circle cx={x(s.firstNegativeWeek)} cy={y(0)} r="6" fill={K.zero} className="swell" /><text x={x(s.firstNegativeWeek)} y={y(0) + 20} textAnchor="middle" fontSize="11" fill={K.zero}>first negative: week {s.firstNegativeWeek}</text></g>
          ) : null)}

          {low && (
            <g aria-hidden>
              <circle cx={x(low.index)} cy={lowY} r="9" fill={main.color} opacity="0.14" className="swell" />
              <circle cx={x(low.index)} cy={lowY} r="4.5" fill="var(--panel)" stroke={main.color} strokeWidth="2.2" className="swell" />
              <text x={x(low.index)} y={lowBelow ? lowY + 22 : lowY - 14} textAnchor={x(low.index) > W - 90 ? "end" : x(low.index) < L + 60 ? "start" : "middle"} fontSize="11" fontWeight="600" fill={BigInt(low.closing) < 0n ? K.zero : "var(--ink)"} stroke="var(--panel)" strokeWidth="4" paintOrder="stroke" className="num">Lowest {fmt(Number(BigInt(low.closing)) / 100)}</text>
            </g>
          )}

          {hasFlows && (
            <g aria-hidden>
              <line x1={L} x2={W - R} y1={fMid} y2={fMid} stroke={K.grid} strokeWidth="1" />
              <text x={L - 8} y={fMid - FH / 4 + 3} textAnchor="end" fontSize="10" fill={K.text}>in</text>
              <text x={L - 8} y={fMid + FH / 4 + 3} textAnchor="end" fontSize="10" fill={K.text}>out</text>
              {main.weeks.map((w) => {
                const i = Number(BigInt(w.inflow ?? "0")) / 100, o = Number(BigInt(w.outflow ?? "0")) / 100;
                const hi_ = (i / flowMax) * (FH / 2 - 2), ho = (o / flowMax) * (FH / 2 - 2);
                const dim = hover !== null && hover !== w.index;
                return <g key={w.index} opacity={dim ? 0.4 : 1} style={{ transition: "opacity 140ms ease" }}>
                  <rect x={x(w.index) - barW / 2} y={fMid - hi_} width={barW} height={hi_} rx="2" fill={K.inn} />
                  <rect x={x(w.index) - barW / 2} y={fMid + 1} width={barW} height={ho} rx="2" fill={K.out} />
                </g>;
              })}
            </g>
          )}

          {Array.from({ length: n }, (_, i) => i + 1).filter((i) => i === 1 || i % 4 === 0).map((i) => (<text key={i} x={x(i)} y={H - 2} textAnchor="middle" fontSize="11" fill={K.text}>{i}</text>))}
          <text x={L - 10} y={H - 2} textAnchor="end" fontSize="10" fill={K.text}>week</text>

          {visible.flatMap((s) => s.weeks.map((w) => {
            const label = `${s.label}, week ${w.index} from ${date(w.start)}: ${money(w.closing, currency)}`;
            const on = hover === w.index;
            return <circle key={`${s.key}-${w.index}`} cx={x(w.index)} cy={y(Number(BigInt(w.closing)) / 100)} r={on ? 5.5 : 3} fill={on ? K.dot : "transparent"} stroke={s.color} strokeWidth={on ? 2.5 : 0} tabIndex={0} role="img" aria-label={label}
              style={{ transition: "r 140ms var(--ease-out)" }} onFocus={() => setHover(w.index)} onBlur={() => setHover(null)} />;
          }))}
        </svg>
        {hover && rows.length > 0 && (
          <div className="glass-pop num pointer-events-none absolute top-2 z-10 w-max min-w-48 max-w-72 rounded-xl px-3 py-2 text-xs fade-in"
            style={{ left: `${pct}%`, transform: `translateX(${pct > 62 ? "calc(-100% - 12px)" : "12px"})` }} role="status">
            <p className="mb-1 font-medium text-ink">Week {hover}{weekStart ? ` · from ${date(weekStart)}` : ""}</p>
            {rows.map(({ s, w }) => (
              <p key={s.key} className="flex items-center justify-between gap-4 py-0.5">
                <span className="flex items-center gap-1.5 text-ink-soft"><span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />{s.label}</span>
                <span className={`font-medium ${BigInt(w.closing) < 0n ? "text-danger" : "text-ink"}`}>{money(w.closing, currency)}</span>
              </p>
            ))}
            {flowWeek && (
              <p className="mt-1 flex justify-between gap-4 border-t border-line pt-1 text-ink-soft">
                <span>In <b className="font-medium text-good">{money(flowWeek.inflow ?? "0", currency)}</b></span>
                <span>Out <b className="font-medium text-ink">{money(flowWeek.outflow ?? "0", currency)}</b></span>
              </p>
            )}
          </div>
        )}
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-ink-soft">
        {series.map((s) => (<span key={s.key} className="inline-flex items-center gap-2"><svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dashed ? "5 3" : undefined} /></svg>{s.label}</span>))}
      </figcaption>
    </figure>
  );
}
