"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// "Do you need to borrow?": the financing decision, run as soon as the page opens. Every figure and sentence comes from the server (plain code over
// the forecast, the rescue planner and the saved offers); the browser does no money arithmetic. Nothing here applies for or accepts anything: a rescue
// option goes on to the existing plans, where it is reviewed, signed, run and independently checked.
// One answer first (is there a gap, how big, by when), then ONE list of ways out: asking customers or suppliers, and funding, side by side.
import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Chip, ErrorNote, Loading, Metric, Th, type Tone } from "@/ui/kit";
import { Icon } from "@/ui/icons";
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
  const [open, setOpen] = useState<string | null>(null);

  async function assess() {
    if (!biz) return;
    setBusy(true); setError(null);
    const res = await call(`/api/business/${biz}/funding/decision`, {});
    setBusy(false);
    if (res.ok) setR(res.data); else { setR(null); setError(res.data?.error ?? "The assessment failed"); }
  }
  useEffect(() => { if (biz) void assess(); }, [biz]); // eslint-disable-line react-hooks/exhaustive-deps
  async function openRescue() {
    if (!biz) return;
    setBusy(true); setError(null);
    const res = await call(`/api/business/${biz}/shortage-check`, {});
    setBusy(false);
    if (res.ok) router.push("/room/case"); else setError(res.data?.error ?? "Could not open the rescue plans");
  }

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!r) return <Loading label="Checking whether you need to borrow" />;
  const d = r.decision;
  const cur = d.currency ?? session?.business.currency ?? "GBP";
  const rec = d.recommendation;
  const viaRescue = d.need.needed && (rec.alternativeId || d.candidates.some((c: any) => c.id === rec.candidateId && c.route.kind === "rescue_plan"));
  const rows: any[] = [
    ...d.alternatives.map((a: any) => ({ key: `a-${a.id}`, kind: "alt", a, recommended: rec.alternativeId === a.id })),
    ...d.candidates.map((c: any) => ({ key: `c-${c.id}`, kind: "fund", c, recommended: rec.candidateId === c.id })),
  ];

  return (
    <section className="space-y-5" aria-label="Do you need to borrow?">
      {/* 1. The answer */}
      <div className="surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <div className="flex items-center gap-2.5"><Chip tone={KIND[rec.kind].tone}>{KIND[rec.kind].label}</Chip><h2 className="display text-[22px] leading-snug">{rec.headline}</h2></div>
            {rec.reasons.length > 0 && <ul className="mt-2 space-y-1 text-[15px] text-ink-soft">{rec.reasons.slice(0, 2).map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}
            {rec.reasons.length > 2 && <details className="mt-1 text-sm text-ink-soft"><summary className="cursor-pointer text-accent">{rec.reasons.length - 2} more reasons</summary><ul className="mt-1 space-y-1">{rec.reasons.slice(2).map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></details>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {viaRescue && <Btn busy={busy} onClick={openRescue}>Review in Plans<Icon name="arrow" size={16} /></Btn>}
            <Btn variant="ghost" busy={busy} onClick={assess} aria-label="Assess again"><Icon name="refresh" size={16} /></Btn>
          </div>
        </div>
        {d.need.needed && (
          <div className="strip mt-5 grid-cols-2 lg:grid-cols-4" aria-label="The gap">
            <Metric label="Deepest gap" tone="danger" value={money(d.need.peakShortfallMinor, cur)} sub={`${week(d.need.peakWeek)} · below your ${money(d.need.reserveMinor, cur)} cushion`} />
            <Metric label="First short week" value={money(d.need.firstShortfallMinor, cur)} sub={`${week(d.need.firstShortWeek)}, ${date(d.need.firstShortStart)}`} />
            <Metric label="Needed in hand by" value={rec.target ? date(rec.target.byDate) : "–"} sub={rec.target ? `${money(rec.target.amountMinor, cur)} covers every week after` : undefined} />
            <Metric label="To stay above zero" tone={d.need.belowZero ? "danger" : "good"} value={money(d.need.zeroShortfallMinor, cur)} sub={d.need.belowZero ? "cash would run out" : "cash does not run out"} />
          </div>
        )}
      </div>

      {/* 2. The ways out, in one list */}
      <details open={d.need.needed} className="surface group overflow-hidden">
        <summary className="row-hover flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-6 py-4 [&::-webkit-details-marker]:hidden">
          <span><span className="display block text-[17px]">{d.need.needed ? "Your options" : "If things change: your options"}</span>
            <span className="block text-sm text-ink-soft">Asking costs least. Funding from the example catalogue is indicative, not an offer.</span></span>
          <Icon name="chevron" size={16} className="text-ink-soft transition-transform duration-200 group-open:rotate-180" />
        </summary>
        {rows.length === 0 ? <p className="px-6 pb-6 text-sm text-ink-soft">No option is available yet. Add an offer you have received below, or check your signed limits.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="bg-panel-quiet"><tr><Th>Option</Th><Th right>You receive</Th><Th right>Total cost</Th><Th right>Lowest balance</Th><Th>Result</Th></tr></thead>
              <tbody>
                {rows.map((x) => {
                  const isOpen = open === x.key;
                  const fund = x.kind === "fund";
                  const c = x.c, a = x.a;
                  return (
                    <Fragment key={x.key}>
                      <tr className={`row-hover cursor-pointer border-t border-line align-middle ${x.recommended ? "bg-accent-soft/40" : ""}`} onClick={() => setOpen(isOpen ? null : x.key)}>
                        <td className="py-3 pl-4 pr-3">
                          <button type="button" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : x.key); }} className="flex items-start gap-2 text-left">
                            <Icon name="chevron" size={14} className={`mt-1 shrink-0 text-ink-soft transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                            <span><span className="block font-medium">{fund ? c.label : a.actions.join("; ")}{x.recommended && <span className="ml-2 align-middle"><Chip tone="accent">Suggested</Chip></span>}</span>
                              <span className="block text-xs text-ink-soft">{fund ? `${c.lender}${c.termsAssumed ? " · terms assumed" : ""}${c.indicative ? " · indicative" : ""}` : "Ask, don't borrow"}</span></span>
                          </button>
                        </td>
                        <td className="num py-3 pr-3 text-right">{fund ? money(c.netReceivedMinor, cur) : <span className="text-ink-soft">–</span>}{fund && <span className="block text-xs text-ink-soft">{date(c.disbursementDate)}</span>}</td>
                        <td className="num py-3 pr-3 text-right">{money(fund ? c.totalCostMinor : a.costMinor, cur)}{fund && c.annualisedCostBps !== null && <span className="block text-xs text-ink-soft">≈ {pct(c.annualisedCostBps)} a year</span>}</td>
                        <td className="num py-3 pr-3 text-right">{money(fund ? c.lowestBalanceMinor : a.lowestBalanceMinor, cur)}</td>
                        <td className="py-3 pr-4"><Chip tone={fund ? AFFORD[c.affordability].tone : OUTCOME[a.outcome].tone}>{fund ? AFFORD[c.affordability].label : OUTCOME[a.outcome].label}</Chip></td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-line bg-panel-quiet"><td colSpan={5} className="px-6 py-4">
                          {fund ? (
                            <div className="space-y-3 text-sm">
                              <dl className="grid gap-x-6 gap-y-2 md:grid-cols-3">
                                <div><dt className="text-ink-soft">Repayments</dt><dd className="num">{c.firstRepaymentDate ? `${c.repaymentCount} from ${date(c.firstRepaymentDate)} to ${date(c.lastRepaymentDate)}` : "–"}</dd></div>
                                <div><dt className="text-ink-soft">Against not borrowing</dt><dd className="num">{money(c.lowestBalanceChangeMinor, cur, { signed: true })} at the low point ({week(c.lowestBalanceWeek)})</dd></div>
                                <div><dt className="text-ink-soft">Still short of the cushion</dt><dd className="num">{money(c.remainingShortfallMinor, cur)} · {c.weeksBelowReserve} week{c.weeksBelowReserve === 1 ? "" : "s"} below{c.newShortWeeks.length > 0 ? ` (${c.newShortWeeks.length} new)` : ""}</dd></div>
                              </dl>
                              <ul className="list-disc space-y-1 pl-5 text-ink-soft">{c.reasons.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
                              {c.catalogue && c.source !== "catalogue" && <p className="text-ink-soft"><b className="font-medium text-ink">Catalogue check:</b> {c.catalogue.verdict === "eligible" ? "you meet the requirements of the example lender's invoice-finance product" : c.catalogue.reason}</p>}
                              <p className="text-xs text-ink-soft">{c.route.note}</p>
                            </div>
                          ) : (
                            <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-3">
                              <div><dt className="text-ink-soft">Still short of the cushion</dt><dd className="num">{money(a.remainingShortfallMinor, cur)}</dd></div>
                              <div className="md:col-span-2"><dt className="text-ink-soft">What it takes</dt><dd>A request to the other side, inside your signed limits. You review and sign it in Plans.</dd></div>
                            </dl>
                          )}
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {d.unavailable.length > 0 && <ul className="space-y-1 border-t border-line px-6 py-4 text-sm text-ink-soft">{d.unavailable.map((u: any, i: number) => <li key={i}><b className="font-medium text-ink">{u.label}:</b> {u.reason}</li>)}</ul>}
      </details>

      <details className="px-1 text-sm text-ink-soft"><summary className="cursor-pointer text-accent">What this assumes</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {d.caveats.map((x: string, i: number) => <li key={i}>{x}</li>)}
          {r.basis.includesAgreedTerms && <li>Terms already agreed with counterparties are included in the forecast.</li>}
        </ul>
      </details>
    </section>
  );
}
