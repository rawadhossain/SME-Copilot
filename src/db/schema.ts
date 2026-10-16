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
  // True for businesses created by check scripts and live verification. Demo pages and "latest business" helpers ignore them.
  isTest: boolean("is_test").notNull().default(false),
  // Owner setting: the cash level the owner wants to stay above (ADR-008). Same currency as base_currency.
  reserveMinor: minor("reserve_minor").notNull().default(sql`0`),
  reserveCurrency: text("reserve_currency").notNull().references(() => currencies.code),
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
    // Personality / behaviour settings for simulated counterparties. Empty for now.
    profile: jsonb("profile").notNull().default(sql`'{}'::jsonb`),
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
    source: text("source").notNull(), // seed | csv | ...
    // Deterministic identifier for de-duplication (see ADR-007). Null for manually entered rows.
    sourceId: text("source_id"),
  },
  (t) => [
    index("transactions_business_posted_idx").on(t.businessId, t.postedOn),
    uniqueIndex("transactions_business_source_id_idx").on(t.businessId, t.sourceId).where(sql`${t.sourceId} is not null`),
  ],
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
    paidOn: date("paid_on"), // when the customer paid; used to learn typical lateness
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
    paidOn: date("paid_on"),
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
    variant: text("variant").notNull().default("baseline"), // baseline | downside
    // Everything needed to reproduce the run besides the database rows: events, delay days, engine version.
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
    inputHash: text("input_hash"), // SHA-256 of engine input + parameters; identical runs are stored once
    summary: jsonb("summary"), // min balance, first breach (money as strings)
  },
  (t) => [
    index("forecast_runs_business_starts_idx").on(t.businessId, t.startsOn),
    uniqueIndex("forecast_runs_business_hash_idx").on(t.businessId, t.inputHash).where(sql`${t.inputHash} is not null`),
  ],
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

// Itemised forecast lines with provenance (the weekly rows live in forecast_lines).
export const forecastItems = pgTable(
  "forecast_items",
  {
    id: id(),
    businessId: businessId(),
    forecastRunId: uuid("forecast_run_id").notNull().references(() => forecastRuns.id),
    weekIndex: integer("week_index").notNull(),
    occursOn: date("occurs_on").notNull(),
    currency: currency(),
    amountMinor: minor("amount_minor").notNull(), // signed
    kind: dataKind("kind").notNull(), // actual | confirmed | estimate | assumption
    sourceType: text("source_type").notNull(), // invoice | bill | commitment | pattern_invoice | pattern_bill | event
    sourceId: text("source_id").notNull(),
    label: text("label").notNull(),
    note: text("note"),
  },
  (t) => [index("forecast_items_business_run_idx").on(t.businessId, t.forecastRunId, t.weekIndex)],
);

// ---------- Owner-signed mandates and the action pipeline (ADR-010, ADR-011) ----------
// The mandate is stored as canonical JSON text plus the owner's Ed25519 signature over exactly that text.
export const mandates = pgTable(
  "mandates",
  {
    id: id(),
    businessId: businessId(),
    version: integer("version").notNull(),
    canonical: text("canonical").notNull(),
    signature: text("signature").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    index("mandates_business_active_idx").on(t.businessId, t.active),
    uniqueIndex("mandates_business_version_idx").on(t.businessId, t.version),
  ],
);

