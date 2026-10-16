"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Adjust a plan's terms yourself. No model is called: each preview sends the edited terms to the server, which checks them against your
// signed limits and recomputes every number with the engine. Saving stores the result as a new plan beside the others; you then sign it as usual.
import { useEffect, useState } from "react";
import { Btn, Chip, ErrorNote, Field, Modal, inputClass } from "../kit";
import { LEVER_NAME, constraintText, money, week } from "../format";
import { call, useSession } from "../session";
import { nameOf } from "./parts";

type FieldDef = { key: string; label: string; unit: "%" | "days"; min: number; max: number };
const FIELDS: Record<string, FieldDef[]> = {
  supplier_reduce_deposit: [{ key: "percentBps", label: "Deposit", unit: "%", min: 0.01, max: 100 }],
  supplier_defer_balance: [{ key: "daysAfterShipment", label: "Pay the balance after shipment", unit: "days", min: 1, max: 180 }],
  buyer_request_deposit: [{ key: "percentBps", label: "Deposit asked", unit: "%", min: 0.01, max: 100 }],
  finance_invoice: [{ key: "advanceBps", label: "Advance", unit: "%", min: 0.01, max: 100 }],
  chase_overdue: [{ key: "payWithinDays", label: "Pay overdue invoices within", unit: "days", min: 1, max: 30 }],
  early_payment_discount: [
    { key: "daysEarly", label: "Pay this many days early", unit: "days", min: 1, max: 60 },
    { key: "discountBps", label: "Discount offered", unit: "%", min: 0.01, max: 100 },
  ],
};
const ROLE: Record<string, string> = { supplier_reduce_deposit: "supplier", supplier_defer_balance: "supplier", buyer_request_deposit: "customer", finance_invoice: "lender", chase_overdue: "customer", early_payment_discount: "customer" };
const DEFAULTS: Record<string, any> = {
  supplier_reduce_deposit: { percentBps: 2000 }, supplier_defer_balance: { daysAfterShipment: 30 }, buyer_request_deposit: { percentBps: 1000 },
  finance_invoice: { advanceBps: 8000 }, chase_overdue: { payWithinDays: 14 }, early_payment_discount: { daysEarly: 14, discountBps: 100 },
};
const isBps = (key: string) => key.endsWith("Bps");
const toInput = (l: any, f: FieldDef) => String(isBps(f.key) ? l[f.key] / 100 : l[f.key]);

/** The term moved to what the counterparty said it will accept (from its structured reply). Returns null when it refused the term outright. */
function suggest(l: any, constraints: any[]): any | null {
  const out = { ...l };
  for (const c of constraints.filter((x) => x.kind === l.kind && x.counterpartyId === l.counterpartyId)) {
    if (c.excluded) return null;
    if (l.kind === "supplier_reduce_deposit" && c.minPercentBps !== undefined) out.percentBps = Math.max(out.percentBps, c.minPercentBps);
    if (l.kind === "buyer_request_deposit" && c.maxPercentBps !== undefined) out.percentBps = Math.min(out.percentBps, c.maxPercentBps);
    if (l.kind === "supplier_defer_balance" && c.maxDays !== undefined) out.daysAfterShipment = Math.min(out.daysAfterShipment, c.maxDays);
    if (l.kind === "chase_overdue" && c.minDays !== undefined) out.payWithinDays = Math.max(out.payWithinDays, c.minDays);
    if (l.kind === "early_payment_discount" && c.minDiscountBps !== undefined) out.discountBps = Math.max(out.discountBps, c.minDiscountBps);
  }
  return out;
}

/** Builds the lever list from the form values; returns null for a field that is not a valid number. */
function buildLevers(base: any[], vals: Record<string, string>, keep: Record<number, boolean>): any[] | null {
  const out: any[] = [];
  for (let i = 0; i < base.length; i++) {
    if (!keep[i]) continue;
    const l = { ...base[i] };
    for (const f of FIELDS[l.kind] ?? []) {
      const n = Number(vals[`${i}.${f.key}`]);
      if (!Number.isFinite(n) || n < f.min || n > f.max) return null;
      const v = isBps(f.key) ? Math.round(n * 100) : n;
      if (!Number.isInteger(v)) return null;
      l[f.key] = v;
    }
    out.push(l);
  }
  return out.length > 0 ? out : null;
}

