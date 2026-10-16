"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Funding options: the owner types the terms of the offers received; plain code compares them with NOT borrowing.
// The browser does no money arithmetic: amounts go to the server as typed, and every figure shown comes back from the engine.
import { useEffect, useState } from "react";
import { Btn, Card, Chip, Empty, ErrorNote, Field, Stat, Th, inputClass, type Tone } from "@/ui/kit";
import { Chart, type Series } from "@/ui/Chart";
import { date, money, pct, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";

type Kind = "equal" | "total_split" | "factor" | "dates";
interface Form {
  key: number; id: string; lender: string; product: string; principal: string; upfrontFees: string; disbursementDate: string;
  kind: Kind; firstDate: string; count: string; frequency: string; amount: string; total: string; factor: string; datesText: string;
}
const PRODUCTS: [string, string][] = [["term_loan", "Term loan"], ["invoice_finance", "Invoice finance"], ["merchant_advance", "Merchant cash advance"], ["overdraft", "Overdraft or credit line"], ["other", "Other"]];
const KINDS: [Kind, string, string][] = [
  ["equal", "Same payment every time", "For example 8 payments of 2,750.00"],
  ["total_split", "One total to repay", "The offer states a total and a number of payments"],
  ["factor", "Factor rate", "A quote like 1.35 times the amount"],
  ["dates", "A list of dated payments", "One per line: 2026-11-20, 5200.00"],
];
const COLORS = ["#2f6f5e", "#b45309", "#6d28d9", "#0e7490", "#be123c", "#4d7c0f"];
let nextKey = 1;
const blank = (n: number): Form => ({ key: nextKey++, id: `Offer ${n}`, lender: "", product: "term_loan", principal: "", upfrontFees: "0", disbursementDate: "", kind: "equal", firstDate: "", count: "", frequency: "monthly", amount: "", total: "", factor: "1.35", datesText: "" });

function toBody(f: Form) {
  const base = { id: f.id.trim(), lender: f.lender.trim(), product: f.product, principal: f.principal.trim(), upfrontFees: f.upfrontFees.trim() || "0", disbursementDate: f.disbursementDate };
  const common = { firstDate: f.firstDate, count: Number(f.count), frequency: f.frequency };
  if (f.kind === "equal") return { ...base, schedule: { kind: "equal", ...common, amount: f.amount.trim() } };
  if (f.kind === "total_split") return { ...base, schedule: { kind: "total_split", ...common, total: f.total.trim() } };
  if (f.kind === "factor") return { ...base, schedule: { kind: "factor", ...common, factor: f.factor.trim() } };
  const repayments = f.datesText.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [d, a] = l.split(/[,\s]+/); return { date: d, amount: a ?? "" }; });
  return { ...base, schedule: { kind: "dates", repayments } };
}

/** The saved form (API shape) back into the editable page form. */
function fromBody(b: any, n: number): Form {
  const f = blank(n);
  f.id = b.id ?? f.id; f.lender = b.lender ?? ""; f.product = b.product ?? "term_loan"; f.principal = b.principal ?? ""; f.upfrontFees = b.upfrontFees ?? "0"; f.disbursementDate = b.disbursementDate ?? "";
  const sc = b.schedule ?? {};
  f.kind = sc.kind ?? "equal"; f.firstDate = sc.firstDate ?? ""; f.count = sc.count !== undefined ? String(sc.count) : ""; f.frequency = sc.frequency ?? "monthly";
  f.amount = sc.amount ?? ""; f.total = sc.total ?? ""; f.factor = sc.factor ?? "1.35";
  f.datesText = Array.isArray(sc.repayments) ? sc.repayments.map((r: any) => `${r.date}, ${r.amount}`).join("\n") : "";
  return f;
}

