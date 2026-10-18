// One focused check for owner automations (not a test suite). Run once: bun run check:automations
// Part A (pure): every template round-trips through the schema and the editor's tree view; a flow is evaluated on an inline synthetic snapshot.
//   Rejected: a forbidden node kind, a cycle, an unknown key, an over-long message, a reminder on the wrong trigger.
// Part B (database, throwaway demo clone, mock provider; no model is called): a dry run on the seeded books gives the expected per-node outcomes and
//   changes no table (hashes before and after); two monitor passes on the same day fire an automation once; a wait stores its resume date and continues
//   on a later pass; the log holds automation.created and automation.ran records with ids and outcomes only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import postgres from "postgres";
import { automationInputSchema, graphSchema, graphToTree, treeToGraph, type FlowGraph } from "../src/domain/automation";
import { AUTOMATION_TEMPLATES, buildTemplate } from "../src/domain/automation-templates";
import { flowSentence } from "../src/domain/automation-words";
import { friendlyIssues } from "../src/domain/automation-friendly";
import { evaluate, triggerEvents, type AutoSnapshot } from "../src/actions/automations";

const inv = (id: string, cp: string, name: string, dueOn: string, amount: bigint) => ({ id, number: id, counterpartyId: cp, counterpartyName: name, issuedOn: "2026-08-01", dueOn, amount, status: "open" as const });
const snap = (o: Partial<AutoSnapshot> = {}): AutoSnapshot => ({ asOf: "2026-10-15", currency: "GBP", reserveMinor: 2_800_000n, weekly: [], invoices: [], bills: [], candidates: [], raised: [], reason: "check", ...o });
const rejects = (g: unknown, why: string) => assert.equal(graphSchema.safeParse(g).success, false, why);

