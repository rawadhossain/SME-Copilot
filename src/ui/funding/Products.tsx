"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// "Products you may qualify for": the synthetic lender catalogue matched to this business's books. Every verdict, requirement, amount and cost comes
// from the server (plain code); the browser does no money arithmetic. Terms are indicative and from a synthetic catalogue, never a quote.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Card, Chip, ErrorNote, Field, inputClass, type Tone } from "@/ui/kit";
import { date, money, pct } from "@/ui/format";
import { call, useSession } from "@/ui/session";

const VERDICT: Record<string, { label: string; tone: Tone }> = {
  eligible: { label: "You qualify", tone: "good" },
  near_miss: { label: "Close: one requirement short", tone: "caution" },
  not_eligible: { label: "Not available yet", tone: "neutral" },
};

/** A requirement value in plain words, by its unit. */
function amountText(unit: string, v: string | null, cur: string): string {
  if (v === null) return "–";
  if (unit === "money") return money(v, cur);
  if (unit === "bps") return pct(Number(v));
  if (unit === "months") return `${v} month${v === "1" ? "" : "s"}`;
  return v;
}

export function Products({ onAdd }: { onAdd: (form: any) => void }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const isOwner = session?.user.role === "owner";
  const router = useRouter();
  const [m, setM] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [since, setSince] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/funding/match`);
    if (r.ok) { setM(r.data); setError(null); setSince(r.data.profile.tradingSince ?? ""); }
    else { setM(null); setError(r.data?.error ?? "The products could not be checked right now."); }
  }, [biz]);
  useEffect(() => { void load(); }, [load]);

  async function saveSince(value: string | null) {
    if (!biz) return;
    setBusy(true); setNote(null);
    const r = await call(`/api/business/${biz}/funding/profile`, { tradingSince: value }, "PUT");
    setBusy(false);
    if (r.ok) { setNote(value ? "Saved. This is your own statement; it has not been checked." : "Cleared. Only your bank statement is used for trading history."); await load(); }
    else setNote(r.data?.error ?? "Could not save that date.");
  }
  async function openRescue() {
    if (!biz) return;
    setBusy(true); setNote(null);
    const r = await call(`/api/business/${biz}/shortage-check`, {});
    setBusy(false);
    if (r.ok) router.push("/room/case"); else setNote(r.data?.error ?? "Could not open the rescue plans");
  }

  const cur = m?.match.currency ?? session?.business.currency ?? "GBP";
  const p = m?.profile;
  const need = m?.need;
  return (
    <Card title="Products you may qualify for" subtitle="Funding products from an example (synthetic) lender catalogue, checked against your own books. These are indicative terms, not quotes, and nothing is applied for from here.">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!m && !error && <p className="text-sm text-ink-soft">Checking your books against the catalogue…</p>}
      {m && (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,18rem)_1fr] md:items-end">
              <Field label="Trading since" hint="your own statement, not checked">
                {isOwner
                  ? <input type="date" className={inputClass} value={since} max={p.asOf} min="1950-01-01" onChange={(e) => setSince(e.target.value)} />
                  : <p className="text-sm">{p.tradingSince ? date(p.tradingSince) : "Not stated"}</p>}
              </Field>
              {isOwner && (
                <div className="flex flex-wrap gap-2">
                  <Btn variant="secondary" busy={busy} disabled={!since || since === (p.tradingSince ?? "")} onClick={() => saveSince(since)}>Save date</Btn>
                  {p.tradingSince && <Btn variant="ghost" busy={busy} onClick={() => saveSince(null)}>Clear</Btn>}
                </div>
              )}
            </div>
            <p className="mt-3 text-sm">
              {p.historySource === "declared"
                ? <>History counted: <b>{p.monthsOfHistory} months</b>, from the date you stated (not checked). Your bank statement covers {p.bankMonthsOfHistory} months.</>
                : <>History counted: <b>{p.monthsOfHistory} month{p.monthsOfHistory === 1 ? "" : "s"}</b>, from your bank statement.{isOwner ? " If you have traded for longer, state when you started above." : ""}</>}
              {" "}Yearly receipts of about <b>{money(p.annualisedTurnoverMinor, cur)}</b> come only from your bank data{p.turnoverAnnualisedFromShortHistory ? `, estimated from ${p.bankMonthsOfHistory} months of it` : ""}.
            </p>
            {note && <p className="mt-2 text-sm" role="status">{note}</p>}
          </div>

          <p className="text-sm">
            {need.needed
              ? <>Your deepest cash gap is <b>{money(need.amountMinor, cur)}</b>. Amounts below are sized to cover it, as far as each product allows.</>
              : <>You have no cash gap right now, so amounts below are a typical size for each product, not sized to a need.</>}
          </p>

          <div className="space-y-3">
            {m.match.results.map((r: any) => {
              const x = m.extras[r.productId];
              const v = VERDICT[r.verdict];
              const isLine = r.kind === "revolving_line";
              return (
                <div key={r.productId} className="rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{r.rank}. {r.label}</p>
                      <p className="text-sm text-ink-soft">{r.lenderName} · example lender, not real</p>
                    </div>
                    <Chip tone={v.tone}>{v.label}</Chip>
                  </div>

                  {r.verdict !== "eligible" && <p className="mt-2 text-sm">{r.reason}</p>}

                  <ul className="mt-2 space-y-1 text-sm">
                    {r.criteria.filter((c: any) => c.status !== "not_applicable").map((c: any) => (
                      <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
                        <Chip tone={c.status === "met" ? "good" : "danger"}>{c.status === "met" ? "Met" : "Not met"}</Chip>
                        <span>{c.label}: needs {c.op === "min" ? "at least" : "no more than"} <b className="num">{amountText(c.unit, c.required, cur)}</b>; you have <b className="num">{amountText(c.unit, c.actual, cur)}</b></span>
                        {c.note && <span className="text-xs text-ink-soft">({c.note})</span>}
                      </li>
                    ))}
                  </ul>

                  {r.offer ? (
                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm md:grid-cols-3">
                      <div><dt className="text-ink-soft">{isLine ? "Credit limit" : "Amount"}</dt><dd className="num">{money(r.sizedAmountMinor, cur)}{isLine ? ` (drawn: ${money(r.offer.principalMinor, cur)})` : ""}</dd></div>
                      <div><dt className="text-ink-soft">Money you receive</dt><dd className="num">{money(r.netReceivedMinor, cur)} in about {r.disbursementDays} day{r.disbursementDays === 1 ? "" : "s"}</dd></div>
                      <div><dt className="text-ink-soft">Total cost</dt><dd className="num">{money(r.totalCostMinor, cur)}{r.annualisedCostBps !== null ? ` (about ${pct(r.annualisedCostBps)} a year, an estimate)` : ""}</dd></div>
                      {x?.coverageBps !== null && x?.coverageBps !== undefined && <div><dt className="text-ink-soft">Your cash gap</dt><dd>Covers <b className="num">{pct(x.coverageBps)}</b> of your gap</dd></div>}
                    </dl>
                  ) : r.verdict !== "not_eligible" && <p className="mt-3 text-sm text-ink-soft">The amount you qualify for is below this product&apos;s minimum, so no offer is shown.</p>}

                  <p className="mt-3 text-xs text-ink-soft">Indicative terms from a synthetic catalogue, not a quote.</p>

                  {r.verdict === "eligible" && r.offer && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {r.executable
                        ? (need.needed
                          ? <><Btn variant="secondary" busy={busy} onClick={openRescue}>Review this in your rescue plans</Btn><span className="text-sm text-ink-soft">You review, sign and run it there.</span></>
                          : <span className="text-sm text-ink-soft">No cash gap right now, so there is nothing to plan with this yet.</span>)
                        : x?.compareForm && <><Btn variant="secondary" onClick={() => onAdd(x.compareForm)}>Add to comparison</Btn><span className="text-sm text-ink-soft">Puts these terms in the comparison below. This app cannot apply for it.</span></>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
