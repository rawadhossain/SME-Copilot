"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// "Do you need to borrow?": the financing decision. Every figure and sentence comes from the server (plain code over the forecast, the rescue
// planner and the saved offers); the browser does no money arithmetic. Nothing here applies for or accepts anything: a rescue option goes on to
// the existing plans, where it is reviewed, signed, run and independently checked.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Card, Chip, ErrorNote, Stat, Th, type Tone } from "@/ui/kit";
import { date, money, pct, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";

const KIND: Record<string, { label: string; tone: Tone }> = {
  no_funding_needed: { label: "No borrowing needed", tone: "good" },
  avoid_borrowing: { label: "Avoid borrowing", tone: "good" },
  borrow: { label: "Borrowing looks necessary", tone: "caution" },
  borrow_partial_only: { label: "Only partly covered", tone: "caution" },
  no_suitable_offer: { label: "No suitable offer", tone: "danger" },
};
const AFFORD: Record<string, { label: string; tone: Tone }> = {
  affordable: { label: "Affordable", tone: "good" },
  affordable_with_caution: { label: "Affordable, with cautions", tone: "caution" },
  partly_covers: { label: "Only partly covers the gap", tone: "caution" },
  not_affordable: { label: "Not affordable", tone: "danger" },
};
const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  removes_need: { label: "Closes the gap", tone: "good" },
  reduces_need: { label: "Narrows the gap", tone: "caution" },
  no_help: { label: "Does not help", tone: "neutral" },
};

