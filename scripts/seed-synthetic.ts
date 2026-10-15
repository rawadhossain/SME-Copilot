// Deterministic synthetic company seed. SYNTHETIC DATA ONLY. Refuses to run against a non-local database.
//   bun run db:seed         seed if not already seeded (idempotent)
//   bun run db:reset-seed   delete the seeded business, then seed again
// The data depends only on the fixed PRNG seed and the "as of" date (today in local time, or SEED_AS_OF=YYYY-MM-DD).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema";
import { toCsvLine } from "../src/ingest/csv";
import { statementRowSourceId } from "../src/ingest/identity";
import { formatDecimal, formatMoney, money, multiplyRatio } from "../src/lib/money";
import { makeInjectedPurchaseOrder } from "../src/ingest/documents/fixtures";
import { SEED_PERSONALITIES } from "../src/sandbox/personalities";
import { PROPOSAL_KINDS, type MandateWire } from "../src/gate/mandate";
import { signMandate } from "../src/gate/owner-signing";

const PRNG_SEED = 876940;
const CURRENCY = "GBP";
const EXP = 2;
const BUSINESS_NAME = "Mercer & Vale Packaging Ltd (SYNTHETIC)";
const TARGET_BALANCE = 4_200_000n; // GBP 42,000.00
const RESERVE = 2_800_000n; // GBP 28,000.00 = one fortnightly payroll

