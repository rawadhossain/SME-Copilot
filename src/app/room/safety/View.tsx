"use client";
// Safety & records: what you allowed, what was done, and the proof, on one page. The three tabs reuse the screens that used to be separate pages.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loading } from "@/ui/kit";
import { WorkflowCanvas } from "@/ui/workflow";
import Evidence from "../evidence/View";
import Mandate from "../mandate/View";
import Scoreboard from "../scoreboard/View";

const TABS = [
  { id: "results", label: "Results", hint: "What the plans achieved" },
  { id: "limits", label: "Your limits", hint: "What the assistant may and may not do" },
  { id: "records", label: "Records", hint: "Everything that happened, tamper-evident" },
  { id: "workflow", label: "Workflow", hint: "How the assistant works, and what happened in a case" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function Safety() {
  return <Suspense fallback={<Loading />}><Tabs /></Suspense>;
}

function Tabs() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : "results";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-3xl">Safety &amp; records</h1>
        <p className="text-ink-soft">What you have allowed, what was done on your behalf, and the proof. Nothing here is written by the AI.</p>
      </div>
      <div role="tablist" aria-label="Safety and records" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="safety-panel" href={`/room/safety?tab=${t.id}`} replace scroll={false}
            onClick={(e) => { e.preventDefault(); router.replace(`/room/safety?tab=${t.id}`, { scroll: false }); }}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.id ? "border-accent text-accent" : "border-transparent text-ink-soft hover:text-ink"}`} title={t.hint}>{t.label}</Link>
        ))}
      </div>
      <div id="safety-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "results" && <Scoreboard />}
        {tab === "limits" && <Mandate />}
        {tab === "records" && <Evidence />}
        {tab === "workflow" && <WorkflowCanvas />}
      </div>
    </div>
  );
}
