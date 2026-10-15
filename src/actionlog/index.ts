// The action log (append-only, hash-chained by database triggers). Everything that must be evidenced is written here:
// proposals, gate decisions, approvals, executions, verifications, document confirmations and security findings.
// Event names are defined once, in src/actions/types.ts (ACTION_EVENTS).
export { appendRecord as appendActionRecord } from "@/actions/log";
export { ACTION_EVENTS } from "@/actions/types";

export interface ActionLog {
  /** Append only. No update or delete methods, by design. */
  append(event: string, detail: unknown): Promise<void>;
}
