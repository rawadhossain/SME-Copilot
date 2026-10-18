// BASELINE: the same requests applied by an executor with the permission gate REMOVED.
// A test double that lives only in scripts/. It is not part of the product and nothing under src/ offers a way around the gate: this file calls the
// sandbox operations directly, with no mandate, no limits, no approval and no log, the way a naive executor that trusts its caller would.
// (ESLint only restricts sandbox writes in src/app and src/agent; scripts/ is not restricted, so no rule is disabled for this.)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { executeDuePayments, schedulePayment, sendProposal, submitApplication } from "../../src/sandbox";
import type { Baseline } from "./types";

export const BASELINE_LABEL = "Baseline: the same requests applied by an executor with the permission gate removed. A test double in scripts/, not part of the product.";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 140);

/** Schedules the payment and lets the bank process it, with no gate. Reports how much left the bank. */
export async function payWithoutGate(h: any, cloneId: string, payeeId: string, amountMinor: bigint, scheduledFor: string, key = h.key()): Promise<Baseline> {
  const before: bigint = await h.bankMinor(cloneId);
  try {
    await schedulePayment(h.db, cloneId, payeeId, amountMinor, "GBP", scheduledFor, key);
    await executeDuePayments(h.db, cloneId, scheduledFor);
  } catch (e) {
    const moved: bigint = before - ((await h.bankMinor(cloneId)) as bigint);
    return { outcome: moved > 0n ? "moved" : "none", movedMinor: moved, note: `the sandbox itself said: ${msg(e)}` };
  }
  const moved: bigint = before - ((await h.bankMinor(cloneId)) as bigint);
  return { outcome: moved > 0n ? "moved" : "none", movedMinor: moved, note: moved > 0n ? "the payment left the bank" : "scheduled, but no money left the bank" };
}

/** Sends a counterparty proposal with no gate (no money moves; it commits the business to terms). */
export async function proposeWithoutGate(h: any, cloneId: string, counterpartyId: string, proposal: unknown): Promise<Baseline> {
  try {
    const r = await sendProposal(h.db, cloneId, counterpartyId, proposal);
    return { outcome: "none", movedMinor: 0n, note: `the proposal was sent to the counterparty (answer: ${String((r as any).response?.outcome ?? (r as any).thread?.status ?? "sent")}); no money moved, but the business is now negotiating terms the owner never allowed` };
  } catch (e) {
    return { outcome: "none", movedMinor: 0n, note: `the sandbox itself said: ${msg(e)}` };
  }
}

/** Applies for invoice finance with no gate. */
export async function applyWithoutGate(h: any, cloneId: string, lenderId: string, invoiceAmountMinor: bigint, advanceBps: number): Promise<Baseline> {
  try {
    const r: any = await submitApplication(h.db, cloneId, lenderId, invoiceAmountMinor, advanceBps, h.key());
    return { outcome: "none", movedMinor: 0n, note: `the application was submitted (lender answer: ${String(r.application?.status ?? "sent")}); no money moved by the application itself` };
  } catch (e) {
    return { outcome: "none", movedMinor: 0n, note: `the sandbox itself said: ${msg(e)}` };
  }
}
