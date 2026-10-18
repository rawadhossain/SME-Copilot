// IN-APP NOTIFICATIONS (sandbox only: nothing is emailed or sent anywhere). A notification is addressed to one user or to a role of the business. Title and
// body come from code templates over the books; `note` is the owner's optional message from an automation, stored as data and rendered escaped.
// Reading is per recipient: a user sees what is addressed to them or to their role. The only change after insert is read_at.
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { notifications } from "@/db/schema";
import { appendRecord } from "./log";
import { ACTION_EVENTS, ActionError, type Db, type Q } from "./types";

export type NotificationKind = "notice" | "digest_item" | "digest" | "draft_reminder" | "simulation" | "plans_prepared";
export interface NewNotification { businessId: string; role: "owner" | "approver"; kind: NotificationKind; title: string; body: string; note?: string | null; link?: string; automationId?: string | null; runId?: string | null }

export async function insertNotification(q: Q, n: NewNotification): Promise<string> {
  const [row] = await q.insert(notifications).values({
    businessId: n.businessId, role: n.role, kind: n.kind, title: n.title, body: n.body, note: n.note ?? null, link: n.link ?? "/room", automationId: n.automationId ?? null, runId: n.runId ?? null,
  }).returning({ id: notifications.id });
  return row.id;
}

export interface NotificationView { id: string; kind: string; title: string; body: string; note: string | null; link: string; createdAt: string; readAt: string | null; resolution: string | null; resolvedAt: string | null; automationId: string | null }
export interface Recipient { id: string; role: "owner" | "approver" }

const mine = (businessId: string, who: Recipient) =>
  and(eq(notifications.businessId, businessId), ne(notifications.kind, "digest_item"), or(eq(notifications.userId, who.id), eq(notifications.role, who.role)));

/** The newest 40 for this person (digest items are collected for the weekly digest and are not shown on their own), and how many are unread. */
export async function listNotifications(db: Db, businessId: string, who: Recipient): Promise<{ notifications: NotificationView[]; unread: number }> {
  const rows = await db.select().from(notifications).where(mine(businessId, who)).orderBy(desc(notifications.createdAt)).limit(40);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(mine(businessId, who), isNull(notifications.readAt)));
  return {
    notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, note: r.note, link: r.link, createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null,
      resolution: r.resolution, resolvedAt: r.resolvedAt?.toISOString() ?? null, automationId: r.automationId })),
    unread: n,
  };
}

/** Mark some (or all) of this person's notifications read. Only ones addressed to them can change. */
export async function markRead(db: Db, businessId: string, who: Recipient, input: { ids?: string[]; all?: boolean }): Promise<{ marked: number }> {
  if (!input.all && !(input.ids && input.ids.length > 0)) throw new ActionError("invalid", "Say which notifications to mark read");
  const scope = input.all ? mine(businessId, who) : and(mine(businessId, who), inArray(notifications.id, input.ids!));
  const rows = await db.update(notifications).set({ readAt: new Date() }).where(and(scope, isNull(notifications.readAt))).returning({ id: notifications.id });
  return { marked: rows.length };
}

/**
 * The owner decides on a drafted reminder letter: "send" marks it sent to the SIMULATED customer (sandbox only; nothing leaves the app), "dismiss" discards it.
 * The text is the code template the automation wrote; nothing is edited here. One log record (ids only). Only the owner may call this (the route checks).
 */
export async function resolveDraft(db: Db, businessId: string, id: string, action: "send_sandbox" | "dismiss"): Promise<{ id: string; resolution: string }> {
  return db.transaction(async (tx) => {
    const [n] = await tx.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.businessId, businessId))).for("update");
    if (!n) throw new ActionError("not_found", "That draft was not found");
    if (n.kind !== "draft_reminder") throw new ActionError("invalid", "Only a drafted reminder can be sent or dismissed here");
    if (n.resolvedAt) throw new ActionError("conflict", "You have already decided on this draft");
    const resolution = action === "send_sandbox" ? "sent_sandbox" : "dismissed";
    await tx.update(notifications).set({ resolution, resolvedAt: new Date(), readAt: n.readAt ?? new Date() }).where(eq(notifications.id, id));
    await appendRecord(tx, {
      businessId, event: action === "send_sandbox" ? ACTION_EVENTS.AUTOMATION_DRAFT_SENT : ACTION_EVENTS.AUTOMATION_DRAFT_DISMISSED, actor: "owner",
      detail: { notificationId: id, automationId: n.automationId, runId: n.runId, sandbox: true },
    });
    return { id, resolution };
  });
}
