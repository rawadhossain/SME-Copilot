"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Card, Chip, ErrorNote, Loading, Stat, type Tone } from "@/ui/kit";
import { dateTime, short } from "@/ui/format";
import { call, useSession } from "@/ui/session";

const EVENT: Record<string, [string, Tone]> = {
  "auth.login": ["Signed in", "neutral"], "auth.login_failed": ["Failed sign-in", "caution"], "auth.logout": ["Signed out", "neutral"], "auth.step_up": ["Password re-entered to sign", "accent"],
  "auth.step_up_failed": ["Wrong password at signing", "danger"], "auth.second_approval": ["Second approver confirmed", "accent"], "auth.second_approval_failed": ["Second approver refused", "danger"], "auth.second_approval_declined": ["Second approver declined the plan", "caution"], "plan.awaiting_second_approval": ["Waiting for the second approver", "neutral"],
  "plan.authorisation_proposed": ["Authorisation prepared", "neutral"], "plan.authorisation_denied": ["Plan blocked by your limits", "danger"], "plan.authorised": ["Plan signed", "accent"],
  "plan.execution_started": ["Execution started", "neutral"], "plan.execution_refused": ["Execution refused", "danger"], "plan.branch_result": ["The other side answered", "neutral"], "plan.needs_replan": ["Stopped: waiting for your decision", "caution"], "plan.edited": ["You adjusted a plan", "neutral"], "evidence.exported": ["You downloaded the record", "neutral"], "funding.offers_saved": ["You saved funding offers", "neutral"], "funding.matched": ["Funding options matched to your books", "neutral"], "funding.profile_declared": ["You stated when the business started trading", "neutral"], "alert.raised": ["An alert was raised", "caution"], "alert.escalated": ["An alert became more serious", "caution"], "alert.resolved": ["An alert cleared by itself", "good"], "alert.acknowledged": ["You marked an alert as seen", "neutral"], "monitor.run": ["Your books were checked for alerts", "neutral"], "monitor.failed": ["The alert check could not finish", "danger"], "plan.edit_assisted": ["You asked the assistant to suggest changes", "neutral"],
  "plan.compensated": ["Rolled back", "caution"], "plan.execution_failed": ["Execution failed", "danger"], "plan.execution_completed": ["Execution completed", "good"], "plan.verified": ["Verification passed", "good"],
  "plan.verification_failed": ["Verification FAILED", "danger"], "plan.replanned": ["Re-planned", "neutral"], "plan.exhausted": ["No feasible plan", "danger"], "shortage.detected": ["Shortage detected", "caution"],
  "agent.run_started": ["Assistant started", "neutral"], "agent.plans_submitted": ["Assistant proposed plans", "neutral"], "action.proposed": ["Action proposed", "neutral"], "gate.decision": ["Safety check done", "neutral"],
  "action.approved": ["Action authorised", "accent"], "action.executed": ["Action executed", "accent"], "action.verified": ["Action verified", "good"], "action.execution_refused": ["Action refused", "danger"],
  "document.extraction_confirmed": ["Document confirmed", "good"], "document.extraction_rejected": ["Document rejected", "neutral"], "security.suspicious_text_detected": ["Suspicious text found", "danger"], "mandate.version_signed": ["Limits signed", "accent"],
};