export function Decision() {
  const { session } = useSession();
  const biz = session?.business.id;
  const router = useRouter();
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assess() {
    if (!biz) return;
    setBusy(true); setError(null);
    const res = await call(`/api/business/${biz}/funding/decision`, {});
    setBusy(false);
    if (res.ok) setR(res.data); else { setR(null); setError(res.data?.error ?? "The assessment failed"); }
  }
  async function openRescue() {
    if (!biz) return;
    setBusy(true); setError(null);
    const res = await call(`/api/business/${biz}/shortage-check`, {});
    setBusy(false);
    if (res.ok) router.push("/room/case"); else setError(res.data?.error ?? "Could not open the rescue plans");
  }

  const d = r?.decision;
  const cur = d?.currency ?? session?.business.currency ?? "GBP";
  const rec = d?.recommendation;
  const viaRescue = !!d && d.need.needed && (rec.alternativeId || d.candidates.some((c: any) => c.id === rec.candidateId && c.route.kind === "rescue_plan"));

  return (
    <Card title="Do you need to borrow?" subtitle="Checks the size and timing of any cash gap, whether asking customers or suppliers could close it instead, and whether the funding available keeps you above your cushion once it is repaid. It uses your saved offers below and the options already in your rescue plans. Nothing is applied for or signed here."
      right={<Btn busy={busy} onClick={assess} disabled={!biz}>{d ? "Assess again" : "Assess my funding need"}</Btn>}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!d && !error && <p className="text-sm text-ink-soft">Press the button to run it. Save your offers first if you want them included.</p>}
      {d && (
        <div className="space-y-5">
          <div className="rounded-xl border border-line bg-panel p-4">
            <Chip tone={KIND[rec.kind].tone}>{KIND[rec.kind].label}</Chip>
            <p className="display mt-2 text-lg">{rec.headline}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{rec.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            {viaRescue && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Btn variant="secondary" busy={busy} onClick={openRescue}>Review this in your rescue plans</Btn>
                <span className="text-sm text-ink-soft">You review, sign and run it there; a separate check then confirms the result.</span>
              </div>
            )}
          </div>

          {d.need.needed && (
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Deepest gap" tone="danger" value={money(d.need.peakShortfallMinor, cur)} sub={`${week(d.need.peakWeek)}, ${date(d.need.peakWeekStart)}; below your ${money(d.need.reserveMinor, cur)} cushion`} />
              <Stat label="Gap in the first short week" value={money(d.need.firstShortfallMinor, cur)} sub={`${week(d.need.firstShortWeek)}, ${date(d.need.firstShortStart)}`} />
              <Stat label="Needed in hand by" value={rec.target ? date(rec.target.byDate) : "–"} sub={rec.target ? `${money(rec.target.amountMinor, cur)} to cover every week from then` : undefined} />
              <Stat label="To stay above zero" tone={d.need.belowZero ? "danger" : undefined} value={money(d.need.zeroShortfallMinor, cur)} sub={d.need.belowZero ? "cash would run out" : "cash does not run out"} />
            </div>
          )}

          <section>
            <h3 className="display text-base">Without borrowing</h3>
            {d.alternatives.length === 0 ? <p className="mt-1 text-sm text-ink-soft">No rescue option that avoids borrowing is available (for example, no overdue invoices to chase, or your signed limits do not allow one).</p> : (
              <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[40rem] text-sm"><thead><tr><Th>What you would ask</Th><Th>Effect</Th><Th right>Lowest balance</Th><Th right>Still short</Th><Th right>Cost</Th></tr></thead>
                <tbody>{d.alternatives.map((a: any) => (
                  <tr key={a.id} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3">{a.actions.join("; ")}</td>
                    <td className="py-1.5 pr-3"><Chip tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].label}</Chip></td>
                    <td className="num py-1.5 pr-3 text-right">{money(a.lowestBalanceMinor, cur)}</td>
                    <td className="num py-1.5 pr-3 text-right">{money(a.remainingShortfallMinor, cur)}</td>
                    <td className="num py-1.5 text-right">{money(a.costMinor, cur)}</td>
                  </tr>))}</tbody></table></div>
            )}
          </section>

          <section>
            <h3 className="display text-base">Funding available, ranked</h3>
            {d.candidates.length === 0 && <p className="mt-1 text-sm text-ink-soft">No funding offers are entered. Add the offers you have received below and save them.</p>}
            <div className="mt-2 space-y-3">
              {d.candidates.map((c: any) => (
                <div key={c.id} className="rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{c.rank}. {c.label} <span className="text-sm font-normal text-ink-soft">({c.lender}{c.termsAssumed ? ", terms assumed" : ""})</span></p>
                    <span className="flex flex-wrap items-center gap-2">{c.indicative && <Chip tone="neutral">Indicative · synthetic catalogue</Chip>}<Chip tone={AFFORD[c.affordability].tone}>{AFFORD[c.affordability].label}</Chip></span>
                  </div>
                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm md:grid-cols-3">
                    <div><dt className="text-ink-soft">Money arrives</dt><dd className="num">{money(c.netReceivedMinor, cur)} on {date(c.disbursementDate)}</dd></div>
                    <div><dt className="text-ink-soft">Total cost</dt><dd className="num">{money(c.totalCostMinor, cur)}{c.annualisedCostBps !== null ? ` (about ${pct(c.annualisedCostBps)} a year)` : ""}</dd></div>
                    <div><dt className="text-ink-soft">Repayments</dt><dd className="num">{c.firstRepaymentDate ? `${c.repaymentCount} from ${date(c.firstRepaymentDate)} to ${date(c.lastRepaymentDate)}` : "–"}</dd></div>
                    <div><dt className="text-ink-soft">Lowest balance with it</dt><dd className="num">{money(c.lowestBalanceMinor, cur)} ({week(c.lowestBalanceWeek)}), {money(c.lowestBalanceChangeMinor, cur, { signed: true })} against not borrowing</dd></div>
                    <div><dt className="text-ink-soft">Still short of the cushion</dt><dd className="num">{money(c.remainingShortfallMinor, cur)}</dd></div>
                    <div><dt className="text-ink-soft">Weeks below the cushion</dt><dd className="num">{c.weeksBelowReserve}{c.newShortWeeks.length > 0 ? ` (${c.newShortWeeks.length} new)` : ""}</dd></div>
                  </dl>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{c.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
                  {c.catalogue && c.source !== "catalogue" && (
                    <p className="mt-2 text-sm"><strong>Catalogue check for this kind of product:</strong> {c.catalogue.verdict === "eligible" ? "you meet the requirements of the example lender's invoice-finance product" : c.catalogue.reason} <span className="text-xs text-ink-soft">(indicative, synthetic catalogue)</span></p>
                  )}
                  <p className="mt-2 text-xs text-ink-soft">{c.route.note}</p>
                </div>))}
            </div>
            {d.unavailable.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">{d.unavailable.map((u: any, i: number) => <li key={i}><strong>{u.label}:</strong> {u.reason}</li>)}</ul>}
          </section>

          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-soft">
            {d.caveats.map((x: string, i: number) => <li key={i}>{x}</li>)}
            {r.basis.includesAgreedTerms && <li>Terms already agreed with counterparties are included in the forecast.</li>}
          </ul>
        </div>
      )}
    </Card>
  );
}