/** Amount, fees, date and the repayment pattern: shared by an offer and by a contract. */
function TermsFields({ f, set }: { f: Form; set: (patch: Partial<Form>) => void }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Amount advanced" hint="before fees"><input className={inputClass} inputMode="decimal" value={f.principal} onChange={(e) => set({ principal: e.target.value })} placeholder="20000.00" /></Field>
        <Field label="Fees taken at the start" hint="arrangement, broker"><input className={inputClass} inputMode="decimal" value={f.upfrontFees} onChange={(e) => set({ upfrontFees: e.target.value })} placeholder="0" /></Field>
        <Field label="Money arrives on"><input type="date" className={inputClass} value={f.disbursementDate} onChange={(e) => set({ disbursementDate: e.target.value })} /></Field>
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium">How you repay</legend>
        <div className="mt-2 grid gap-2 md:grid-cols-4">
          {KINDS.map(([k, label, hint]) => (
            <label key={k} className={`cursor-pointer rounded-lg border p-2 text-sm ${f.kind === k ? "border-accent bg-accent-soft" : "border-line-strong"}`}>
              <input type="radio" className="mr-2" name={`kind-${f.key}`} checked={f.kind === k} onChange={() => set({ kind: k })} />{label}<span className="block text-xs text-ink-soft">{hint}</span>
            </label>
          ))}
        </div>
        {f.kind === "dates" ? (
          <div className="mt-3"><Field label="Payments" hint="date, amount (one per line)"><textarea className={`${inputClass} font-mono`} rows={5} value={f.datesText} onChange={(e) => set({ datesText: e.target.value })} placeholder={"2026-11-20, 5200.00\n2026-12-20, 5200.00"} /></Field></div>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <Field label="First payment on"><input type="date" className={inputClass} value={f.firstDate} onChange={(e) => set({ firstDate: e.target.value })} /></Field>
            <Field label="Number of payments"><input className={inputClass} inputMode="numeric" value={f.count} onChange={(e) => set({ count: e.target.value })} placeholder="8" /></Field>
            <Field label="How often"><select className={inputClass} value={f.frequency} onChange={(e) => set({ frequency: e.target.value })}><option value="weekly">Weekly</option><option value="fortnightly">Every two weeks</option><option value="monthly">Monthly</option></select></Field>
            {f.kind === "equal" && <Field label="Each payment"><input className={inputClass} inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="2750.00" /></Field>}
            {f.kind === "total_split" && <Field label="Total to repay"><input className={inputClass} inputMode="decimal" value={f.total} onChange={(e) => set({ total: e.target.value })} placeholder="22000.00" /></Field>}
            {f.kind === "factor" && <Field label="Factor rate" hint="1.35 means repay 1.35 times"><input className={inputClass} inputMode="decimal" value={f.factor} onChange={(e) => set({ factor: e.target.value })} placeholder="1.35" /></Field>}
          </div>
        )}
      </fieldset>
    </>
  );
}

