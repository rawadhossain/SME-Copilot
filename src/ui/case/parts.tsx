"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Presentational parts of the shortage case: stepper, planner timeline, plan comparison, execution, re-plan and verification.
import { useState } from "react";
import { Btn, Card, Chip, Th, type Tone } from "../kit";
import { constraintText, date, dateTime, leverText, money, pct, week } from "../format";

export const nameOf = (names: Record<string, string>, id: string) => (names[id] ?? "a counterparty").replace(" (SYNTHETIC)", "");

// ---------------------------------------------------------------- stepper
export function Stepper({ steps }: { steps: { label: string; state: "done" | "active" | "todo" | "bad" }[] }) {
  return (
    <div className="overflow-x-auto">
      <ol className="grid min-w-[40rem] grid-cols-5 gap-2" aria-label="Progress of this case">
        {steps.map((s, i) => (
          <li key={s.label} aria-current={s.state === "active" ? "step" : undefined} className={`rounded-xl border px-3 py-2 text-sm ${s.state === "done" ? "border-good/40 bg-good-soft text-good" : s.state === "active" ? "border-accent bg-accent-soft text-accent" : s.state === "bad" ? "border-danger/40 bg-danger-soft text-danger" : "border-line bg-panel text-ink-soft"}`}>
            <span className="num text-xs opacity-70">{i + 1}</span> <span className="font-medium">{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- status chips
export function lifecycleChip(run: any): { tone: Tone; label: string; pulse?: boolean } {
  if (run.status === "running") return { tone: "accent", label: "running", pulse: true };
  switch (run.lifecycle) {
    case "needs_replan": return { tone: "caution", label: "needs re-plan" };
    case "replanned": return { tone: "neutral", label: "re-planned" };
    case "exhausted": return { tone: "danger", label: "exhausted" };
    case "executed": return { tone: "good", label: "executed and verified" };
    case "verification_failed": return { tone: "danger", label: "verification failed" };
    case "superseded": return { tone: "neutral", label: "superseded" };
    default: return run.status === "refused" || run.status === "failed" ? { tone: "danger", label: run.status } : { tone: "accent", label: "plans ready" };
  }
}

export function RunChips({ run }: { run: any }) {
  const c = lifecycleChip(run);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Chip tone={c.tone} pulse={c.pulse}>{c.label}</Chip>
      {run.fallbackUsed && <Chip tone="caution">fallback used</Chip>}
      <Chip tone="neutral">{run.planSource === "ai" ? "AI planner" : run.planSource === "deterministic" ? "deterministic planner" : run.planSource === "owner" ? "your revision" : "no plans"}</Chip>
    </span>
  );
}

// ---------------------------------------------------------------- planner timeline
export function Timeline({ run }: { run: any }) {
  const [all, setAll] = useState(false);
  const steps: any[] = run.timeline.filter((s: any) => s.kind !== "tool_result" && s.kind !== "llm_message");
  const shown = all ? steps : steps.slice(-8);
  return (
    <div>
      <ol className="space-y-1.5">
        {shown.map((s) => (
          <li key={s.seq} className="flex items-start gap-3 text-sm">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.tone === "good" ? "bg-good" : s.tone === "caution" ? "bg-caution" : s.tone === "danger" ? "bg-danger" : "bg-line-strong"}`} aria-hidden />
            <span className="flex-1">{s.label}</span><span className="num text-xs text-ink-soft">{dateTime(s.at)}</span>
          </li>
        ))}
        {run.status === "running" && <li className="pulse pl-5 text-sm text-accent">working…</li>}
      </ol>
      {steps.length > 8 && <button className="mt-2 text-xs text-accent underline" onClick={() => setAll(!all)}>{all ? "Show fewer steps" : `Show all ${steps.length} steps`}</button>}
      <p className="mt-2 text-xs text-ink-soft">These are tool calls and checks recorded as the planner worked. The planner never receives raw document text or counterparty free text.</p>
    </div>
  );
}

// ---------------------------------------------------------------- plan comparison
export function PlanTable({ run, names, cur, selected, onSelect, onSign, onEdit, canSign }: { run: any; names: Record<string, string>; cur: string; selected: string | null; onSelect: (id: string) => void; onSign: (id: string) => void; onEdit: (id: string) => void; canSign: boolean }) {
  const dn = run.doNothing;
  const rows: { label: string; dn: React.ReactNode; get: (p: any) => React.ReactNode }[] = [
    { label: "Lowest balance", dn: dn ? <span className={`num ${BigInt(dn.minBalanceMinor) < 0n ? "text-danger" : ""}`}>{money(dn.minBalanceMinor, cur)}</span> : "–", get: (p) => <span className={`num ${BigInt(p.metrics.minBalanceMinor) < 0n ? "text-danger" : "text-good"}`}>{money(p.metrics.minBalanceMinor, cur)} <span className="text-xs text-ink-soft">({week(p.metrics.minBalanceWeek)})</span></span> },
    { label: "Weeks below zero", dn: dn ? dn.weeksBelowZero ?? (dn.firstNegativeWeek ? "some" : 0) : "–", get: (p) => (p.metrics.weeksBelowZero ?? (p.metrics.firstNegativeWeek ? "some" : 0)) },
    { label: "First negative week", dn: dn ? week(dn.firstNegativeWeek) : "–", get: (p) => week(p.metrics.firstNegativeWeek) },
    { label: "Total cost", dn: money("0", cur), get: (p) => <span className="num">{money(p.metrics.totalCostMinor, cur)}</span> },
    { label: "Closing balance", dn: dn ? <span className="num">{money(dn.closingAtHorizonMinor, cur)}</span> : "–", get: (p) => <span className="num">{money(p.metrics.closingAtHorizonMinor, cur)}</span> },
    { label: "Who it will talk to", dn: "none", get: (p) => `${p.metrics.counterpartiesNeeded}: ${[...new Set(p.levers.map((l: any) => nameOf(names, l.counterpartyId)))].join(", ")}` },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="align-bottom">
            <th className="w-36" />
            <th scope="col" className="px-2 pb-2 text-left"><span className="block text-xs uppercase tracking-wide text-ink-soft">Baseline</span><span className="display">Do nothing</span></th>
            {run.plans.map((p: any, i: number) => (
              <th key={p.id} scope="col" className={`px-2 pb-2 text-left ${selected === p.id ? "bg-accent-soft/50" : ""}`}>
                <span className="block text-xs uppercase tracking-wide text-ink-soft">{p.plan.source === "owner" ? "Your edit" : i === 0 ? "Recommended" : `Alternative ${i}`}</span><span className="display">Plan {i + 1}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-line align-top"><th scope="row" className="py-2 pr-2 text-left text-xs font-medium text-ink-soft">{r.label}</th><td className="px-2 py-2">{r.dn}</td>
              {run.plans.map((p: any) => <td key={p.id} className={`px-2 py-2 ${selected === p.id ? "bg-accent-soft/50" : ""}`}>{r.get(p.plan)}</td>)}</tr>
          ))}
          <tr className="border-t border-line align-top"><th scope="row" className="py-2 pr-2 text-left text-xs font-medium text-ink-soft">What it does</th><td className="px-2 py-2 text-ink-soft">Accept the order on its original terms.</td>
            {run.plans.map((p: any) => (
              <td key={p.id} className={`px-2 py-2 ${selected === p.id ? "bg-accent-soft/50" : ""}`}>
                <ul className="space-y-1">{p.plan.levers.map((l: any, i: number) => <li key={i}>{leverText(l, nameOf(names, l.counterpartyId))}</li>)}</ul>
                {Object.entries(p.plan.ownerNotes ?? {}).map(([id, t]) => <p key={id} className="mt-1 text-xs text-ink-soft">Your note for {nameOf(names, id)}: {String(t)}</p>)}
              </td>
            ))}</tr>
          <tr className="border-t border-line align-top"><th scope="row" className="py-2 pr-2 text-left text-xs font-medium text-ink-soft">Within your limits?</th><td className="px-2 py-2 text-ink-soft">–</td>
            {run.plans.map((p: any) => {
              const checks: any[] = p.plan.checks ?? [];
              const denied = checks.filter((c) => c.decision === "deny");
              return <td key={p.id} className={`px-2 py-2 ${selected === p.id ? "bg-accent-soft/50" : ""}`}>
                {denied.length ? <><Chip tone="danger">blocked</Chip><p className="mt-1 text-xs text-danger">{denied[0].reasons[0]}</p></> : <><Chip tone="good">within your limits</Chip><p className="mt-1 text-xs text-ink-soft">{checks.length} check{checks.length === 1 ? "" : "s"} passed; needs your signature</p></>}
              </td>;
            })}</tr>
          <tr className="border-t border-line align-top"><th scope="row" className="py-2 pr-2 text-left text-xs font-medium text-ink-soft">Flags</th><td className="px-2 py-2 text-ink-soft">–</td>
            {run.plans.map((p: any) => (
              <td key={p.id} className={`px-2 py-2 text-xs ${selected === p.id ? "bg-accent-soft/50" : ""}`}>
                {(p.plan.warnings ?? []).map((w: string, i: number) => <p key={i} className="text-caution">⚠ {w}</p>)}
                {p.plan.proseFlagged && <p className="text-caution">⚠ The agent&apos;s wording contained numbers no tool produced; those sentences were removed.</p>}
                {!(p.plan.warnings ?? []).length && !p.plan.proseFlagged && <span className="text-ink-soft">none</span>}
              </td>
            ))}</tr>
          <tr className="border-t border-line"><td />
            <td />
            {run.plans.map((p: any) => (
              <td key={p.id} className="px-2 py-3">
                <div className="flex flex-col gap-2">
                  <Btn variant={selected === p.id ? "primary" : "secondary"} onClick={() => onSelect(p.id)} aria-pressed={selected === p.id}>{selected === p.id ? "Shown on the chart" : "Show on the chart"}</Btn>
                  {canSign && <Btn variant="ghost" onClick={() => onEdit(p.id)}>Adjust terms…</Btn>}
                  {canSign && (p.plan.blockers?.length ? <Btn variant="ghost" disabled title="A payment these terms imply would break your signed limits. Use Adjust terms to fix it.">Cannot be signed as it is</Btn> : <Btn variant="ghost" onClick={() => onSign(p.id)}>Review and sign…</Btn>)}
                </div>
              </td>
            ))}</tr>
        </tbody>
      </table>
      {run.plans.map((p: any, i: number) => selected === p.id && (
        <div key={p.id} className="mt-4 rounded-xl border border-line bg-white/60 p-4 text-sm">
          <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-soft">Agent&apos;s explanation of plan {i + 1} <Chip tone="neutral">{p.plan.source === "owner" ? "adjusted by you; every number is recomputed by the engine" : `written by the ${p.plan.source === "ai" ? "AI" : "planner"}; numbers are not taken from it`}</Chip></p>
          <p className="font-medium">{p.plan.title}</p><p className="text-ink-soft">{p.plan.rationale}</p>
          <details className="mt-2"><summary className="cursor-pointer text-xs text-accent">Assumptions</summary><ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">{(p.plan.assumptions ?? []).map((a: string, k: number) => <li key={k}>{a}</li>)}</ul></details>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- execution
const BRANCH: Record<string, [string, Tone]> = {
  pending: ["Waiting", "neutral"], agreed: ["Agreed", "good"], offered: ["Offer received", "good"], committed: ["Committed", "good"], failed: ["Failed", "danger"],
};
function branchState(b: any): [string, Tone] {
  if (b.status === "needs_replan") {
    const r = String(b.reason ?? "");
    return /refus|declin|rejected/i.test(r) ? ["Refused", "danger"] : ["Countered outside your terms", "caution"];
  }
  return BRANCH[b.status] ?? [b.status, "neutral"];
}
const ACTION_LABEL: Record<string, string> = {
  "sandbox.send_proposal": "Send proposal", "sandbox.submit_application": "Submit finance application", "sandbox.accept_offer": "Take up the finance offer",
  "sandbox.schedule_payment": "Schedule payment", "sandbox.schedule_receipt": "Schedule receipt", "sandbox.withdraw": "Withdraw (rollback)", "sandbox.cancel_payment": "Cancel payment",
};

export function ExecutionPanel({ auth, names, cur, busy, onExecute }: { auth: any; names: Record<string, string>; cur: string; busy: boolean; onExecute: () => void }) {
  const a = auth.authorisation, ex = auth.execution;
  const out = ex?.outcome;
  const rolled = out?.compensated?.length > 0;
  const stateTone: [Tone, string] = ex ? (ex.status === "completed" ? ["good", "Executed and verified"] : ex.status === "needs_replan" ? ["caution", "Stopped: waiting for your decision"] : ex.status === "rolled_back" ? ["danger", "Rolled back"] : ex.status === "verification_failed" ? ["danger", "Verification failed"] : ex.status === "failed" ? ["danger", "Failed"] : ["accent", "Running"]) : a.status === "authorised" ? ["accent", "Signed, waiting to run"] : a.status === "denied" ? ["danger", "Denied at signing"] : a.status === "expired" ? ["danger", "Expired"] : ["neutral", a.status];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Chip tone={stateTone[0]}>{stateTone[1]}</Chip>
        <span className="text-sm text-ink-soft">Signed by {a.approvedBy ?? "–"} · expires {dateTime(a.expiresAt)} · limits version {a.mandateVersion}</span>
        {a.status === "authorised" && <Btn busy={busy} onClick={onExecute} className="ml-auto">Run the plan</Btn>}
      </div>
      {(a.letters || a.signatureImage) && (
        <details className="rounded-lg border border-line bg-white/70 p-3 text-sm">
          <summary className="cursor-pointer font-medium">Proposal letters and signature, exactly as signed</summary>
          <div className="mt-3 space-y-4">
            {Object.entries(a.letters ?? {}).map(([cp, l]: [string, any]) => (
              <article key={cp} className="rounded-lg border border-line bg-white px-5 py-4" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                <p className="text-xs text-ink-soft" style={{ fontFamily: "system-ui, sans-serif" }}>To {nameOf(names, cp)}</p>
                <p className="mt-1 font-semibold">Subject: {l.subject}</p>
                {l.paragraphs.map((p: string, i: number) => <p key={i} className="mt-2">{p}</p>)}
              </article>
            ))}
            {a.signatureImage && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(a.signatureImage) && (
              <div><p className="mb-1 text-xs text-ink-soft">Drawn signature, fingerprint <span className="font-mono">{String(a.signatureHash ?? "").slice(0, 12)}</span>. Its fingerprint and the letters&apos; are inside the owner signature, so neither can change.</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={`Drawn signature of ${a.approvedBy ?? "the owner"}`} src={a.signatureImage} className="max-w-xs rounded-lg border border-line bg-white" /></div>
            )}
          </div>
        </details>
      )}
      {out?.branches?.length > 0 && (
        <table className="w-full text-sm">
          <thead><tr><Th>Counterparty</Th><Th>What we asked</Th><Th>Answer</Th><Th>Terms</Th></tr></thead>
          <tbody>
            {out.branches.map((b: any) => { const [label, tone] = branchState(b); return (
              <tr key={b.index} className="border-t border-line align-top">
                <td className="py-2 pr-3 font-medium">{nameOf(names, b.counterpartyId)}</td>
                <td className="pr-3">{leverText(a.terms?.entries?.[b.index]?.lever ?? { kind: b.kind })}</td>
                <td className="pr-3"><Chip tone={tone}>{label}</Chip>{b.withdrawn && <Chip tone="neutral">withdrawn</Chip>}{!b.withdrawn && !b.adopted && ex?.status === "needs_replan" && (b.status === "agreed" || b.status === "offered") && <Chip tone="caution">on hold</Chip>}{b.adopted && <Chip tone="accent">kept in the new round</Chip>}{b.carriedFrom && <Chip tone="accent">kept from the earlier round</Chip>}{b.reason && <p className="mt-1 text-xs text-ink-soft">{b.reason}</p>}</td>
                <td className="num text-xs">{b.agreedTerms ? Object.entries(b.agreedTerms).map(([k, v]) => `${k.replace(/Bps$/, "")}: ${k.endsWith("Bps") ? pct(Number(v)) : String(v)}`).join(", ") : b.offer ? `advance ${pct(b.offer.advanceBps)}, fee ${pct(b.offer.feeBps)}` : "–"}</td>
              </tr>); })}
          </tbody>
        </table>
      )}
      {out?.scheduled?.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium">Scheduled in the sandbox bank</h4>
          <ul className="space-y-1 text-sm">{out.scheduled.map((s: any) => <li key={s.id} className="flex items-center gap-2"><Chip tone={s.withdrawn ? "neutral" : s.kind === "receipt" ? "good" : "accent"}>{s.kind}</Chip><span className="num">{money(s.amountMinor, cur)}</span><span className="text-ink-soft">on {date(s.date)}</span>{s.withdrawn && <span className="text-xs text-ink-soft">cancelled</span>}</li>)}</ul>
          <p className="mt-1 text-xs text-ink-soft">They stay scheduled until the bank&apos;s end-of-day job, so the whole plan can still be withdrawn.</p>
        </div>
      )}
      {rolled && <div role="status" className="rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger"><b>Rolled back.</b> {out.compensated.length} agreement{out.compensated.length === 1 ? "" : "s"} or scheduled item{out.compensated.length === 1 ? "" : "s"} withdrawn so nothing is half-applied{out.compensated.every((c: any) => c.ok) ? "." : ", but at least one withdrawal failed: see the evidence log."}</div>}
      {out?.failure && <p className="text-sm text-danger">Stopped at “{out.failure.step}”: {out.failure.reason}</p>}
      {auth.actions?.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-accent">Every action ({auth.actions.length}): gate decision, execution, verification</summary>
          <table className="mt-2 w-full text-sm">
            <thead><tr><Th>Action</Th><Th>Gate</Th><Th>Status</Th></tr></thead>
            <tbody>
              {auth.actions.map((x: any) => (
                <tr key={x.id} className="border-t border-line"><td className="py-1.5 pr-3">{ACTION_LABEL[x.kind] ?? x.kind}{x.payload?.counterpartyId ? ` · ${nameOf(names, x.payload.counterpartyId)}` : ""}</td>
                  <td className="pr-3"><Chip tone={x.gateResult?.decision === "deny" ? "danger" : "neutral"}>{x.gateResult?.decision === "needs_approval" ? "within limits" : x.gateResult?.decision}</Chip></td>
                  <td><Chip tone={x.status === "verified" ? "good" : x.status === "executed" ? "accent" : x.status === "failed" || x.status === "denied" ? "danger" : "neutral"}>{x.status}</Chip></td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- re-plan
export function ReplanPanel({ run, constraints, names, onReplan, onRevise, onRelease, busy, maxRounds = 2 }: { run: any; constraints: any[]; names: Record<string, string>; onReplan: () => void; onRevise: () => void; onRelease: () => void; busy: boolean; maxRounds?: number }) {
  const left = maxRounds - run.round;
  return (
    <Card tone="caution" title="A counterparty did not accept your terms" subtitle="Agreements already reached are kept on hold. Nothing is committed or paid until you decide and sign.">
      <p className="mb-2 text-sm font-medium">What the counterparties told us (structured answers only):</p>
      <ul className="mb-3 space-y-1 text-sm">
        {constraints.length === 0 && <li className="text-ink-soft">No usable constraint was learned.</li>}
        {constraints.map((c, i) => <li key={i} className="flex gap-2"><span className="text-caution" aria-hidden>●</span>{constraintText(c, nameOf(names, c.counterpartyId))}</li>)}
      </ul>
      <p className="mb-3 text-sm text-ink-soft">You can revise the terms yourself (their answers are filled in; terms you leave unchanged stay agreed, and only the ones you change are asked again), ask the agent to plan again (this withdraws the held agreements first), or withdraw everything. Either way the new plan needs <b>a new signature from you</b>; nothing runs automatically.{left <= 0 ? " The agent has used its re-plan rounds, but you can still revise the terms yourself." : ""}</p>
      <div className="flex flex-wrap gap-2"><Btn onClick={onRevise}>Revise the terms myself</Btn><Btn variant="secondary" busy={busy} disabled={left <= 0} onClick={onReplan}>Ask the agent to re-plan</Btn><Btn variant="ghost" busy={busy} onClick={onRelease}>Withdraw everything</Btn></div>
    </Card>
  );
}

export function ExhaustedCard({ run, last, cur }: { run: any; last: any; cur: string }) {
  const dn = run.doNothing;
  return (
    <Card tone="danger" title="No feasible plan inside your constraints" subtitle="The two re-plan rounds are used up. Nothing was left half-done.">
      <p className="text-sm">The closest documented option was refused by a counterparty, and every other option breaks one of your limits or a constraint they told us. You decide what to do next: accept different terms, ask again later, or do nothing.</p>
      {last && <p className="mt-2 text-sm"><b>Closest option:</b> {last.levers.map((l: any) => leverText(l)).join("; ")} (lowest balance <span className="num">{money(last.metrics.minBalanceMinor, cur)}</span>).</p>}
      {dn && <p className="mt-1 text-sm"><b>If you do nothing:</b> lowest balance <span className="num">{money(dn.minBalanceMinor, cur)}</span> in {week(dn.minBalanceWeek)}.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- verification
const METRIC: Record<string, string> = { minBalanceMinor: "Lowest balance", minBalanceWeek: "Week of the lowest balance", firstNegativeWeek: "First negative week", closingAtHorizonMinor: "Closing balance", totalCostMinor: "Total cost" };

export function VerificationPanel({ v, cur }: { v: any; cur: string }) {
  const val = (m: any, x: string | null) => (m.kind === "money" ? money(x, cur) : x === null ? "none" : `week ${x}`);
  const dir = v.promiseVsAgreed?.direction;
  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${v.ok ? "border-good/40 bg-good-soft" : "border-danger/40 bg-danger-soft"}`} role="status">
        <Chip tone={v.ok ? "good" : "danger"}>{v.ok ? "Verification passed" : "Verification FAILED"}</Chip>
        <p className="text-sm">{v.ok ? "An independent check recomputed your forecast from what the sandbox actually holds, and it matches what the agreed terms should give." : "The sandbox does not match what was agreed. Nothing was fixed or retried automatically: you decide."}</p>
      </div>
      <div>
        <h4 className="mb-1 text-sm font-medium">Promised → agreed terms → actual</h4>
        <table className="w-full text-sm">
          <thead><tr><Th>Measure</Th><Th right>Plan promised</Th><Th right>Agreed terms give</Th><Th right>Recomputed from the sandbox</Th><Th>Check</Th></tr></thead>
          <tbody>
            {v.metrics.map((m: any, i: number) => { const p = v.promiseVsAgreed?.metrics?.[i]; return (
              <tr key={m.name} className="border-t border-line">
                <td className="py-2 pr-3 font-medium">{METRIC[m.name] ?? m.name}</td>
                <td className="num pr-3 text-right text-ink-soft">{p ? val(p, p.promised) : "–"}</td>
                <td className="num pr-3 text-right">{val(m, m.promised)}</td>
                <td className="num pr-3 text-right">{val(m, m.actual)}</td>
                <td><Chip tone={m.ok ? "good" : "danger"}>{m.ok ? "match" : `differs by ${m.kind === "money" ? money(m.difference, cur) : m.difference}`}</Chip></td>
              </tr>); })}
          </tbody>
        </table>
      </div>
      {v.promiseVsAgreed && <p className="rounded-lg border border-line bg-white/60 px-3 py-2 text-sm"><Chip tone={dir === "worse" ? "caution" : dir === "better" ? "good" : "neutral"}>{dir === "same" ? "as planned" : dir}</Chip> <span className="ml-1">{v.promiseVsAgreed.label}</span></p>}
      <p className="text-sm text-ink-soft">Scheduled payments and receipts: {v.schedule.found} of {v.schedule.expected} found, {v.schedule.ok ? "all as the agreed terms imply" : "PROBLEM: " + v.schedule.problems.join("; ")}.</p>
      {v.explanation?.length > 0 && <ul className="list-disc pl-5 text-sm text-ink-soft">{v.explanation.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
    </div>
  );
}
