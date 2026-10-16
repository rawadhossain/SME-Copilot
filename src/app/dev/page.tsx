import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { demoToolsEnabled } from "@/lib/demo-tools";
import { Shell } from "@/ui/Shell";
import DevTools from "./DevTools";

// Demo and developer tools. Not linked from the app; a production build answers 404 unless DEMO_TOOLS=on (read on every request).
export const metadata = { title: "Demo tools", robots: { index: false } };
export const instant = false;

export default function Page() {
  return <Suspense fallback={null}><Gate /></Suspense>;
}

async function Gate() {
  await connection();
  if (!demoToolsEnabled()) notFound();
  return <Shell><DevTools /></Shell>;
}