export function EditPlanDialog({ open, onClose, runId, plan, names, counterparties, cur, onSaved, constraints = [], submit, title = "Adjust this plan", intro, saveLabel = "Save as a new plan" }: { open: boolean; onClose: () => void; runId: string; plan: any; names: Record<string, string>; counterparties: { id: string; name: string; role: string }[]; cur: string; onSaved: (planId: string) => void; constraints?: any[]; submit?: (p: { levers: any[]; notes: Record<string, string>; commit: boolean }) => Promise<any>; title?: string; intro?: string; saveLabel?: string }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const [added, setAdded] = useState<any[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [instruction, setInstruction] = useState("");
  const [assist, setAssist] = useState<any>(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [addKind, setAddKind] = useState("");
  const [addCp, setAddCp] = useState("");
  const base: any[] = [...(plan?.plan.levers ?? []), ...added];
  const [vals, setVals] = useState<Record<string, string>>({});
  const [keep, setKeep] = useState<Record<number, boolean>>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const v: Record<string, string> = {}; const k: Record<number, boolean> = {};
    base.forEach((l, i) => {
      const moved = suggest(l, constraints); // counterparty answers move the term to what they said they accept; a refused term starts unticked
      k[i] = moved !== null;
      for (const f of FIELDS[l.kind] ?? []) v[`${i}.${f.key}`] = toInput(moved ?? l, f);
    });
    setVals(v); setKeep(k); setAdded([]); setNotes(plan?.plan.ownerNotes ?? {}); setAddKind(""); setAddCp(""); setInstruction(""); setAssist(null); setResult(null); setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan?.id]);

  const levers = buildLevers(base, vals, keep);
  const edit = (k: string, v: string) => { setVals((p) => ({ ...p, [k]: v })); setResult(null); };

  async function run(commit: boolean) {
    if (!levers) return;
    setBusy(commit ? "save" : "preview"); setError(null);
    const r = submit ? await submit({ levers, notes, commit }) : await call(`/api/business/${biz}/plan-edit`, { runId, basePlanId: plan.id, levers, notes, commit });
    setBusy(null);
    if (!r.ok) { setError(r.data.error ?? "That did not work"); return; }
    setResult(r.data);
    if (r.data.ok && commit) { onSaved(r.data.plan.id); onClose(); }
  }

  /** Fills the form from the terms the assistant proposed. Nothing is saved: the owner reviews, then checks and saves as usual. */
  function applyProposed(proposed: any[]) {
    const all = [...base];
    const extra = [...added];
    for (const p of proposed) if (!all.some((l) => l.kind === p.kind)) { all.push(p); extra.push(p); }
    const v: Record<string, string> = {}; const k: Record<number, boolean> = {};
    all.forEach((l, i) => {
      const p = proposed.find((x) => x.kind === l.kind);
      k[i] = !!p;
      for (const f of FIELDS[l.kind] ?? []) v[`${i}.${f.key}`] = toInput(p ? { ...l, ...p, counterpartyId: l.counterpartyId } : l, f);
    });
    setAdded(extra); setVals(v); setKeep(k); setResult(null);
  }

  async function askAssistant() {
    setAssistBusy(true); setError(null); setAssist(null);
    const r = await call(`/api/business/${biz}/plan-assist`, { runId, instruction, levers: levers ?? base });
    setAssistBusy(false);
    if (!r.ok) { setError(r.data.error ?? "The assistant did not answer"); return; }
    if (!r.data.ok) { setError(r.data.error); setAssist({ remaining: r.data.remaining }); return; }
    setAssist(r.data);
    if (r.data.changes.length > 0) applyProposed(r.data.levers);
  }

  function addTerm() {
    const cp = counterparties.find((c) => c.id === addCp);
    if (!addKind || !cp) return;
    const lever = { kind: addKind, counterpartyId: cp.id, ...DEFAULTS[addKind] };
    const i = base.length;
    setAdded((a) => [...a, lever]);
    setKeep((q) => ({ ...q, [i]: true }));
    setVals((v) => { const n = { ...v }; for (const f of FIELDS[addKind]) n[`${i}.${f.key}`] = toInput(lever, f); return n; });
    setAddKind(""); setAddCp(""); setResult(null);
  }
  const usedKinds = new Set(base.map((l) => l.kind));
  const freeKinds = Object.keys(FIELDS).filter((k) => !usedKinds.has(k));
  const roleCps = addKind ? counterparties.filter((c) => c.role === ROLE[addKind]) : [];
  const noted = [...new Set(base.filter((_, i) => keep[i]).map((l) => l.counterpartyId))];

  const p = result?.ok ? result.plan : null;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4 text-sm">
        <p className="text-ink-soft">{intro ?? "Change the terms you want. Nothing is sent to anyone. The system re-checks them against your limits and recomputes every number; no AI is used here. Saving adds your version as a new plan to sign."}</p>
        <section className="rounded-lg border border-line bg-white/70 p-3">
          <Field label="Or tell the assistant what to change (optional)">
            <div className="flex gap-2">
              <input className={inputClass} maxLength={500} placeholder="for example: deposit to 15% and defer 20 days" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
              <Btn variant="secondary" busy={assistBusy} disabled={!instruction.trim() || assist?.remaining === 0} onClick={() => void askAssistant()}>Suggest changes</Btn>
            </div>
          </Field>
          {assist?.ok && (
            <div className="mt-2 space-y-1 text-xs" aria-live="polite">
              {assist.changes.length > 0 && <p><b>The form now shows:</b> {assist.changes.map((c: any) => c.action === "remove" ? `drop ${LEVER_NAME[c.kind] ?? c.kind}` : c.action === "add" && c.to === null ? `add ${LEVER_NAME[c.kind] ?? c.kind}` : `${LEVER_NAME[c.kind] ?? c.kind}: ${c.from === null ? "" : `${c.from} → `}${c.to}`).join("; ")}. Check the numbers, then press “Check my changes”.</p>}
              {assist.unclear && <p className="text-caution">{assist.unclear}</p>}
              {assist.ignored.map((t: string, i: number) => <p key={i} className="text-caution">Not applied: {t}</p>)}
              <p className="text-ink-soft">{assist.source === "rules" ? "Read by the built-in reader (the AI model was not available). " : "Suggested by the AI model, which sees only your sentence and these terms. "}It only changes the form; every number is recomputed by the engine and checked against your limits. {assist.remaining} suggestion{assist.remaining === 1 ? "" : "s"} left on this case.</p>
            </div>
          )}
        </section>
        <ul className="space-y-3">
          {base.map((l, i) => (
            <li key={i} className={`rounded-lg border border-line bg-white/70 p-3 ${keep[i] ? "" : "opacity-60"}`}>
              <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={!!keep[i]} onChange={(e) => { setKeep((q) => ({ ...q, [i]: e.target.checked })); setResult(null); }} />{LEVER_NAME[l.kind] ?? l.kind} <span className="font-normal text-ink-soft">({nameOf(names, l.counterpartyId)})</span></label>
              {constraints.filter((c) => c.kind === l.kind && c.counterpartyId === l.counterpartyId).map((c, n) => <p key={n} className="mt-1 text-xs text-caution">{constraintText(c, nameOf(names, l.counterpartyId))}</p>)}
              {keep[i] && (
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {(FIELDS[l.kind] ?? []).map((f) => (
                    <Field key={f.key} label={`${f.label} (${f.unit})`}>
                      <input className={inputClass} inputMode="decimal" value={vals[`${i}.${f.key}`] ?? ""} onChange={(e) => edit(`${i}.${f.key}`, e.target.value)} />
                    </Field>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        {freeKinds.length > 0 && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-line p-3">
            <Field label="Add another term"><select className={inputClass} value={addKind} onChange={(e) => { setAddKind(e.target.value); setAddCp(""); }}><option value="">Choose…</option>{freeKinds.map((k) => <option key={k} value={k}>{LEVER_NAME[k] ?? k}</option>)}</select></Field>
            {addKind && <Field label="With"><select className={inputClass} value={addCp} onChange={(e) => setAddCp(e.target.value)}><option value="">Choose…</option>{roleCps.map((c) => <option key={c.id} value={c.id}>{c.name.replace(" (SYNTHETIC)", "")}</option>)}</select></Field>}
            <Btn variant="secondary" disabled={!addKind || !addCp} onClick={addTerm}>Add</Btn>
          </div>
        )}
        {noted.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium">Your notes <span className="font-normal text-ink-soft">(optional)</span></h3>
            <p className="mb-2 text-xs text-ink-soft">Kept with this plan and in the record, for you and your team. Counterparties receive the structured terms only, never this text.</p>
            <div className="space-y-2">{noted.map((id) => <Field key={id} label={nameOf(names, id)}><input className={inputClass} maxLength={300} value={notes[id] ?? ""} onChange={(e) => { setNotes((n) => ({ ...n, [id]: e.target.value })); setResult(null); }} /></Field>)}</div>
          </section>
        )}
        {!levers && <p className="text-xs text-caution">Keep at least one term, and use numbers inside the allowed range of each field.</p>}
        {result && !result.ok && (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-danger"><b>These terms are not allowed.</b><ul className="mt-1 list-disc pl-5">{result.reasons.slice(0, 5).map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></div>
        )}
        {p && (
          <div className="rounded-xl border border-line bg-white/70 p-3">
            <p className="mb-2 flex items-center gap-2 font-medium">Recomputed result {result.unchanged ? <Chip tone="neutral">same as an existing plan</Chip> : <Chip tone="good">within your limits</Chip>}</p>
            {(result.kept?.length > 0 || result.askedAgain?.length > 0) && (
              <div className="mb-2 space-y-1 text-xs">
                {result.kept?.length > 0 && <p><b className="text-good">Stays as already agreed:</b> {result.kept.map((k: any) => `${LEVER_NAME[k.kind] ?? k.kind} (${nameOf(names, k.counterpartyId)})`).join("; ")}</p>}
                {result.askedAgain?.length > 0 && <p><b className="text-caution">Will be asked again:</b> {result.askedAgain.map((k: any) => `${LEVER_NAME[k.kind] ?? k.kind} (${nameOf(names, k.counterpartyId)})`).join("; ")}</p>}
              </div>
            )}
            {p.contingenciesDropped && <p className="mb-2 text-xs text-caution">Some of the original plan&apos;s fallback options no longer fit these terms and were left out.</p>}
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <dt className="text-ink-soft">Lowest balance</dt><dd className={`num ${BigInt(p.metrics.minBalanceMinor) < 0n ? "text-danger" : "text-good"}`}>{money(p.metrics.minBalanceMinor, cur)} ({week(p.metrics.minBalanceWeek)})</dd>
              <dt className="text-ink-soft">First negative week</dt><dd>{week(p.metrics.firstNegativeWeek)}</dd>
              <dt className="text-ink-soft">Total cost</dt><dd className="num">{money(p.metrics.totalCostMinor, cur)}</dd>
              <dt className="text-ink-soft">Closing balance</dt><dd className="num">{money(p.metrics.closingAtHorizonMinor, cur)}</dd>
            </dl>
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn variant="secondary" busy={busy === "preview"} disabled={!levers} onClick={() => void run(false)}>Check my changes</Btn>
          <Btn busy={busy === "save"} disabled={!levers || !(result?.ok)} onClick={() => void run(true)}>{result?.unchanged ? "Use that plan" : saveLabel}</Btn>
        </div>
      </div>
    </Modal>
  );
}
