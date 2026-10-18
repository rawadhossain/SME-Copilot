"use client";
// Safety & records: what you allowed, what was done, and the proof, on one page. The three tabs reuse the screens that used to be separate pages.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loading, PageHead } from "@/ui/kit";
import { WorkflowCanvas } from "@/ui/workflow";
import Evidence from "../evidence/View";
import Mandate from "../mandate/View";
import Scoreboard from "../scoreboard/View";

// Results and Records were one question ("what happened, and can I prove it?"), so they share a tab; the old ?tab=records links still land there.
const TABS = [
  { id: "results", label: "Activity", hint: "What the assistant did, and the proof" },
  { id: "limits", label: "Limits", hint: "What the assistant may and may not do" },
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
      <PageHead title="Safety & records" sub="Limits, what was done, and the proof" info="What your assistant may do, what it has done, and the proof. None of it is written by the AI."
        actions={<div role="tablist" aria-label="Safety and records" className="seg flex-wrap">
        {TABS.map((t) => (
          <Link key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="safety-panel" href={`/room/safety?tab=${t.id}`} replace scroll={false}
            onClick={(e) => { e.preventDefault(); router.replace(`/room/safety?tab=${t.id}`, { scroll: false }); }}
            className="seg-item" title={t.hint}>{t.label}</Link>
        ))}
      </div>} />
      <div id="safety-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "results" && <div className="space-y-8"><Scoreboard /><Evidence /></div>}
        {tab === "limits" && <Mandate />}
        {tab === "workflow" && <WorkflowCanvas />}
      </div>
    </div>
  );
}
