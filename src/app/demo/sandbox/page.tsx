import { Suspense } from "react";
import { z } from "zod";
import { db } from "@/db";
import { getDefaultBusinessId } from "@/db/queries";
import { getSandboxState } from "@/sandbox";
import SandboxConsole from "./SandboxConsole";

export const metadata = { title: "Sandbox console - SME Finance Copilot" };

export default function SandboxPage({ searchParams }: { searchParams: Promise<{ business?: string }> }) {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <p className="mb-4 text-sm"><a className="underline" href="/demo">Back to data view</a> | <a className="underline" href="/demo/forecast">Forecast</a></p>
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
  const state = await getSandboxState(db, id);
  if (!state) return <p>Business not found.</p>;
  return <SandboxConsole initial={state} />;
}
