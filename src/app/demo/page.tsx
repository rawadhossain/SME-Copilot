import { Suspense } from "react";
import { z } from "zod";
import { getBusinessSummary, getDefaultBusinessId, getRecentTransactions } from "@/db/queries";
import { formatMoney, moneyFromJson } from "@/lib/money";

export const metadata = { title: "Demo data - SME Finance Copilot" };

export default function DemoPage({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <Suspense fallback={<p>Loading...</p>}>
        <Demo searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Demo({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  const { business } = await searchParams;
  const parsed = z.string().uuid().safeParse(business);
  const id = parsed.success ? parsed.data : await getDefaultBusinessId();
  if (!id) return <p>No business found. Run <code>bun run db:seed</code>.</p>;
  const summary = await getBusinessSummary(id);
  if (!summary) return <p>Business not found.</p>;
  const exp = summary.business.minorUnitExponent;
  const recent = await getRecentTransactions(id, 10);

  return (
    <>
      <h1 className="text-2xl font-semibold">
        {summary.business.name}
        {summary.business.isSynthetic && (
          <span className="ml-3 rounded bg-amber-200 px-2 py-0.5 align-middle text-xs font-medium text-amber-900">SYNTHETIC DATA</span>
        )}
      </h1>
      <p className="mt-4 text-sm text-zinc-500">Current balance</p>
      <p className="text-3xl font-semibold tabular-nums">{formatMoney(moneyFromJson(summary.balance), exp)}</p>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(
          [
            ["Transactions", summary.counts.transactions],
            ["Open invoices", summary.counts.openInvoices],
            ["Overdue invoices", summary.counts.overdueInvoices],
            ["Open bills", summary.counts.openBills],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded border border-zinc-300 p-3">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="text-xl font-medium tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-6"><a className="underline" href="/demo/forecast">Cash forecast</a> | <a className="underline" href="/demo/sandbox">Sandbox console</a> | <a className="underline" href="/demo/actions">Actions and limits</a></p>
      <h2 className="mt-8 text-lg font-medium">10 most recent transactions</h2>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-300 text-left">
            <th className="py-1 pr-2">Date</th>
            <th className="py-1 pr-2">Description</th>
            <th className="py-1 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((t) => (
            <tr key={t.id} className="border-b border-zinc-200">
              <td className="py-1 pr-2 whitespace-nowrap">{t.postedOn}</td>
              <td className="py-1 pr-2">{t.description}</td>
              <td className="py-1 text-right tabular-nums whitespace-nowrap">{formatMoney(t.amount, exp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
