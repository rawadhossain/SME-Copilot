// AUTOMATION MANAGEMENT: create, edit, turn on and off, delete, list, run history. Every flow is validated by the same schema the runner reads, every change is
// one hash-chained log record (ids and version only, never the owner's text). Nothing here runs a flow; the monitor does (src/actions/automations.ts).
import { and, desc, eq, sql } from "drizzle-orm";
import { automationRuns, automations, businesses, currencies } from "@/db/schema";
import { automationInputSchema, graphToTree, TRIGGER_TITLE, type AutomationStatus, type FlowGraph, type NodeResult } from "@/domain/automation";
import { AUTOMATION_TEMPLATES, buildTemplate, type RecipeTag } from "@/domain/automation-templates";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export const MAX_AUTOMATIONS = 25;

export interface AutomationView {
  id: string; name: string; status: AutomationStatus; version: number; graph: FlowGraph; triggerTitle: string; editable: boolean;
  createdBy: string; updatedBy: string; updatedAt: string;
  lastRun: { at: string; status: string; entity: string } | null; waiting: number; runs: number;
}

export interface RecipeView { id: string; name: string; blurb: string; tag: RecipeTag; group: string; graph: FlowGraph }

export async function listAutomations(db: Db, businessId: string): Promise<{ automations: AutomationView[]; templates: RecipeView[] }> {
  const rows = await db.select().from(automations).where(eq(automations.businessId, businessId)).orderBy(desc(automations.updatedAt));
  const runs = await db.select({ automationId: automationRuns.automationId, status: automationRuns.status, entity: automationRuns.entity, at: automationRuns.startedAt }).from(automationRuns).where(eq(automationRuns.businessId, businessId)).orderBy(desc(automationRuns.startedAt)).limit(500);
  const views = rows.map((a) => {
    const graph = a.graph as FlowGraph;
    const mine = runs.filter((r) => r.automationId === a.id);
    const trig = graph.nodes.find((n) => n.type === "trigger");
    return {
      id: a.id, name: a.name, status: a.status as AutomationStatus, version: a.version, graph,
      triggerTitle: trig && trig.type === "trigger" ? TRIGGER_TITLE[trig.trigger.kind] : "", editable: graphToTree(graph) !== null,
      createdBy: a.createdBy, updatedBy: a.updatedBy, updatedAt: a.updatedAt.toISOString(),
      lastRun: mine[0] ? { at: mine[0].at.toISOString(), status: mine[0].status, entity: mine[0].entity } : null,
      waiting: mine.filter((r) => r.status === "waiting").length, runs: mine.length,
    };
  });
  // Recipes are built for this business's currency, so "Use this" can open the builder already filled in.
  const [cur] = await db.select({ exp: currencies.minorUnitExponent }).from(businesses).innerJoin(currencies, eq(currencies.code, businesses.baseCurrency)).where(eq(businesses.id, businessId));
  const exp = cur?.exp ?? 2;
  const templates = AUTOMATION_TEMPLATES.flatMap((t) => { const b = buildTemplate(t.id, exp); return b ? [{ id: t.id, name: t.name, blurb: t.blurb, tag: t.tag, group: t.group, graph: b.graph }] : []; });
  return { automations: views, templates };
}

export async function createAutomation(db: Db, businessId: string, input: unknown, by: string): Promise<{ id: string; version: number }> {
  const data = automationInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`automations:${businessId}`}))`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(automations).where(eq(automations.businessId, businessId));
    if (n >= MAX_AUTOMATIONS) throw new ActionError("refused", `A business can have at most ${MAX_AUTOMATIONS} automations. Delete one first.`);
    const [r] = await tx.insert(automations).values({ businessId, name: data.name, graph: data.graph, createdBy: by, updatedBy: by }).returning({ id: automations.id });
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.AUTOMATION_CREATED, actor: "owner", detail: { automationId: r.id, version: 1, nodes: data.graph.nodes.length } });
    return { id: r.id, version: 1 };
  });
}

export async function createFromTemplate(db: Db, businessId: string, templateId: string, by: string) {
  const [b] = await db.select({ exp: currencies.minorUnitExponent }).from(businesses).innerJoin(currencies, eq(currencies.code, businesses.baseCurrency)).where(eq(businesses.id, businessId));
  if (!b) throw new ActionError("not_found", "Business not found");
  const t = buildTemplate(templateId, b.exp);
  if (!t) throw new ActionError("not_found", "Template not found");
  return createAutomation(db, businessId, t, by);
}

export async function updateAutomation(db: Db, businessId: string, id: string, input: unknown, by: string): Promise<{ id: string; version: number }> {
  const data = automationInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(automations).where(and(eq(automations.id, id), eq(automations.businessId, businessId))).for("update");
    if (!cur) throw new ActionError("not_found", "Automation not found");
    const version = cur.version + 1;
    await tx.update(automations).set({ name: data.name, graph: data.graph, version, updatedBy: by, updatedAt: new Date() }).where(eq(automations.id, id));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.AUTOMATION_UPDATED, actor: "owner", detail: { automationId: id, version, nodes: data.graph.nodes.length } });
    return { id, version };
  });
}

export async function setEnabled(db: Db, businessId: string, id: string, enabled: boolean, by: string): Promise<{ id: string; status: AutomationStatus }> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(automations).where(and(eq(automations.id, id), eq(automations.businessId, businessId))).for("update");
    if (!cur) throw new ActionError("not_found", "Automation not found");
    const status: AutomationStatus = enabled ? "enabled" : "disabled";
    if (cur.status === status) return { id, status };
    await tx.update(automations).set({ status, updatedBy: by, updatedAt: new Date() }).where(eq(automations.id, id));
    await appendRecord(tx, { businessId, event: enabled ? ACTION_EVENTS.AUTOMATION_ENABLED : ACTION_EVENTS.AUTOMATION_DISABLED, actor: "owner", detail: { automationId: id, version: cur.version } });
    return { id, status };
  });
}

export async function deleteAutomation(db: Db, businessId: string, id: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(automations).where(and(eq(automations.id, id), eq(automations.businessId, businessId))).for("update");
    if (!cur) throw new ActionError("not_found", "Automation not found");
    await tx.delete(automations).where(eq(automations.id, id));
    // Waiting runs of a deleted automation can never continue: close them so they do not look pending.
    await tx.update(automationRuns).set({ status: "stopped", finishedAt: new Date(), resumeNode: null }).where(and(eq(automationRuns.automationId, id), eq(automationRuns.status, "waiting")));
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.AUTOMATION_DELETED, actor: "owner", detail: { automationId: id, version: cur.version } });
    return { id };
  });
}

export async function listRuns(db: Db, businessId: string, automationId?: string) {
  const where = automationId ? and(eq(automationRuns.businessId, businessId), eq(automationRuns.automationId, automationId)) : eq(automationRuns.businessId, businessId);
  const rows = await db.select().from(automationRuns).where(where).orderBy(desc(automationRuns.startedAt)).limit(50);
  return {
    runs: rows.map((r) => ({
      id: r.id, automationId: r.automationId, automationName: r.automationName, version: r.version, status: r.status, entity: r.entity, day: r.day, startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null, resumeOn: r.resumeOn, results: r.results as NodeResult[], dryRun: r.dryRun,
    })),
  };
}

export async function loadAutomation(db: Db, businessId: string, id: string) {
  const [r] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.businessId, businessId)));
  if (!r) throw new ActionError("not_found", "Automation not found");
  return { id: r.id, name: r.name, graph: r.graph as FlowGraph, version: r.version, status: r.status as AutomationStatus };
}
