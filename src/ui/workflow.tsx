"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Workflow canvas. A FIXED graph of how the assistant works (no user-made nodes or links), in two modes:
// Builder explains each step in plain words and shows the signed limits read-only; Debug overlays what happened in one case,
// using buildCaseMap's records. Read-only: it writes nothing. Counterparty free text is never shown (buildCaseMap never copies it).
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn, Chip, ErrorNote, Loading, type Tone } from "@/ui/kit";
import { DEFAULT_PLAYBOOK, type Playbook } from "@/domain/playbook";
import { buildCaseMap, type MapNode, type MapStatus } from "@/ui/case-map-build";
import { LEVER_NAME, date, money, pct } from "@/ui/format";
import { call, useSession } from "@/ui/session";

const TONE: Record<MapStatus, Tone> = { done: "good", refused: "danger", rolled_back: "caution", waiting: "neutral", failed: "danger" };
const STROKE: Record<MapStatus, string> = { done: "#1b7a4a", refused: "#b3261e", rolled_back: "#a15c00", waiting: "#8b958f", failed: "#b3261e" };
const TYPE_COLOR: Record<string, string> = { Trigger: "#a15c00", Analyse: "#2457a6", Decision: "#6b3fa0", Approve: "#1b7a4a", Check: "#0d5a50", Act: "#b04a12", "Re-plan": "#8a3b6e", Verify: "#0d5a50", Export: "#53605a", Recovery: "#53605a" };

const W = 176, H = 66, GX = 44, GY = 12, ROW = H + GY, PADX = 40, PADY = 40;
const X = (col: number) => PADX + col * (W + GX);
const Y = (row: number) => PADY + row * ROW;

const LEVERS = ["buyer_request_deposit", "supplier_defer_balance", "supplier_reduce_deposit", "finance_invoice", "early_payment_discount", "chase_overdue"] as const;
const PROPOSAL_KIND: Record<string, string> = {
  buyer_request_deposit: "buyer.request_deposit", supplier_defer_balance: "supplier.defer_balance", supplier_reduce_deposit: "supplier.reduce_deposit",
  finance_invoice: "lender.apply_invoice_finance", early_payment_discount: "buyer.request_early_payment", chase_overdue: "buyer.chase_payment",
};
const MAX_ROUNDS = 2; // MAX_REPLAN_ROUNDS in src/domain/constraints.ts
const MID = 2.5;

// Playbook controls per canvas node. Each one is wired to code that reads it: levers narrow the planner and simulator, the second approver adds a human step,
// auto-prepare stops the shortage check from starting a planning run by itself. Nothing here can widen the signed limits.
interface Ctl { path: string; label: string; off: string }
const CTLS: Record<string, Ctl[]> = {
  trigger: [{ path: "autoPrepare", label: "Prepare plans automatically when a shortage is found", off: "If off, confirming a document still updates your forecast, but the assistant waits for you to ask for a shortage check before it prepares plans. It never signs or executes either way." }],
  approve: [{ path: "alwaysSecondApprover", label: "Always ask for a second approver", off: "If on, every plan waits for a second approver, even below your signed threshold. It can only add this step; it never lowers the threshold. If off, only your signed threshold decides." }],
  ...Object.fromEntries(LEVERS.map((k) => [`act-${k}`, [{ path: `levers.${k}`, label: "Let the assistant plan and simulate this ask", off: "If off, this ask is left out of every plan and every what-if. Your signed limits do not change, and the other asks still work." }]])),
};
const getAt = (p: Playbook, path: string): boolean => (path.startsWith("levers.") ? p.levers[path.slice(7) as (typeof LEVERS)[number]] : (p as unknown as Record<string, boolean>)[path]);
const setAt = (p: Playbook, path: string, v: boolean): Playbook => (path.startsWith("levers.") ? { ...p, levers: { ...p.levers, [path.slice(7)]: v } } : { ...p, [path]: v });
const customised = (id: string, p: Playbook) => (CTLS[id] ?? []).some((c) => getAt(p, c.path) !== getAt(DEFAULT_PLAYBOOK, c.path));

type Setting = [string, string];
interface Def {
  id: string; type: string; title: string; sub: string; col: number; row: number; kind?: "decision";
  does: string; reads: string; never: string; settings?: (L: any, cur: string) => Setting[]; note?: string;
}

