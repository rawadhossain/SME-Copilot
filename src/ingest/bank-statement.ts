// Parser for the one supported bank-export layout (ADR-007): Date,Description,Amount,Balance
import { money, parseDecimalToMinor, MoneyParseError, type Money } from "@/lib/money";
import { parseCsv } from "./csv";
import { normaliseDescription } from "./identity";

export const STATEMENT_HEADER = ["Date", "Description", "Amount", "Balance"] as const;

export interface StatementRow {
  /** 1-based line number in the file, counting the header as row 1. */
  rowNumber: number;
  postedOn: string; // YYYY-MM-DD
  description: string;
  amount: Money; // signed
  balance: Money; // running balance after this row, as stated by the bank
}

export interface RowError {
  row: number;
  field: string;
  reason: string;
}

export interface Reconciliation {
  /** Last valid row's balance as stated by the statement. */
  statementClosing: Money | null;
  /** Opening balance implied by the first valid row, plus the sum of all valid amounts. */
  computedClosing: Money | null;
  /** statementClosing - computedClosing. Zero means the statement reconciles. */
  difference: Money | null;
  /** Rows whose stated balance differs from the previous balance plus their amount. */
  balanceBreaks: number[];
  ok: boolean;
}

export interface ParsedStatement {
  rows: StatementRow[];
  errors: RowError[];
  rowsRead: number;
  reconciliation: Reconciliation;
}

function validIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseField(raw: string, field: string, row: number, exponent: number, errors: RowError[]): bigint | null {
  try {
    return parseDecimalToMinor(raw, exponent);
  } catch (e) {
    errors.push({ row, field, reason: e instanceof MoneyParseError ? e.message : String(e) });
    return null;
  }
}

export function parseBankStatement(text: string, currency: string, exponent: number): ParsedStatement {
  const lines = parseCsv(text);
  const errors: RowError[] = [];
  const rows: StatementRow[] = [];

  const header = lines[0]?.map((h) => h.trim());
  if (!header || header.length !== STATEMENT_HEADER.length || STATEMENT_HEADER.some((h, i) => header[i] !== h)) {
    errors.push({ row: 1, field: "header", reason: `Expected header "${STATEMENT_HEADER.join(",")}"` });
    return { rows, errors, rowsRead: 0, reconciliation: reconcile(rows, currency) };
  }

  for (let i = 1; i < lines.length; i++) {
    const rowNumber = i + 1;
    const cells = lines[i];
    if (cells.length !== STATEMENT_HEADER.length) {
      errors.push({ row: rowNumber, field: "row", reason: `Expected ${STATEMENT_HEADER.length} columns, found ${cells.length}` });
      continue;
    }
    const [date, descRaw, amountRaw, balanceRaw] = cells;
    const before = errors.length;
    const postedOn = date.trim();
    if (!validIsoDate(postedOn)) errors.push({ row: rowNumber, field: "Date", reason: `Not a valid YYYY-MM-DD date: "${date}"` });
    const description = normaliseDescription(descRaw);
    if (description === "") errors.push({ row: rowNumber, field: "Description", reason: "Empty description" });
    const amount = parseField(amountRaw, "Amount", rowNumber, exponent, errors);
    const balance = parseField(balanceRaw, "Balance", rowNumber, exponent, errors);
    if (errors.length > before || amount === null || balance === null) continue;
    rows.push({ rowNumber, postedOn, description, amount: money(amount, currency), balance: money(balance, currency) });
  }
  return { rows, errors, rowsRead: lines.length - 1, reconciliation: reconcile(rows, currency) };
}

export function reconcile(rows: StatementRow[], currency: string): Reconciliation {
  if (rows.length === 0) return { statementClosing: null, computedClosing: null, difference: null, balanceBreaks: [], ok: true };
  const breaks: number[] = [];
  let running = rows[0].balance.amountMinor - rows[0].amount.amountMinor; // implied opening balance
  for (const r of rows) {
    running += r.amount.amountMinor;
    if (running !== r.balance.amountMinor) {
      breaks.push(r.rowNumber);
      running = r.balance.amountMinor; // resync so one break is reported once
    }
  }
  const stated = rows[rows.length - 1].balance.amountMinor;
  const sum = rows.reduce((a, r) => a + r.amount.amountMinor, 0n);
  const computed = rows[0].balance.amountMinor - rows[0].amount.amountMinor + sum;
  return {
    statementClosing: money(stated, currency),
    computedClosing: money(computed, currency),
    difference: money(stated - computed, currency),
    balanceBreaks: breaks,
    ok: stated === computed && breaks.length === 0,
  };
}
