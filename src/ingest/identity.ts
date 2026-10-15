import { createHash } from "node:crypto";

export function normaliseDescription(d: string): string {
  return d.trim().replace(/\s+/g, " ");
}

/**
 * Deterministic source identifier for a bank row (ADR-007):
 * SHA-256 of a JSON array [businessId, date, amountMinor, description, balanceMinor],
 * with the description whitespace-normalised first.
 */
export function statementRowSourceId(
  businessId: string,
  postedOn: string,
  amountMinor: bigint,
  description: string,
  balanceMinor: bigint,
): string {
  const payload = JSON.stringify([businessId, postedOn, amountMinor.toString(), normaliseDescription(description), balanceMinor.toString()]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