const askDef = (k: string, i: number): Def => ({
  id: `act-${k}`, type: "Act", title: LEVER_NAME[k], sub: "counterparty ask", col: 6, row: i,
  does: `Sends one structured ask to the other side in the sandbox (${LEVER_NAME[k].toLowerCase()}). It is one of several asks that run in parallel, each recorded separately.`,
  reads: "Only the terms in the plan you signed, and the counterparty's structured answer (accepted, refused, or outside the terms).",
  never: "Go beyond the worst answer you accepted when signing. Free text from the other side is never read as an instruction; an answer outside the terms is treated as a refusal.",
  settings: (L) => [
    ["Allowed by your limits", (L.allowedProposalKinds ?? []).includes(PROPOSAL_KIND[k]) ? "yes" : "no"],
    ...(k === "early_payment_discount" ? [["Largest discount", pct(L.maxEarlyPaymentDiscountBps)] as Setting] : []),
    ...(k === "finance_invoice" ? [["Largest advance", pct(L.maxFinanceAdvanceBps)] as Setting, ["Highest fee", pct(L.maxFinanceFeeBps)] as Setting] : []),
  ],
});

const DEFS: Def[] = [
  { id: "trigger", type: "Trigger", title: "Forecast falls below the cushion", sub: "alerts monitor / shortage check", col: 0, row: MID,
    does: "Starts a case when the forecast shows cash below your cushion or below zero. It runs when you confirm a commitment, on a monitor run, or when you ask for a shortage check.",
    reads: "The forecast computed by fixed code from your books, and your cushion (reserve).", never: "Move money or contact anyone. It only opens a case.",
    note: "The cushion and the alert timings are part of the books and code; there is no owner setting for them in the product today." },
  { id: "causes", type: "Analyse", title: "Find causes", sub: "insights", col: 1, row: MID,
    does: "Looks for what is driving the gap: late buyers, big bills, concentration. The findings are computed by fixed code.", reads: "Invoices, bills and the forecast (structured data only).", never: "Write numbers itself or act. Document and counterparty text is data, never instructions." },
  { id: "compare", type: "Analyse", title: "Compare strategies", sub: "planner and simulator", col: 2, row: MID,
    does: "The planner proposes combinations of fixes and the simulator scores each against doing nothing. Every figure comes from fixed code.", reads: "Structured data only: figures, counterparty constraints learned so far.", never: "See raw document or counterparty text, do arithmetic that matters, or decide what is allowed." },
  { id: "decide-plan", type: "Decision", title: "Plan keeps the cushion and fits the limits?", sub: "checked by code", col: 3, row: MID, kind: "decision",
    does: "A plan goes to you only if code confirms it fits the limits you signed. If no plan fits, the case says so and shows the closest option and what you could loosen.", reads: "The scored plans and the active signed limits.", never: "Hide a plan that misses the cushion; it is shown as such.",
    settings: (L, cur) => [["Bank balance floor", money(L.minBankBalanceMinor, cur)]] },
  { id: "approve", type: "Approve", title: "Owner signs", sub: "second approver above the threshold", col: 4, row: MID,
    does: "You review one plan and sign it. The signature covers the plan, the exact requests and the worst answer you accept. Above the threshold a different approver must also confirm.", reads: "The plan and your password.", never: "Be done by the assistant: modules under the agent cannot reach the signing code.",
    settings: (L, cur) => [["Second confirmation above", money(L.requireSecondConfirmationAboveMinor, cur)]] },
  { id: "gate", type: "Check", title: "Permission gate", sub: "before every action", col: 5, row: MID,
    does: "Every action is checked in code against your signed limits before it runs, and each decision is written to the append-only log.", reads: "The proposed action, the signed limits and the projected balance.", never: "Be skipped, or be overruled by the AI or by text in a document.",
    settings: (L, cur) => [["Largest single payment", money(L.maxPaymentMinor, cur)], ["Largest outflow in a day", money(L.maxDailyOutflowMinor, cur)], ["Bank balance floor", money(L.minBankBalanceMinor, cur)], ["New payees", L.allowNewPayees ? "allowed" : "not allowed"], ["Never paid by the assistant", (L.forbiddenPurposes ?? []).join(", ") || "none"]] },
  ...LEVERS.map(askDef),
  { id: "replan", type: "Re-plan", title: "Re-plan", sub: `up to ${MAX_ROUNDS} re-plan rounds`, col: 6, row: 6.7,
    does: `After a refusal or an answer outside the terms, the structured answers are kept as constraints and the planner tries again, at most ${MAX_ROUNDS} times. A new round needs a new signature.`, reads: "Structured constraints from the answers, never the other side's wording.", never: "Act on the new plan without your fresh signature.",
    note: `The round limit is fixed in code (${MAX_ROUNDS}); it is not an owner setting.` },
  { id: "verify", type: "Verify", title: "Independent verification", sub: "recomputes the result", col: 7, row: MID,
    does: "A separate piece of code recomputes the forecast from what the practice bank holds and compares it with what the agreed terms should give.", reads: "The sandbox bank and the agreed terms.", never: "Reuse the code that carried the plan out, or change anything." },
  { id: "decide-check", type: "Decision", title: "Check passed?", sub: "Check passed / Check failed", col: 8, row: MID, kind: "decision",
    does: "The result is shown as Check passed or Check failed, with the figures behind it.", reads: "The verification result.", never: "Soften a failed check." },
  { id: "export", type: "Export", title: "Evidence export", sub: "full record", col: 9, row: 1.5,
    does: "Packages the case with its log records so it can be checked independently.", reads: "The append-only log and the case.", never: "Edit a record; the log is tamper-evident." },
  { id: "recovery", type: "Recovery", title: "Recovery", sub: "if it drifts later", col: 9, row: 3.5,
    does: "Watches a strategy that was signed and run. If counterparties stop honouring it later, it raises a recovery case for you to decide.", reads: "Recorded strategy and later events.", never: "Act on its own; a recovery plan needs your signature too." },
];
const DEF = Object.fromEntries(DEFS.map((d) => [d.id, d]));

