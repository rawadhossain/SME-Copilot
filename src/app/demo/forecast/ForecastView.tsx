"use client";

import { useState } from "react";
import { formatMoney, money } from "@/lib/money";
import type { CommitmentEventJson } from "@/domain/commitment-event";
import type { ComparisonJson, DriverAnalysisJson, ForecastJson, ItemJson } from "@/engine/json";

interface Props {
  businessId: string;
  businessName: string;
  isSynthetic: boolean;
  exponent: number;
  initialBaseline: ForecastJson;
  sampleEvents: CommitmentEventJson[];
}

interface View {
  baseline: ForecastJson;
  scenario: ForecastJson | null;
  comparison: ComparisonJson | null;
  drivers: DriverAnalysisJson | null;
}

const DELAY_DAYS = 14;
// The baseline view is 13 weeks; with the sample order we show 20 weeks so the customer receipt (day 95) lands in the window.
const BASELINE_WEEKS = 13;
const SCENARIO_WEEKS = 20;

export default function ForecastView({ businessId, businessName, isSynthetic, exponent, initialBaseline, sampleEvents }: Props) {
  const [downside, setDownside] = useState(false);
  const [applied, setApplied] = useState(false);
  const [view, setView] = useState<View>({ baseline: initialBaseline, scenario: null, comparison: null, drivers: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cur = initialBaseline.currency;
  const fm = (minor: string) => formatMoney(money(BigInt(minor), cur), exponent);

  async function load(nextDownside: boolean, nextApplied: boolean) {
    setBusy(true);
    setError(null);
    try {
      const variant = nextDownside ? "downside" : "baseline";
      if (nextApplied) {
        const res = await fetch(`/api/business/${businessId}/scenario`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: sampleEvents, variant, delayDays: DELAY_DAYS, horizonWeeks: SCENARIO_WEEKS }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");
        setView({ baseline: data.baseline, scenario: data.scenario, comparison: data.comparison, drivers: data.drivers });
      } else {
        const res = await fetch(`/api/business/${businessId}/forecast?variant=${variant}&delayDays=${DELAY_DAYS}&horizonWeeks=${BASELINE_WEEKS}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");
        setView({ baseline: data.forecast, scenario: null, comparison: null, drivers: null });
      }
      setDownside(nextDownside);
      setApplied(nextApplied);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const shown = view.scenario ?? view.baseline;
  const cmp = view.comparison;
  const baselineBreach = view.baseline.firstBreach;
  const scenarioBreach = view.scenario?.firstBreach ?? null;

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Cash forecast
        {isSynthetic && <span className="ml-3 rounded bg-amber-200 px-2 py-0.5 align-middle text-xs font-medium text-amber-900">SYNTHETIC DATA</span>}
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        {businessName}. From {view.baseline.asOf}, weekly buckets, <b>{view.baseline.horizonWeeks}-week horizon</b>{applied && " (extended to 20 weeks so the order receipt lands in the window)"}, reserve {fm(view.baseline.reserveMinor)} (owner setting). Variant: <b>{view.baseline.variant}</b>
        {downside && ` (estimated customer receipts delayed ${DELAY_DAYS} days)`}.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="rounded border border-zinc-400 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          disabled={busy}
          onClick={() => load(downside, !applied)}
        >
          {applied ? "Remove sample order" : "Apply sample order"}
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={downside} disabled={busy} onChange={(e) => load(e.target.checked, applied)} />
          Downside: estimated customer receipts {DELAY_DAYS} days late
        </label>
        {busy && <span className="text-sm text-zinc-500">Updating...</span>}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card title="Baseline">
          <p>Lowest closing balance: <b>{fm(view.baseline.minimum.amountMinor)}</b> in week {view.baseline.minimum.weekIndex + 1}</p>
          <p>{baselineBreach ? <>Below reserve from week {baselineBreach.weekIndex + 1}; shortfall then {fm(baselineBreach.shortfallMinor)}</> : "Stays above the reserve."}</p>
          {view.baseline.weeksBelowZero.length > 0 && <p className="text-red-600">Below zero in weeks {view.baseline.weeksBelowZero.map((w) => w + 1).join(", ")}</p>}
        </Card>
        {view.scenario && cmp ? (
          <Card title="With the sample order">
            <p>Lowest closing balance: <b>{fm(view.scenario.minimum.amountMinor)}</b> in week {view.scenario.minimum.weekIndex + 1} ({fm(cmp.minimumDeltaMinor)} vs baseline)</p>
            <p>{scenarioBreach ? <>Below reserve from week {scenarioBreach.weekIndex + 1}; shortfall then {fm(scenarioBreach.shortfallMinor)}. Deepest shortfall {fm(view.scenario.maxShortfallMinor)}</> : "Stays above the reserve."}</p>
            {view.scenario.weeksBelowZero.length > 0 && <p className="text-red-600">Below zero in weeks {view.scenario.weeksBelowZero.map((w) => w + 1).join(", ")}</p>}
            {view.scenario.items.filter((i) => i.sourceType === "event" && !i.amountMinor.startsWith("-")).map((i) => (
              <p key={i.sourceId} className="text-emerald-700">
                Recovery: {i.label} lands in week {i.weekIndex + 1}; that week closes at <b>{fm(view.scenario!.weeks[i.weekIndex].closingMinor)}</b>
              </p>
            ))}
            {view.scenario.outsideHorizon.map((i) => (
              <p key={i.sourceId} className="text-zinc-500">Outside the {view.scenario!.horizonWeeks} weeks: {i.label} on {i.date} ({fm(i.amountMinor)})</p>
            ))}
          </Card>
        ) : (
          <Card title="Sample order">
            <p className="text-zinc-500">Not applied. Use the button to lay the 180,000 order, the supplier deposit and the balance on the timeline.</p>
          </Card>
        )}
      </div>

      <Chart baseline={view.baseline} scenario={view.scenario} exponent={exponent} />

      {view.drivers && view.scenario && <Drivers analysis={view.drivers} scenario={view.scenario} fm={fm} />}

      <section className="mt-6">
        <h2 className="text-lg font-medium">Weekly closing balances</h2>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm tabular-nums">
            <thead>
              <tr className="border-b border-zinc-300 text-left">
                <th className="py-1 pr-2">Week</th>
                <th className="py-1 pr-2">Starts</th>
                <th className="py-1 pr-2 text-right">In</th>
                <th className="py-1 pr-2 text-right">Out</th>
                <th className="py-1 pr-2 text-right">Baseline</th>
                {view.scenario && <th className="py-1 pr-2 text-right">With order</th>}
              </tr>
            </thead>
            <tbody>
              {view.baseline.weeks.map((w, i) => {
                const s = view.scenario?.weeks[i];
                return (
                  <tr key={w.index} className="border-b border-zinc-200">
                    <td className="py-1 pr-2">{w.index + 1}</td>
                    <td className="py-1 pr-2">{w.start}</td>
                    <td className="py-1 pr-2 text-right">{fm((s ?? w).inflowMinor)}</td>
                    <td className="py-1 pr-2 text-right">{fm((s ?? w).outflowMinor)}</td>
                    <td className={`py-1 pr-2 text-right ${w.belowReserve ? "text-red-600" : ""}`}>{fm(w.closingMinor)}</td>
                    {s && <td className={`py-1 pr-2 text-right ${s.belowReserve ? "text-red-600" : ""}`}>{fm(s.closingMinor)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-zinc-500">In / Out columns show the {view.scenario ? "scenario" : "baseline"} forecast. Red = below the reserve.</p>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Lines by provenance ({view.scenario ? "scenario" : "baseline"})</h2>
        {(["assumption", "estimate", "confirmed"] as const).map((kind) => {
          const rows = shown.items.filter((i) => i.kind === kind);
          return (
            <details key={kind} className="mt-2" open={kind === "assumption" && rows.length > 0}>
              <summary className="cursor-pointer text-sm font-medium">{kind} ({rows.length}) <span className="font-normal text-zinc-500">{HELP[kind]}</span></summary>
              <ItemTable rows={rows} fm={fm} />
            </details>
          );
        })}
        <p className="mt-2 text-xs text-zinc-500">Opening balance ({fm(shown.openingBalanceMinor)}) is the actual bank balance on {shown.asOf}.</p>
      </section>
    </div>
  );
}

const HELP = {
  assumption: "scenario inputs and downside delays",
  estimate: "dates or amounts adjusted by a learned pattern",
  confirmed: "open invoices and bills on their dates, and recurring commitments",
} as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-zinc-300 p-3 text-sm">
      <h3 className="mb-1 font-medium">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ItemTable({ rows, fm }: { rows: ItemJson[]; fm: (m: string) => string }) {
  if (rows.length === 0) return <p className="mt-1 text-sm text-zinc-500">None.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="mt-1 w-full text-xs tabular-nums">
        <tbody>
          {rows.map((i, n) => (
            <tr key={i.sourceId + n} className="border-b border-zinc-200 align-top" title={i.note}>
              <td className="py-0.5 pr-2 whitespace-nowrap">W{i.weekIndex + 1} {i.date}</td>
              <td className="py-0.5 pr-2">{i.label}<span className="block text-zinc-500">{i.note}</span></td>
              <td className={`py-0.5 text-right whitespace-nowrap ${i.amountMinor.startsWith("-") ? "" : "text-emerald-700"}`}>{fm(i.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drivers({ analysis, scenario, fm }: { analysis: DriverAnalysisJson; scenario: ForecastJson; fm: (m: string) => string }) {
  const byId = new Map([...scenario.items, ...scenario.outsideHorizon].map((i) => [i.sourceId, i]));
  const friendly = (ref: string) => {
    const it = byId.get(ref);
    return it ? `${it.label}, ${it.date} (${fm(it.amountMinor)})` : null;
  };
  const Refs = ({ refs }: { refs: string[] }) => {
    const names = [...new Set(refs.map(friendly).filter((x): x is string => x !== null))];
    return (
      <span className="block text-xs text-zinc-500">
        {names.slice(0, 3).join("; ")}
        {names.length > 3 ? `; and ${names.length - 3} more` : ""}
        <details className="inline-block align-top">
          <summary className="ml-2 inline cursor-pointer">details</summary>
          <span className="block font-mono">{refs.join(", ")}</span>
        </details>
      </span>
    );
  };
  const gapNow = BigInt(analysis.reserveMinor) - BigInt(analysis.minimumMinor);
  return (
    <section className="mt-6">
      <h2 className="text-lg font-medium">What is driving the gap</h2>
      <p className="mt-1 text-sm text-zinc-500">
        The lowest balance is <b>{fm(analysis.minimumMinor)}</b>, {gapNow > 0n ? <>{fm(gapNow.toString())} below the reserve</> : "above the reserve"}.
        Drivers are taken away one after another, largest first, so the steps below add up exactly to the total change.
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
        {analysis.sequential.map((s) => (
          <li key={s.kind + s.label}>
            {s.label}: <b>{fm(s.effectMinor)}</b> <span className="text-zinc-500">(lowest balance after this step: {fm(s.minimumAfterMinor)})</span>
            <Refs refs={s.refs} />
          </li>
        ))}
      </ol>
      <p className="mt-1 text-sm">
        Total of the steps: <b>{fm(analysis.totalEffectMinor)}</b>. With every driver removed the lowest balance would be {fm(analysis.minimumWithoutDriversMinor)}.
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Each driver removed on its own (these overlap and do not add up)</summary>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
          {analysis.drivers.map((d) => (
            <li key={d.kind + d.label}>
              {d.label}: <b>{fm(d.effectOnMinimumMinor)}</b>
              {d.shareOfShortfallBps !== null && <span className="text-zinc-500"> ({(d.shareOfShortfallBps / 100).toFixed(0)}% of the deepest shortfall)</span>}
              <Refs refs={d.refs} />
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

/** Round tick step (1, 2 or 5 times a power of ten) giving about `target` intervals. */
function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

// Inline SVG chart. Number() is used only to place points on screen, never for money values.
function Chart({ baseline, scenario, exponent }: { baseline: ForecastJson; scenario: ForecastJson | null; exponent: number }) {
  const W = 720;
  const H = 340;
  const m = { l: 76, r: 16, t: 26, b: 56 };
  const scale = 10 ** exponent;
  const series = [baseline, scenario].filter((f): f is ForecastJson => f !== null);
  const pounds = (minor: string) => Number(minor) / scale;
  const values = series.flatMap((f) => f.weeks.map((w) => pounds(w.closingMinor))).concat([pounds(baseline.reserveMinor), 0]);
  const step = niceStep(Math.max(...values) - Math.min(...values), 5);
  const lo = Math.floor(Math.min(...values) / step) * step;
  const hi = Math.ceil(Math.max(...values) / step) * step;
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const x = (i: number) => m.l + (i / (baseline.weeks.length - 1)) * (W - m.l - m.r);
  const line = (f: ForecastJson) => f.weeks.map((w, i) => `${x(i).toFixed(1)},${y(pounds(w.closingMinor)).toFixed(1)}`).join(" ");
  const money0 = (v: number) => (v === 0 ? "0" : formatMoney(money(BigInt(Math.round(v * scale)), baseline.currency), exponent).replace(/\.\d+/, "").replace(" GBP", ""));
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  const main = scenario ?? baseline;
  const minX = x(main.minimum.weekIndex);
  const minY = y(pounds(main.minimum.amountMinor));
  const labelRight = main.minimum.weekIndex < baseline.weeks.length / 2;
  const labelUp = minY > m.t + 40; // there is room above the point
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" role="img" aria-label="Weekly closing balance chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-zinc-700" : "stroke-zinc-200"} strokeWidth={t === 0 ? 1.5 : 1} />
          <text x={m.l - 6} y={y(t) + 4} textAnchor="end" className={`text-[11px] ${t === 0 ? "fill-zinc-900 font-semibold" : "fill-zinc-500"}`}>{money0(t)}</text>
        </g>
      ))}
      <text x={m.l - 6} y={m.t - 12} textAnchor="end" className="fill-zinc-500 text-[10px]">{baseline.currency}</text>
      <line x1={m.l} x2={W - m.r} y1={y(pounds(baseline.reserveMinor))} y2={y(pounds(baseline.reserveMinor))} className="stroke-amber-600" strokeDasharray="5 4" />
      <text x={W - m.r} y={y(pounds(baseline.reserveMinor)) - 4} textAnchor="end" className="fill-amber-700 text-[10px]">reserve {money0(pounds(baseline.reserveMinor))}</text>
      <polyline points={line(baseline)} fill="none" className="stroke-zinc-500" strokeWidth={2} />
      {scenario && <polyline points={line(scenario)} fill="none" className="stroke-blue-600" strokeWidth={2.5} />}
      {baseline.weeks.map((w, i) => (
        <text key={i} x={x(i)} y={H - 32} textAnchor="middle" className="fill-zinc-500 text-[10px]">{w.index + 1}</text>
      ))}
      <text x={(m.l + W - m.r) / 2} y={H - 10} textAnchor="middle" className="fill-zinc-600 text-[11px]">Week (balance at the end of the week)</text>
      <circle cx={minX} cy={minY} r={6} className="fill-red-600" />
      <text
        x={minX + (labelRight ? 12 : -12)}
        y={minY + (labelUp ? -14 : 22)}
        textAnchor={labelRight ? "start" : "end"}
        className="fill-red-700 stroke-white text-[11px] font-medium"
        strokeWidth={4}
        paintOrder="stroke"
      >
        lowest: {money0(pounds(main.minimum.amountMinor))} (week {main.minimum.weekIndex + 1})
      </text>
      <g className="text-[11px]">
        <line x1={m.l + 8} x2={m.l + 30} y1={10} y2={10} className="stroke-zinc-500" strokeWidth={2} />
        <text x={m.l + 34} y={14} className="fill-zinc-600">baseline</text>
        {scenario && (
          <>
            <line x1={m.l + 100} x2={m.l + 122} y1={10} y2={10} className="stroke-blue-600" strokeWidth={2.5} />
            <text x={m.l + 126} y={14} className="fill-zinc-600">with sample order</text>
          </>
        )}
      </g>
    </svg>
  );
}
