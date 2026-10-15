"use client";

import { useState } from "react";
import { formatMoney, money } from "@/lib/money";
import type { CommitmentEventJson } from "@/domain/commitment-event";
import type { ExtractionView } from "@/ingest/documents";
import type { ScenarioResponse } from "@/engine/service";

interface Fixture {
  id: string;
  label: string;
  file: string;
  kind: "purchase_order" | "supplier_quote";
  text: string;
}

interface Run {
  document: { id: string; filename: string; kind: string };
  extraction: ExtractionView;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export default function DocumentsView({ businessId, fixtures, llm }: { businessId: string; fixtures: Fixture[]; llm: string }) {
  const [choice, setChoice] = useState(fixtures[0]?.id ?? "paste");
  const [kind, setKind] = useState<"purchase_order" | "supplier_quote">("purchase_order");
  const [pasted, setPasted] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<Record<string, CommitmentEventJson[]>>({});
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null);

  const fx = fixtures.find((f) => f.id === choice);
  const fm = (minor: string, cur: string) => formatMoney(money(BigInt(minor), cur), 2);

  async function api(path: string, body?: unknown) {
    const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function extract() {
    setBusy(true);
    setStatus("");
    setScenario(null);
    try {
      const t = fx ? fx.text : pasted;
      const k = fx ? fx.kind : kind;
      const r = await api(`/api/business/${businessId}/documents`, { filename: fx ? fx.file : "pasted-document.txt", kind: k, text: t });
      if (!r.ok) {
        setStatus(`Error ${r.status}: ${String(r.json.error ?? "request failed")}`);
        return;
      }
      setText(t);
      setRun(r.json as unknown as Run);
    } finally {
      setBusy(false);
    }
  }

  async function decide(kindOf: "confirm" | "reject") {
    if (!run) return;
    setBusy(true);
    try {
      const body = kindOf === "confirm" ? { confirmedBy: "Demo Owner" } : { rejectedBy: "Demo Owner", reason: "rejected in the demo" };
      const r = await api(`/api/extractions/${run.extraction.id}/${kindOf}`, body);
      if (!r.ok) {
        setStatus(`Error ${r.status}: ${String(r.json.error ?? "refused")}`);
        return;
      }
      setRun({ ...run, extraction: { ...run.extraction, status: kindOf === "confirm" ? "confirmed" : "rejected" } });
      if (kindOf === "confirm") setConfirmed((c) => ({ ...c, [run.extraction.id]: (r.json as { events: CommitmentEventJson[] }).events }));
      setStatus(kindOf === "confirm" ? "Confirmed by the owner and logged." : "Rejected and logged.");
    } finally {
      setBusy(false);
    }
  }

  const allEvents = Object.values(confirmed).flat().sort((a, b) => a.date.localeCompare(b.date));

  async function applyScenario() {
    setBusy(true);
    try {
      const r = await api(`/api/business/${businessId}/scenario`, { events: allEvents, horizonWeeks: 20 });
      if (!r.ok) setStatus(`Error ${r.status}: ${String(r.json.error ?? "scenario failed")}`);
      else setScenario(r.json as unknown as ScenarioResponse);
    } finally {
      setBusy(false);
    }
  }

  const fields = run ? Object.entries(run.extraction.result.fields) : [];
  const suspicious = run?.extraction.flags.suspicious ?? [];
  // Highlight evidence quotes (green) and suspicious lines (red) in the document text.
  const lines = text.split("\n");
  const evidence = fields.filter(([, f]) => f.status === "verified" && f.evidence).map(([, f]) => norm(f.evidence!));
  const isSuspiciousLine = (line: string) => {
    const n = norm(line);
    return n.length >= 20 && suspicious.some((s) => s.text.includes(n.slice(0, 40)) || n.includes(s.text.slice(0, 40)));
  };
  const renderLine = (line: string) => {
    if (isSuspiciousLine(line)) return <mark className="bg-red-200 text-red-900">{line}</mark>;
    const hit = evidence.find((e) => norm(line).includes(e));
    if (!hit) return line;
    const idx = line.indexOf(hit.split(" ")[0]);
    return idx >= 0 ? <>{line.slice(0, idx)}<mark className="bg-emerald-200 text-emerald-900">{line.slice(idx)}</mark></> : <mark className="bg-emerald-200">{line}</mark>;
  };

  const ex = run?.extraction;
  const cur = (ex?.result.derived as { currency?: string } | null)?.currency ?? "GBP";

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        Documents
        <span className="ml-3 rounded bg-amber-200 px-2 py-0.5 align-middle text-xs font-medium text-amber-900">SYNTHETIC DATA</span>
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Document text is untrusted data. The reader runs in a quarantined call with no tools; deterministic code checks every claim against the text; you confirm before anything is used. LLM: {llm}{llm.includes("provider=mock") ? " (scripted responses, no live model)" : ""}.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label>Document
          <select className="ml-2 rounded border border-zinc-400 px-2 py-1" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {fixtures.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            <option value="paste">Paste text...</option>
          </select>
        </label>
        {choice === "paste" && (
          <label>Type
            <select className="ml-2 rounded border border-zinc-400 px-2 py-1" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="purchase_order">Purchase order</option>
              <option value="supplier_quote">Supplier quote</option>
            </select>
          </label>
        )}
        <button disabled={busy || (choice === "paste" && pasted.trim() === "")} className="rounded border border-zinc-500 px-3 py-1.5 font-medium disabled:opacity-50" onClick={extract}>Run extraction</button>
      </div>
      {choice === "paste" && <textarea className="mt-2 h-40 w-full rounded border border-zinc-400 p-2 font-mono text-xs" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste a purchase order or supplier quote" />}
      {status && <p className="mt-2 text-sm">{status}</p>}

      {run && ex && (
        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section>
            <h2 className="text-lg font-medium">Document <span className="text-sm font-normal text-zinc-500">({run.document.filename})</span></h2>
            <p className="text-xs text-zinc-500"><mark className="bg-emerald-200 px-1">green</mark> = evidence quoted by the reader and found in the text; <mark className="bg-red-200 px-1">red</mark> = suspicious instructions.</p>
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-zinc-300 p-2 text-xs">{lines.map((l, i) => <div key={i}>{renderLine(l) || " "}</div>)}</pre>
          </section>

          <section>
            <h2 className="text-lg font-medium">
              Extraction <span className={`ml-2 rounded px-2 py-0.5 text-xs ${ex.status === "pending_confirmation" ? "bg-blue-100 text-blue-800" : ex.status === "confirmed" ? "bg-emerald-200 text-emerald-900" : "bg-red-100 text-red-800"}`}>{ex.status}</span>
            </h2>
            <p className="text-xs text-zinc-500">model: {ex.model}, prompt {ex.promptVersion}</p>

            {suspicious.length > 0 && (
              <div className="mt-2 rounded border-2 border-red-400 bg-red-50 p-2 text-sm text-red-900">
                <b>Suspicious instructions found in this document ({suspicious.length}).</b> They were treated as data and ignored; they cannot change any amount, date or limit.
                <ul className="mt-1 list-disc pl-5 text-xs">{suspicious.slice(0, 6).map((s, i) => <li key={i}>[{s.source}{s.pattern ? `: ${s.pattern}` : ""}] {s.text}</li>)}</ul>
              </div>
            )}
            {ex.flags.flags.filter((f) => f.code !== "suspicious_text").map((f, i) => (
              <p key={i} className={`mt-1 text-sm ${f.severity === "error" ? "font-medium text-red-700" : "text-amber-700"}`}>{f.severity === "error" ? "ERROR" : "Warning"}: {f.message}</p>
            ))}

            <table className="mt-2 w-full text-xs">
              <thead><tr className="border-b border-zinc-300 text-left"><th className="py-1 pr-2">Field</th><th className="pr-2">Value</th><th className="pr-2">Confidence</th><th>Check</th></tr></thead>
              <tbody>
                {fields.map(([k, f]) => (
                  <tr key={k} className="border-b border-zinc-200 align-top" title={f.evidence ?? ""}>
                    <td className="py-1 pr-2 font-medium">{k}</td>
                    <td className="pr-2">{f.value === null ? "-" : String(f.value)}</td>
                    <td className="pr-2">{f.confidence}</td>
                    <td className={f.status === "verified" ? "text-emerald-700" : f.status === "rejected" ? "text-red-700" : "text-zinc-500"}>{f.status}{f.reason ? `: ${f.reason}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 flex gap-2">
              <button disabled={busy || ex.status !== "pending_confirmation"} className="rounded border border-emerald-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40" onClick={() => decide("confirm")}>Confirm as owner</button>
              <button disabled={busy || !["pending_confirmation", "failed"].includes(ex.status)} className="rounded border border-red-500 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => decide("reject")}>Reject</button>
            </div>
            {ex.status === "failed" && <p className="mt-1 text-xs text-zinc-500">A failed extraction cannot be confirmed and nothing is mapped.</p>}
          </section>
        </div>
      )}

      {allEvents.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-medium">Mapped events (from confirmed extractions)</h2>
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {allEvents.map((e, i) => (
                <tr key={i} className="border-b border-zinc-200">
                  <td className="py-1 pr-2 whitespace-nowrap">{e.date}</td>
                  <td className="pr-2">{e.label}</td>
                  <td className="pr-2 text-right whitespace-nowrap">{fm(e.amountMinor, e.currency)}</td>
                  <td className="text-xs text-zinc-500">{e.source}, {e.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={busy} className="mt-2 rounded border border-zinc-500 px-3 py-1.5 text-sm font-medium" onClick={applyScenario}>Apply these events to the scenario (20 weeks)</button>
          <p className="text-xs text-zinc-500">Confirm both the supplier quote and the purchase order to see the full sample order.</p>
        </section>
      )}

      {scenario && (
        <section className="mt-4 rounded border border-zinc-300 p-3 text-sm">
          <h2 className="font-medium">Scenario result</h2>
          <p>Lowest closing balance: <b>{fm(scenario.scenario.minimum.amountMinor, cur)}</b> in week {scenario.scenario.minimum.weekIndex + 1} (baseline lowest {fm(scenario.baseline.minimum.amountMinor, cur)}).</p>
          <p>First week below zero: <b>{scenario.scenario.weeksBelowZero.length > 0 ? scenario.scenario.weeksBelowZero[0] + 1 : "none"}</b>. Deepest shortfall below the reserve: {fm(scenario.scenario.maxShortfallMinor, cur)}.</p>
          <p className="mt-1 font-medium">Ranked drivers (each step adds up to the total):</p>
          <ol className="list-decimal pl-5">
            {scenario.drivers.sequential.map((s, i) => <li key={i}>{s.label}: {fm(s.effectMinor, cur)}</li>)}
          </ol>
          <p className="text-xs text-zinc-500">Full view with the chart: <a className="underline" href="/demo/forecast">/demo/forecast</a>.</p>
        </section>
      )}
    </div>
  );
}