// Canvas node -> case-map nodes that describe it.
function pick(id: string, nodes: MapNode[]): MapNode[] {
  if (id === "trigger") return nodes.filter((n) => n.id === "shortage");
  if (id === "compare" || id === "decide-plan") return nodes.filter((n) => n.id === "plans");
  if (id === "approve") return nodes.filter((n) => /(^signed$|-signed$|-second$)/.test(n.id));
  if (id === "gate") return nodes.filter((n) => /(^gate$|-gate$)/.test(n.id));
  if (id === "replan") return nodes.filter((n) => /-replan$/.test(n.id));
  if (id === "verify" || id === "decide-check") return nodes.filter((n) => n.id === "verify");
  if (id.startsWith("act-")) return nodes.filter((n) => /-ask\d+$/.test(n.id) && n.title === LEVER_NAME[id.slice(4)]);
  return [];
}

interface P { x: number; y: number }
const L = (id: string): P => ({ x: X(DEF[id].col), y: Y(DEF[id].row) + H / 2 });
const R = (id: string): P => ({ x: X(DEF[id].col) + W, y: Y(DEF[id].row) + H / 2 });
interface Edge { a: P; b: P; c1?: P; c2?: P; label?: string; dashed?: boolean; danger?: boolean; at?: P }
const curve = (a: P, b: P): Pick<Edge, "c1" | "c2"> => { const mx = (a.x + b.x) / 2; return { c1: { x: mx, y: a.y }, c2: { x: mx, y: b.y } }; };
const flow = (from: string, to: string, extra: Partial<Edge> = {}): Edge => { const a = R(from), b = L(to); return { a, b, ...curve(a, b), ...extra }; };
const GROUP = { x: X(6) - 10, y: Y(0) - 22, w: W + 20, h: 6 * ROW + 28 };
const replanTop: P = { x: X(6) + W / 2, y: Y(6.7) };
const compareBottom: P = { x: X(2) + W / 2, y: Y(MID) + H };
const replanLeft = L("replan");

