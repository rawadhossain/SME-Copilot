import { readFileSync } from "node:fs";
import { Suspense } from "react";
import { z } from "zod";
import { describeConfig, readConfig } from "@/ai";
import { getDefaultBusinessId } from "@/db/queries";
import DocumentsView from "./DocumentsView";

export const metadata = { title: "Documents - SME Finance Copilot" };

const FIXTURES = [
  { id: "po", label: "Purchase order (Northgate)", file: "purchase-order-northgate.md", kind: "purchase_order" as const },
  { id: "quote", label: "Supplier quote (Kestrel)", file: "supplier-quote-kestrel.md", kind: "supplier_quote" as const },
  { id: "injected", label: "Injected purchase order (security test)", file: "injected-purchase-order.md", kind: "purchase_order" as const },
];

export default function DocumentsPage({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <p className="mb-4 text-sm">
        <a className="underline" href="/demo">Data</a> | <a className="underline" href="/demo/forecast">Forecast</a> | <a className="underline" href="/demo/actions">Actions and limits</a> | <a className="underline" href="/demo/sandbox">Sandbox</a>
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
  const fixtures = FIXTURES.map((f) => {
    try {
      return { ...f, text: readFileSync(`fixtures/${f.file}`, "utf8") };
    } catch {
      return { ...f, text: "" };
    }
  });
  const cfg = describeConfig(readConfig());
  return <DocumentsView businessId={id} fixtures={fixtures} llm={`provider=${cfg.provider} mode=${cfg.mode} model=${cfg.model}`} />;
}
