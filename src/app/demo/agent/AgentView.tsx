"use client";

import { useState } from "react";
import { formatMoney, money } from "@/lib/money";
import type { Lever, PlanView } from "@/domain/plan";

interface Sample {
  file: string;
  kind: "supplier_quote" | "purchase_order";
  text: string;
}
interface Step {
  seq: number;
  kind: "llm_message" | "tool_call" | "tool_result" | "validation" | "note";
  payload: Record<string, unknown>;
}
interface RunData {
  run: { id: string; status: string; planSource: string | null; model: string; mode: string; error: string | null };
  steps: Step[];
  plans: { id: string; rank: number; status: string; plan: PlanView }[];
}
interface Metrics {
  minBalanceMinor: string;
  minBalanceWeek: number;
  firstNegativeWeek: number | null;
  weeksBelowReserve: number;
  closingAtHorizonMinor: string;
}

const gbp = (minor: string) => formatMoney(money(BigInt(minor), "GBP"), 2);
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;

export default function AgentView({ businessId, names, sample, llm }: { businessId: string; names: Record<string, string>; sample: Sample[]; llm: string }) {
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [data, setData] = useState<RunData | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function api(path: string, body?: unknown) {
    const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function loadSample() {
    setBusy(true);
    setStatus("");
    try {
      let last: string | null = null;
      for (const s of sample) {
        const r = await api(`/api/business/${businessId}/documents`, { filename: s.file, kind: s.kind, text: s.text });
        if (!r.ok) return setStatus(`Error ${r.status}: ${String(r.json.error ?? "extraction failed")}`);
        const ex = (r.json as { extraction: { id: string } }).extraction;
        const c = await api(`/api/extractions/${ex.id}/confirm`, { confirmedBy: "Demo Owner (demo shortcut)" });
        if (!c.ok) return setStatus(`Error ${c.status}: ${String(c.json.error ?? "confirm failed")}`);
        last = ex.id;
      }
      setExtractionId(last);
      setStatus("Sample commitment loaded and confirmed through the owner path (demo shortcut).");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!extractionId) return;
    setBusy(true);
    setStatus("");
    setData(null);
    try {
      const r = await api(`/api/business/${businessId}/agent/runs`, { trigger: { type: "commitment", extractionId } });
      const runId = (r.json as { runId?: string }).runId;
      if (!runId) return setStatus(`Error ${r.status}: ${String(r.json.error ?? "run failed")}`);
      const d = await api(`/api/agent/runs/${runId}`);
      if (d.ok) setData(d.json as unknown as RunData);
      if (!r.ok) setStatus(`Run ${String((r.json as { status?: string }).status)}: ${String(r.json.note ?? r.json.error ?? "")}`);
    } finally {
      setBusy(false);
    }
  }

  const baseline = data?.steps.find((s) => s.kind === "note" && s.payload.type === "do_nothing")?.payload.metrics as Metrics | undefined;
  const nm = (id: string) => names[id] ?? "a counterparty";
  const words = (l: Lever) => {
    switch (l.kind) {
      case "supplier_reduce_deposit": return `Ask ${nm(l.counterpartyId)} to cut the deposit to ${pct(l.percentBps)}`;
      case "supplier_defer_balance": return `Ask ${nm(l.counterpartyId)} to take the balance ${l.daysAfterShipment} days after shipment`;
      case "buyer_request_deposit": return `Ask ${nm(l.counterpartyId)} for a ${pct(l.percentBps)} deposit`;
      case "finance_invoice": return `Apply to ${nm(l.counterpartyId)} for an invoice-finance advance of ${pct(l.advanceBps)}`;
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Planning agent</h1>
        <p className="text-sm text-zinc-600">Synthetic data. The agent can only read and propose plans. It cannot execute, send, schedule or approve anything. Every number is computed by code. {llm}</p>
      </header>

      <section className="space-y-2 rounded border p-4">
        <p className="text-sm">
          <strong>Demo shortcut:</strong> loads the synthetic supplier quote and customer purchase order, reads them and confirms them as the owner. Normally the owner confirms each on the Documents page.
        </p>
        <div className="flex gap-2">
          <button className="rounded border px-3 py-1 disabled:opacity-50" disabled={busy} onClick={loadSample}>Load sample commitment</button>
          <button className="rounded border bg-zinc-900 px-3 py-1 text-white disabled:opacity-50" disabled={busy || !extractionId} onClick={start}>Start planning run</button>
        </div>
        {status && <p className="text-sm">{status}</p>}
      </section>

      {data && (
        <>
          <section>
            <h2 className="mb-2 text-lg font-semibold">Run: {data.run.status} <span className="text-sm font-normal text-zinc-600">(plans from: {data.run.planSource ?? "none"}; model {data.run.model || "n/a"}, {data.run.mode || "n/a"})</span></h2>
            {data.run.error && <p className="text-sm text-red-700">Error: {data.run.error}</p>}
            <ol className="space-y-1 text-sm">
              {data.steps.map((s) => (
                <li key={s.seq} className="rounded border px-2 py-1">
                  <span className="mr-2 inline-block w-24 text-xs uppercase text-zinc-500">{s.kind.replace("_", " ")}</span>
                  {summary(s)}
                  <details className="text-xs text-zinc-500">
                    <summary className="cursor-pointer">details</summary>
                    <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(s.payload, null, 1)}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Plans (20-week horizon)</h2>
            {baseline && (
              <div className="rounded border border-dashed p-4">
                <h3 className="font-semibold">Do nothing (computed baseline)</h3>
                <p className="text-sm">{metricsLine(baseline)}</p>
              </div>
            )}
            {data.plans.length === 0 && <p className="text-sm">No plans in this run.</p>}
            {data.plans.map(({ id, rank, plan }) => (
              <article key={id} className="space-y-2 rounded border p-4">
                <h3 className="font-semibold">
                  {rank}. {plan.title}{" "}
                  <span className="ml-2 rounded bg-zinc-200 px-2 py-0.5 text-xs font-normal">{plan.source === "ai" ? "AI" : "deterministic"}</span>
                  {rank === 1 && <span className="ml-2 rounded bg-green-100 px-2 py-0.5 text-xs font-normal">recommended</span>}
                </h3>
                <ul className="list-disc pl-5 text-sm">
                  {plan.levers.map((l, i) => <li key={i}>{words(l)}</li>)}
                </ul>
                <p className="text-sm">{metricsLine(plan.metrics)}</p>
                <p className="text-sm">Total cost {gbp(plan.metrics.totalCostMinor)}. Counterparties to ask: {plan.metrics.counterpartiesNeeded}.</p>
                <div className="text-sm">
                  <strong>Gate dry-run (nothing is sent):</strong>
                  <ul className="list-disc pl-5">
                    {plan.checks.map((c, i) => <li key={i}>{words(c.lever)}: <strong>{c.decision.replace("_", " ")}</strong>{c.reasons.length > 0 && ` (${c.reasons.join("; ")})`}</li>)}
                  </ul>
                </div>
                {plan.contingencies.length > 0 && (
                  <div className="text-sm">
                    <strong>If a request is refused:</strong>
                    <ul className="list-disc pl-5">{plan.contingencies.map((c, i) => <li key={i}>{JSON.stringify(c)}</li>)}</ul>
                  </div>
                )}
                <p className="text-sm"><strong>Rationale:</strong> {plan.rationale}</p>
                {(plan.warnings ?? []).map((w, i) => <p key={i} className="rounded bg-amber-100 p-2 text-sm">Warning (computed by code): {w}</p>)}
                {plan.proseFlagged && <p className="rounded bg-amber-100 p-2 text-sm">Prose flagged: a sentence with a number that no tool result supports was removed.{plan.removedSentences.length > 0 && ` Removed ${plan.removedSentences.length} sentence(s).`}</p>}
                <details className="text-sm">
                  <summary className="cursor-pointer">Assumptions</summary>
                  <ul className="list-disc pl-5">{plan.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </details>
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function metricsLine(m: Metrics) {
  const neg = m.firstNegativeWeek === null ? "never goes negative" : `first negative in week ${m.firstNegativeWeek}`;
  return `Lowest balance ${gbp(m.minBalanceMinor)} in week ${m.minBalanceWeek}; ${neg}; ${m.weeksBelowReserve} week(s) below reserve; closing balance at the horizon ${gbp(m.closingAtHorizonMinor)}.`;
}

function summary(s: Step): string {
  const p = s.payload;
  switch (s.kind) {
    case "llm_message": return `Model message (${String(p.text ?? "").length} characters)`;
    case "tool_call": return `Called ${String(p.toolName)}`;
    case "tool_result": return `Result from ${String(p.toolName)}`;
    case "validation": return `Validation: ${String(p.type ?? p.status ?? "check")}${p.reasons ? ` - ${(p.reasons as string[]).join("; ")}` : ""}`;
    default: return `Note: ${String(p.type ?? "")}${p.note ? ` - ${String(p.note)}` : ""}${p.reason ? ` - ${String(p.reason)}` : ""}`;
  }
}