// ---------- safety ----------
function assertLocal(label: string, url: string | undefined): string {
  if (!url) throw new Error(`${label} is not set`);
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing to seed: ${label} points at "${host}", not a local database`);
  }
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed with NODE_ENV=production");
  return url;
}

// ---------- deterministic integer PRNG (mulberry32, uint32 output; no floats) ----------
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (lo: number, hi: number): number => lo + (next() % (hi - lo + 1));
  return { next, int };
}
const rng = makeRng(PRNG_SEED);
/** Random bigint in [lo, hi] using two uint32 draws (enough range for these amounts). */
function randMinor(lo: bigint, hi: bigint): bigint {
  const r = (BigInt(rng.next()) << 32n) | BigInt(rng.next());
  return lo + (r % (hi - lo + 1n));
}
function uuid(): string {
  const h = [rng.next(), rng.next(), rng.next(), rng.next()].map((n) => n.toString(16).padStart(8, "0")).join("");
  const v = h.slice(0, 12) + "4" + h.slice(13, 16) + "89ab"[parseInt(h[16], 16) % 4] + h.slice(17, 32);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** Deterministic uuid derived from a label, without touching the main PRNG stream (keeps the tuned history unchanged). */
function detUuid(label: string): string {
  const h = createHash("sha256").update(`seed:${PRNG_SEED}:${label}`).digest("hex");
  const v = h.slice(0, 12) + "4" + h.slice(13, 16) + "89ab"[parseInt(h[16], 16) % 4] + h.slice(17, 32);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

// ---------- dates (ISO strings, UTC) ----------
const MS_DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const addDays = (iso: string, n: number) => new Date(toMs(iso) + n * MS_DAY).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / MS_DAY);
const dom = (iso: string) => Number(iso.slice(8, 10));
const dow = (iso: string) => new Date(toMs(iso)).getUTCDay();
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const ANCHOR = process.env.SEED_AS_OF ?? todayLocal();
if (!/^\d{4}-\d{2}-\d{2}$/.test(ANCHOR)) throw new Error("SEED_AS_OF must be YYYY-MM-DD");
const START = addDays(ANCHOR, -182); // about 6 months

function nextDayOfMonth(after: string, day: number): string {
  for (let i = 1; i <= 32; i++) {
    const d = addDays(after, i);
    if (dom(d) === day) return d;
  }
  throw new Error("unreachable");
}

// ---------- generation ----------
interface Cp { key: string; id: string; name: string; role: "customer" | "supplier" | "lender" }
interface Tx { date: string; rank: number; description: string; amount: bigint; cp?: string }

const businessId = uuid();
const accountId = uuid();
const cps: Cp[] = [
  { key: "grocer", name: "Northgate Grocers plc (SYNTHETIC)", role: "customer", id: uuid() },
  { key: "harbour", name: "Harbourline Cafes Ltd (SYNTHETIC)", role: "customer", id: uuid() },
  { key: "pennine", name: "Pennine Hospitality Supplies Ltd (SYNTHETIC)", role: "customer", id: uuid() },
  { key: "kestrel", name: "Kestrel Packaging Materials Ltd (SYNTHETIC)", role: "supplier", id: uuid() },
  { key: "clearwater", name: "Clearwater Business Finance Ltd (SYNTHETIC)", role: "lender", id: uuid() },
  // Hostile small customer for later security demos. No invoices. Its id does not use the main PRNG.
  { key: "quickbuy", name: "Quickbuy Retail Ltd (SYNTHETIC)", role: "customer", id: detUuid("cp:quickbuy") },
];
const PROFILES = SEED_PERSONALITIES; // simulated counterparty personalities (src/sandbox/personalities.ts)
const cp = (k: string) => cps.find((c) => c.key === k)!;
const pounds = (p: number, pence = 0) => BigInt(p) * 100n + BigInt(pence);

const txs: Tx[] = [];
interface Inv { id: string; cp: string; number: string; issuedOn: string; dueOn: string; amount: bigint; status: string; paidOn: string | null }
interface Bill { id: string; cp: string; reference: string; issuedOn: string; dueOn: string; amount: bigint; status: string; paidOn: string | null }
const invoices: Inv[] = [];
const bills: Bill[] = [];

// Customers. Schedules run backwards from the as-of date so the book at the as-of date is controlled:
// the grocery chain (Northgate) pays about 11 days late, the smaller customers a few days late.
// An invoice that is past due but unpaid at the as-of date would be "overdue"; the only overdue invoices are
// the three planted below, so natural late payers are clamped to "paid on the as-of date" instead.
const customers = [
  { key: "grocer", every: 28, lastIssueAgo: 26, lo: pounds(59263), hi: pounds(74603), terms: 30, lateLo: 10, lateHi: 12, label: "Northgate Grocers" },
  { key: "harbour", every: 21, lastIssueAgo: 2, lo: pounds(15853), hi: pounds(28620), terms: 30, lateLo: 1, lateHi: 4, label: "Harbourline Cafes" },
  { key: "pennine", every: 14, lastIssueAgo: 5, lo: pounds(7913), hi: pounds(12352), terms: 14, lateLo: 0, lateHi: 3, label: "Pennine Hospitality" },
];
// Planted overdue invoices from the smaller customers (not Northgate): days overdue at the as-of date.
const overdueInvoices = [
  { cp: "harbour", daysOverdue: 41, terms: 30, amount: pounds(13400) },
  { cp: "pennine", daysOverdue: 25, terms: 14, amount: pounds(9750) },
  { cp: "harbour", daysOverdue: 12, terms: 30, amount: pounds(10200) },
];
let invNo = 1000;
const invoiceDrafts: { cp: string; issuedOn: string; dueOn: string; amount: bigint; paidOn: string | null }[] = [];
for (const c of customers) {
  for (let issued = addDays(ANCHOR, -c.lastIssueAgo); issued >= addDays(START, -100); issued = addDays(issued, -c.every)) {
    const dueOn = addDays(issued, c.terms);
    let paidOn: string | null = addDays(dueOn, rng.int(c.lateLo, c.lateHi));
    if (paidOn > ANCHOR && dueOn < ANCHOR) paidOn = ANCHOR; // late payer who has just paid, not an overdue invoice
    invoiceDrafts.push({ cp: c.key, issuedOn: issued, dueOn, amount: randMinor(c.lo, c.hi), paidOn });
  }
}
for (const o of overdueInvoices) {
  const dueOn = addDays(ANCHOR, -o.daysOverdue);
  invoiceDrafts.push({ cp: o.cp, issuedOn: addDays(dueOn, -o.terms), dueOn, amount: o.amount, paidOn: null });
}
invoiceDrafts.sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.cp.localeCompare(b.cp));
for (const d of invoiceDrafts) {
  invNo++;
  const paid = d.paidOn !== null && d.paidOn <= ANCHOR;
  if (paid && d.paidOn! < START) continue; // settled before the statement window: not stored
  const status = paid ? "paid" : d.dueOn < ANCHOR ? "overdue" : "sent";
  invoices.push({ id: uuid(), cp: d.cp, number: `MV-INV-${invNo}`, issuedOn: d.issuedOn, dueOn: d.dueOn, amount: d.amount, status, paidOn: paid ? d.paidOn : null });
  if (paid) {
    const label = customers.find((c) => c.key === d.cp)!.label;
    txs.push({ date: d.paidOn!, rank: 0, description: `BACS CR ${label} MV-INV-${invNo}`, amount: d.amount, cp: d.cp });
  }
}

// Supplier bills: 30-day terms, paid on or just after the due date.
let billNo = 4400;
const billDrafts: { issuedOn: string; dueOn: string; amount: bigint; paidOn: string }[] = [];
for (let issued = addDays(START, -60); issued <= ANCHOR; issued = addDays(issued, 30)) {
  const dueOn = addDays(issued, 30);
  billDrafts.push({ issuedOn: issued, dueOn, amount: randMinor(pounds(40834), pounds(48957)), paidOn: addDays(dueOn, rng.int(0, 3)) });
}
for (const d of billDrafts) {
  billNo++;
  const paid = d.paidOn <= ANCHOR;
  if (paid && d.paidOn < START) continue;
  const reference = `KPM-${billNo}`;
  bills.push({ id: uuid(), cp: "kestrel", reference, issuedOn: d.issuedOn, dueOn: d.dueOn, amount: d.amount, status: paid ? "paid" : "unpaid", paidOn: paid ? d.paidOn : null });
  if (paid) txs.push({ date: d.paidOn, rank: 1, description: `BACS DR Kestrel Packaging ${reference}`, amount: -d.amount, cp: "kestrel" });
}

// Fixed and recurring outflows, day by day.
const lastPayroll = (() => {
  let d = ANCHOR;
  while (dow(d) !== 5) d = addDays(d, -1);
  return d;
})();
const vatDates = [addDays(ANCHOR, -42), addDays(ANCHOR, -133)];
for (let d = START; d <= ANCHOR; d = addDays(d, 1)) {
  const day = dom(d);
  if (dow(d) === 5 && dayDiff(d, lastPayroll) % 14 === 0) {
    const base = pounds(28000);
    const amt = base + (base * BigInt(rng.int(-100, 100))) / 10000n;
    txs.push({ date: d, rank: 2, description: "BACS DR PAYROLL RUN", amount: -amt });
  }
  if (day === 1) txs.push({ date: d, rank: 3, description: "STO Dockside Estates rent", amount: -pounds(4500) });
  if (day === 5) txs.push({ date: d, rank: 4, description: "DD Cloud accounting subscription", amount: -pounds(62) });
  if (day === 10) txs.push({ date: d, rank: 4, description: "DD Lumen Energy utilities", amount: -randMinor(pounds(800), pounds(1150)) });
  if (day === 12) txs.push({ date: d, rank: 4, description: "DD Inventory system subscription", amount: -pounds(185) });
  if (day === 20) txs.push({ date: d, rank: 4, description: "DD Office suite subscription", amount: -pounds(140) });
  if (day === 25) txs.push({ date: d, rank: 4, description: "BACS DR Clearwater Business Finance loan repayment", amount: -pounds(1850), cp: "clearwater" });
  if (vatDates.includes(d)) txs.push({ date: d, rank: 4, description: "FPS DR HMRC VAT", amount: -randMinor(pounds(36500), pounds(40500)) });
}

txs.sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank || a.description.localeCompare(b.description));
const net = txs.reduce((a, t) => a + t.amount, 0n);
const OPENING = TARGET_BALANCE - net;
let running = OPENING;
let minBalance = OPENING;
const rows = txs.map((t) => {
  running += t.amount;
  if (running < minBalance) minBalance = running;
  return { ...t, balance: running };
});
if (running !== TARGET_BALANCE) throw new Error("internal: closing balance mismatch");
function assertPlausible() {
  if (OPENING < 0n || minBalance < 0n) {
    throw new Error(`Generated data is not plausible (opening ${formatMoney(money(OPENING, CURRENCY), EXP)}, min ${formatMoney(money(minBalance, CURRENCY), EXP)}); adjust parameters`);
  }
}

// Recurring commitments (signed; outflows negative).
const nextPayroll = addDays(lastPayroll, 14);
const commitments = [
  { name: "Payroll", amount: -pounds(28000), frequency: "fortnightly", nextDueOn: nextPayroll, kind: "confirmed" },
  { name: "Rent - Dockside Estates", amount: -pounds(4500), frequency: "monthly", nextDueOn: nextDayOfMonth(ANCHOR, 1), kind: "confirmed" },
  { name: "VAT (quarterly, estimate)", amount: -pounds(41800), frequency: "quarterly", nextDueOn: addDays(ANCHOR, 49), kind: "estimate" },
  { name: "Utilities - Lumen Energy", amount: -pounds(980), frequency: "monthly", nextDueOn: nextDayOfMonth(ANCHOR, 10), kind: "estimate" },
  { name: "Cloud accounting subscription", amount: -pounds(62), frequency: "monthly", nextDueOn: nextDayOfMonth(ANCHOR, 5), kind: "confirmed" },
  { name: "Inventory system subscription", amount: -pounds(185), frequency: "monthly", nextDueOn: nextDayOfMonth(ANCHOR, 12), kind: "confirmed" },
  { name: "Office suite subscription", amount: -pounds(140), frequency: "monthly", nextDueOn: nextDayOfMonth(ANCHOR, 20), kind: "confirmed" },
  { name: "Loan repayment - Clearwater", amount: -pounds(1850), frequency: "monthly", nextDueOn: nextDayOfMonth(ANCHOR, 25), kind: "confirmed" },
] as const;

// ---------- fixtures ----------
function writeFixtures() {
  mkdirSync("fixtures", { recursive: true });
  const lines = [toCsvLine(["Date", "Description", "Amount", "Balance"])];
  for (const r of rows) lines.push(toCsvLine([r.date, r.description, formatDecimal(r.amount, EXP), formatDecimal(r.balance, EXP)]));
  writeFileSync("fixtures/bank-statement.csv", lines.join("\n") + "\n");

  const m = (minor: bigint) => formatMoney(money(minor, CURRENCY), EXP);
  const lineItems = [
    { desc: "Corrugated shipping carton 400x300x250", qty: 60000n, unit: 105n },
    { desc: "Kraft produce tray 1kg", qty: 40000n, unit: 80n },
    { desc: "Pallet stretch wrap roll", qty: 5000n, unit: 1100n },
  ];
  const sub = lineItems.reduce((a, l) => a + l.qty * l.unit, 0n);
  const vat = multiplyRatio(money(sub, CURRENCY), { num: 1n, den: 5n }, "half-up").amountMinor;
  const poRows = lineItems.map((l) => `| ${l.desc} | ${l.qty} | ${m(l.unit)} | ${m(l.qty * l.unit)} |`).join("\n");
  writeFileSync(
    "fixtures/purchase-order-northgate.md",
    `# PURCHASE ORDER NG-PO-48213 (SYNTHETIC DOCUMENT)

From: Northgate Grocers plc (SYNTHETIC), Procurement
To: ${BUSINESS_NAME}
Date: ${addDays(ANCHOR, -1)}

Please supply the following goods:

| Item | Qty | Unit price | Line total |
|---|---|---|---|
${poRows}

Subtotal: ${m(sub)}
VAT at 20%: ${m(vat)}
**Total: ${m(sub + vat)}**

Payment terms: 60 days from invoice date.
Delivery: weekly call-offs starting ${addDays(ANCHOR, 35)}.
Please confirm acceptance within 5 working days.
`,
  );

  const qLines = [
    { desc: "Corrugated shipping carton 400x300x250", qty: 60000n, unit: 55n },
    { desc: "Kraft produce tray 1kg", qty: 40000n, unit: 40n },
    { desc: "Pallet stretch wrap roll", qty: 5000n, unit: 620n },
  ];
  const qSub = qLines.reduce((a, l) => a + l.qty * l.unit, 0n);
  const qVat = multiplyRatio(money(qSub, CURRENCY), { num: 1n, den: 5n }, "half-up").amountMinor;
  const qTotal = qSub + qVat;
  const deposit = multiplyRatio(money(qTotal, CURRENCY), { num: 3n, den: 10n }, "half-up").amountMinor;
  const qRows = qLines.map((l) => `| ${l.desc} | ${l.qty} | ${m(l.unit)} | ${m(l.qty * l.unit)} |`).join("\n");
  writeFileSync(
    "fixtures/supplier-quote-kestrel.md",
    `# QUOTATION KPM-Q-7731 (SYNTHETIC DOCUMENT)

From: Kestrel Packaging Materials Ltd (SYNTHETIC)
To: ${BUSINESS_NAME}
Date: ${ANCHOR}
Valid for: 14 days

| Item | Qty | Unit price | Line total |
|---|---|---|---|
${qRows}

Subtotal: ${m(qSub)}
VAT at 20%: ${m(qVat)}
**Total: ${m(qTotal)}**

Terms:
- 30% deposit (${m(deposit)}) payable now, on acceptance.
- Balance (${m(qTotal - deposit)}) payable on shipment, scheduled for week 5 from acceptance (w/c ${addDays(ANCHOR, 28)}).
- Production starts when the deposit is received.
`,
  );

  // Synthetic security test fixture: the same purchase order with instructions aimed at an AI reader.
  writeFileSync("fixtures/injected-purchase-order.md", makeInjectedPurchaseOrder(readFileSync("fixtures/purchase-order-northgate.md", "utf8")));
}

// ---------- database ----------
async function reset(ownerUrl: string) {
  const sql = postgres(ownerUrl, { max: 1 });
  try {
    const [{ n }] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM action_records WHERE business_id IN (SELECT id FROM businesses WHERE name = ${BUSINESS_NAME})`;
    if (n !== "0") throw new Error(`Cannot reset: the seeded business has ${n} action_records (append-only). Use "bun run db:wipe" (docker compose down -v, then migrate and seed) for a full wipe.`);
    const ids = sql`(SELECT id FROM businesses WHERE name = ${BUSINESS_NAME})`;
    for (const t of ["transactions", "invoices", "bills", "recurring_commitments", "forecast_items", "forecast_lines", "forecast_runs", "approvals", "action_proposals", "mandates", "sandbox_messages", "sandbox_threads", "sandbox_applications", "sandbox_payments", "sandbox_payees", "sandbox_bank_accounts", "counterparties", "financial_accounts"]) {
      await sql`DELETE FROM ${sql(t)} WHERE business_id IN ${ids}`;
    }
    await sql`DELETE FROM businesses WHERE name = ${BUSINESS_NAME}`;
    console.log("reset: removed the seeded business and its data");
  } finally {
    await sql.end();
  }
}

