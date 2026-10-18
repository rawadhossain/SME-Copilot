"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, Chip, Empty, Field, Loading, inputClass, Th, type Tone } from "@/ui/kit";
import { dateTime } from "@/ui/format";
import { call, useSession } from "@/ui/session";

/* eslint-disable @typescript-eslint/no-explicit-any */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const STATUS: Record<string, [string, Tone]> = {
  pending_confirmation: ["Waiting for you", "caution"], confirmed: ["Confirmed", "good"], rejected: ["Rejected", "neutral"], failed: ["Could not be read safely", "danger"],
};
const FIELD_LABEL: Record<string, string> = {
  buyerName: "Buyer", supplierName: "Supplier", orderReference: "Order reference", quoteReference: "Quote reference", totalAmount: "Total (incl. VAT)", currency: "Currency",
  paymentTermsDays: "Payment terms", deliveryDate: "First delivery", depositTerms: "Deposit terms the buyer states", depositPercent: "Deposit", depositDue: "Deposit due",
  balanceAmount: "Balance", balanceTiming: "Balance due", shipmentWeek: "Shipment week (from acceptance)", shipmentDate: "Shipment date", validityDays: "Quote valid for",
};
/** A value as an owner reads it: money with its currency, percentages with a sign, days with their unit. */
function showValue(key: string, v: unknown, currency: string): string {
  if (v === null || v === undefined || v === "") return "not stated";
  const t = String(v);
  if (key === "totalAmount" || key === "balanceAmount") return `${currency === "GBP" ? "£" : currency + " "}${t}`;
  if (key === "depositPercent") return `${t}%`;
  if (key === "paymentTermsDays" || key === "validityDays") return `${t} days`;
  return t;
}

