import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { demoToolsEnabled } from "@/lib/demo-tools";
import LoginForm from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

// The demo accounts hint and the prefilled address are shown only when demo tools are on (development, or DEMO_TOOLS=on).
// The setting is read on every request, not once at build time.
export default function LoginPage() {
  return <Suspense fallback={null}><Form /></Suspense>;
}

async function Form() {
  await connection();
  return <Suspense fallback={null}><LoginForm demo={demoToolsEnabled()} /></Suspense>;
}
