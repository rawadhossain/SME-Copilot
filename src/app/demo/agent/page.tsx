import { readFileSync } from "node:fs";
import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { describeConfig, readConfig } from "@/ai";
import { db } from "@/db";
import { counterparties } from "@/db/schema";
import { getDefaultBusinessId } from "@/db/queries";
import AgentView from "./AgentView";

export const metadata = { title: "Planning agent - SME Finance Copilot" };

// The sample commitment is two synthetic documents (quote + purchase order) read through the normal extraction path.
const SAMPLE = [
  { file: "supplier-quote-kestrel.md", kind: "supplier_quote" as const },
  { file: "purchase-order-northgate.md", kind: "purchase_order" as const },
];

export default function AgentPage({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <p className="mb-4 text-sm">
        <a className="underline" href="/demo">Data</a> | <a className="underline" href="/demo/forecast">Forecast</a> | <a className="underline" href="/demo/documents">Documents</a> | <a className="underline" href="/demo/actions">Actions and limits</a> | <a className="underline" href="/demo/sandbox">Sandbox</a>
      </p>
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
  const names = Object.fromEntries((await db.select({ id: counterparties.id, name: counterparties.name }).from(counterparties).where(eq(counterparties.businessId, id))).map((c) => [c.id, c.name]));
  const sample = SAMPLE.map((s) => ({ ...s, text: readFileSync(`fixtures/${s.file}`, "utf8") }));
  const cfg = describeConfig(readConfig());
  return <AgentView businessId={id} names={names} sample={sample} llm={`provider=${cfg.provider} mode=${cfg.mode} model=${cfg.model}`} />;
}
