// What the planning agent may see: a read-only snapshot prepared by the orchestrator (outside src/agent). The snapshot holds
// structured data only: no raw document text, no counterparty free text, no personality data. Tools are pure functions of it.
import type { CommitmentEvent } from "@/domain/commitment-event";
import type { Constraint } from "@/domain/constraints";
import type { FinancingOffer } from "@/domain/financing-offer";
import type { ShortageReason } from "@/domain/shortage";
import type { PlanView } from "@/domain/plan";
import type { EngineInput } from "@/engine";
import type { Parties } from "@/engine/plans/parties";
import type { GateState, SignedMandate } from "@/gate";

export interface PendingEvent {
  /** Stable handle the model uses instead of echoing event contents: pc1, pc2, ... */
  ref: string;
  extractionId: string;
  event: CommitmentEvent;
}

export interface CounterpartyRef {
  id: string;
  name: string;
  role: "customer" | "supplier" | "lender";
}

export interface ValidationNote {
  planIndex: number | null;
  accepted: boolean;
  reasons: string[];
}

export interface AgentToolContext {
  businessId: string;
  asOf: string;
  currency: string;
  /** Planning horizon in weeks (the order receipt must fall inside it). */
  horizonWeeks: number;
  input: EngineInput;
  pending: PendingEvent[];
  counterparties: CounterpartyRef[];
  parties: Parties;
  mandate: SignedMandate | null;
  gateState: GateState;
  /** Constraints learned from counterparty replies in earlier attempts (empty on the first plan). */
  constraints: Constraint[];
  /** Set when the run was started by the shortage detector: the structured reason (numbers only). */
  shortage: ShortageReason | null;
  /** Finance fee assumed when planning (basis points of the invoice). */
  financeFeeBps: number;
  /** Funding offers the owner saved (typed by the owner, validated by code). Absent or empty = the tool is not offered to the model. */
  fundingOffers?: FinancingOffer[];
  /** Numbers seen in tool results so far (digit strings); used to check model prose. */
  seen: Set<string>;
  /** Validation outcomes of submit_plans calls, in order. */
  notes: ValidationNote[];
  /** Set by the first successful submit_plans. */
  submitted: PlanView[] | null;
}
