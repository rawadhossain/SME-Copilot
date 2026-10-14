import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Money columns: bigint minor units (mode "bigint") with a currency column beside them,
// referencing the currencies table. Every business-scoped table has business_id.
const minor = (name: string) => bigint(name, { mode: "bigint" });
const currency = () => text("currency").notNull().references(() => currencies.code);
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const businessId = () => uuid("business_id").notNull().references(() => businesses.id);

export const dataKind = pgEnum("data_kind", ["actual", "confirmed", "estimate", "assumption"]);
export const counterpartyRole = pgEnum("counterparty_role", ["customer", "supplier", "lender"]);
export const permissionTier = pgEnum("permission_tier", ["read", "draft", "external", "money"]);

/** Reference data: ISO 4217 code and minor-unit exponent (2 for GBP, 0 for JPY). */
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  minorUnitExponent: smallint("minor_unit_exponent").notNull(),
  name: text("name").notNull(),
});

export const businesses = pgTable("businesses", {
  id: id(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().references(() => currencies.code),
  isSynthetic: boolean("is_synthetic").notNull().default(true),
  createdAt: createdAt(),
});

export const financialAccounts = pgTable(
  "financial_accounts",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    currency: currency(),
    balanceMinor: minor("balance_minor").notNull(),
    balanceAsOf: timestamp("balance_as_of", { withTimezone: true }).notNull(),
  },
  (t) => [index("financial_accounts_business_idx").on(t.businessId)],
);

export const counterparties = pgTable(
  "counterparties",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    role: counterpartyRole("role").notNull(),
    isSimulated: boolean("is_simulated").notNull().default(true),
  },
  (t) => [index("counterparties_business_idx").on(t.businessId)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    businessId: businessId(),
    accountId: uuid("account_id").notNull().references(() => financialAccounts.id),
    postedOn: date("posted_on").notNull(),
    amountMinor: minor("amount_minor").notNull(), // signed
    currency: currency(),
    description: text("description").notNull(),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id),
    source: text("source").notNull(),
  },
  (t) => [index("transactions_business_posted_idx").on(t.businessId, t.postedOn)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    businessId: businessId(),
    customerId: uuid("customer_id").notNull().references(() => counterparties.id),
    number: text("number").notNull(),
    issuedOn: date("issued_on").notNull(),
    dueOn: date("due_on").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency(),
    status: text("status").notNull(), // draft | sent | paid | overdue | void
  },
  (t) => [index("invoices_business_due_idx").on(t.businessId, t.dueOn)],
);

export const bills = pgTable(
  "bills",
  {
    id: id(),
    businessId: businessId(),
    supplierId: uuid("supplier_id").notNull().references(() => counterparties.id),
    reference: text("reference").notNull(),
    issuedOn: date("issued_on").notNull(),
    dueOn: date("due_on").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency(),
    status: text("status").notNull(), // unpaid | scheduled | paid | void
  },
  (t) => [index("bills_business_due_idx").on(t.businessId, t.dueOn)],
);

export const recurringCommitments = pgTable(
  "recurring_commitments",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    amountMinor: minor("amount_minor").notNull(), // signed
    currency: currency(),
    frequency: text("frequency").notNull(), // weekly | fortnightly | monthly | quarterly | annual
    nextDueOn: date("next_due_on").notNull(),
    kind: dataKind("kind").notNull(),
  },
  (t) => [index("recurring_commitments_business_due_idx").on(t.businessId, t.nextDueOn)],
);

export const forecastRuns = pgTable(
  "forecast_runs",
  {
    id: id(),
    businessId: businessId(),
    createdAt: createdAt(),
    startsOn: date("starts_on").notNull(),
    horizonWeeks: integer("horizon_weeks").notNull(),
    assumptions: text("assumptions").notNull().default(""),
  },
  (t) => [index("forecast_runs_business_starts_idx").on(t.businessId, t.startsOn)],
);

export const forecastLines = pgTable(
  "forecast_lines",
  {
    id: id(),
    businessId: businessId(),
    forecastRunId: uuid("forecast_run_id").notNull().references(() => forecastRuns.id),
    weekStart: date("week_start").notNull(),
    currency: currency(),
    openingMinor: minor("opening_minor").notNull(),
    inflowMinor: minor("inflow_minor").notNull(),
    outflowMinor: minor("outflow_minor").notNull(),
    closingMinor: minor("closing_minor").notNull(),
    kind: dataKind("kind").notNull(),
    sourceRef: text("source_ref"),
  },
  (t) => [index("forecast_lines_business_week_idx").on(t.businessId, t.weekStart)],
);

export const mandates = pgTable(
  "mandates",
  {
    id: id(),
    businessId: businessId(),
    signedBy: text("signed_by").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    maxDiscountBps: integer("max_discount_bps").notNull(),
    maxDailyOutflowMinor: minor("max_daily_outflow_minor").notNull(),
    currency: currency(),
    allowNewPayees: boolean("allow_new_payees").notNull().default(false),
    allowPayroll: boolean("allow_payroll").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("mandates_business_signed_idx").on(t.businessId, t.signedAt)],
);

export const actionProposals = pgTable(
  "action_proposals",
  {
    id: id(),
    businessId: businessId(),
    tool: text("tool").notNull(),
    tier: permissionTier("tier").notNull(),
    params: jsonb("params").notNull(),
    mandateId: uuid("mandate_id").references(() => mandates.id),
    status: text("status").notNull(), // proposed | approved | rejected | executed | failed
    createdAt: createdAt(),
  },
  (t) => [index("action_proposals_business_created_idx").on(t.businessId, t.createdAt)],
);

// Append-only and hash-chained. prev_hash and hash are computed by a BEFORE INSERT trigger
// (see migration 0001); never supply them from the app. UPDATE/DELETE/TRUNCATE are blocked.
export const actionRecords = pgTable(
  "action_records",
  {
    id: id(),
    businessId: businessId(),
    proposalId: uuid("proposal_id").references(() => actionProposals.id),
    event: text("event").notNull(),
    actor: text("actor").notNull(), // owner | agent | gate | verifier | system
    detail: jsonb("detail").notNull(),
    verification: text("verification").notNull().default("pending"),
    createdAt: createdAt(),
    chainSeq: bigint("chain_seq", { mode: "bigint" }).notNull().default(sql`0`), // per-business position, set by trigger
    prevHash: text("prev_hash").notNull().default(""), // set by trigger
    hash: text("hash").notNull().default(""), // set by trigger
  },
  (t) => [
    index("action_records_business_created_idx").on(t.businessId, t.createdAt),
    uniqueIndex("action_records_business_chain_idx").on(t.businessId, t.chainSeq),
  ],
);
