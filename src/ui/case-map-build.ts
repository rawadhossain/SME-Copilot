/* eslint-disable @typescript-eslint/no-explicit-any */
// Case map: a PURE read-only view over the case data the case page already loads (getCase). It draws only what the records show.
// Counterparty free text (a branch's "reason") is never copied out; it is only tested for a refusal. Money is formatted, never computed.
import { LEVER_NAME, money, pct, week } from "./format";

export type MapStatus = "done" | "refused" | "rolled_back" | "waiting" | "failed";
export interface MapNode {
  id: string; col: number; row: number; title: string; figure: string; status: MapStatus; label: string;
  what: string; figures: string[]; limit: string | null; actual: string | null; record: number | null;
}
export interface MapEdge { from: string; to: string }
export interface CaseMap { nodes: MapNode[]; edges: MapEdge[] }

const boundText = (b: any): string | null => {
  switch (b?.kind) {
    case "supplier_reduce_deposit": return `deposit at most ${pct(b.maxPercentBps)}`;
    case "supplier_defer_balance": return `deferral of at least ${b.minDays} days`;
    case "buyer_request_deposit": return `deposit of at least ${pct(b.minPercentBps)}`;
    case "finance_invoice": return `fee at most ${pct(b.maxFeeBps)}`;
    case "chase_overdue": return `payment within ${b.maxDays} days or sooner`;
    case "early_payment_discount": return `discount at most ${pct(b.maxDiscountBps)}`;
    default: return null;
  }
};
const termText = (b: any): string | null => {
  if (b.agreedTerms) return Object.entries(b.agreedTerms).map(([k, v]) => `${k.replace(/Bps$/, "")} ${k.endsWith("Bps") ? pct(Number(v)) : String(v)}`).join(", ");
  if (b.offer) return `advance ${pct(b.offer.advanceBps)}, fee ${pct(b.offer.feeBps)}`;
  return null;
};

