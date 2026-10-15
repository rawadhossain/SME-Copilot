import { Suspense } from "react";
import { z } from "zod";
import { getBusinessSummary, getDefaultBusinessId } from "@/db/queries";
import { commitmentEventToJson } from "@/domain/commitment-event";
import { forecastFor } from "@/engine/service";
import { sampleOrderEvents } from "@/engine/samples/grocery-order";
import ForecastView from "./ForecastView";

export const metadata = { title: "Cash forecast - SME Finance Copilot" };

export default function ForecastPage({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <p className="mb-4 text-sm"><a className="underline" href="/demo">Back to data view</a></p>
      <Suspense fallback={<p>Loading...</p>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Content({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  const { business } = await searchParams;
  const parsed = z.string().uuid().safeParse(business);
  const id = parsed.success ? parsed.data : await getDefaultBusinessId();
  if (!id) return <p>No business found. Run <code>bun run db:seed</code>.</p>;
  const summary = await getBusinessSummary(id);
  const result = await forecastFor(id, { variant: "baseline", delayDays: 14 }, false);
  if (!summary || !result) return <p>Business not found.</p>;
  return (
    <ForecastView
      businessId={id}
      businessName={summary.business.name}
      isSynthetic={summary.business.isSynthetic}
      exponent={summary.business.minorUnitExponent}
      initialBaseline={result.forecast}
      sampleEvents={sampleOrderEvents(result.forecast.asOf, result.forecast.currency).map(commitmentEventToJson)}
    />
  );
}