export const actionProposals = pgTable(
  "action_proposals",
  {
    id: id(),
    businessId: businessId(),
    kind: text("kind").notNull(), // sandbox.send_proposal | sandbox.schedule_payment | sandbox.submit_application | sandbox.cancel_payment
    payload: jsonb("payload").notNull(), // the exact request, money as strings
    payloadHash: text("payload_hash").notNull(), // SHA-256 of the canonical payload
    // proposed | denied | approved | executing | executed | verified | failed | verification_failed | cancelled | expired
    status: text("status").notNull(),
    gateResult: jsonb("gate_result").notNull(),
    result: jsonb("result"), // execution and verification outcome
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(), // agent | owner | seed
    // Set when the action is covered by an owner-signed plan authorisation instead of its own approval (ADR-016).
    authorisationId: uuid("authorisation_id"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("action_proposals_business_created_idx").on(t.businessId, t.createdAt),
    uniqueIndex("action_proposals_business_key_idx").on(t.businessId, t.idempotencyKey),
  ],
);

// An approval is bound to one exact payload (payload_hash), signed by the owner, and single use.
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    businessId: businessId(),
    proposalId: uuid("proposal_id").notNull().references(() => actionProposals.id),
    payloadHash: text("payload_hash").notNull(),
    confirmations: smallint("confirmations").notNull(), // 1 or 2
    approvedBy: text("approved_by").notNull(),
    signed: text("signed").notNull(), // Ed25519 signature over {proposalId, payloadHash, confirmations}
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("approvals_business_proposal_idx").on(t.businessId, t.proposalId)],
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

// ---------- Sandbox world (ADR-009). Normal mutable state; separate from the seeded books. ----------
export const sandboxBankAccounts = pgTable(
  "sandbox_bank_accounts",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    currency: currency(),
    balanceMinor: minor("balance_minor").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sandbox_bank_accounts_business_idx").on(t.businessId)],
);

export const sandboxPayees = pgTable(
  "sandbox_payees",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    accountRef: text("account_ref").notNull(), // fake account reference
    approved: boolean("approved").notNull().default(false),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id),
    createdVia: text("created_via").notNull(), // seed | agent
    bankDetailsHash: text("bank_details_hash").notNull(), // SHA-256 of name + account_ref, to detect later changes
  },
  (t) => [index("sandbox_payees_business_idx").on(t.businessId)],
);