const EDGES: Edge[] = [
  flow("trigger", "causes"), flow("causes", "compare"), flow("compare", "decide-plan"),
  flow("decide-plan", "approve", { label: "yes" }), flow("approve", "gate"),
  ...LEVERS.flatMap((k) => [flow("gate", `act-${k}`), flow(`act-${k}`, "verify")]),
  flow("verify", "decide-check"),
  flow("decide-check", "export", { label: "yes" }),
  flow("decide-check", "recovery", { label: "if it drifts later", dashed: true }),
  { a: { x: GROUP.x + GROUP.w / 2, y: GROUP.y + GROUP.h }, b: replanTop, c1: { x: replanTop.x, y: GROUP.y + GROUP.h + 20 }, c2: { x: replanTop.x, y: replanTop.y - 20 }, label: "if refused or out of terms", dashed: true, danger: true },
  { a: replanLeft, b: compareBottom, c1: { x: replanLeft.x - 120, y: replanLeft.y }, c2: { x: compareBottom.x, y: compareBottom.y + 120 }, label: "else: planned again, new signature", dashed: true, at: { x: (replanLeft.x + compareBottom.x) / 2 - 20, y: replanLeft.y - 6 } },
];
const midOf = (e: Edge): P => e.at ?? (e.c1 && e.c2 ? { x: (e.a.x + 3 * e.c1.x + 3 * e.c2.x + e.b.x) / 8, y: (e.a.y + 3 * e.c1.y + 3 * e.c2.y + e.b.y) / 8 } : { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 });
const WIDTH = X(10) + PADX, HEIGHT = Y(8) + PADY;

