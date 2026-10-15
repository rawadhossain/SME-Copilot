// Writes to the hash-chained action_records table. The database trigger assigns chain position and hashes.
import { actionRecords } from "@/db/schema";
import { toJsonValue } from "@/sandbox/proposals";
import type { ActionEvent, Actor, Q } from "./types";

export async function appendRecord(
  q: Q,
  r: { businessId: string; proposalId?: string | null; event: ActionEvent; actor: Actor; detail: unknown; verification?: "pending" | "verified" | "failed" },
) {
  const [row] = await q
    .insert(actionRecords)
    .values({
      businessId: r.businessId,
      proposalId: r.proposalId ?? null,
      event: r.event,
      actor: r.actor,
      detail: toJsonValue(r.detail) as Record<string, unknown>,
      verification: r.verification ?? "pending",
    })
    .returning({ id: actionRecords.id, chainSeq: actionRecords.chainSeq, hash: actionRecords.hash });
  return row;
}