export default function Funding() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [forms, setForms] = useState<Form[]>([blank(1)]);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [contractFor, setContractFor] = useState(0);
  const [contract, setContract] = useState<Form>(() => blank(0));
  const [contractResult, setContractResult] = useState<any>(null);
  const [contractError, setContractError] = useState<string | null>(null);

  useEffect(() => {
    if (!biz) return;
    void call(`/api/business/${biz}/funding/offers`).then((r) => {
      if (r.ok && Array.isArray(r.data.forms) && r.data.forms.length > 0) { setForms(r.data.forms.map((b: any, i: number) => fromBody(b, i + 1))); setSaved("Your saved offers are shown."); }
    });
  }, [biz]);

  const set = (key: number, patch: Partial<Form>) => setForms((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  async function run() {
    if (!biz) return;
    setBusy(true); setError(null);
    const r = await call(`/api/business/${biz}/funding/compare`, { offers: forms.map(toBody) });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else { setResult(null); setError(r.data?.error === "Invalid request" ? "Some fields are missing or not valid. Check the amounts, dates and the number of payments." : (r.data?.error ?? "The comparison failed")); }
  }

  async function save() {
    if (!biz) return;
    setBusy(true); setError(null); setSaved(null);
    const r = await call(`/api/business/${biz}/funding/offers`, { offers: forms.map(toBody) }, "PUT");
    setBusy(false);
    if (r.ok) setSaved(`Saved ${r.data.saved} offer${r.data.saved === 1 ? "" : "s"}. The planning agent can now see the numbers, without lender names.`);
    else setError(r.data?.error === "Invalid request" ? "Some fields are missing or not valid, so nothing was saved." : (r.data?.error ?? "Could not save"));
  }
  async function checkContract() {
    if (!biz) return;
    setBusy(true); setContractError(null);
    const base = forms[contractFor] ?? forms[0];
    const r = await call(`/api/business/${biz}/funding/contract-check`, { offer: toBody(base), contract: toBody({ ...contract, id: base.id, lender: base.lender, product: base.product }) });
    setBusy(false);
    if (r.ok) setContractResult(r.data);
    else { setContractResult(null); setContractError(r.data?.error === "Invalid request" ? "Some contract fields are missing or not valid." : (r.data?.error ?? "The check failed")); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-3xl">Funding options</h1>
        <p className="text-ink-soft">Type in the offers you have received. The system works out what each really costs and what it does to your cash, next to the choice of not borrowing at all. Nothing is sent to any lender and nothing is signed here.</p>
      </div>

      {forms.map((f, i) => (
        <Card key={f.key} title={`Offer ${i + 1}`} right={forms.length > 1 ? <Btn variant="ghost" onClick={() => setForms((fs) => fs.filter((x) => x.key !== f.key))}>Remove</Btn> : undefined}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Short name"><input className={inputClass} value={f.id} onChange={(e) => set(f.key, { id: e.target.value })} maxLength={60} /></Field>
            <Field label="Lender"><input className={inputClass} value={f.lender} onChange={(e) => set(f.key, { lender: e.target.value })} placeholder="Who is offering" maxLength={120} /></Field>
            <Field label="Type of funding"><select className={inputClass} value={f.product} onChange={(e) => set(f.key, { product: e.target.value })}>{PRODUCTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          </div>
          <div className="mt-3"><TermsFields f={f} set={(patch) => set(f.key, patch)} /></div>
        </Card>
      ))}

      <div className="flex flex-wrap gap-3">
        {forms.length < 6 && <Btn variant="secondary" onClick={() => setForms((fs) => [...fs, blank(fs.length + 1)])}>Add another offer</Btn>}
        <Btn busy={busy} onClick={run} disabled={!biz}>Compare with not borrowing</Btn>
        <Btn variant="secondary" busy={busy} onClick={save} disabled={!biz}>Save these offers</Btn>
      </div>
      {saved && <p className="text-sm text-good" role="status">{saved}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {!result && !error && <Empty title="Nothing compared yet">Fill in at least one offer and press compare. Use the exact figures from the offer letter. The result is an estimate for comparing offers, not the lender&apos;s official rate.</Empty>}
      {result && <Results r={result} />}

      <Card title="Check a contract against an offer" subtitle="When a lender sends the contract, type in what it actually says. The system lists every way it differs from the offer you compared. Nothing is read by an AI here.">
        {forms.length > 1 && (
          <div className="mb-3 max-w-xs"><Field label="Which offer is this contract for?"><select className={inputClass} value={contractFor} onChange={(e) => setContractFor(Number(e.target.value))}>{forms.map((f, i) => <option key={f.key} value={i}>{f.id || `Offer ${i + 1}`}</option>)}</select></Field></div>
        )}
        <TermsFields f={contract} set={(patch) => setContract((c) => ({ ...c, ...patch }))} />
        <div className="mt-4"><Btn busy={busy} onClick={checkContract} disabled={!biz}>Check the contract</Btn></div>
        {contractError && <div className="mt-3"><ErrorNote>{contractError}</ErrorNote></div>}
        {contractResult && <ContractResult r={contractResult} cur={session?.business.currency ?? "GBP"} />}
      </Card>
    </div>
  );
}

const DIFF_LABEL: Record<string, string> = { principal: "Amount advanced", upfront_fees: "Fees taken at the start", advance_date: "Date the money arrives", payment_count: "Number of payments", total_repayment: "Total to repay", payment: "Payment" };
function ContractResult({ r, cur }: { r: any; cur: string }) {
  const c = r.check;
  const show = (d: any, v: string) => d.unit === "money" ? money(v, cur) : d.unit === "date" ? date(v) : v;
  if (c.matches) return <div className="mt-4"><Chip tone="good">The contract matches the offer</Chip><p className="mt-2 text-sm">Every amount, date and payment is the same as in {r.offerLabel}.</p></div>;
  return (
    <div className="mt-4 space-y-3">
      <Chip tone={c.worseCount > 0 ? "danger" : "caution"}>{c.differences.length} difference{c.differences.length === 1 ? "" : "s"} from the offer{c.worseCount > 0 ? `, ${c.worseCount} that cost${c.worseCount === 1 ? "s" : ""} you more or need a look` : ""}</Chip>
      <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm"><thead><tr><Th>What</Th><Th right>Offer said</Th><Th right>Contract says</Th><Th>Effect</Th></tr></thead>
        <tbody>{c.differences.map((d: any, i: number) => (
          <tr key={i} className="border-t border-line">
            <td className="py-1.5 pr-3">{DIFF_LABEL[d.field]}{d.paymentNumber ? ` ${d.paymentNumber}` : ""}</td>
            <td className="num py-1.5 pr-3 text-right">{show(d, d.offered)}</td>
            <td className="num py-1.5 pr-3 text-right">{show(d, d.contract)}</td>
            <td className="py-1.5"><Chip tone={d.worse === true ? "danger" : d.worse === false ? "good" : "caution"}>{d.worse === true ? "costs you more" : d.worse === false ? "in your favour" : "check this"}</Chip></td>
          </tr>))}</tbody></table></div>
      <p className="text-sm">Total cost: offer {money(c.offerCost.totalCostMinor, cur)}, contract {money(c.contractCost.totalCostMinor, cur)} ({money(c.extraCostMinor, cur, { signed: true })}). Estimated yearly cost changes by {pct(c.annualisedDeltaBps)}. Do not sign until each line above is explained or corrected.</p>
    </div>
  );
}

function Results({ r }: { r: any }) {
  const cmp = r.comparison, cur = r.basis.currency;
  const dn = cmp.doNotBorrow;
  const wk = (s: any) => s.weekly.map((w: any) => ({ index: w.index, start: w.start, closing: w.closingMinor }));
  const series: Series[] = [
    { key: "none", label: "Not borrowing", weeks: wk(dn), color: "#6b7280", dashed: true, firstNegativeWeek: dn.firstNegativeWeek },
    ...cmp.offers.map((o: any, i: number) => ({ key: o.offerId, label: o.offerId, weeks: wk(o.summary), color: COLORS[i % COLORS.length], firstNegativeWeek: o.summary.firstNegativeWeek })),
  ];
  const cheapest = cmp.cheapestFirst[0];
  const rate = (o: any) => o.cost.effectiveAnnualRateBps === null ? "too short to be meaningful" : pct(o.cost.effectiveAnnualRateBps);
  return (
    <div className="space-y-6">
      <Card title="First: do you need to borrow at all?" tone={cmp.borrowingNeeded ? "caution" : "good"}
        subtitle={`Your books, ${r.basis.includesPendingCommitments} confirmed commitment${r.basis.includesPendingCommitments === 1 ? "" : "s"}${r.basis.includesAgreedTerms ? " and the terms agreed so far" : ""}, over ${r.basis.horizonWeeks} weeks from ${date(r.basis.asOf)}.`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Lowest balance" value={money(dn.minBalanceMinor, cur)} sub={week(dn.minBalanceWeek)} tone={BigInt(dn.minBalanceMinor) < 0n ? "danger" : "neutral"} />
          <Stat label="First below zero" value={week(dn.firstNegativeWeek)} tone={dn.firstNegativeWeek ? "danger" : "good"} />
          <Stat label="Weeks under your reserve" value={dn.weeksBelowReserve} tone={dn.weeksBelowReserve ? "caution" : "good"} />
          <Stat label="Closing balance" value={money(dn.closingAtHorizonMinor, cur)} />
        </div>
        <p className="mt-3 text-sm">{cmp.borrowingNeeded ? "Cash falls short of your reserve or below zero without borrowing, so funding or another fix is worth weighing." : "You stay above your reserve every week without borrowing. Borrowing would only add cost, so weigh it carefully."}</p>
      </Card>

      {(r.limits.costBps !== null || r.limits.amountMinor !== null) && (
        <p className="text-sm text-ink-soft">Your signed funding limits: {r.limits.costBps !== null && <>yearly cost up to <b className="text-ink">{pct(r.limits.costBps)}</b></>}{r.limits.costBps !== null && r.limits.amountMinor !== null && ", "}{r.limits.amountMinor !== null && <>up to <b className="text-ink">{money(r.limits.amountMinor, cur)}</b> from one lender</>}. Offers beyond them are flagged below.</p>
      )}
      {!r.limits.mandateValid && <ErrorNote>Your signed limits could not be verified, so no funding limits were applied.</ErrorNote>}

      <Card title="Cash by week" subtitle="Each line is your balance if you take that offer. The grey dashed line is not borrowing.">
        <Chart series={series} reserveMinor={r.basis.reserveMinor} currency={cur} />
      </Card>

      <Card title="Side by side" subtitle="Ordered as you entered them. Yearly cost figures are estimates for comparison, not the lender's official rate.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead><tr><Th>Offer</Th><Th right>What it costs</Th><Th right>Yearly cost (simple)</Th><Th right>Yearly cost (compounded)</Th><Th right>Lowest balance</Th><Th right>Against not borrowing</Th><Th right>Cover ratio</Th><Th right>Repaid after the window</Th></tr></thead>
            <tbody>
              {cmp.offers.map((o: any) => {
                const better = BigInt(o.lowestBalanceImprovementMinor) >= 0n;
                const cover = o.dscr.ratioX100;
                return (
                  <tr key={o.offerId} className="border-t border-line align-top">
                    <td className="py-2 pr-3"><b>{o.offerId}</b> {o.offerId === cheapest && cmp.offers.length > 1 && <Chip tone="good">lowest yearly cost</Chip>}<div className="text-xs text-ink-soft">{o.lender}</div></td>
                    <td className="num py-2 pr-3 text-right">{money(o.cost.totalCostMinor, cur)}<div className="text-xs text-ink-soft">{pct(o.cost.costOfAmountBps)} of the amount</div></td>
                    <td className="num py-2 pr-3 text-right">{pct(o.cost.annualisedCostBps)}</td>
                    <td className="num py-2 pr-3 text-right">{rate(o)}</td>
                    <td className="num py-2 pr-3 text-right">{money(o.summary.minBalanceMinor, cur)}<div className="text-xs text-ink-soft">{week(o.summary.minBalanceWeek)}</div></td>
                    <td className={`num py-2 pr-3 text-right ${better ? "text-good" : "text-danger"}`}>{money(o.lowestBalanceImprovementMinor, cur, { signed: true })}</td>
                    <td className="py-2 pr-3 text-right">{cover === null ? "–" : <Chip tone={(o.dscr.warn ? "danger" : "good") as Tone}>{(cover / 100).toFixed(2)}</Chip>}<div className="text-xs text-ink-soft">lenders want {(o.dscr.minRequiredX100 / 100).toFixed(2)}+</div></td>
                    <td className="num py-2 pr-3 text-right">{money(o.repaymentsAfterWindowMinor, cur)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 space-y-1 text-sm">
          {cmp.offers.flatMap((o: any) => o.warnings.map((w: string, i: number) => <li key={`${o.offerId}-${i}`} className="flex gap-2"><Chip tone="caution">{o.offerId}</Chip><span>{w}</span></li>))}
        </ul>
      </Card>

      {cmp.allTogether && (
        <Card title="If you took all of them" tone={cmp.allTogether.dscr.warn ? "caution" : undefined}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Lowest balance" value={money(cmp.allTogether.summary.minBalanceMinor, cur)} sub={week(cmp.allTogether.summary.minBalanceWeek)} />
            <Stat label="Cover ratio" value={cmp.allTogether.dscr.ratioX100 === null ? "–" : (cmp.allTogether.dscr.ratioX100 / 100).toFixed(2)} tone={cmp.allTogether.dscr.warn ? "danger" : "good"} />
            <Stat label="Heaviest repayment week" value={week(cmp.allTogether.stacking.peakWeek)} sub={money(cmp.allTogether.stacking.peakWeeklyRepaymentMinor, cur)} />
          </div>
          {cmp.allTogether.warnings.map((w: string, i: number) => <p key={i} className="mt-2 text-sm">{w}</p>)}
        </Card>
      )}

      <p className="text-sm text-ink-soft">How to read this: <b>cover ratio</b> is the cash your business makes from operations over the window divided by everything you would have to repay in it; lenders typically look for about 1.25 or more. Two yearly figures are shown because the simple one ignores compounding and the compounded one becomes meaningless for very short terms. Both come from your own numbers and are estimates.</p>
    </div>
  );
}
