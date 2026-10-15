// Read-only views: the action list with timelines, the mandate status, and the evidence export.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { actionProposals, actionRecords, approvals, mandates } from "@/db/schema";
import { checkSignedMandate } from "@/gate";
import { toJsonValue } from "@/sandbox/proposals";
import type { Db } from "./types";

export async function listActions(db: Db, businessId: string, limit = 50) {
  const proposals = await db.select().from(actionProposals).where(eq(actionProposals.businessId, businessId)).orderBy(desc(actionProposals.createdAt), desc(actionProposals.id)).limit(limit);
  const records = await db.select().from(actionRecords).where(eq(actionRecords.businessId, businessId)).orderBy(asc(actionRecords.chainSeq));
  const apps = await db.select().from(approvals).where(eq(approvals.businessId, businessId));
  return toJsonValue(
    proposals.map((p) => ({
      ...p,
      approval: apps.filter((a) => a.proposalId === p.id).map((a) => ({ id: a.id, approvedBy: a.approvedBy, confirmations: a.confirmations, usedAt: a.usedAt, payloadHash: a.payloadHash })).at(-1) ?? null,
      timeline: records.filter((r) => r.proposalId === p.id).map((r) => ({ chainSeq: r.chainSeq, event: r.event, actor: r.actor, detail: r.detail, verification: r.verification, createdAt: r.createdAt })),
    })),
  ) as ActionView[];
}

export interface ActionView {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  gateResult: { decision: string; tier: string; reasons: string[]; limitsChecked: { limit: string; value: string; bound: string; ok: boolean }[]; requiresSecondConfirmation: boolean };
  result: Record<string, unknown> | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  approval: { id: string; approvedBy: string; confirmations: number; usedAt: string | null; payloadHash: string } | null;
  timeline: { chainSeq: string; event: string; actor: string; detail: Record<string, unknown>; verification: string; createdAt: string }[];
}

export async function getMandateInfo(db: Db, businessId: string) {
  const [row] = await db.select().from(mandates).where(and(eq(mandates.businessId, businessId), eq(mandates.active, true))).orderBy(desc(mandates.version)).limit(1);
  if (!row) return { present: false as const };
  const check = checkSignedMandate({ canonical: row.canonical, signature: row.signature });
  return toJsonValue({
    present: true as const,
    version: row.version,
    signedAt: row.signedAt,
    signatureValid: check.ok,
    reason: check.ok ? null : check.reason,
    mandate: JSON.parse(row.canonical) as unknown, // wire form: money as strings
    signature: row.signature,
  }) as MandateInfo;
}

export type MandateInfo =
  | { present: false }
  | { present: true; version: number; signedAt: string; signatureValid: boolean; reason: string | null; mandate: { version: number; businessId: string; issuedAt: string; expiresAt: string; currency: string; limits: Record<string, unknown> }; signature: string };

/** Evidence export: all log records in chain order, the chain head, and an independent check of the chain. */
export async function getEvidence(db: Db, businessId: string) {
  const rows = (await db.execute(sql`
    SELECT id, proposal_id, event, actor, detail, verification, created_at, chain_seq::text AS chain_seq, prev_hash, hash, action_record_canonical(r) AS canonical
    FROM action_records r WHERE business_id = ${businessId} ORDER BY r.chain_seq`)) as unknown as {
    id: string; proposal_id: string | null; event: string; actor: string; detail: unknown; verification: string; created_at: string | Date; chain_seq: string; prev_hash: string; hash: string; canonical: string;
  }[];
  let prev = "0".repeat(64);
  let expect = 0n;
  let brokenAt: string | null = null;
  for (const r of rows) {
    expect += 1n;
    const sha = createHash("sha256").update(r.canonical, "utf8").digest("hex");
    if (BigInt(r.chain_seq) !== expect || r.prev_hash !== prev || r.hash !== sha) {
      brokenAt = r.chain_seq;
      break;
    }
    prev = r.hash;
  }
  const last = rows.at(-1);
  return toJsonValue({
    businessId,
    count: rows.length,
    head: last ? { chainSeq: last.chain_seq, hash: last.hash } : null,
    chain: { ok: brokenAt === null, brokenAt },
    note: "Compare head.hash and count with an earlier export to detect that the newest records were removed (the chain alone cannot show that).",
    records: rows.map((r) => ({ chainSeq: r.chain_seq, id: r.id, proposalId: r.proposal_id, event: r.event, actor: r.actor, detail: r.detail, verification: r.verification, createdAt: r.created_at, prevHash: r.prev_hash, hash: r.hash, canonical: r.canonical })),
  });
}
