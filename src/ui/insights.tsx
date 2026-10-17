"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Financial health and early warnings on Today. Presentational: every figure and sentence arrives from /api/business/[id]/insights, which is
// computed by fixed rules in code. A rescue-plan search here is the same read-only search as "Re-check my cash"; nothing runs until the owner signs.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Btn, Card, Chip, ErrorNote, Loading, type Tone } from "./kit";
import { call } from "./session";
import { date, money, pct } from "./format";

const STATUS: Record<string, [string, Tone]> = {
  needs_attention: ["Needs attention", "danger"], watch: ["Worth watching", "caution"], steady: ["Steady", "good"], not_enough_history: ["Not enough history", "neutral"],
};
const SEVERITY: Record<string, [string, Tone]> = { high: ["Important", "danger"], medium: ["Watch", "caution"], low: ["Note", "neutral"] };

const figureText = (f: any, cur: string): string => (f.kind === "money" ? money(f.amountMinor, cur) : f.kind === "percent" ? pct(f.bps) : f.kind === "date" ? date(f.value) : String(f.value));

export function FinancialHealth({ biz, cur, busy, latestRunId, onPlanSearch }: { biz: string; cur: string; busy: boolean; latestRunId: string | null; onPlanSearch: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void call(`/api/business/${biz}/insights`).then((r) => { if (!live) return; if (r.ok) setData(r.data); else setError(r.data?.error ?? "Could not read your financial health"); });
    return () => { live = false; };
  }, [biz]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading label="Checking for early warnings" />;
  const [statusText, statusTone] = STATUS[data.status] ?? STATUS.steady;
  const m = data.metrics;
  const p = data.periods;
  const noBank = p.historyFrom === null; // no bank transactions: show "No data", not 0.00
  const canSearch = data.findings.some((f: any) => f.actions.some((a: any) => a.kind === "plan_search"));
  return (
    <div id="financial-health" className="scroll-mt-20">
      <Card tone={statusTone} title={<span className="flex flex-wrap items-center gap-2">Financial health and early warnings <Chip tone={statusTone}>{statusText}</Chip></span>}
        subtitle={p.comparable ? `${data.headline} Compares the last ${p.windowDays} days (${date(p.current.from)} to ${date(p.current.to)}) with the ${p.windowDays} before.` : data.headline}>
        {!p.comparable && p.reason && <p className="mb-3 rounded-lg bg-neutral-soft px-3 py-2 text-sm text-ink-soft" role="note">Periods not compared: {p.reason}</p>}
        <dl className="mb-4 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
          {[
            [`Money in, last ${p.windowDays} days`, (noBank ? "No data" : money(m.current.inMinor, cur)), m.prior ? `before: ${money(m.prior.inMinor, cur)}` : null],
            [`Money out, last ${p.windowDays} days`, (noBank ? "No data" : money(m.current.outMinor, cur)), m.prior ? `before: ${money(m.prior.outMinor, cur)}` : null],
            ["Owed to you", money(m.outstandingReceivablesMinor, cur), `${m.overdueInvoiceCount} overdue, ${money(m.overdueReceivablesMinor, cur)}`],
            [`Your bills due in ${p.windowDays} days`, money(m.billsDueNextWindowMinor, cur), `last ${p.windowDays} days: ${money(m.billsDueLastWindowMinor, cur)}`],
          ].map(([k, v, sub]) => (
            <div key={k as string} className="rounded-xl border border-line bg-paper p-3"><dt className="text-xs uppercase tracking-wide text-ink-soft">{k}</dt><dd className="display num mt-1 text-lg">{v}</dd>{sub && <dd className="text-xs text-ink-soft">{sub}</dd>}</div>
          ))}
        </dl>

        {canSearch && (
          <div className="mb-4 flex flex-wrap items-center gap-2"><Btn variant="secondary" busy={busy} onClick={onPlanSearch}>Look for a rescue plan</Btn>{latestRunId && <Link className="text-xs text-accent underline" href={`/room/case?run=${latestRunId}`}>Open the latest plans</Link>}<span className="text-xs text-ink-soft">Searches inside your signed limits. Nothing runs until you sign.</span></div>
        )}
        {data.findings.length === 0 ? (
          <p className="text-sm text-ink-soft">No warnings from the records available. This is not a guarantee: it only covers what your records show.</p>
        ) : (
          <ol className="space-y-3" aria-label="Findings, most important first">
            {data.findings.map((f: any) => {
              const [sevText, sevTone] = SEVERITY[f.severity];
              return (
                <li key={f.id} className="rounded-xl border border-line bg-white/70 p-4 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium"><Chip tone={sevTone}>{sevText}</Chip>{f.title}</p>
                  <p className="mt-1.5">{f.why}</p>
                  {f.comparison && <p className="mt-1 text-xs text-ink-soft">Compared: {f.comparison.label}.</p>}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-accent">The figures, records and what is uncertain</summary>
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-soft">{f.figures.map((x: any, i: number) => <li key={`${x.label}-${i}`}>{x.label}: <span className="num text-ink">{figureText(x, cur)}</span></li>)}</ul>
                    {f.evidence.length > 0 && (
                      <div className="mt-2 overflow-x-auto"><table className="w-full text-xs"><caption className="sr-only">Records behind this finding</caption><thead><tr><th className="py-1 pr-3 text-left font-medium text-ink-soft">Record</th><th className="py-1 pr-3 text-left font-medium text-ink-soft">Date</th><th className="py-1 pr-3 text-right font-medium text-ink-soft">Amount</th><th className="py-1 text-left font-medium text-ink-soft">Note</th></tr></thead>
                        <tbody>{f.evidence.map((e: any, i: number) => <tr key={i} className="border-t border-line"><td className="py-1 pr-3">{e.label}</td><td className="whitespace-nowrap py-1 pr-3">{e.date ? date(e.date) : ""}</td><td className="num py-1 pr-3 text-right">{e.amountMinor ? money(e.amountMinor, cur) : ""}</td><td className="py-1 text-ink-soft">{e.note ?? ""}</td></tr>)}</tbody></table></div>
                    )}
                    <ul className="mt-2 space-y-0.5 text-xs text-caution">{f.uncertainty.map((u: string) => <li key={u}>▲ {u}</li>)}</ul>
                  </details>
                  {f.actions.some((a: any) => a.kind === "plan_search" && a.note && a.kind !== "forecast") && <p className="mt-2 text-xs text-ink-soft">{f.actions.find((a: any) => a.kind === "plan_search")?.note}</p>}
                  {f.actions.some((a: any) => a.kind === "funding" || a.kind === "orders") && (
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{f.actions.filter((a: any) => a.kind === "funding" || a.kind === "orders").map((a: any) => <Link key={a.label} className="text-accent underline" href={a.href ?? "/room"}>{a.label}</Link>)}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-accent">What this view cannot tell you</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-soft">{data.limits.map((l: string) => <li key={l}>{l}</li>)}</ul>
        </details>
      </Card>
    </div>
  );
}
