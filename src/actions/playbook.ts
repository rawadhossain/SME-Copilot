// Owner playbook: read and save. Only the owner route saves; planning (buildContext), plan authorisation and the shortage check READ it. The gate does not.
import { eq, sql } from "drizzle-orm";
import { playbookSettings } from "@/db/schema";
import { changedKeys, DEFAULT_PLAYBOOK, parsePlaybook, playbookSchema, type Playbook } from "@/domain/playbook";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

export interface PlaybookInfo { settings: Playbook; version: number; updatedBy: string | null; updatedAt: string | null; defaults: Playbook }

export async function loadPlaybook(db: Db, businessId: string): Promise<Playbook> {
  const [row] = await db.select({ settings: playbookSettings.settings }).from(playbookSettings).where(eq(playbookSettings.businessId, businessId));
  return row ? parsePlaybook(row.settings) : DEFAULT_PLAYBOOK;
}

export async function getPlaybook(db: Db, businessId: string): Promise<PlaybookInfo> {
  const [row] = await db.select().from(playbookSettings).where(eq(playbookSettings.businessId, businessId));
  return { settings: row ? parsePlaybook(row.settings) : DEFAULT_PLAYBOOK, version: row?.version ?? 0, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt.toISOString() ?? null, defaults: DEFAULT_PLAYBOOK };
}

/** Saves the whole playbook. No change = no new version and no log record. One log record per real save: version and changed keys only. */
export async function savePlaybook(db: Db, businessId: string, input: unknown, actorName: string): Promise<PlaybookInfo> {
  const parsed = playbookSchema.safeParse(input);
  if (!parsed.success) throw new ActionError("invalid", parsed.error.issues.map((i) => i.message).join(" "));
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`playbook:${businessId}`}))`);
    const [row] = await tx.select().from(playbookSettings).where(eq(playbookSettings.businessId, businessId));
    const before = row ? parsePlaybook(row.settings) : DEFAULT_PLAYBOOK;
    const changed = changedKeys(before, parsed.data);
    if (changed.length === 0) return;
    const version = (row?.version ?? 0) + 1;
    if (row) await tx.update(playbookSettings).set({ settings: parsed.data, version, updatedBy: actorName, updatedAt: new Date() }).where(eq(playbookSettings.businessId, businessId));
    else await tx.insert(playbookSettings).values({ businessId, settings: parsed.data, version, updatedBy: actorName });
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.PLAYBOOK_UPDATED, actor: "owner", detail: { version, changed } });
  });
  return getPlaybook(db, businessId);
}
