import { Suspense } from "react";
import { z } from "zod";
import { db } from "@/db";
import { getDefaultBusinessId } from "@/db/queries";
import { getEvidence, getMandateInfo, listActions } from "@/actions";
import { getSandboxState } from "@/sandbox";
import ActionsView from "./ActionsView";

export const metadata = { title: "Actions and limits - SME Finance Copilot" };

export default function ActionsPage({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <p className="mb-4 text-sm">
        <a className="underline" href="/demo">Data</a> | <a className="underline" href="/demo/forecast">Forecast</a> | <a className="underline" href="/demo/sandbox">Sandbox console</a>
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
  const [mandate, actions, sandbox, evidence] = await Promise.all([getMandateInfo(db, id), listActions(db, id), getSandboxState(db, id), getEvidence(db, id)]);
  if (!sandbox) return <p>Business not found.</p>;
  return <ActionsView businessId={id} businessName={sandbox.business.name} currency={sandbox.business.currency} initialMandate={mandate} initialActions={actions} initialSandbox={sandbox} initialEvidence={evidence as never} />;
}
