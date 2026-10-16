"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Chip, Empty, ErrorNote, Loading, Stat } from "@/ui/kit";
import { date, money, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";

export default function Scoreboard() {
  const { session } = useSession();
  const biz = session?.business.id;
  const cur = session?.business.currency ?? "GBP";
  const [sb, setSb] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (biz) void call(`/api/business/${biz}/scoreboard`).then((r) => (r.ok ? setSb(r.data) : setError(r.data.error ?? "Could not load"))); }, [biz]);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!sb) return <Loading />;
  const s = sb.summary;
  return (
    <div className="space-y-6">
      <div><h2 className="display text-2xl">Results</h2><p className="text-ink-soft">What doing nothing would have cost against what your assistant&apos;s plan achieved. Every figure is calculated or counted from the tamper-evident log, never written by the AI.</p></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Cases" value={s.commitmentsAndShortages} />
        <Stat label="Executed" value={s.executed} />
        <Stat label="Verified" value={s.verified} tone={s.verificationFailed ? "caution" : "good"} sub={s.verificationFailed ? `${s.verificationFailed} failed` : "none failed"} />
        <Stat label="Owner approvals" value={s.ownerApprovals} sub="signatures you gave" />
        <Stat label="Denied or blocked" value={s.deniedOrBlocked} sub="actions the system refused" />
      </div>
      {sb.entries.length === 0 && <Empty title="Nothing to score yet">Cases appear here once your assistant has proposed plans for an order or quote or a shortage.</Empty>}
      {sb.entries.map((e: any) => {
        const dn = e.doNothing, ex = e.executedPlan;
        const max = Math.max(1, ...[dn?.minBalanceMinor, ex?.minBalanceMinor].filter(Boolean).map((v: string) => Math.abs(Number(BigInt(v) / 100n))));
        const bar = (v: string | undefined, tone: string) => v === undefined ? null : (
          <div className="flex items-center gap-3"><div className="relative h-5 flex-1 rounded bg-neutral-soft"><div className={`absolute top-0 h-5 rounded ${tone}`} style={{ width: `${(Math.abs(Number(BigInt(v) / 100n)) / max) * 50}%`, left: BigInt(v) < 0n ? `${50 - (Math.abs(Number(BigInt(v) / 100n)) / max) * 50}%` : "50%" }} /><div className="absolute left-1/2 top-0 h-5 w-px bg-ink/40" /></div><span className="num w-28 text-right text-sm">{money(v, cur)}</span></div>
        );
        return (
          <Card key={e.runId} title={e.trigger.type === "shortage" ? "Shortage" : "Commitment"} subtitle={`Started ${date(e.startedAt)} · ${e.rounds} re-plan round${e.rounds === 1 ? "" : "s"}`}
            right={<Chip tone={ex ? (ex.verification === "verified" ? "good" : "danger") : e.status === "exhausted" ? "danger" : e.status === "superseded" ? "neutral" : "caution"}>{ex ? (ex.verification === "verified" ? "executed · verified" : "executed · verification failed") : e.status}</Chip>}>
            <p className="mb-3 text-sm">{e.label}</p>
            {dn && (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-soft">Lowest balance</p>
                  <div className="space-y-1.5"><p className="text-xs text-ink-soft">Do nothing</p>{bar(dn.minBalanceMinor, "bg-danger/70")}{ex && <><p className="text-xs text-ink-soft">Executed plan</p>{bar(ex.minBalanceMinor, "bg-good/70")}</>}</div>
                </div>
                <div className="overflow-x-auto"><table className="w-full min-w-[18rem] text-sm"><thead><tr><th /><th className="text-right text-xs font-medium uppercase text-ink-soft">Do nothing</th><th className="text-right text-xs font-medium uppercase text-ink-soft">Executed</th></tr></thead>
                  <tbody>
                    <tr className="border-t border-line"><td className="py-1.5">Weeks below zero</td><td className="num text-right">{dn.weeksBelowZero}</td><td className="num text-right">{ex ? ex.weeksBelowZero : "–"}</td></tr>
                    <tr className="border-t border-line"><td className="py-1.5">First negative week</td><td className="text-right">{week(dn.firstNegativeWeek)}</td><td className="text-right">{ex ? week(ex.firstNegativeWeek) : "–"}</td></tr>
                    <tr className="border-t border-line"><td className="py-1.5">Total cost</td><td className="num text-right">{money("0", cur)}</td><td className="num text-right">{ex ? money(ex.totalCostMinor, cur) : "–"}</td></tr>
                    <tr className="border-t border-line"><td className="py-1.5">Closing balance</td><td className="num text-right">{money(dn.closingAtHorizonMinor, cur)}</td><td className="num text-right">{ex ? money(ex.closingAtHorizonMinor, cur) : "–"}</td></tr>
                  </tbody></table></div>
              </div>
            )}
            <p className="mt-3 flex flex-wrap gap-x-6 text-sm text-ink-soft"><span>Owner approvals: <b className="text-ink">{e.ownerApprovals}</b> ({e.ownerConfirmations} confirmations)</span><span>Denied or blocked actions: <b className="text-ink">{e.deniedOrBlocked}</b></span>
              <Link className="ml-auto text-accent underline" href={`/room/case?run=${e.runId}`}>Open the case</Link></p>
          </Card>
        );
      })}
    </div>
  );
}