export default function Evidence() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [ev, setEv] = useState<any>(null);
  const [cases, setCases] = useState<any[]>([]);
  const [caseData, setCaseData] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/evidence`);
    if (r.ok) setEv(r.data); else setError(r.data.error ?? "Could not load the log");
    return r;
  }, [biz]);
  useEffect(() => { void load(); if (biz) void call(`/api/business/${biz}/cases`).then((r) => r.ok && setCases(r.data.filter((c: any) => !c.parentRunId))); }, [load, biz]);
  useEffect(() => { if (biz && filter !== "all") void call(`/api/business/${biz}/cases/${filter}`).then((r) => r.ok && setCaseData(r.data)); else setCaseData(null); }, [biz, filter]);

  async function verify() {
    setChecking(true);
    const r = await load();
    setChecking(false);
    if (r?.ok) setChecked({ ok: r.data.chain.ok, at: new Date().toLocaleTimeString("en-GB") });
  }

  const scope = useMemo(() => {
    if (!caseData) return null;
    const runIds = new Set<string>(caseData.runs.map((r: any) => r.id));
    const authIds = new Set<string>(caseData.authorisations.map((a: any) => a.authorisation.id));
    const actionIds = new Set<string>(caseData.authorisations.flatMap((a: any) => a.actions.map((x: any) => x.id)));
    return { runIds, authIds, actionIds };
  }, [caseData]);

  const rows: any[] = useMemo(() => {
    if (!ev) return [];
    let r: any[] = [...ev.records].reverse();
    if (scope) r = r.filter((x) => scope.runIds.has(x.detail?.runId) || scope.authIds.has(x.detail?.authorisationId) || (x.proposalId && scope.actionIds.has(x.proposalId)));
    if (kind !== "all") r = r.filter((x) => x.event.startsWith(kind));
    return r;
  }, [ev, scope, kind]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!ev) return <Loading />;

  return (
    <div className="space-y-6">
      <div><h2 className="display text-2xl">Records</h2><p className="text-ink-soft">The full record. Every proposal, signature, safety check, execution and verification, in order. Each record carries the fingerprint of the one before it, so editing or deleting any record breaks the chain.</p></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Records" value={ev.count} />
        <Stat label="Chain" value={ev.chain.ok ? "Intact" : "BROKEN"} tone={ev.chain.ok ? "good" : "danger"} sub={checked ? `checked at ${checked.at}` : "checked when this page loaded"} />
        <Stat label="Latest fingerprint" value={<span className="font-mono text-lg">{short(ev.head?.hash, 12)}</span>} sub="keep a copy to prove nothing newer was removed" />
        <div className="flex items-center"><Btn busy={checking} onClick={verify} className="w-full">Verify the chain now</Btn></div>
      </div>
      {checked && <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${checked.ok ? "border-good/40 bg-good-soft text-good" : "border-danger/40 bg-danger-soft text-danger"}`}>{checked.ok ? `An independent check recomputed every fingerprint of ${ev.count} records: the chain is intact.` : "The chain does NOT verify: a record was changed or removed."}</p>}
      <Card title="Timeline" right={
        <div className="flex flex-wrap gap-2 text-sm">
          <label>Case <select className="ml-1 rounded-lg border border-line-strong bg-white px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">Whole business</option>{cases.map((c) => <option key={c.runId} value={c.runId}>{c.trigger.type} · {dateTime(c.startedAt)}</option>)}</select></label>
          <label>Show <select className="ml-1 rounded-lg border border-line-strong bg-white px-2 py-1" value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">Everything</option><option value="plan.">Plans</option><option value="auth.">Sign-ins and signing</option><option value="action.">Actions</option><option value="gate.">Safety checks</option><option value="document.">Documents</option></select></label>
        </div>}>
        <ol className="divide-y divide-line">
          {rows.slice(0, 200).map((r) => { const [label, tone] = EVENT[r.event] ?? [r.event, "neutral" as Tone]; return (
            <li key={r.id} className="py-2.5">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm"><span className="num w-12 text-xs text-ink-soft">#{r.chainSeq}</span><Chip tone={tone}>{label}</Chip><span className="text-ink-soft">{r.actor}</span><span className="num ml-auto text-xs text-ink-soft">{dateTime(r.createdAt)}</span>
                  {r.verification === "failed" && <Chip tone="danger">failed</Chip>}{r.verification === "verified" && <Chip tone="good">verified</Chip>}</summary>
                <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-white p-3 text-xs">{JSON.stringify(r.detail, null, 2)}</pre>
                <p className="mt-1 font-mono text-xs text-ink-soft">hash {short(r.hash, 16)} ← previous {short(r.prevHash, 16)}</p>
              </details>
            </li>); })}
        </ol>
        {rows.length > 200 && <p className="mt-2 text-xs text-ink-soft">Showing the latest 200 of {rows.length}.</p>}
        {rows.length === 0 && <p className="py-6 text-center text-sm text-ink-soft">No records match.</p>}
      </Card>
    </div>
  );
}
