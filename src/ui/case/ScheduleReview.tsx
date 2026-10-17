"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// The payments and receipts a plan would schedule, shown before anyone signs it. "Proposed" only: nothing here is agreed, scheduled or guaranteed.
// Every figure comes from the same terms that are hashed and signed (src/actions/plan-projection.ts); the browser adds nothing up except for display.
import { Chip, Th } from "../kit";
import { date, money } from "../format";

export function ScheduleReview({ summary, cur }: { summary: any; cur: string }) {
  const items: any[] = summary?.schedule ?? [];
  const fees: any[] = summary?.fees ?? [];
  if (!summary?.schedule) return null;
  return (
    <section aria-label="Money this plan would schedule" className="rounded-lg border border-line bg-white/70 p-3">
      <h3 className="mb-1 flex flex-wrap items-center gap-2 font-medium">Money it would schedule <Chip tone="neutral">proposed, not agreed</Chip></h3>
      {summary.scheduleProblem && <p role="alert" className="text-xs text-danger">The terms could not be applied to your confirmed order, so no schedule can be shown: {summary.scheduleProblem}</p>}
      {!summary.scheduleProblem && items.length === 0 && <p className="text-xs text-ink-soft">These terms schedule no payment or receipt of their own. They change when customers pay, which the forecast already reflects.</p>}
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="sr-only">Payments and receipts this plan would schedule if every term is accepted as asked</caption>
            <thead><tr><Th>Date</Th><Th>Who</Th><Th>What</Th><Th right>Amount</Th></tr></thead>
            <tbody>
              {items.map((i, k) => (
                <tr key={k} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{date(i.date)}</td>
                  <td className="pr-3">{String(i.counterparty).replace(" (SYNTHETIC)", "")}</td>
                  <td className="pr-3">{i.purpose} <Chip tone={i.direction === "receipt" ? "good" : "accent"}>{i.direction === "receipt" ? "money in" : "money out"}</Chip></td>
                  <td className={`num text-right ${i.direction === "receipt" ? "text-good" : ""}`}>{i.direction === "receipt" ? "+" : "−"}{money(i.amountMinor, i.currency || cur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t border-line-strong"><td colSpan={3} className="py-1.5 pr-3 text-xs text-ink-soft">Net of these items</td><td className="num text-right font-medium">{money(summary.scheduleNetMinor, cur, { signed: true })}</td></tr></tfoot>
          </table>
        </div>
      )}
      {fees.map((f, k) => <p key={k} className="mt-2 text-xs">Finance cost: a fee of up to <b className="num">{money(f.maxFeeMinor, f.currency || cur)}</b> ({f.maxFeeBps / 100}% of the {money(f.invoiceMinor, f.currency || cur)} invoice), the highest your signed terms allow. It is already taken off the customer payment above.</p>)}
      <p className="mt-2 text-xs text-ink-soft">Only if every other side accepts exactly as asked. Money in depends on them and is not guaranteed. Each item is checked again against your signed limits and your balance before it is scheduled.</p>
    </section>
  );
}
