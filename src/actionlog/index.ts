// Placeholder for the append-only action log.
import type { ActionRecord } from "@/domain";

export interface ActionLog {
  /** Append only. No update or delete methods, by design. */
  append(record: ActionRecord): Promise<void>;
}