function partA() {
  // A1. Every template is valid, survives graph -> tree -> graph unchanged, and contains no node outside the vocabulary.
  assert.equal(AUTOMATION_TEMPLATES.length, 6);
  for (const t of AUTOMATION_TEMPLATES) {
    const built = buildTemplate(t.id, 2)!;
    assert.ok(built, t.id);
    const parsed = automationInputSchema.parse(built);
    const tree = graphToTree(parsed.graph);
    assert.ok(tree, `${t.id} is tree-shaped`);
    assert.deepEqual(automationInputSchema.parse({ name: built.name, graph: treeToGraph(tree!) }).graph, parsed.graph, `${t.id} round-trips`);
  }
  const big = buildTemplate("big_bill_watch", 2)!.graph.nodes[0];
  assert.equal(big.type === "trigger" && big.trigger.kind === "bill_due" ? big.trigger.minAmount : "", "100000", "1,000.00 in minor units");

  // A2. Rejected: forbidden kind, cycle, unknown keys, long message, wrong-trigger reminder, unreachable step, two triggers.
  const ok: FlowGraph = { nodes: [{ id: "t", type: "trigger", trigger: { kind: "weekly_digest", weekday: "mon" } }, { id: "s1", type: "action", action: { kind: "notify_owner" } }], edges: [{ from: "t", to: "s1", label: "next" }] };
  const withNode = (n: any, e?: any): FlowGraph => ({ nodes: [...ok.nodes, n], edges: [...ok.edges, ...(e ? [e] : [])] }) as any;
  rejects(withNode({ id: "pay", type: "action", action: { kind: "pay_supplier" } }, { from: "s1", to: "pay", label: "next" }), "no node that pays");
  for (const kind of ["sign_plan", "approve_plan", "execute_plan", "send_email", "edit_mandate", "change_limits"]) rejects(withNode({ id: "x1", type: "action", action: { kind } }, { from: "s1", to: "x1", label: "next" }), kind);
  const loop = withNode({ id: "x1", type: "action", action: { kind: "notify_owner" } }, { from: "s1", to: "x1", label: "next" });
  rejects({ ...loop, edges: [...loop.edges, { from: "x1", to: "s1", label: "next" }] }, "a cycle");
  rejects({ ...ok, nodes: ok.nodes.map((n: any) => (n.type === "action" ? { ...n, action: { ...n.action, send: true } } : n)) }, "unknown key inside an action");
  rejects({ ...ok, extra: 1 }, "unknown key on the graph");
  rejects({ ...ok, nodes: ok.nodes.map((n: any) => (n.type === "action" ? { ...n, action: { kind: "notify_owner", message: "x".repeat(201) } } : n)) }, "message over 200 characters");
  rejects({ ...ok, nodes: ok.nodes.map((n: any) => (n.type === "action" ? { ...n, action: { kind: "draft_customer_reminder", tone: "firm" } } : n)) }, "a reminder from a digest trigger");
  rejects(withNode({ id: "lonely", type: "action", action: { kind: "stop" } }), "a step nothing leads to");
  rejects(withNode({ id: "t2", type: "trigger", trigger: { kind: "document_confirmed" } }), "two triggers");
  rejects({ nodes: ok.nodes.filter((n) => n.type === "trigger"), edges: [] }, "no action");

  // A3. The pure walk, on an inline synthetic snapshot: an invoice 20 days overdue takes the "yes" branch after the wait; one 9 days overdue takes "otherwise".
  const books = snap({ invoices: [inv("old", "c1", "Alpha Ltd (test)", "2026-09-25", 500_000n), inv("new", "c2", "Beta Ltd (test)", "2026-10-06", 300_000n), inv("fresh", "c3", "Gamma Ltd (test)", "2026-10-12", 100_000n)] });
  const chase = buildTemplate("chase_overdue_invoices", 2)!.graph;
  const trig = (chase.nodes[0] as any).trigger;
  const evs = triggerEvents(trig, books);
  assert.deepEqual(evs.map((e) => e.entity).sort(), ["invoice:new", "invoice:old"], "7+ days overdue only");
  const first = evaluate(chase, evs.find((e) => e.entity === "invoice:old")!, books, { dryRun: false });
  assert.deepEqual(first.steps.map((s) => [s.node, s.outcome]), [["t", "ran"], ["s1", "ran"], ["s2", "waiting"]]);
  assert.equal(first.wait?.resumeOn, "2026-10-22", "resumes 7 days after the books date");
  const later = snap({ ...books, asOf: "2026-10-22" });
  const evOld = triggerEvents(trig, later).find((e) => e.entity === "invoice:old")!;
  const evNew = triggerEvents(trig, later).find((e) => e.entity === "invoice:new")!;
  assert.deepEqual(evaluate(chase, evOld, later, { from: first.wait!.next!, dryRun: false }).steps.map((s) => s.outcome), ["yes", "ran", "ran"], "27 days overdue: a firm reminder");
  assert.deepEqual(evaluate(chase, evNew, later, { from: first.wait!.next!, dryRun: false }).steps.map((s) => s.outcome), ["yes", "ran", "ran"], "16 days overdue is over 13: also firm");
  const early = snap({ ...books, asOf: "2026-10-17" });
  const evEarly = triggerEvents(trig, early).find((e) => e.entity === "invoice:new")!;
  assert.deepEqual(evaluate(chase, evEarly, early, { from: first.wait!.next!, dryRun: false }).steps.map((s) => s.outcome), ["otherwise", "stopped"], "11 days overdue: otherwise, stop");
    // A4. The two read-only actions are part of the vocabulary and nothing else slipped in: they validate, an unknown key on them is refused, and applying or sending is not a kind.
  const withNew = (kind: string, extra: object = {}): FlowGraph => ({ nodes: [...ok.nodes, { id: "x1", type: "action", action: { kind, ...extra } }], edges: [...ok.edges, { from: "s1", to: "x1", label: "next" }] }) as any;
  assert.ok(graphSchema.safeParse(withNew("suggest_financing_options")).success, "suggest_financing_options is allowed");
  assert.ok(graphSchema.safeParse(withNew("attach_analysis_snapshot")).success, "attach_analysis_snapshot is allowed");
  rejects(withNew("suggest_financing_options", { apply: true }), "financing options cannot carry an apply flag");
  rejects(withNew("attach_analysis_snapshot", { send: true }), "the analysis snapshot cannot carry a send flag");
  for (const kind of ["apply_for_loan", "accept_offer", "send_to_lender"]) rejects(withNew(kind), kind);

  // A5. Plain words: the one-sentence summary reads well, and a raw schema message never reaches the owner.
  const money = (v: string) => `£${(Number(v) / 100).toLocaleString("en-GB")}`;
  const chaseSentence = flowSentence(buildTemplate("chase_overdue_invoices", 2)!.graph, money);
  assert.ok(chaseSentence.startsWith("When an invoice is 7 days overdue, draft a friendly reminder"), chaseSentence);
  assert.ok(flowSentence(buildTemplate("financing_gap_check", 2)!.graph, money).includes("suggest financing options, prepare rescue plans for you to review and tell you"));
  const bad = automationInputSchema.safeParse({ name: "", graph: ok });
  assert.ok(!bad.success);
  const friendly = friendlyIssues(bad.error.issues);
  assert.ok(friendly.includes("Give this automation a name."), friendly.join(" | "));
  assert.ok(friendly.every((m) => !/too small|expected|>=/i.test(m)), `no raw schema text: ${friendly.join(" | ")}`);
  const daysBad = automationInputSchema.safeParse({ name: "x", graph: { ...ok, nodes: ok.nodes.map((n: any) => (n.type === "trigger" ? { ...n, trigger: { kind: "forecast_below_cushion", withinWeeks: 99 } } : n)) } });
  assert.ok(!daysBad.success && friendlyIssues(daysBad.error.issues).some((m) => m.includes("weeks")), "a number out of range is explained");
  console.log("  Part A ok: 6 templates round-trip; the two read-only actions validate and apply/send is not a kind; plain-words sentence and friendly errors; forbidden kinds, cycle, unknown keys, long message, wrong trigger, orphan, two triggers all rejected; the walk branches and waits");
}

