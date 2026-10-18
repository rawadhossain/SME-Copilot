"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Chart, type Series } from "@/ui/Chart";
import { ExecutionPanel, ExhaustedCard, ReplanPanel, PlanTable, RunChips, Stepper, Timeline, VerificationPanel } from "@/ui/case/parts";
import { EditPlanDialog } from "@/ui/case/EditPlanDialog";
import { SignDialog } from "@/ui/case/SignDialog";
import { Btn, Card, Chip, Empty, ErrorNote, Loading } from "@/ui/kit";
import { OutcomeSummary } from "@/ui/rescue";
import { AdaptationCard } from "@/ui/case/Adaptation";
import { date, money, week } from "@/ui/format";
import { call, useSession } from "@/ui/session";

export default function CasePage() {
  return <Suspense fallback={<Loading />}><Case /></Suspense>;
}

function Case() {
  const { session } = useSession();
  const biz = session?.business.id;
  const cur = session?.business.currency ?? "GBP";
  const params = useSearchParams();
  const [cases, setCases] = useState<any[] | null>(null);
  const [data, setData] = useState<any>(null);
  const [rootId, setRootId] = useState<string | null>(params.get("run"));
  const [roundIdx, setRoundIdx] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<any>(null);
  const [signPlan, setSignPlan] = useState<string | null>(null);
  const [editPlanId, setEditPlanId] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState<any>(null);

  const loadCases = useCallback(async () => {
    if (!biz) return;
    const c = await call(`/api/business/${biz}/cases`);
    if (!c.ok) return;
    setCases(c.data);
    setRootId((cur) => cur ?? (c.data.filter((x: any) => !x.parentRunId && x.lifecycle !== "superseded").at(-1) ?? c.data.filter((x: any) => !x.parentRunId).at(-1))?.runId ?? null);
  }, [biz]);
  const loadCase = useCallback(async () => {
    if (!biz || !rootId) return;
    const c = await call(`/api/business/${biz}/cases/${rootId}`);
    if (c.ok) setData(c.data); else setError(c.data.error ?? "Could not load the case");
  }, [biz, rootId]);
  useEffect(() => { void loadCases(); }, [loadCases]);
  useEffect(() => { void loadCase(); }, [loadCase]);
  // While something is running, keep the timeline live (steps are saved as they happen).
  useEffect(() => { if (!busy) return; const t = setInterval(() => void loadCase(), 1000); return () => clearInterval(t); }, [busy, loadCase]);

  const runs: any[] = data?.runs ?? [];
  const run = runs[roundIdx ?? runs.length - 1];
  const names: Record<string, string> = useMemo(() => Object.fromEntries((data?.counterparties ?? []).map((c: any) => [c.id, c.name])), [data]);
  const auths: any[] = data?.authorisations ?? [];
  const runAuths = auths.filter((a) => a.authorisation.runId === run?.id);
  const latestAuth = runAuths.at(-1);
  const executedAuth = [...auths].reverse().find((a) => a.execution && ["completed", "verification_failed"].includes(a.execution.status));

  // Chart lines for the selected plan and, once executed, the agreed outcome.
  useEffect(() => {
    if (!biz || !run) return;
    const q = new URLSearchParams({ runId: run.id });
    const planId = selected ?? run.plans[0]?.id;
    if (planId) q.set("planId", planId);
    if (executedAuth) q.set("authorisationId", executedAuth.authorisation.id);
    void call(`/api/business/${biz}/room/forecast?${q}`).then((r) => r.ok && setLines(r.data));
  }, [biz, run, selected, executedAuth]);

  async function act(label: string, path: string, after?: (r: any) => void) {
    setBusy(label); setError(null);
    const r = await call(path, {});
    setBusy(null);
    if (!r.ok && r.status !== 422) setError(r.data.error ?? "That did not work");
    else if (r.status === 422 && r.data.error) setError(r.data.error);
    after?.(r);
    await loadCases(); await loadCase();
  }

  if (!cases || (rootId && !data && !error)) return <Loading label="Opening the case" />;
  if (!rootId || !run) {
    return (
      <div className="space-y-4">
        <h1 className="display text-3xl">Plans</h1>
        <Empty title="Nothing to decide right now" action={<div className="flex justify-center gap-2"><Btn busy={!!busy} onClick={() => act("check", `/api/business/${biz}/shortage-check`)}>Check for a shortage now</Btn><Btn variant="secondary" href="/room/commitments">Add a document</Btn></div>}>
          A case opens when the forecast shows a shortage: after you confirm a commitment, or when you ask for a check. Your assistant then investigates and proposes plans. It cannot act on its own.
        </Empty>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    );
  }

  const reason = run.trigger?.reason ?? data.runs[0]?.trigger?.reason;
  const hasPlans = runs.some((r) => r.plans.length > 0);
  const signed = auths.some((a) => a.authorisation.signed);
  const waitingSecond = runAuths.find((a) => a.authorisation.status === "awaiting_second");
  const declinedSecond = runAuths.at(-1)?.authorisation.status === "declined";
  const ran = auths.some((a) => a.execution);
  const verified = auths.some((a) => a.execution?.status === "completed");
  const vfail = auths.some((a) => a.execution?.status === "verification_failed");
  const lastRun = runs.at(-1);
  const lastExec = auths.at(-1)?.execution?.status;
  const haltedClean = lastExec === "rolled_back";
  const haltedUnclean = lastExec === "failed";
  const finished = auths.some((a) => a.execution && ["completed", "verification_failed", "rolled_back", "failed"].includes(a.execution.status)) && lastRun.lifecycle !== "needs_replan";
  const stepState = (done: boolean, active: boolean, bad = false) => (bad ? "bad" : done ? "done" : active ? "active" : "todo") as "done" | "active" | "todo" | "bad";
  const steps = [
    { label: "Problem found", state: stepState(true, false) },
    { label: "Options ready", state: stepState(hasPlans, !hasPlans && run.status !== "running") },
    { label: "You approve", state: stepState(signed, (hasPlans && !signed) || !!waitingSecond) },
    { label: "Assistant acts", state: stepState(ran && !["needs_replan"].includes(lastRun.lifecycle), signed && !ran, lastRun.lifecycle === "needs_replan" || lastRun.lifecycle === "exhausted") },
    { label: "Checked", state: stepState(verified, ran && !verified && !vfail && !haltedClean && !haltedUnclean && !["needs_replan", "exhausted"].includes(lastRun.lifecycle), vfail || haltedClean || haltedUnclean) },
  ];

  const series: Series[] = [];
  if (lines) {
    series.push({ key: "dn", label: "Do nothing", weeks: lines.doNothing.weeks, color: "#8b958f", dashed: true, firstNegativeWeek: lines.doNothing.firstNegativeWeek });
    if (lines.plan) series.push({ key: "plan", label: "Selected plan (as promised)", weeks: lines.plan.weeks, color: "#0d5a50", firstNegativeWeek: lines.plan.firstNegativeWeek });
    if (lines.agreed) series.push({ key: "agreed", label: "Executed: outcome of the agreed terms", weeks: lines.agreed.weeks, color: "#1b7a4a" });
  }
  const isExhausted = lastRun.lifecycle === "exhausted" || exhausted;
  const lastAttempted = (() => { const a = auths.at(-1); const r = a && runs.find((x) => x.id === a.authorisation.runId); return r?.plans.find((p: any) => p.id === a?.authorisation.planId)?.plan ?? null; })();
  const roots = cases.filter((c) => !c.parentRunId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-3xl">Plans</h1>
          <h2 className="display mt-1 text-xl text-ink-soft">{run.trigger?.origin === "simulation" ? "Prepare for a simulated crisis" : "Fix the cash gap"}</h2>
          <p className="text-ink-soft">{run.trigger?.origin === "simulation" ? <>You asked to prepare for a scenario from the simulator. It has not happened. On today&apos;s real books, doing nothing would leave your lowest balance at <b className="num">{money(run.doNothing?.minBalanceMinor, cur)}</b> in {week(run.doNothing?.minBalanceWeek)}.</> : reason ? <>The forecast showed {reason.kind === "below_zero" ? "you running out of cash" : "you dropping below your reserve"}: lowest <b className="num">{money(reason.minBalanceMinor, cur)}</b> in {week(reason.minBalanceWeek)}{reason.firstNegativeWeek ? `, below zero from ${week(reason.firstNegativeWeek)}` : ""}.</> : run.doNothing ? <>A new order or quote started this case. Doing nothing would leave your lowest balance at <b className="num">{money(run.doNothing.minBalanceMinor, cur)}</b> in {week(run.doNothing.minBalanceWeek)}.</> : "A new order or quote started this case."}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <a className="rounded-lg border border-line-strong bg-panel px-3 py-2 font-medium text-accent hover:bg-neutral-soft" href={`/api/business/${biz}/cases/${rootId}/export?format=html`} download>Download the full record</a>
          <a className="rounded-lg border border-line-strong bg-panel px-3 py-2 font-medium text-accent hover:bg-neutral-soft" href={`/api/business/${biz}/cases/${rootId}/export?format=json`} download>Data file (JSON)</a>
        </div>
        {roots.length > 1 && (
          <label className="text-sm text-ink-soft">Case <select className="ml-2 rounded-lg border border-line-strong bg-white px-2 py-1.5 text-ink" value={rootId} onChange={(e) => { setRootId(e.target.value); setData(null); setRoundIdx(null); setSelected(null); setLines(null); }}>
            {roots.map((c) => <option key={c.runId} value={c.runId}>{date(c.startedAt)} · {c.lifecycle}</option>)}</select></label>
        )}
      </div>
      <Stepper steps={steps} />
      {(() => {
        const dn = lines?.doNothing, ag = lines?.agreed;
        const tone = verified ? "good" : vfail || haltedClean || haltedUnclean || isExhausted || declinedSecond ? "danger" : lastRun.lifecycle === "needs_replan" || waitingSecond ? "caution" : "accent";
        const [head, body] = verified && dn && ag
          ? ["Fixed, and checked.", `Your lowest balance goes from ${money(dn.minBalanceMinor, cur)} (doing nothing) to ${money(ag.minBalanceMinor, cur)} with the deals that were actually agreed. A separate check confirmed it.`]
          : vfail ? ["The check found a mismatch.", "What happened in the practice bank did not match what was agreed. Nothing is hidden: see the verification below."]
          : isExhausted ? ["No plan fits inside your limits.", "Your assistant tried everything allowed. Below is the closest option and what you could loosen."]
          : lastRun.lifecycle === "needs_replan" ? ["Someone said no, so your assistant needs to try again.", "Tell it to re-plan: it will avoid what was refused and come back with new options."]
          : waitingSecond ? ["Waiting for a second approver.", `You have confirmed this plan. Because it involves large payments, a different approver must sign in as themselves and confirm it too. Nothing is sent or paid until they do.${session?.user.role === "owner" ? "" : " Open Approvals to confirm it."}`]
          : declinedSecond ? ["The second approver declined this plan.", "Nothing was sent or paid. Adjust the terms or choose another plan, and sign again."]
          : haltedClean ? ["The plan could not finish, so it was rolled back.", "Everything that had been agreed or scheduled was withdrawn, so nothing is left half-done. Read what happened below. You can choose an option and sign again: a fresh signature is needed."]
          : haltedUnclean ? ["The plan failed and the roll-back was not complete.", "Do not assume nothing was left behind. Download the evidence below and check the practice bank before doing anything else."]
          : signed && !ran ? ["You approved a plan. Now let your assistant carry it out.", "It will negotiate and act, but every step must pass your limits first."]
          : hasPlans ? ["Your assistant found ways to fix this. Pick one.", "Compare the options below. Nothing is sent to anyone until you review and sign one: signing is what gives your assistant permission, and only within the limits shown."]
          : ["Your assistant is working on it.", "It reads your numbers and searches for combinations of fixes."];
        return <div className={`rounded-2xl border p-4 ${tone === "good" ? "border-good/40 bg-good-soft" : tone === "danger" ? "border-danger/40 bg-danger-soft" : tone === "caution" ? "border-caution/40 bg-caution-soft" : "border-accent/30 bg-accent-soft/50"}`}><p className="display text-xl">{head}</p><p className="mt-1 text-sm text-ink-soft">{body}</p></div>;
      })()}
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="text-sm"><Link className="text-accent underline" href={`/room/safety?tab=workflow&mode=debug&case=${rootId}`}>See this case on the workflow canvas</Link> <span className="text-ink-soft">(Debug mode)</span></p>

      {runs.length > 1 && (
        <div role="tablist" aria-label="Planning rounds" className="flex flex-wrap gap-2">
          {runs.map((r, i) => <button key={r.id} role="tab" aria-selected={r.id === run.id} onClick={() => { setRoundIdx(i); setSelected(null); }} className={`rounded-full border px-3 py-1 text-sm ${r.id === run.id ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-panel text-ink-soft"}`}>{r.round === 0 ? "First plan" : `Re-plan ${r.round}`}</button>)}
        </div>
      )}

      {auths.filter((a) => a.execution && ["completed", "verification_failed", "failed", "rolled_back"].includes(a.execution.status)).map((a) => (
        <OutcomeSummary key={`o-${a.authorisation.id}`} auth={a} reason={data.runs[0]?.trigger?.reason ?? null} doNothing={lines?.doNothing ?? null} agreed={lines?.agreed ?? null} reserveMinor={lines?.reserveMinor ?? null} cur={cur} exportBase={`/api/business/${biz}/cases/${rootId}/export`} />
      ))}
      {(() => { const a = [...data.runs].reverse().find((r: any) => r.adaptation)?.adaptation ?? exhausted?.adaptation; return a ? <AdaptationCard a={a} cur={cur} /> : null; })()}
      {isExhausted && <ExhaustedCard run={run} last={exhausted?.bestOption?.plan ?? lastAttempted} cur={cur} />}
      <details className="group rounded-2xl border border-line bg-panel"><summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-ink-soft">Show how the assistant worked it out ({run.timeline.length} steps)</summary>
      <Card title="How the assistant worked it out" subtitle={`Round ${run.round}${run.round > 0 ? " · re-plan with learned constraints" : ""} · started ${new Date(run.startedAt).toLocaleTimeString("en-GB")}`} right={<RunChips run={run} />}>
        <Timeline run={run} />
        {run.constraints?.length > 0 && <p className="mt-3 text-xs text-ink-soft">This round respected {run.constraints.length} structured constraint{run.constraints.length === 1 ? "" : "s"} learned from customers, suppliers and lenders.</p>}
      </Card></details>

      {((finished && !haltedClean) || isExhausted) && run.plans.length > 0 ? (
        <details className="rounded-2xl border border-line bg-panel"><summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-ink-soft">Show the options that were compared</summary><div className="space-y-6 p-3">
        {run.plans.length === 0 ? (
          run.status === "running" ? <Loading label="Your assistant is searching for plans" /> : <Empty title="No plans were proposed">{run.error ?? "No plan fits the limits you signed and what the other side has said."}</Empty>
        ) : (
          <>
            <Card title="Your options, compared with doing nothing" subtitle="Every number is calculated by fixed code, not written by the AI.">
              <PlanTable run={run} names={names} cur={cur} selected={selected ?? run.plans[0].id} onSelect={setSelected} reserveMinor={lines?.reserveMinor ?? null} onSign={(id) => setSignPlan(id)} onEdit={(id) => setEditPlanId(id)} canSign={session?.user.role === "owner" && run.id === lastRun.id && !runAuths.some((a) => ["authorised", "awaiting_second"].includes(a.authorisation.status) || (a.authorisation.status === "used" && a.execution?.status !== "rolled_back")) && !isExhausted} />
            </Card>
            <Card title="What each choice would do to your cash" subtitle="A simulation from fixed code: nothing has been sent or changed. The grey dashed line is doing nothing.">
              {lines ? <Chart series={series} reserveMinor={lines.reserveMinor} currency={cur} /> : <Loading />}
            </Card>
          </>
        )}
  
          </div></details>
      ) : (
      <>
      {run.plans.length === 0 ? (
        run.status === "running" ? <Loading label="Your assistant is searching for plans" /> : <Empty title="No plans were proposed">{run.error ?? "No plan fits the limits you signed and what the other side has said."}</Empty>
      ) : (
        <>
          <Card title="Your options, compared with doing nothing" subtitle="Every number is calculated by fixed code, not written by the AI.">
            <PlanTable run={run} names={names} cur={cur} selected={selected ?? run.plans[0].id} onSelect={setSelected} reserveMinor={lines?.reserveMinor ?? null} onSign={(id) => setSignPlan(id)} onEdit={(id) => setEditPlanId(id)} canSign={session?.user.role === "owner" && run.id === lastRun.id && !runAuths.some((a) => ["authorised", "awaiting_second"].includes(a.authorisation.status) || (a.authorisation.status === "used" && a.execution?.status !== "rolled_back")) && !isExhausted} />
          </Card>
          <Card title="What each choice would do to your cash" subtitle="A simulation from fixed code: nothing has been sent or changed. The grey dashed line is doing nothing.">
            {lines ? <Chart series={series} reserveMinor={lines.reserveMinor} currency={cur} /> : <Loading />}
          </Card>
        </>
      )}

      </>
      )}
      {runAuths.map((a) => (
        <Card key={a.authorisation.id} title="Your approved plan in action" subtitle="Every step is checked against your limits before it happens, and checked again after.">
          <ExecutionPanel auth={a} names={names} cur={cur} busy={busy === "execute"} onExecute={() => act("execute", `/api/plan-authorisations/${a.authorisation.id}/execute`)} />
        </Card>
      ))}

      {run.lifecycle === "needs_replan" && latestAuth?.execution?.status === "needs_replan" && (
        <ReplanPanel run={run} constraints={latestAuth.execution.outcome.constraints ?? []} names={names} busy={busy === "replan"} onRevise={() => setRevising(true)} onRelease={() => act("release", `/api/plan-authorisations/${latestAuth.authorisation.id}/release`)} onReplan={() => act("replan", `/api/plan-authorisations/${latestAuth.authorisation.id}/replan`, (r) => r.data?.status === "exhausted" && setExhausted(r.data))} />
      )}

      {auths.filter((a) => a.execution?.verification).map((a) => (
        <Card key={`v-${a.authorisation.id}`} title="Independent check" subtitle="Done by a separate piece of code, not the one that carried out the plan." tone={a.execution.verification.ok ? "good" : "danger"}>
          <VerificationPanel v={a.execution.verification} cur={cur} />
          <p className="mt-3 text-sm"><Link className="text-accent underline" href="/room/safety?tab=results">See the results</Link> · <Link className="text-accent underline" href="/room/safety?tab=records">Read the records</Link></p>
        </Card>
      ))}

      {editPlanId && <EditPlanDialog open onClose={() => setEditPlanId(null)} runId={run.id} plan={run.plans.find((x: any) => x.id === editPlanId)} names={names} counterparties={data?.counterparties ?? []} cur={cur} onSaved={(id) => { setSelected(id); void loadCase(); }} />}
      {revising && latestAuth && (
        <EditPlanDialog open onClose={() => setRevising(false)} runId={run.id} plan={run.plans.find((x: any) => x.id === latestAuth.authorisation.planId) ?? run.plans[0]} names={names} counterparties={data?.counterparties ?? []} cur={cur}
          constraints={latestAuth.execution?.outcome?.constraints ?? []} title="Revise the terms" saveLabel="Open a new round with these terms"
          intro="Their answers are filled in. Change only what you want to change: the terms for the one who pushed back, for all of them, or untick a term to drop it. Nothing is sent until you sign the new round; every number is recomputed by the engine."
          submit={({ levers, notes, commit }) => call(`/api/plan-authorisations/${latestAuth.authorisation.id}/revise`, { levers, notes, commit })}
          onSaved={() => { setRevising(false); void loadCases(); void loadCase(); }} />
      )}
      {signPlan && <SignDialog open onClose={() => setSignPlan(null)} runId={run.id} planId={signPlan} plan={run.plans.find((x: any) => x.id === signPlan)?.plan ?? null} doNothing={run.doNothing} reserveMinor={lines?.reserveMinor ?? null} cur={cur} onSigned={() => { setSignPlan(null); void loadCases(); void loadCase(); }} />}
      {!signed && hasPlans && !isExhausted && <p className="text-center text-sm text-ink-soft">Nothing has been sent to anyone. <Chip tone="neutral">waiting for your signature</Chip></p>}
    </div>
  );
}