export function buildCaseMap(input: { runs: any[]; authorisations: any[]; counterparties: any[]; cur: string; reserveMinor?: string | null }): CaseMap {
  const { runs, authorisations: auths, cur } = input;
  const names: Record<string, string> = Object.fromEntries((input.counterparties ?? []).map((c) => [c.id, c.name]));
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const add = (n: Omit<MapNode, "row"> & { row?: number }) => { nodes.push({ row: -1, ...n }); return n.id; };
  const link = (from: string, to: string) => edges.push({ from, to });
  const first = runs[0];
  if (!first) return { nodes, edges };

  // 1. Shortage detected
  const r = first.trigger?.reason ?? first.doNothing;
  let col = 0;
  const shortFigure = r?.minBalanceMinor !== undefined
    ? (BigInt(r.minBalanceMinor) < 0n ? `lowest ${money(r.minBalanceMinor, cur)} in ${week(r.minBalanceWeek)}` : `lowest ${money(r.minBalanceMinor, cur)}, ${week(r.minBalanceWeek)}`)
    : "recorded by the forecast";
  let prev = add({
    id: "shortage", col: col++, title: "Shortage detected", figure: shortFigure, status: "done", label: "done",
    what: first.trigger?.origin === "simulation" ? "A simulated crisis was prepared for. It has not happened; the figures are from today's real books." : "The forecast showed the cash balance falling short.",
    figures: r?.minBalanceMinor !== undefined ? [`Lowest balance: ${money(r.minBalanceMinor, cur)}`, `In: ${week(r.minBalanceWeek)}`, ...(BigInt(r.minBalanceMinor) < 0n ? [`Shortfall below zero: ${money((-BigInt(r.minBalanceMinor)).toString(), cur)}`] : [])] : [],
    limit: null, actual: null, record: null,
  });

  // 2. Plans compared
  const planCount = runs.reduce((n, x) => n + x.plans.length, 0);
  const plansId = add({
    id: "plans", col: col++, title: "Plans compared", figure: planCount ? `${planCount} option${planCount === 1 ? "" : "s"} across ${runs.length} round${runs.length === 1 ? "" : "s"}` : "no plan yet",
    status: planCount ? "done" : "waiting", label: planCount ? "done" : "waiting",
    what: planCount ? "The assistant searched for combinations of fixes. Every figure was computed by fixed code and compared with doing nothing." : "The assistant is still working on options.",
    figures: runs.map((x) => `${x.round === 0 ? "First round" : `Re-plan ${x.round}`}: ${x.plans.length} option${x.plans.length === 1 ? "" : "s"}`), limit: null, actual: null, record: null,
  });
  link(prev, plansId); prev = plansId;

  if (auths.length === 0) {
    const s = add({ id: "signed", col: col++, title: "Owner signed", figure: "waiting for your signature", status: "waiting", label: "waiting", what: "Nothing is sent to anyone until you sign a plan within your limits.", figures: [], limit: null, actual: null, record: null });
    const a = add({ id: "asks", col: col++, title: "Counterparty asks", figure: "not started", status: "waiting", label: "waiting", what: "After you sign, each ask goes to the other side.", figures: [], limit: null, actual: null, record: null });
    const g = add({ id: "gate", col: col++, title: "Gate checks", figure: "not started", status: "waiting", label: "waiting", what: "Every action is checked against your signed limits first.", figures: [], limit: null, actual: null, record: null });
    const v = add({ id: "verify", col: col++, title: "Independent verification", figure: "not started", status: "waiting", label: "waiting", what: "A separate check runs after the plan has been carried out.", figures: [], limit: null, actual: null, record: null });
    link(prev, s); link(s, a); link(a, g); link(g, v);
    return finish(nodes, edges);
  }

  auths.forEach((view, i) => {
    const a = view.authorisation, ex = view.execution, out = ex?.outcome, trail: any[] = view.trail ?? [];
    const run = runs.find((x) => x.id === a.runId);
    const seqOf = (ev: string) => trail.find((t) => t.event === ev)?.chainSeq ?? null;
    const p = `a${i}`;
    const twoStep = a.terms?.confirmations === 2 || ["awaiting_second", "declined"].includes(a.status) || !!a.firstConfirmedName;
    const signedOk = !!a.signed;
    const sid = add({
      id: `${p}-signed`, col: col++, title: i === 0 ? "Owner signed" : "Owner signed again",
      figure: signedOk ? `by ${a.approvedBy ?? "the owner"}` : twoStep && a.status === "awaiting_second" ? `confirmed by ${a.firstConfirmedName ?? "the owner"}` : a.status,
      status: signedOk ? "done" : a.status === "denied" || a.status === "declined" || a.status === "expired" ? "failed" : "waiting",
      label: signedOk ? "done" : a.status === "denied" ? "denied" : a.status === "expired" ? "expired" : a.status === "declined" ? "declined" : "waiting",
      what: signedOk ? "You signed this plan. The signature covers the plan, the exact requests and the worst answer you accept in advance." : "The plan has not been signed yet, so nothing has been sent.",
      figures: [`Limits version: ${a.mandateVersion}`, `Plan terms: ${(a.terms?.entries ?? []).length} ask${(a.terms?.entries ?? []).length === 1 ? "" : "s"}`],
      limit: null, actual: null, record: seqOf("plan.authorised") ?? seqOf("plan.authorisation_proposed"),
    });
    link(prev, sid);
    let fromAsks = sid;
    if (twoStep) {
      const second = add({
        id: `${p}-second`, col: col++, title: "Second approver", figure: a.status === "declined" ? "declined" : a.status === "awaiting_second" ? "waiting for a different approver" : "confirmed",
        status: a.status === "declined" ? "refused" : a.status === "awaiting_second" ? "waiting" : "done", label: a.status === "declined" ? "declined" : a.status === "awaiting_second" ? "waiting" : "done",
        what: "Because the payments are large, a different approver must also confirm the plan before anything is sent.",
        figures: [`First confirmed by: ${a.firstConfirmedName ?? "the owner"}`], limit: null, actual: null, record: seqOf("plan.awaiting_second_approval") ?? seqOf("plan.authorised"),
      });
      link(sid, second); fromAsks = second;
    }

    // One node per counterparty ask: the recorded branches when execution has started, otherwise the signed terms as waiting.
    const entries: any[] = a.terms?.entries ?? [];
    const branches: any[] = out?.branches?.length ? out.branches : entries.map((e: any) => ({ index: e.index, kind: e.lever.kind, status: "pending", counterpartyId: e.request?.counterpartyId ?? e.lever.counterpartyId }));
    const halted = ex && ["failed", "rolled_back"].includes(ex.status);
    const askCol = col++;
    const askIds: string[] = [];
    const refusedIds: string[] = [];
    branches.forEach((b: any, k: number) => {
      const entry = entries[b.index] ?? entries[k];
      const kind = b.kind ?? entry?.lever?.kind;
      const who = b.counterpartyId ? names[b.counterpartyId] ?? "counterparty" : "counterparty";
      const reason = String(b.reason ?? "");
      let status: MapStatus, label: string;
      if (b.withdrawn) { status = "rolled_back"; label = halted || ex?.status === "needs_replan" ? "rolled back" : "withdrawn"; }
      else if (b.status === "needs_replan") { const refusal = /refus|declin|rejected/i.test(reason); status = "refused"; label = refusal ? "refused" : "out of terms"; }
      else if (halted && ["agreed", "offered", "committed"].includes(b.status)) { status = "failed"; label = "not withdrawn"; }
      else if (["agreed", "offered", "committed"].includes(b.status)) { status = "done"; label = "accepted"; }
      else if (b.status === "failed") { status = "failed"; label = "failed"; }
      else { status = ex?.status === "rolled_back" ? "rolled_back" : "waiting"; label = status === "waiting" ? "waiting" : "rolled back"; }
      const rec = trail.find((t) => t.event === "plan.branch_result" && t.detail?.index === b.index)?.chainSeq ?? null;
      const actual = termText(b);
      const kindName = LEVER_NAME[kind] ?? String(kind);
      const id = add({
        id: `${p}-ask${k}`, col: askCol, row: k, title: kindName, figure: `${who} · ${label}`, status, label,
        what: status === "done" ? `${who} accepted within the limits you signed.` : status === "refused" ? (label === "refused" ? `${who} refused this ask.` : `${who} answered outside the terms you signed, so it was not accepted.`) : status === "rolled_back" ? `The agreement with ${who} was withdrawn so nothing was left half-done.` : status === "failed" ? `This ask did not complete.` : `Not asked yet.`,
        figures: entry ? [`Asked: ${entry.lever ? kindName : ""}`.trim()].filter(Boolean) : [],
        limit: entry ? boundText(entry.bound) : null, actual, record: rec,
      });
      askIds.push(id); if (status === "refused") refusedIds.push(id);
      link(fromAsks, id);
    });
    const gateCol = col;

    // Gate checks over this authorisation's actions
    let after: string[] = askIds.filter((x) => !refusedIds.includes(x));
    if (view.actions?.length) {
      const acts: any[] = view.actions;
      const denied = acts.filter((x) => x.gateResult?.decision === "deny").length;
      const recs = trail.filter((t) => t.proposalId).map((t) => t.chainSeq as number);
      const gid = add({
        id: `${p}-gate`, col: gateCol, title: "Gate checks", figure: `${acts.length} checked, ${denied} blocked`, status: denied ? "failed" : "done", label: denied ? "blocked" : "done",
        what: "Every action was checked against your signed limits before it ran, by code, not by the AI.",
        figures: [`Actions checked: ${acts.length}`, `Blocked: ${denied}`, `Allowed within limits: ${acts.length - denied}`], limit: `Limits version ${a.mandateVersion}`, actual: denied ? `${denied} action${denied === 1 ? "" : "s"} blocked` : "all within limits", record: recs.length ? Math.min(...recs) : null,
      });
      after.forEach((x) => link(x, gid)); after = [gid]; col++;
    }

    // Re-plan after a refusal / out-of-terms answer
    const replanned = !!a.run?.successorRunId || !!run?.successorRunId;
    const needs = ex?.status === "needs_replan" || run?.lifecycle === "needs_replan";
    const exhausted = run?.lifecycle === "exhausted";
    if (replanned || needs || exhausted || refusedIds.length) {
      const round = (run?.round ?? i) + 1;
      const rid = add({
        id: `${p}-replan`, col: col++, title: `Re-plan round ${round}`, figure: exhausted ? "no plan fits your limits" : replanned ? "new plan prepared" : "waiting for your decision",
        status: exhausted ? "failed" : replanned ? "done" : "waiting", label: exhausted ? "exhausted" : replanned ? "done" : "waiting",
        what: "After someone said no, the structured answers were kept as constraints and the assistant planned again. A new round needs a new signature from you.",
        figures: [`Constraints learned: ${(run?.constraints ?? []).length}`], limit: null, actual: null, record: seqOf("plan.needs_replan") ?? seqOf("plan.replanned"),
      });
      refusedIds.forEach((x) => link(x, rid));
      prev = rid;
      return;
    } else prev = after[0] ?? sid;

    if (i === auths.length - 1) {
      const v = ex?.verification;
      const metrics: any[] = v?.metrics ?? [];
      const low = metrics.find((m) => m.name === "minBalanceMinor");
      const cushionMissed = v && low?.actual != null && input.reserveMinor != null && BigInt(low.actual) < BigInt(input.reserveMinor);
      const vid = add({
        id: "verify", col: col++, title: "Independent verification",
        figure: !v ? "not run yet" : v.ok ? "Check passed" : "Check failed",
        status: !v ? "waiting" : v.ok ? "done" : "failed", label: !v ? "waiting" : v.ok ? "Check passed" : "Check failed",
        what: !v ? "A separate piece of code will recompute the forecast from the practice bank once the plan has run." : v.ok ? "A separate check recomputed your forecast from what the practice bank holds and it matches what the agreed terms should give." : "The recomputed forecast differs from what the agreed terms should give.",
        figures: v ? [`Scheduled items found: ${v.schedule?.found} of ${v.schedule?.expected}`, ...(cushionMissed ? ["Cushion not restored"] : [])] : [],
        limit: metrics.length ? metrics.map((m) => `${m.name}: expected ${m.kind === "money" ? money(m.promised, cur) : m.promised === null ? "none" : week(Number(m.promised))}`).join("; ") : null,
        actual: metrics.length ? metrics.map((m) => `${m.name}: actual ${m.kind === "money" ? money(m.actual, cur) : m.actual === null ? "none" : week(Number(m.actual))}${m.ok ? "" : " (differs)"}`).join("; ") : null,
        record: seqOf("plan.verified") ?? seqOf("plan.verification_failed"),
      });
      after.forEach((x) => link(x, vid));
    }
  });
  return finish(nodes, edges);
}

function finish(nodes: MapNode[], edges: MapEdge[]): CaseMap {
  const maxAsks = Math.max(1, ...nodes.filter((n) => n.row >= 0).map((n) => n.row + 1));
  for (const n of nodes) if (n.row < 0) n.row = (maxAsks - 1) / 2;
  return { nodes, edges };
}
