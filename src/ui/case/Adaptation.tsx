"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// "What changed and what we do next" after a counterparty refused or countered. Presentational: the report was decided by code
// (src/engine/plans/adapt.ts); nothing here calculates or rewrites a figure.
import Link from "next/link";
import { Card, Chip } from "../kit";
import { money } from "../format";

export function AdaptationCard({ a, cur }: { a: any; cur: string }) {
  const tone = a.status === "recommended" ? "good" : a.status === "best_available" ? "caution" : "danger";
  const considered: any[] = a.candidates.filter((c: any) => c.kind !== "do_nothing");
  return (
    <Card tone={tone} title={<span className="flex flex-wrap items-center gap-2">What they said, and the next step <Chip tone={tone}>{a.status === "recommended" ? "Recommended" : a.status === "best_available" ? "Best available" : "No option fits"}</Chip></span>}
      subtitle={`Round ${a.round} of ${a.maxRounds}. ${a.headline}`}>
      {a.responses.length > 0 && (
        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm">{a.responses.map((r: any) => <li key={r.index}>{r.summary}</li>)}</ul>
      )}
      {a.selected && (
        <div className="rounded-xl border border-line bg-white/70 p-4 text-sm">
          <p className="font-medium">{a.selected.label}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{a.selected.cashImpact.map((x: string) => <li key={x}>{x}</li>)}<li>{a.selected.cost}</li></ul>
          <p className="mt-2 text-xs font-medium text-ink-soft">Trade-offs</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-soft">{a.selected.tradeoffs.map((x: string) => <li key={x}>{x}</li>)}</ul>
          <p className="mt-2 text-xs font-medium text-ink-soft">Remaining risks</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-caution">{a.selected.risks.map((x: string) => <li key={x}>{x}</li>)}</ul>
          <p className="mt-2 text-xs text-ink-soft">{a.selected.approval}</p>
        </div>
      )}
      {a.nextSteps.length > 0 && (
        <div className="mt-3 text-sm"><p className="font-medium">What you can do next</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{a.nextSteps.map((s: any) => <li key={s.label}>{s.href ? <Link className="text-accent underline" href={s.href}>{s.label}</Link> : s.label}</li>)}</ul></div>
      )}
      <details className="mt-3"><summary className="cursor-pointer text-xs text-accent">Every option that was considered</summary>
        <ul className="mt-2 space-y-1.5 text-xs">{considered.map((c: any) => (
          <li key={c.id}><span className="font-medium">{c.label}</span>{c.metrics ? ` (lowest ${money(c.metrics.minBalanceMinor, cur)}, cost ${money(c.metrics.totalCostMinor, cur)})` : ""}
            {c.rejectedBecause.length > 0 ? <span className="text-danger"> Rejected: {c.rejectedBecause.join("; ")}.</span> : <span className="text-good"> Feasible.</span>}</li>
        ))}</ul></details>
    </Card>
  );
}