async function main() {
  assertPlausible();
  const doReset = process.argv.includes("--reset");
  const appUrl = assertLocal("APP_DATABASE_URL", process.env.APP_DATABASE_URL);
  if (doReset) await reset(assertLocal("DATABASE_URL", process.env.DATABASE_URL));

  const client = postgres(appUrl, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const existing = await db.select({ id: schema.businesses.id }).from(schema.businesses).where(eq(schema.businesses.name, BUSINESS_NAME));
    if (existing.length > 0) {
      console.log(`Already seeded (business ${existing[0].id}). Nothing changed. Use "bun run db:reset-seed" to rebuild.`);
      return;
    }
    await db.transaction(async (tx) => {
      await tx.insert(schema.businesses).values({ id: businessId, name: BUSINESS_NAME, baseCurrency: CURRENCY, isSynthetic: true,
        // Owner reserve setting: one fortnightly payroll (ADR-008).
        reserveMinor: RESERVE, reserveCurrency: CURRENCY });
      await tx.insert(schema.financialAccounts).values({
        id: accountId, businessId, name: "Current account (SYNTHETIC)", currency: CURRENCY,
        balanceMinor: TARGET_BALANCE, balanceAsOf: new Date(`${ANCHOR}T00:00:00Z`),
      });
      await tx.insert(schema.counterparties).values(cps.map((c) => ({ id: c.id, businessId, name: c.name, role: c.role, isSimulated: true, profile: PROFILES[c.key] ?? {} })));
      const txRows = rows.map((r) => ({
        businessId, accountId, postedOn: r.date, amountMinor: r.amount, currency: CURRENCY, description: r.description,
        counterpartyId: r.cp ? cp(r.cp).id : null, source: "seed",
        sourceId: statementRowSourceId(businessId, r.date, r.amount, r.description, r.balance),
      }));
      for (let i = 0; i < txRows.length; i += 500) await tx.insert(schema.transactions).values(txRows.slice(i, i + 500));
      await tx.insert(schema.invoices).values(invoices.map((v) => ({
        id: v.id, businessId, customerId: cp(v.cp).id, number: v.number, issuedOn: v.issuedOn, dueOn: v.dueOn,
        amountMinor: v.amount, currency: CURRENCY, status: v.status, paidOn: v.paidOn,
      })));
      await tx.insert(schema.bills).values(bills.map((b) => ({
        id: b.id, businessId, supplierId: cp(b.cp).id, reference: b.reference, issuedOn: b.issuedOn, dueOn: b.dueOn,
        amountMinor: b.amount, currency: CURRENCY, status: b.status, paidOn: b.paidOn,
      })));
      await tx.insert(schema.recurringCommitments).values(commitments.map((c) => ({
        businessId, name: c.name, amountMinor: c.amount, currency: CURRENCY, frequency: c.frequency, nextDueOn: c.nextDueOn, kind: c.kind,
      })));

      // Sandbox world: a fake bank holding the business balance, and approved payees for Kestrel and the lender only.
      const bankId = detUuid("sandbox:bank");
      await tx.insert(schema.sandboxBankAccounts).values({ id: bankId, businessId, name: "Sandbox current account (SYNTHETIC)", currency: CURRENCY, balanceMinor: TARGET_BALANCE, updatedAt: new Date(`${ANCHOR}T00:00:00Z`) });
      const payees = [
        { key: "kestrel", ref: "SBX-GB00-KPM-0001" },
        { key: "clearwater", ref: "SBX-GB00-CWF-0001" },
      ];
      await tx.insert(schema.sandboxPayees).values(payees.map((p) => ({
        id: detUuid(`sandbox:payee:${p.key}`), businessId, name: cp(p.key).name, accountRef: p.ref, approved: true, counterpartyId: cp(p.key).id, createdVia: "seed",
        bankDetailsHash: createHash("sha256").update(`${cp(p.key).name}|${p.ref}`).digest("hex"),
      })));

      // Owner-signed mandate (ADR-010). The seed acts as the owner here; the dev private key comes from .env.
      const wire: MandateWire = {
        version: 1,
        businessId,
        issuedAt: `${ANCHOR}T00:00:00.000Z`,
        expiresAt: `${addDays(ANCHOR, 90)}T00:00:00.000Z`,
        currency: CURRENCY,
        limits: {
          maxEarlyPaymentDiscountBps: 150, // 1.5%
          maxPaymentMinor: "8000000", // GBP 80,000.00 (raised in Batch 8b so the largest plan payment, a GBP 76,800.00 supplier balance, fits; ADR-019)
          maxDailyOutflowMinor: "8500000", // GBP 85,000.00 (raised with the per-payment limit)
          minBankBalanceMinor: "500000", // GBP 5,000.00
          forbiddenPurposes: ["payroll", "tax"],
          allowNewPayees: false,
          allowedProposalKinds: [...PROPOSAL_KINDS],
          maxFinanceAdvanceBps: 8000, // 80%
          maxFinanceFeeBps: 300, // 3%
          requireSecondConfirmationAboveMinor: "1000000", // GBP 10,000.00
        },
      };
      const signed = signMandate(wire);
      await tx.insert(schema.mandates).values({ businessId, version: 1, canonical: signed.canonical, signature: signed.signature, signedAt: new Date(`${ANCHOR}T00:00:00Z`), active: true });
    });
    writeFixtures();
    const open = invoices.filter((i) => i.status !== "paid");
    console.log(`Seeded ${BUSINESS_NAME}`);
    console.log(`  business id:   ${businessId}`);
    console.log(`  as of:         ${ANCHOR} (statement window starts ${START})`);
    console.log(`  opening:       ${formatMoney(money(OPENING, CURRENCY), EXP)}   closing: ${formatMoney(money(TARGET_BALANCE, CURRENCY), EXP)}   lowest: ${formatMoney(money(minBalance, CURRENCY), EXP)}`);
    console.log(`  transactions:  ${rows.length}`);
    console.log(`  invoices:      ${invoices.length} (${open.length} open, ${invoices.filter((i) => i.status === "overdue").length} overdue)`);
    console.log(`  bills:         ${bills.length} (${bills.filter((b) => b.status !== "paid").length} open)`);
    console.log(`  fixtures:      fixtures/bank-statement.csv, purchase-order-northgate.md, supplier-quote-kestrel.md`);
  } finally {
    await client.end();
  }
}

// Importable for analysis (scripts/_probe.ts); only runs when executed directly.
export const generated = { ANCHOR, TARGET_BALANCE, RESERVE, OPENING, minBalance, businessId, cps, invoices, bills, commitments, rows };

if (process.argv[1]?.includes("seed-synthetic")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