export const sandboxPayments = pgTable(
  "sandbox_payments",
  {
    id: id(),
    businessId: businessId(),
    bankAccountId: uuid("bank_account_id").notNull().references(() => sandboxBankAccounts.id),
    payeeId: uuid("payee_id").notNull().references(() => sandboxPayees.id),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency(),
    scheduledFor: date("scheduled_for").notNull(),
    status: text("status").notNull(), // scheduled | executed | failed | cancelled
    failureReason: text("failure_reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    reference: text("reference").notNull(),
    createdAt: createdAt(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => [
    index("sandbox_payments_business_due_idx").on(t.businessId, t.scheduledFor),
    uniqueIndex("sandbox_payments_business_key_idx").on(t.businessId, t.idempotencyKey),
  ],
);

export const sandboxThreads = pgTable(
  "sandbox_threads",
  {
    id: id(),
    businessId: businessId(),
    counterpartyId: uuid("counterparty_id").notNull().references(() => counterparties.id),
    topic: text("topic").notNull(), // the proposal kind, e.g. supplier.reduce_deposit
    status: text("status").notNull(), // open | agreed | countered | rejected
    agreedTerms: jsonb("agreed_terms"),
    createdAt: createdAt(),
  },
  (t) => [index("sandbox_threads_business_cp_idx").on(t.businessId, t.counterpartyId, t.createdAt)],
);

export const sandboxMessages = pgTable(
  "sandbox_messages",
  {
    id: id(),
    businessId: businessId(),
    threadId: uuid("thread_id").notNull().references(() => sandboxThreads.id),
    counterpartyId: uuid("counterparty_id").notNull().references(() => counterparties.id),
    direction: text("direction").notNull(), // outbound | inbound
    kind: text("kind").notNull(), // proposal | response | notice
    body: text("body").notNull(),
    structured: jsonb("structured").notNull(),
    // Every inbound message is untrusted text: data, never instructions. Enforced by a CHECK constraint.
    untrusted: boolean("untrusted").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sandbox_messages_business_thread_idx").on(t.businessId, t.threadId, t.createdAt)],
);

export const sandboxApplications = pgTable(
  "sandbox_applications",
  {
    id: id(),
    businessId: businessId(),
    lenderId: uuid("lender_id").notNull().references(() => counterparties.id),
    kind: text("kind").notNull(), // invoice_finance
    requestedAmountMinor: minor("requested_amount_minor").notNull(),
    currency: currency(),
    status: text("status").notNull(), // submitted | offered | declined
    offer: jsonb("offer"),
    reference: text("reference").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sandbox_applications_business_idx").on(t.businessId, t.createdAt),
    uniqueIndex("sandbox_applications_business_key_idx").on(t.businessId, t.idempotencyKey),
  ],
);

// Scheduled money coming in (ADR-019). Credited to the bank by the bank's own end-of-day job, never by the pipeline directly.
// A receipt is "backed" by an agreed thread or an accepted application; the gate counts only backed receipts in its projection.
export const sandboxReceipts = pgTable(
  "sandbox_receipts",
  {
    id: id(),
    businessId: businessId(),
    bankAccountId: uuid("bank_account_id").notNull().references(() => sandboxBankAccounts.id),
    counterpartyId: uuid("counterparty_id").notNull().references(() => counterparties.id),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency(),
    expectedOn: date("expected_on", { mode: "string" }).notNull(),
    status: text("status").notNull(), // scheduled | received | cancelled
    backingType: text("backing_type").notNull(), // thread | application
    backingId: uuid("backing_id").notNull(),
    reference: text("reference").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("sandbox_receipts_business_idx").on(t.businessId, t.expectedOn),
    uniqueIndex("sandbox_receipts_business_key_idx").on(t.businessId, t.idempotencyKey),
  ],
);

// ---------- LLM telemetry, documents and extractions (ADR-012, ADR-013) ----------
// llm_calls is operational telemetry, NOT the hash-chained action log. It never stores document text or secrets.
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: id(),
    businessId: uuid("business_id").references(() => businesses.id), // nullable: smoke tests and non-business calls
    purpose: text("purpose").notNull(),
    mode: text("mode").notNull(), // live | record | replay | mock
    model: text("model").notNull(),
    requestHash: text("request_hash").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_business_created_idx").on(t.businessId, t.createdAt)],
);

// Documents are insert-only (no UPDATE or DELETE grant).
export const documents = pgTable(
  "documents",
  {
    id: id(),
    businessId: businessId(),
    filename: text("filename").notNull(),
    kind: text("kind").notNull(), // purchase_order | supplier_quote | other
    text: text("text").notNull(), // untrusted content
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("documents_business_created_idx").on(t.businessId, t.createdAt)],
);

export const extractions = pgTable(
  "extractions",
  {
    id: id(),
    businessId: businessId(),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    status: text("status").notNull(), // pending_confirmation | confirmed | rejected | failed
    result: jsonb("result").notNull(),
    flags: jsonb("flags").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: createdAt(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
  },
  (t) => [index("extractions_business_created_idx").on(t.businessId, t.createdAt)],
);

// ---------- Planning agent runs (ADR-015). Operational records of reading and proposing; nothing here executes. ----------
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    businessId: businessId(),
    trigger: jsonb("trigger").notNull(),
    status: text("status").notNull(), // running | completed | failed | refused
    model: text("model").notNull().default(""),
    mode: text("mode").notNull().default(""),
    planSource: text("plan_source"), // ai | deterministic | none
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    // Re-planning (ADR-021): the run this one re-plans, its round (0 = first plan), the structured constraints it was given,
    // where the run stands, and the run that superseded it.
    parentRunId: uuid("parent_run_id"),
    round: integer("round").notNull().default(0),
    constraints: jsonb("constraints").notNull().default(sql`'[]'::jsonb`),
    lifecycle: text("lifecycle").notNull().default("planned"), // planned | needs_replan | replanned | exhausted | executed | verification_failed
    successorRunId: uuid("successor_run_id"),
  },
  (t) => [index("agent_runs_business_started_idx").on(t.businessId, t.startedAt)],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: id(),
    businessId: businessId(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(), // llm_message | tool_call | tool_result | validation | note
    payload: jsonb("payload").notNull(), // structured data only: never raw document text or counterparty free text
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_steps_business_run_seq_idx").on(t.businessId, t.runId, t.seq)],
);

export const plans = pgTable(
  "plans",
  {
    id: id(),
    businessId: businessId(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    planHash: text("plan_hash").notNull(), // deterministic hash of the sorted levers
    rank: integer("rank").notNull(),
    plan: jsonb("plan").notNull(),
    status: text("status").notNull().default("proposed"), // proposed | superseded | rejected
    createdAt: createdAt(),
  },
  (t) => [index("plans_business_run_rank_idx").on(t.businessId, t.runId, t.rank)],
);

// ---------- Owner-signed plan authorisation and its execution (ADR-016, ADR-017). ----------
// An authorisation binds one plan (levers hash), its exact requests and bounds (terms hash), an expiry and the mandate
// version and hash. The signature covers those fields (see src/gate/owner-signing-types.ts).
export const planAuthorisations = pgTable(
  "plan_authorisations",
  {
    id: id(),
    businessId: businessId(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    planId: text("plan_id").notNull(), // plans.plan_hash
    leversHash: text("levers_hash").notNull(),
    terms: jsonb("terms").notNull(), // levers, exact requests and acceptance bounds, money as strings
    termsHash: text("terms_hash").notNull(),
    mandateVersion: integer("mandate_version").notNull(),
    mandateHash: text("mandate_hash").notNull(),
    status: text("status").notNull(), // proposed | denied | authorised | used | expired
    gateResult: jsonb("gate_result").notNull(),
    signature: text("signature"),
    approvedBy: text("approved_by"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    // Batch 14: the proposal letters the owner approved (per counterparty, plain text) and the drawn signature. Both are set when the
    // authorisation is created; their SHA-256 hashes are part of the owner-signed message, so neither can change afterwards.
    letters: jsonb("letters"),
    lettersHash: text("letters_hash"),
    signatureImage: text("signature_image"),
    signatureHash: text("signature_hash"),
  },
  (t) => [index("plan_authorisations_business_idx").on(t.businessId, t.createdAt)],
);

export const planExecutions = pgTable(
  "plan_executions",
  {
    id: id(),
    businessId: businessId(),
    authorisationId: uuid("authorisation_id").notNull().references(() => planAuthorisations.id),
    // running | completed | needs_replan | rolled_back | failed | verification_failed | refused
    status: text("status").notNull(),
    outcome: jsonb("outcome").notNull(), // per-lever branch results (structured only; counterparty free text is not copied here)
    verification: jsonb("verification"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [uniqueIndex("plan_executions_authorisation_idx").on(t.authorisationId)],
);

// ---------- Owner login (Batch 10). Passwords are scrypt hashes; sessions are random tokens stored only as SHA-256. ----------
export const ownerUsers = pgTable(
  "owner_users",
  {
    id: id(),
    businessId: businessId(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull(), // owner | approver (the second approver for two-confirmation signing)
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("owner_users_email_idx").on(t.email)],
);

export const ownerSessions = pgTable(
  "owner_sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => ownerUsers.id),
    businessId: businessId(), // the business this session is working in (the user's own, or a flagged demo clone)
    tokenHash: text("token_hash").notNull(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("owner_sessions_token_idx").on(t.tokenHash)],
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: id(),
    key: text("key").notNull(), // email|ip
    ok: boolean("ok").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_key_idx").on(t.key, t.at)],
);

// ---------- Funding offers typed by the owner (Phase K) ----------
// The validated offer (money as integer strings) plus the owner's form, so the page can show it again. Replaced as a set: saving archives the
// previous active offers. Append-style: the app role can only set archived_at after insert.
export const fundingOffers = pgTable(
  "funding_offers",
  {
    id: id(),
    businessId: businessId(),
    label: text("label").notNull(),
    offer: jsonb("offer").notNull(),
    form: jsonb("form").notNull(),
    offerHash: text("offer_hash").notNull(),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("funding_offers_business_idx").on(t.businessId, t.createdAt),
    uniqueIndex("funding_offers_active_label_idx").on(t.businessId, t.label).where(sql`${t.archivedAt} is null`),
  ],
);