async function partB() {
  const { db, sql } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { createDemoClone } = await import("../src/actions/demo-clone");
  const { createAutomation, createFromTemplate, setEnabled } = await import("../src/actions/automation-admin");
  const { dryRunFlow, runAutomationsAfterMonitor } = await import("../src/actions/automations");
  const { runMonitor, loadAutomationSnapshot } = await import("../src/actions/monitor");
  const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rows = async <T = Record<string, any>>(strings: TemplateStringsArray, ...v: unknown[]) => (await owner(strings, ...(v as never[]))) as unknown as T[];
  const TABLES = ["automation_runs", "notifications", "action_records", "agent_runs", "alerts", "automations", "invoices", "bills", "sandbox_payments"];
  const hashes = async (id: string) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, JSON.stringify((await owner.unsafe(`select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from ${t} x where business_id = '${id}'`))[0])])));
  try {
    const demo = await getDefaultBusinessId();
    assert.ok(demo, "run bun run db:seed first");
    const biz = await createDemoClone(db as any, demo!);
    const { asOf } = await loadAutomationSnapshot(db as any, biz.id);
    const overdue = Number((await rows<{ n: number }>`select count(*)::int n from invoices where business_id = ${biz.id} and status not in ('paid','void','draft') and counted_in is null and due_on <= ${asOf}::date - 7`)[0].n);
    assert.ok(overdue > 0, "the seeded books have invoices 7+ days overdue");

    // ---- dry run on the seeded business: expected outcomes, and no table changes ----
    const chase = buildTemplate("chase_overdue_invoices", 2)!;
    const before = await hashes(biz.id);
    const dry = await dryRunFlow(db as any, biz.id, chase.name, chase.graph, await loadAutomationSnapshot(db as any, biz.id));
    assert.equal(dry.matched, overdue, "matched = the invoices 7+ days overdue, counted independently in SQL");
    assert.ok(dry.examples.length > 0 && dry.examples.length <= 5);
    for (const ex of dry.examples) {
      assert.deepEqual(ex.nodes.map((n) => [n.node, n.outcome]), [["t", "ran"], ["s1", "would_run"], ["s2", "would_wait"], ["s3", "later"], ["s4", "later"], ["s5", "later"], ["s6", "later"]], "draft now, wait, the rest is not reached");
      assert.ok(ex.nodes[1].summary.includes("Nothing is sent"), ex.nodes[1].summary);
    }
    const custId = (await rows<{ customer_id: string }>`select customer_id from invoices where business_id = ${biz.id} and status not in ('paid','void','draft') and due_on <= ${asOf}::date - 7 limit 1`)[0].customer_id;
    const wide: FlowGraph = {
      nodes: [
        { id: "t", type: "trigger", trigger: { kind: "invoice_overdue", days: 1 } },
        { id: "s1", type: "action", action: { kind: "run_simulation", scenario: { name: "That customer pays 14 days late", shocks: [{ kind: "customer_late", counterpartyId: custId, days: 14 }] } } },
        { id: "s2", type: "action", action: { kind: "prepare_rescue_plans" } },
        { id: "s3", type: "action", action: { kind: "notify_approver", message: "<b>look</b>" } },
      ],
      edges: [{ from: "t", to: "s1", label: "next" }, { from: "s1", to: "s2", label: "next" }, { from: "s2", to: "s3", label: "next" }],
    };
    const dry2 = await dryRunFlow(db as any, biz.id, "Wide", wide, await loadAutomationSnapshot(db as any, biz.id));
    const n2 = dry2.examples[0].nodes;
    assert.equal(n2[1].outcome, "would_run", n2[1].summary);
    assert.ok(n2[1].summary.startsWith("Would report a what-if"), n2[1].summary);
    assert.ok(["would_run", "skipped"].includes(n2[2].outcome) && !n2[2].summary.includes("Prepared"), `dry run only looks: ${n2[2].summary}`);
    assert.equal(n2[3].outcome, "would_run");
    assert.deepEqual(await hashes(biz.id), before, "a dry run changes no table (runs, notifications, log, planning runs, alerts, automations, books, sandbox payments)");

    // ---- the two new read-only actions: the dry run shows the figures and still changes nothing ----
    const rich: FlowGraph = {
      nodes: [
        { id: "t", type: "trigger", trigger: { kind: "invoice_overdue", days: 1 } },
        { id: "s1", type: "action", action: { kind: "suggest_financing_options" } },
        { id: "s2", type: "action", action: { kind: "attach_analysis_snapshot" } },
        { id: "s3", type: "action", action: { kind: "notify_owner" } },
      ],
      edges: [{ from: "t", to: "s1", label: "next" }, { from: "s1", to: "s2", label: "next" }, { from: "s2", to: "s3", label: "next" }],
    };
    const dry3 = await dryRunFlow(db as any, biz.id, "Rich", rich, await loadAutomationSnapshot(db as any, biz.id));
    const n3 = dry3.examples[0].nodes;
    assert.equal(n3[1].outcome, "would_run", n3[1].summary);
    assert.ok(/indicative/i.test(n3[1].summary) && /not a quote/i.test(n3[1].summary), `financing carries the honesty notice: ${n3[1].summary}`);
    assert.ok(n3[2].summary.includes("Owed to you") && n3[2].summary.includes("Overdue"), `analysis figures: ${n3[2].summary}`);
    assert.ok(dry3.examples[0].body.length > 0 && dry3.examples[0].link.startsWith("/room"), "the preview names what matched");
    assert.deepEqual(await hashes(biz.id), before, "a dry run with the two new actions still changes no table");

    // ---- two passes on the same day fire once ----
    const created = await createAutomation(db as any, biz.id, { name: "Tell me about every late invoice", graph: { nodes: [{ id: "t", type: "trigger", trigger: { kind: "invoice_overdue", days: 1 } }, { id: "s1", type: "action", action: { kind: "notify_owner", message: "Check this one" } }], edges: [{ from: "t", to: "s1", label: "next" }] } }, "Test Owner");
    await setEnabled(db as any, biz.id, created.id, true, "Test Owner");
    const lateNow = Number((await rows<{ n: number }>`select count(*)::int n from invoices where business_id = ${biz.id} and status not in ('paid','void','draft') and counted_in is null and due_on < ${asOf}::date`)[0].n);
    await runMonitor(db as any, biz.id, { reason: "check" });
    const count = async () => ({
      runs: Number((await rows<{ n: number }>`select count(*)::int n from automation_runs where automation_id = ${created.id}`)[0].n),
      notes: Number((await rows<{ n: number }>`select count(*)::int n from notifications where automation_id = ${created.id}`)[0].n),
    });
    const one = await count();
    assert.equal(one.runs, Math.min(lateNow, 10), "one run per late invoice (capped at 10 per day)");
    assert.equal(one.notes, one.runs, "one notification per run");
    await runMonitor(db as any, biz.id, { reason: "check" });
    await runMonitor(db as any, biz.id, { reason: "document_confirmed" });
    assert.deepEqual(await count(), one, "the same day again: nothing fires twice");

    // ---- a wait stores its resume date and continues on a later pass ----
    const tpl = await createFromTemplate(db as any, biz.id, "chase_overdue_invoices", "Test Owner");
    await setEnabled(db as any, biz.id, tpl.id, true, "Test Owner");
    await runMonitor(db as any, biz.id, { reason: "check" });
    const waiting = await rows<{ id: string; resume_on: string; resume_node: string }>`select id, resume_on::text, resume_node from automation_runs where automation_id = ${tpl.id} and status = 'waiting'`;
    assert.equal(waiting.length, Math.min(overdue, 10), "each chased invoice waits");
    assert.equal(waiting[0].resume_on, new Date(Date.parse(`${asOf}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10), "resume date = books date + 7");
    const snapNow = await loadAutomationSnapshot(db as any, biz.id);
    const { addDays } = await import("../src/engine");
    const res = await runAutomationsAfterMonitor(db as any, biz.id, { ...snapNow, asOf: addDays(asOf, 7) });
    assert.equal(res.resumed, waiting.length, "the later pass continued every waiting run");
    const done = await rows<{ status: string; results: any[] }>`select status, results from automation_runs where automation_id = ${tpl.id}`;
    assert.ok(done.every((r) => r.status === "done"), "finished");
    assert.ok(done.every((r) => r.results.length >= 5 && r.results.some((x: any) => x.node === "s3" && ["yes", "otherwise"].includes(x.outcome))), "the condition after the wait was evaluated on the later books");
    const drafts = await rows<{ title: string; body: string }>`select title, body from notifications where automation_id = ${tpl.id} and kind = 'draft_reminder'`;
    assert.ok(drafts.length >= waiting.length && drafts.every((d) => d.body.startsWith("DRAFT. Nothing has been sent.")), "drafts say they are drafts");

    // ---- a real run of the new actions adds their text to the one notification; the owner then decides on a draft (one log record) ----
    const richA = await createAutomation(db as any, biz.id, { name: "Rich", graph: rich }, "Test Owner");
    await setEnabled(db as any, biz.id, richA.id, true, "Test Owner");
    await runMonitor(db as any, biz.id, { reason: "check" });
    const richNotes = await rows<{ body: string }>`select body from notifications where automation_id = ${richA.id}`;
    assert.ok(richNotes.length > 0 && richNotes.every((n) => /Financing options \(indicative/.test(n.body) && /Cash analysis/.test(n.body)), "both extras are inside the notification");
    const draft = (await rows<{ id: string }>`select id from notifications where business_id = ${biz.id} and kind = 'draft_reminder' limit 1`)[0];
    const { resolveDraft } = await import("../src/actions/notifications");
    await resolveDraft(db as any, biz.id, draft.id, "send_sandbox");
    const sent = (await rows<{ resolution: string; resolved_at: string | null }>`select resolution, resolved_at::text from notifications where id = ${draft.id}`)[0];
    assert.equal(sent.resolution, "sent_sandbox");
    assert.ok(sent.resolved_at);
    await assert.rejects(() => resolveDraft(db as any, biz.id, draft.id, "dismiss"), /already decided/, "a draft is decided once");
    assert.equal(Number((await rows<{ n: number }>`select count(*)::int n from action_records where business_id = ${biz.id} and event = 'automation.draft_sent'`)[0].n), 1, "one log record");

    // ---- the log: ids and outcomes only ----
    const ran = await rows<{ detail: any }>`select detail from action_records where business_id = ${biz.id} and event = 'automation.ran' limit 1`;
    assert.deepEqual(Object.keys(ran[0].detail).sort(), ["automationId", "entity", "nodes", "runId", "status", "version"], "no free text in the log");
    assert.ok(Number((await rows<{ n: number }>`select count(*)::int n from action_records where business_id = ${biz.id} and event in ('automation.created','automation.enabled')`)[0].n) >= 4);
    await db.select().from(S.automations).where(and(eq(S.automations.businessId, biz.id)));
    console.log(`  Part B ok: dry run matched ${dry.matched} overdue invoice(s) and changed nothing; ${one.runs} run(s) fired once; ${waiting.length} wait(s) resumed; log holds ids and outcomes only`);
  } finally {
    await owner.end();
    await sql.end();
  }
}

partA();
partB().then(() => console.log("check:automations ok"), (e) => { console.error(e); process.exit(1); });