export function WorkflowCanvas() {
  const { session } = useSession();
  const biz = session?.business.id;
  const cur = session?.business.currency ?? "GBP";
  const params = useSearchParams();
  const router = useRouter();
  const mode: "builder" | "debug" = params.get("mode") === "debug" ? "debug" : "builder";
  const caseParam = params.get("case");

  const [info, setInfo] = useState<any>(null);
  const [cases, setCases] = useState<any[] | null>(null);
  const [data, setData] = useState<any>(null);
  const [reserve, setReserve] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(DEFS[0].id);
  const [pb, setPb] = useState<{ settings: Playbook; version: number } | null>(null);
  const [draft, setDraft] = useState<Playbook>(DEFAULT_PLAYBOOK);
  const [saving, setSaving] = useState(false);
  const [pbMsg, setPbMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 16, y: 8, k: 0.8 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const setUrl = useCallback((m: string, c?: string | null) => {
    const q = new URLSearchParams({ tab: "workflow", mode: m });
    if (c) q.set("case", c);
    router.replace(`/room/safety?${q}`, { scroll: false });
  }, [router]);

  useEffect(() => { if (biz) void call(`/api/business/${biz}/mandate`).then((r) => r.ok && setInfo(r.data)); }, [biz]);
  useEffect(() => {
    if (!biz || mode !== "debug") return;
    void call(`/api/business/${biz}/cases`).then((r) => { if (r.ok) setCases(r.data); else setError("Could not load the cases"); });
  }, [biz, mode]);

  const roots = useMemo(() => (cases ?? []).filter((c) => !c.parentRunId), [cases]);
  const caseId = caseParam ?? (roots.filter((c) => c.lifecycle !== "superseded").at(-1) ?? roots.at(-1))?.runId ?? null;
  useEffect(() => {
    if (!biz || mode !== "debug" || !caseId) return;
    let live = true;
    setData(null); setReserve(null); setError(null);
    void call(`/api/business/${biz}/cases/${caseId}`).then(async (r) => {
      if (!live) return;
      if (!r.ok) { setError(r.data.error ?? "Could not load the case"); return; }
      setData(r.data);
      const last = r.data.runs?.at(-1);
      if (last) { const f = await call(`/api/business/${biz}/room/forecast?runId=${last.id}`); if (live && f.ok) setReserve(f.data.reserveMinor ?? null); }
    });
    return () => { live = false; };
  }, [biz, mode, caseId]);

  const map = useMemo(() => (data ? buildCaseMap({ runs: data.runs ?? [], authorisations: data.authorisations ?? [], counterparties: data.counterparties ?? [], cur, reserveMinor: reserve }) : null), [data, cur, reserve]);
  const mapped = useCallback((id: string) => (map ? pick(id, map.nodes) : []), [map]);

  const limits = info?.present ? info.mandate.limits : null;
  const open = sel ? DEF[sel] : null;
  const isOwner = session?.user.role === "owner";
  useEffect(() => {
    if (!biz) return;
    void call(`/api/business/${biz}/playbook`).then((r) => { if (r.ok) { setPb({ settings: r.data.settings, version: r.data.version }); setDraft(r.data.settings); } });
  }, [biz]);
  const dirty = !!pb && JSON.stringify(draft) !== JSON.stringify(pb.settings);
  const lastLever = LEVERS.filter((k) => draft.levers[k]).length <= 1;
  const save = async (next: Playbook) => {
    if (!biz) return;
    setSaving(true); setPbMsg(null);
    const r = await call(`/api/business/${biz}/playbook`, next, "PUT");
    setSaving(false);
    if (!r.ok) { setPbMsg({ tone: "danger", text: r.data?.error ?? "Could not save the playbook" }); return; }
    setPb({ settings: r.data.settings, version: r.data.version }); setDraft(r.data.settings);
    setPbMsg({ tone: "good", text: r.data.version === (pb?.version ?? 0) ? "Nothing changed, so no new version." : `Saved as version ${r.data.version}.` });
  };

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || el.clientWidth === 0) return;
    const k = Math.min(1.6, Math.max(0.2, Math.floor(Math.min((el.clientWidth - 24) / WIDTH, (el.clientHeight - 24) / HEIGHT) * 100) / 100));
    setView({ k, x: Math.round((el.clientWidth - WIDTH * k) / 2), y: Math.round((el.clientHeight - HEIGHT * k) / 2) });
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  const zoom = (d: number) => setView((v) => ({ ...v, k: Math.min(1.6, Math.max(0.2, Math.round((v.k + d) * 10) / 10)) }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="display text-2xl">Workflow</h2><p className="text-ink-soft">How your assistant works, step by step. Fixed by the product; nothing here can be rewired. Synthetic sandbox data.</p></div>
        {mode === "debug" && roots.length > 0 && caseId && (
          <label className="text-sm text-ink-soft">Case <select className="ml-2 rounded-lg border border-line-strong bg-white px-2 py-1.5 text-ink" value={caseId} onChange={(e) => { setUrl("debug", e.target.value); }}>
            {roots.map((c) => <option key={c.runId} value={c.runId}>{date(c.startedAt)} · {c.lifecycle}</option>)}</select></label>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <div ref={box} className="relative h-[620px] select-none overflow-hidden rounded-2xl border border-line bg-[#f7f8f6] [background-image:radial-gradient(#cfd5d1_1px,transparent_1px)] [background-size:20px_20px]"
          style={{ touchAction: "none", cursor: "grab" }}
          onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button,a")) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }; }}
          onPointerMove={(e) => { const d = drag.current; if (d) setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py })); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <div className="absolute left-0 top-0 origin-top-left" style={{ width: WIDTH, height: HEIGHT, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg width={WIDTH} height={HEIGHT} className="absolute inset-0" aria-hidden>
              <rect x={GROUP.x} y={GROUP.y} width={GROUP.w} height={GROUP.h} rx={14} fill="none" stroke="#b9c1bc" strokeDasharray="4 4" />
              {EDGES.map((e, i) => {
                const refused = e.danger && mode === "debug" && map?.nodes.some((n) => n.status === "refused");
                return <path key={i} d={e.c1 && e.c2 ? `M${e.a.x},${e.a.y} C${e.c1.x},${e.c1.y} ${e.c2.x},${e.c2.y} ${e.b.x},${e.b.y}` : `M${e.a.x},${e.a.y} L${e.b.x},${e.b.y}`} fill="none" stroke={refused || (e.danger && mode === "builder") ? "#b3261e" : "#a3ada7"} strokeWidth={1.2} strokeDasharray={e.dashed ? "5 4" : undefined} />;
              })}
            </svg>
            <span className="absolute text-[11px] font-medium uppercase tracking-wide text-ink-soft" style={{ left: GROUP.x + 8, top: GROUP.y + 4 }}>Counterparty asks, in parallel</span>
            {EDGES.filter((e) => e.label).map((e, i) => { const m = midOf(e); return <span key={i} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-line bg-white px-2 py-0.5 text-[11px] text-ink-soft" style={{ left: m.x, top: m.y }}>{e.label}</span>; })}
            {DEFS.map((d) => {
              const ms = mode === "debug" ? mapped(d.id) : [];
              const st = ms.at(-1);
              const dim = mode === "debug" && map && !st && d.id.startsWith("act-");
              return (
                <button key={d.id} type="button" onClick={() => setSel(sel === d.id ? null : d.id)} aria-pressed={sel === d.id}
                  className={`absolute overflow-hidden border bg-white p-2 text-left shadow-sm ${d.kind === "decision" ? "rounded-[22px]" : "rounded-lg"} ${sel === d.id ? "ring-2 ring-accent" : ""} ${dim ? "opacity-50" : ""}`}
                  style={{ left: X(d.col), top: Y(d.row), width: W, height: H, borderColor: st ? STROKE[st.status] : "#d6dbd8" }}>
                  <span className="flex items-center justify-between"><span className="block text-[10px] font-bold uppercase tracking-wider" style={{ color: TYPE_COLOR[d.type] }}>{d.type}</span>{mode === "builder" && customised(d.id, draft) && <span className="rounded-full bg-accent px-1.5 text-[9px] font-semibold uppercase tracking-wide text-white">Customised</span>}</span>
                  <span className="block truncate text-[13px] font-semibold leading-tight" title={d.title}>{d.title}</span>
                  {mode === "debug" && map ? <span className="mt-0.5 flex items-center gap-1 text-[11px]"><Chip tone={st ? TONE[st.status] : "neutral"}>{st ? st.label : "no record"}</Chip></span> : <span className="block truncate text-[11px] text-ink-soft">{d.sub}</span>}
                </button>
              );
            })}
          </div>
          {mode === "debug" && !data && !error && <div className="absolute inset-0 grid place-items-center bg-white/60"><Loading label="Loading the case" /></div>}
          {mode === "debug" && cases && roots.length === 0 && <p className="absolute left-4 top-4 rounded-lg bg-white px-3 py-2 text-sm text-ink-soft shadow-sm">No case yet, so nothing to show. Builder mode explains each step.</p>}
          <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-line bg-white p-1 text-sm shadow-sm" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" aria-label="Zoom out" className="h-7 w-7 rounded hover:bg-neutral-soft" onClick={() => zoom(-0.1)}>−</button>
            <span className="num w-12 text-center">{Math.round(view.k * 100)}%</span>
            <button type="button" aria-label="Zoom in" className="h-7 w-7 rounded hover:bg-neutral-soft" onClick={() => zoom(0.1)}>+</button>
            <button type="button" aria-label="Fit the whole workflow in view" className="ml-1 rounded px-2 py-1 text-xs font-medium hover:bg-neutral-soft" onClick={fit}>Fit</button>
          </div>
          <div role="tablist" aria-label="Workflow mode" className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1 rounded-full border border-line bg-white p-1 text-sm shadow-sm" onPointerDown={(e) => e.stopPropagation()}>
            {(["builder", "debug"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setUrl(m, m === "debug" ? caseParam : null); }}
                className={`rounded-full px-4 py-1.5 font-medium ${mode === m ? "bg-accent text-white" : "text-ink-soft hover:text-ink"}`}>{m === "builder" ? "Builder" : "Debug"}</button>
            ))}
          </div>
        </div>

        <aside className="rounded-2xl border border-line bg-panel p-4 text-sm lg:max-h-[620px] lg:overflow-y-auto" aria-label="Step details">
          {!open ? <p className="text-ink-soft">{mode === "builder" ? "Click a step to see what it does, what it reads, what it can never do, and the limits that apply." : "Click a step to see what happened in this case."}</p> : (
            <div className="space-y-3">
              <div><p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: TYPE_COLOR[open.type] }}>{open.type}</p><h3 className="display text-lg leading-tight">{open.title}</h3>{mode === "builder" && customised(open.id, draft) && <div className="mt-1"><Chip tone="accent">Customised</Chip></div>}</div>
              {mode === "builder" ? <BuilderPanel d={open} limits={limits} cur={cur} draft={draft} onChange={(path, v) => { setPbMsg(null); setDraft((p) => setAt(p, path, v)); }} canEdit={!!isOwner && !saving} lastLever={lastLever} /> : <DebugPanel d={open} nodes={mapped(open.id)} ready={!!map} />}
            </div>
          )}
          {mode === "builder" && pb && (
            <div className="mt-4 space-y-2 border-t border-line pt-3">
              <p className="text-xs text-ink-soft">Playbook {pb.version === 0 ? "is on its defaults (never saved)" : `version ${pb.version}`}{dirty ? " · unsaved changes" : ""}. It can only switch things off or add a human step; it never raises your signed limits.</p>
              {isOwner ? (
                <div className="flex flex-wrap gap-2">
                  <Btn busy={saving} disabled={!dirty} onClick={() => void save(draft)}>Save as version {pb.version + 1}</Btn>
                  <Btn variant="secondary" disabled={saving || JSON.stringify(draft) === JSON.stringify(DEFAULT_PLAYBOOK)} onClick={() => { setPbMsg(null); setDraft(DEFAULT_PLAYBOOK); }}>Reset to defaults</Btn>
                </div>
              ) : <p className="text-xs text-ink-soft">Only the owner can change the playbook. You can read it here.</p>}
              {pbMsg && <p className={`text-xs ${pbMsg.tone === "danger" ? "text-danger" : "text-ink-soft"}`} role="status">{pbMsg.text}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function BuilderPanel({ d, limits, cur, draft, onChange, canEdit, lastLever }: { d: Def; limits: any; cur: string; draft: Playbook; onChange: (path: string, v: boolean) => void; canEdit: boolean; lastLever: boolean }) {
  const settings = limits && d.settings ? d.settings(limits, cur) : [];
  return (
    <>
      <Block h="What it does">{d.does}</Block>
      {(CTLS[d.id] ?? []).map((c) => {
        const on = getAt(draft, c.path);
        const blocked = on && c.path.startsWith("levers.") && lastLever;
        return (
          <div key={c.path} className="rounded-xl border border-line bg-white/70 p-3">
            <label className="flex items-start gap-2 font-semibold">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={on} disabled={!canEdit || blocked} onChange={(e) => onChange(c.path, e.target.checked)} />
              <span>{c.label}</span>
            </label>
            <p className="mt-1 text-xs text-ink-soft">{c.off}</p>
            {blocked && <p className="mt-1 text-xs text-ink-soft">This is the last ask that is on. At least one must stay on, or no plan can be offered.</p>}
          </div>
        );
      })}
      <Block h="What it reads">{d.reads}</Block>
      <Block h="What it can never do">{d.never}</Block>
      {(d.settings || d.note) && (
        <div>
          <p className="font-semibold">Your signed limits</p>
          {d.settings && !limits && <p className="mt-1 text-ink-soft">No signed limits yet, so every action is denied.</p>}
          {settings.length > 0 && (
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">{settings.map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-soft">{k}</dt><dd className="num text-right">{v}</dd></div>)}</dl>
          )}
          {settings.length > 0 && <p className="mt-2 text-xs text-ink-soft">Read-only. Signed by the owner; change them in <Link className="text-accent underline" href="/room/safety?tab=limits">Your limits</Link>.</p>}
          {d.note && <p className="mt-2 text-xs text-ink-soft">{d.note}</p>}
        </div>
      )}
    </>
  );
}

function DebugPanel({ d, nodes, ready }: { d: Def; nodes: MapNode[]; ready: boolean }) {
  if (!ready) return <p className="text-ink-soft">Loading the case.</p>;
  if (nodes.length === 0) return <p className="text-ink-soft">{d.type === "Act" ? "This ask was not part of this case." : "Nothing was recorded for this step in this case."}</p>;
  return (
    <div className="space-y-3">
      {nodes.map((n) => (
        <div key={n.id} className="space-y-1.5 rounded-xl border border-line bg-white/70 p-3">
          <p className="flex flex-wrap items-center gap-2 font-semibold">{n.title} <Chip tone={TONE[n.status]}>{n.label}</Chip></p>
          <p>{n.what}</p>
          {n.figures.length > 0 && <ul className="list-disc pl-5 text-ink-soft">{n.figures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
          {(n.limit || n.actual) && (
            <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
              {n.limit && <><dt className="text-ink-soft">Signed limit</dt><dd>{n.limit}</dd></>}
              {n.actual && <><dt className="text-ink-soft">Actual</dt><dd>{n.actual}</dd></>}
            </dl>
          )}
          <p className="text-xs text-ink-soft">{n.record !== null ? <>Log record number <span className="num">#{n.record}</span></> : "No log record number for this step"} · recorded from the sandbox (synthetic)</p>
        </div>
      ))}
    </div>
  );
}

const Block = ({ h, children }: { h: string; children: React.ReactNode }) => <div><p className="font-semibold">{h}</p><p className="mt-0.5 text-ink-soft">{children}</p></div>;