export default function Commitments() {
  const { session } = useSession();
  const biz = session?.business.id;
  const [docs, setDocs] = useState<any[] | null>(null);
  const [samples, setSamples] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [kind, setKind] = useState("purchase_order");
  const [ack, setAck] = useState(false);

  const load = useCallback(async () => {
    if (!biz) return;
    const r = await call(`/api/business/${biz}/documents`);
    if (r.ok) setDocs(r.data);
  }, [biz]);
  useEffect(() => {
    try {
      const fresh = sessionStorage.getItem("ledgerhand.fresh");
      if (fresh) { sessionStorage.removeItem("ledgerhand.fresh"); setMsg({ tone: "good", text: `Fresh demo run created: ${fresh.replace(" (SYNTHETIC)", "")}. Nothing existing was changed. Step 1: add the two sample documents below, then confirm both.` }); }
    } catch { /* optional */ }
  }, []);
  useEffect(() => { void load(); void call("/api/demo/samples").then((r) => r.ok && setSamples(r.data.samples)); }, [load]);

  async function openDoc(id: string) {
    setAck(false);
    const r = await call(`/api/business/${biz}/extractions/${id}`);
    if (r.ok) setOpen(r.data);
  }

  async function submit(filename: string, k: string, text: string) {
    setBusy(true);
    setMsg(null);
    const r = await call(`/api/business/${biz}/documents`, { filename, kind: k, text });
    setBusy(false);
    if (!r.ok) { setMsg({ tone: "danger", text: r.data.error ?? "The document could not be read." }); return; }
    await load();
    await openDoc(r.data.extraction.id);
  }

  async function decide(what: "confirm" | "reject") {
    setBusy(true);
    const id = open.extraction.id;
    const r = await call(`/api/extractions/${id}/${what}`, what === "confirm" ? { confirmedBy: session?.user.displayName } : { rejectedBy: session?.user.displayName, reason: "Rejected by the owner" });
    setBusy(false);
    if (!r.ok) { setMsg({ tone: "danger", text: r.data.error ?? "Refused" }); return; }
    if (what === "confirm") {
      const s = r.data.shortage;
      setMsg({ tone: "good", text: s?.status === "planned" ? "Confirmed and logged. The forecast now shows a shortage and your assistant has proposed plans." : s?.status === "existing_run" ? "Confirmed and logged. Your assistant already has plans for this shortage." : s?.status === "auto_prepare_off" ? "Confirmed and logged. Your playbook is set to not prepare plans automatically; ask for a shortage check when you want them." : "Confirmed and logged. The forecast has been updated." });
    } else setMsg({ tone: "neutral", text: "Rejected and logged. Nothing from this document is used." });
    await load();
    await openDoc(id);
  }

  const ex = open?.extraction;
  const fields: [string, any][] = ex ? Object.entries(ex.result.fields) : [];
  const reported: any[] = ex?.flags?.suspicious ?? [];
  // Pattern-scan hits are firm findings (independent of the model). A sentence only the model pointed at is a soft note: it often over-reports ordinary terms.
  const suspicious: any[] = reported.filter((x) => x.source !== "model");
  const modelNotes: any[] = reported.filter((x) => x.source === "model");
  const evidence = fields.filter(([, f]) => f.status === "verified" && f.evidence).map(([, f]) => norm(f.evidence));
  const isSuspicious = (line: string) => { const n = norm(line); return n.length >= 20 && reported.some((s) => s.text.includes(n.slice(0, 40)) || n.includes(s.text.slice(0, 40))); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-3xl">Orders & quotes</h1>
        <p className="text-ink-soft">Add a customer order or a supplier quote. It is read and every figure is checked against the text, but nothing counts until <b>you confirm</b> it.</p>
      </div>
      {msg && <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${msg.tone === "good" ? "border-good/40 bg-good-soft text-good" : msg.tone === "danger" ? "border-danger/40 bg-danger-soft text-danger" : "border-line-strong bg-neutral-soft"}`}>{msg.text} {msg.tone === "good" && <Link className="underline" href="/room/case">Open the case</Link>}</p>}

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card title="Add a document" subtitle="Paste the text of an order or a quote, or choose a text file.">
            {samples.length > 0 && <details className="mb-4 text-sm"><summary className="cursor-pointer text-accent">Try it with sample documents</summary><div className="mt-3 space-y-2">
              {samples.length > 1 && <Btn busy={busy} onClick={async () => { for (const x of samples) await submit(x.filename, x.kind, x.text); setMsg({ tone: "neutral", text: "Both documents were read. Review each one, then confirm both: your assistant plans once, after the last confirmation." }); }}>Add both sample documents</Btn>}
              {samples.map((s) => <Btn key={s.filename} variant="secondary" className="w-full justify-start" busy={busy} onClick={() => submit(s.filename, s.kind, s.text)}>Use sample: {s.title}</Btn>)}
            </div></details>}
            <div className="text-sm">
              <div className="space-y-3">
                <Field label="Type"><select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}><option value="purchase_order">Purchase order</option><option value="supplier_quote">Supplier quote</option></select></Field>
                <Field label="Text" hint="or choose a .txt/.md file"><textarea className={`${inputClass} h-32 font-mono text-xs`} value={pasted} onChange={(e) => setPasted(e.target.value)} /></Field>
                <input type="file" accept=".txt,.md,text/plain" aria-label="Upload a text document" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPasted(await f.text()); }} className="text-xs" />
                <Btn disabled={!pasted.trim()} busy={busy} onClick={() => submit("pasted-document.txt", kind, pasted)}>Read this document</Btn>
              </div>
            </div>
          </Card>
          <Card title="Your documents">
            {docs === null ? <Loading /> : docs.length === 0 ? <p className="text-sm text-ink-soft">None yet.</p> : (
              <ul className="space-y-1">
                {docs.map((d) => { const [label, tone] = STATUS[d.status] ?? [d.status, "neutral" as Tone]; return (
                  <li key={d.extractionId}><button onClick={() => openDoc(d.extractionId)} className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-soft ${open?.extraction.id === d.extractionId ? "bg-accent-soft" : ""}`}>
                    <span><span className="block font-medium">{d.filename}</span><span className="text-xs text-ink-soft">{dateTime(d.createdAt)}</span></span><Chip tone={tone}>{label}</Chip></button></li>); })}
              </ul>
            )}
          </Card>
        </div>

        <div>
          {!ex ? <Empty title="Choose a document">Open one from your list to see what was read from it and which figures were checked against the text.</Empty> : (
            <Card title={open.document.filename} subtitle={`Read by ${ex.model} · prompt ${ex.promptVersion}`} right={<Chip tone={(STATUS[ex.status] ?? ["", "neutral"])[1] as Tone}>{(STATUS[ex.status] ?? [ex.status])[0]}</Chip>}>
              {suspicious.length > 0 && (
                <div role="alert" className="mb-4 rounded-xl border-2 border-danger/50 bg-danger-soft p-3 text-sm text-danger">
                  <p className="font-semibold">This document contains wording that looks like instructions to an AI ({suspicious.length}).</p>
                  <p className="mt-0.5">It was treated as data and ignored. It cannot change an amount, a date or a limit. Read the highlighted lines before you confirm.</p>
                  <ul className="mt-1 list-disc pl-5 text-xs">{suspicious.slice(0, 5).map((s, i) => <li key={i}>{s.text}</li>)}</ul>
                </div>
              )}
              {suspicious.length === 0 && modelNotes.length > 0 && (
                <div className="mb-4 rounded-xl border border-caution/40 bg-caution-soft p-3 text-sm text-caution">
                  <p className="font-medium">The reader pointed at {modelNotes.length === 1 ? "a sentence" : `${modelNotes.length} sentences`} for a second look.</p>
                  <p className="mt-0.5 text-ink-soft">They read like ordinary payment terms, and no instruction-like pattern was found by the independent scan. Nothing in them is acted on; a document can never change an amount, a date or a limit.</p>
                  <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">{modelNotes.slice(0, 4).map((x, i) => <li key={i}>{String(x.text).replace(/^[-•]\s*/, "")}</li>)}</ul>
                </div>
              )}
              {ex.flags.flags.filter((f: any) => f.code !== "suspicious_text").map((f: any, i: number) => <p key={i} className={`mb-1 text-sm ${f.severity === "error" ? "font-medium text-danger" : "text-caution"}`}>{f.severity === "error" ? "Problem" : "Check"}: {f.message}</p>)}

              <div className="grid gap-4 xl:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-sm font-medium">What the reader found</h3>
                  <div className="overflow-x-auto"><table className="w-full text-sm">
                    <thead><tr><Th>Field</Th><Th>Value</Th><Th>Check</Th></tr></thead>
                    <tbody>
                      {fields.map(([k, f]) => (
                        <tr key={k} className="border-t border-line align-top" title={f.evidence ?? ""}>
                          <td className="py-1.5 pr-2 text-ink-soft">{FIELD_LABEL[k] ?? k}</td><td className={`num pr-2 font-medium ${f.value === null ? "text-ink-soft" : ""}`}>{showValue(k, f.value, String(ex.result.fields.currency?.value ?? "GBP"))}</td>
                          <td><Chip tone={f.status === "verified" ? "good" : f.status === "rejected" ? "danger" : "neutral"}>{f.status === "verified" ? "found in the text" : f.status === "rejected" ? "not supported" : f.status === "missing" ? "not in the document" : f.status}</Chip>{f.reason && <span className="ml-1 text-xs text-ink-soft">{f.reason}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                </div>
                <div>
                  <h3 className="mb-1 text-sm font-medium">The document</h3>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-white p-3 text-xs">{String(open.document.text).split("\n").map((l: string, i: number) => {
                    if (isSuspicious(l)) { const firm = suspicious.some((x) => norm(l).includes(String(x.text).slice(0, 40)) || String(x.text).includes(norm(l).slice(0, 40))); return <div key={i}><mark className={firm ? "bg-danger-soft text-danger" : "bg-caution-soft text-caution"}>{l}</mark></div>; }
                    const hit = evidence.find((e) => norm(l).includes(e));
                    return <div key={i}>{hit ? <mark className="bg-good-soft text-good">{l}</mark> : l || " "}</div>;
                  })}</pre>
                  <p className="mt-1 text-xs text-ink-soft"><mark className="bg-good-soft px-1 text-good">green</mark> quoted evidence found in the text · <mark className="bg-danger-soft px-1 text-danger">red</mark> instruction-like wording · <mark className="bg-caution-soft px-1 text-caution">amber</mark> the reader asked for a second look</p>
                </div>
              </div>

              {(ex.status === "pending_confirmation" || ex.status === "failed") && (
                <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  {ex.status === "pending_confirmation" && suspicious.length > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I read the warning above; the document&apos;s instructions are ignored.</label>}
                  {ex.status === "pending_confirmation" && <Btn busy={busy} disabled={suspicious.length > 0 && !ack} onClick={() => decide("confirm")}>Confirm: use this commitment</Btn>}
                  <Btn variant="secondary" busy={busy} onClick={() => decide("reject")}>Reject</Btn>
                  {ex.status === "failed" && <span className="text-sm text-ink-soft">A failed reading cannot be confirmed and nothing is used.</span>}
                </div>
              )}
              {ex.status === "confirmed" && <p className="mt-4 text-sm text-ink-soft">Confirmed and logged. It is part of your forecast.</p>}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
