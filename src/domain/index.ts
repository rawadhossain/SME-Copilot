// Domain types only. Money is always integer minor units with an explicit currency.
import type { Currency, Money } from "@/lib/money";

export type Id = string;
/** ISO 8601 date (YYYY-MM-DD). */
export type IsoDate = string;
/** ISO 8601 timestamp. */
export type IsoTimestamp = string;

/** Provenance of a figure: actuals vs commitments vs estimates vs assumptions. */
export type DataKind = "actual" | "confirmed" | "estimate" | "assumption";

export interface Business {
  id: Id;
  name: string;
  baseCurrency: Currency;
  /** All demo data must be labelled synthetic. */
  isSynthetic: boolean;
  createdAt: IsoTimestamp;
}

export interface FinancialAccount {
  id: Id;
  businessId: Id;
  name: string;
  currency: Currency;
  /** Latest known balance and when it was known. */
  balance: Money;
  balanceAsOf: IsoTimestamp;
}

export interface Transaction {
  id: Id;
  businessId: Id;
  accountId: Id;
  postedOn: IsoDate;
  /** Signed: positive = money in, negative = money out. */
  amount: Money;
  description: string;
  counterpartyId?: Id;
  source: string;
  /** Deterministic de-duplication identifier. */
  sourceId?: string;
}

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export interface Invoice {
  id: Id;
  businessId: Id;
  customerId: Id;
  number: string;
  issuedOn: IsoDate;
  dueOn: IsoDate;
  amount: Money;
  status: InvoiceStatus;
}

export type BillStatus = "unpaid" | "scheduled" | "paid" | "void";

export interface Bill {
  id: Id;
  businessId: Id;
  supplierId: Id;
  reference: string;
  issuedOn: IsoDate;
  dueOn: IsoDate;
  amount: Money;
  status: BillStatus;
}

export type CommitmentFrequency = "weekly" | "fortnightly" | "monthly" | "quarterly" | "annual";

export interface RecurringCommitment {
  id: Id;
  businessId: Id;
  name: string;
  /** Signed: negative = outflow (rent, payroll), positive = inflow. */
  amount: Money;
  frequency: CommitmentFrequency;
  nextDueOn: IsoDate;
  kind: DataKind;
}

export interface ForecastRun {
  id: Id;
  businessId: Id;
  createdAt: IsoTimestamp;
  startsOn: IsoDate;
  horizonWeeks: number;
  /** Free-form description of the assumptions / scenario overlay used. */
  assumptions: string;
}

export interface ForecastLine {
  id: Id;
  businessId: Id;
  forecastRunId: Id;
  weekStart: IsoDate;
  opening: Money;
  inflow: Money;
  outflow: Money;
  closing: Money;
  kind: DataKind;
  /** Source record (invoice, bill, commitment...) this line derives from. */
  sourceRef?: string;
}

export type CounterpartyRole = "customer" | "supplier" | "lender";

export interface Counterparty {
  id: Id;
  businessId: Id;
  name: string;
  role: CounterpartyRole;
  /** Simulated counterparties are always declared as such. */
  isSimulated: boolean;
  /** Behaviour / personality settings. Empty until counterparty personalities are built. */
  profile: Record<string, unknown>;
}

/** The owner-signed limits, enforced in code by the gate. */
export interface Mandate {
  id: Id;
  businessId: Id;
  signedBy: string;
  signedAt: IsoTimestamp;
  maxDiscountBps: number;
  maxDailyOutflow: Money;
  allowNewPayees: boolean;
  allowPayroll: boolean;
  revokedAt?: IsoTimestamp;
}

export type PermissionTier = "read" | "draft" | "external" | "money";
export type ProposalStatus = "proposed" | "approved" | "rejected" | "executed" | "failed";

export interface ActionProposal {
  id: Id;
  businessId: Id;
  tool: string;
  tier: PermissionTier;
  params: Record<string, unknown>;
  mandateId?: Id;
  status: ProposalStatus;
  createdAt: IsoTimestamp;
}

export type VerificationStatus = "pending" | "verified" | "failed";

/** One append-only log entry. */
export interface ActionRecord {
  id: Id;
  businessId: Id;
  proposalId?: Id;
  event: string;
  actor: "owner" | "agent" | "gate" | "verifier" | "system";
  detail: Record<string, unknown>;
  verification: VerificationStatus;
  createdAt: IsoTimestamp;
  /** Hash chain fields, set by the database on insert. */
  chainSeq: bigint;
  prevHash: string;
  hash: string;
}

export type { Currency };
export * from "./commitment-event";
