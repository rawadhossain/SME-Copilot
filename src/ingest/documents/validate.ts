// Deterministic validation of a model's extraction against the document text. Pure functions: no database, no model,
// no clock (asOf is passed in), no floating point (money uses the existing decimal parser and rounding helpers).
// The model's output is a claim; nothing here trusts it.
import { addDays, diffDays } from "@/engine/dates";
import { formatMoney, money, multiplyRatio, parseDecimalToMinor, MoneyParseError } from "@/lib/money";
import type { DocKind, PoOutput, QuoteOutput, RawField } from "./schema";

export const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2, CNY: 2, HKD: 2, JPY: 0 };

export const normWs = (s: string): string => s.replace(/\s+/g, " ").trim();

export type FieldStatus = "verified" | "rejected" | "missing";
export interface FieldResult {
  value: string | number | null;
  confidence: "high" | "medium" | "low";
  evidence: string | null;
  status: FieldStatus;
  reason?: string;
}
export interface Flag {
  severity: "error" | "warning";
  code: string;
  field?: string;
  message: string;
}
export interface Suspicious {
  source: "scan" | "model";
  text: string;
  pattern?: string;
}

export interface PoDerived {
  currency: string;
  totalMinor: string;
  termsDays: number;
  deliveryDate: string;
  buyerName: string;
  orderReference: string;
}
export interface QuoteDerived {
  currency: string;
  totalMinor: string;
  depositBps: number;
  depositDate: string;
  balanceDate: string;
  weekNumber: number;
  supplierName: string;
  quoteReference: string;
}

export interface ExtractionResult {
  kind: DocKind;
  asOf: string;
  fields: Record<string, FieldResult>;
  derived: PoDerived | QuoteDerived | null;
}
export interface FlagsBlob {
  flags: Flag[];
  suspicious: Suspicious[];
}
export interface Outcome {
  status: "pending_confirmation" | "failed";
  result: ExtractionResult;
  flags: FlagsBlob;
}

// ---------------------------------------------------------------- suspicious text (independent of the model)

const PATTERNS: [string, RegExp][] = [
  ["tells the reader to ignore instructions or limits", /\bignore\b[^.\n]{0,40}\b(previous|prior|above|your|all)\b[^.\n]{0,40}\b(instructions?|limits?|rules?)\b/i],
  ["mentions a system prompt", /system prompt/i],
  ["addresses an AI", /\b(you are an? (ai|assistant|language model)|ai assistant|language model|chatgpt|llm)\b/i],
  ["asks to approve", /\bapprove\b/i],
  ["asks for secrecy", /do not tell|don'?t tell|keep this (secret|between)/i],
  ["asks to transfer money", /\btransfer\b/i],
  ["mentions bank details", /(new|changed|updated) (bank|account) details|bank details/i],
  ["asks to override or bypass", /\b(override|disregard|bypass)\b/i],
];

export function scanSuspicious(text: string): Suspicious[] {
  const found: Suspicious[] = [];
  const seen = new Set<string>();
  for (const [label, re] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      const start = Math.max(0, (m.index ?? 0) - 50);
      const snippet = normWs(text.slice(start, (m.index ?? 0) + m[0].length + 60)).slice(0, 160);
      if (seen.has(snippet)) continue;
      seen.add(snippet);
      found.push({ source: "scan", text: snippet, pattern: label });
      if (found.length >= 12) return found;
    }
  }
  return found;
}

// ---------------------------------------------------------------- field checks

type FieldType = "text" | "amount" | "currency" | "int" | "isoDate" | "percent" | "phrase";

export function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

function checkField(text: string, nText: string, type: FieldType, raw: RawField | undefined): FieldResult {
  const confidence = raw?.confidence ?? "low";
  const evidence = raw?.evidence ?? null;
  if (!raw || raw.value === null || raw.value === undefined || raw.value === "") return { value: null, confidence, evidence, status: "missing", reason: "not stated" };
  const value = raw.value;
  const reject = (reason: string): FieldResult => ({ value, confidence, evidence, status: "rejected", reason });
  if (evidence === null || normWs(evidence) === "") return reject("no evidence quote");
  const nEv = normWs(evidence);
  if (!nText.includes(nEv)) return reject("the evidence quote is not found verbatim in the document");
  const v = normWs(String(value));
  switch (type) {
    case "text":
    case "phrase":
      if (!nEv.toLowerCase().includes(v.toLowerCase())) return reject("the value is not in its evidence quote");
      break;
    case "amount":
      if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(v)) return reject("not a plain amount");
      if (!nEv.includes(v) || !nText.includes(v)) return reject("the amount is not in the document");
      break;
    case "currency":
      if (!/^[A-Z]{3}$/.test(v) || !nEv.includes(v) || !nText.includes(v)) return reject("the currency is not in the document");
      break;
    case "int":
      if (!Number.isInteger(Number(v)) || !new RegExp(`(^|\\D)${v}(\\D|$)`).test(nEv)) return reject("the number is not in its evidence quote");
      break;
    case "isoDate":
      if (!isRealIsoDate(v)) return reject("not a real ISO date");
      if (!nEv.includes(v)) return reject("the date is not in its evidence quote");
      break;
    case "percent":
      if (!/^\d+(\.\d+)?$/.test(v) || !nEv.includes(v)) return reject("the percentage is not in its evidence quote");
      break;
  }
  return { value, confidence, evidence, status: "verified" };
}

interface Spec {
  key: string;
  type: FieldType;
  required: boolean;
}

function runSpecs(text: string, raw: Record<string, RawField>, specs: Spec[], flags: Flag[]): Record<string, FieldResult> {
  const nText = normWs(text);
  const out: Record<string, FieldResult> = {};
  for (const s of specs) {
    const r = checkField(text, nText, s.type, raw[s.key]);
    out[s.key] = r;
    if (r.status === "rejected") flags.push({ severity: s.required ? "error" : "warning", code: "field_rejected", field: s.key, message: `${s.key}: ${r.reason}` });
    else if (r.status === "missing" && s.required) flags.push({ severity: "error", code: "missing_required", field: s.key, message: `${s.key}: required but not found in the document` });
    else if (r.status === "verified" && r.confidence === "low") flags.push({ severity: "warning", code: "low_confidence", field: s.key, message: `${s.key}: the reader was not confident` });
  }
  return out;
}

const verified = (f: FieldResult | undefined): f is FieldResult & { value: string | number } => !!f && f.status === "verified" && f.value !== null;

function parseAmount(v: string, currency: string, key: string, flags: Flag[]): bigint | null {
  const exp = EXPONENTS[currency];
  if (exp === undefined) {
    flags.push({ severity: "error", code: "unsupported_currency", field: key, message: `currency ${currency} is not supported` });
    return null;
  }
  try {
    return parseDecimalToMinor(v, exp);
  } catch (e) {
    flags.push({ severity: "error", code: "bad_amount", field: key, message: `${key}: ${e instanceof MoneyParseError ? e.message : "cannot parse amount"}` });
    return null;
  }
}

function finish(kind: DocKind, text: string, asOf: string, fields: Record<string, FieldResult>, derived: ExtractionResult["derived"], flags: Flag[], modelSuspicious: string[]): Outcome {
  const scan = scanSuspicious(text);
  const suspicious: Suspicious[] = [...scan];
  for (const m of modelSuspicious) {
    const t = normWs(m).slice(0, 300);
    if (t && !suspicious.some((s) => s.text === t)) suspicious.push({ source: "model", text: t });
  }
  if (suspicious.length > 0) {
    flags.push({ severity: "warning", code: "suspicious_text", message: `${suspicious.length} passage(s) in the document look like instructions to an AI or the reader. They were ignored. Review before confirming.` });
  }
  const hasError = flags.some((f) => f.severity === "error");
  return { status: hasError ? "failed" : "pending_confirmation", result: { kind, asOf, fields, derived: hasError ? null : derived }, flags: { flags, suspicious } };
}

// ---------------------------------------------------------------- purchase order

export function validatePurchaseOrder(text: string, raw: PoOutput, ctx: { asOf: string }): Outcome {
  const flags: Flag[] = [];
  const fields = runSpecs(text, raw as unknown as Record<string, RawField>, [
    { key: "buyerName", type: "text", required: true },
    { key: "orderReference", type: "text", required: true },
    { key: "totalAmount", type: "amount", required: true },
    { key: "currency", type: "currency", required: true },
    { key: "paymentTermsDays", type: "int", required: true },
    { key: "deliveryDate", type: "isoDate", required: true },
    { key: "depositTerms", type: "text", required: false },
  ], flags);

  let derived: PoDerived | null = null;
  const { buyerName, orderReference, totalAmount, currency, paymentTermsDays, deliveryDate, depositTerms } = fields;
  if (verified(buyerName) && verified(orderReference) && verified(totalAmount) && verified(currency) && verified(paymentTermsDays) && verified(deliveryDate)) {
    const total = parseAmount(String(totalAmount.value), String(currency.value), "totalAmount", flags);
    const days = Number(paymentTermsDays.value);
    if (days < 0 || days > 365) flags.push({ severity: "error", code: "bad_terms", field: "paymentTermsDays", message: "payment terms must be between 0 and 365 days" });
    if (total !== null && total <= 0n) flags.push({ severity: "error", code: "bad_amount", field: "totalAmount", message: "total must be positive" });
    if (total !== null && days >= 0 && days <= 365 && total > 0n) {
      derived = { currency: String(currency.value), totalMinor: total.toString(), termsDays: days, deliveryDate: String(deliveryDate.value), buyerName: String(buyerName.value), orderReference: String(orderReference.value) };
    }
  }
  if (verified(depositTerms)) flags.push({ severity: "warning", code: "deposit_terms_not_mapped", field: "depositTerms", message: "The buyer states deposit terms. They are shown to you but not mapped to events automatically." });
  return finish("purchase_order", text, ctx.asOf, fields, derived, flags, raw.suspiciousInstructions);
}

// ---------------------------------------------------------------- supplier quote

export function validateSupplierQuote(text: string, raw: QuoteOutput, ctx: { asOf: string }): Outcome {
  const flags: Flag[] = [];
  const fields = runSpecs(text, raw as unknown as Record<string, RawField>, [
    { key: "supplierName", type: "text", required: true },
    { key: "quoteReference", type: "text", required: true },
    { key: "totalAmount", type: "amount", required: true },
    { key: "currency", type: "currency", required: true },
    { key: "depositPercent", type: "percent", required: true },
    { key: "depositDue", type: "phrase", required: true },
    { key: "balanceAmount", type: "amount", required: true },
    { key: "balanceTiming", type: "phrase", required: true },
    { key: "shipmentWeek", type: "int", required: false },
    { key: "shipmentDate", type: "isoDate", required: false },
    { key: "validityDays", type: "int", required: false },
  ], flags);

  let derived: QuoteDerived | null = null;
  const f = fields;
  if (verified(f.supplierName) && verified(f.quoteReference) && verified(f.totalAmount) && verified(f.currency) && verified(f.depositPercent) && verified(f.depositDue) && verified(f.balanceAmount) && verified(f.balanceTiming)) {
    const cur = String(f.currency.value);
    const total = parseAmount(String(f.totalAmount.value), cur, "totalAmount", flags);
    const balance = parseAmount(String(f.balanceAmount.value), cur, "balanceAmount", flags);
    let bps: number | null = null;
    try {
      const b = parseDecimalToMinor(String(f.depositPercent.value), 2);
      if (b > 0n && b <= 10000n) bps = Number(b);
      else flags.push({ severity: "error", code: "bad_percent", field: "depositPercent", message: "deposit percent must be above 0 and at most 100" });
    } catch {
      flags.push({ severity: "error", code: "bad_percent", field: "depositPercent", message: "cannot parse the deposit percent" });
    }

    // Timing: deposit "on acceptance" (resolved to asOf) or an ISO date; balance on shipment (resolved from the stated date or week).
    const dueRaw = String(f.depositDue.value).toLowerCase();
    let depositDate: string | null = null;
    if (dueRaw.includes("acceptance") || dueRaw.includes("now")) depositDate = ctx.asOf;
    else if (isRealIsoDate(String(f.depositDue.value))) depositDate = String(f.depositDue.value);
    else flags.push({ severity: "error", code: "unsupported_deposit_timing", field: "depositDue", message: "deposit timing must be 'on acceptance' or a date" });
    if (!String(f.balanceTiming.value).toLowerCase().includes("shipment")) {
      flags.push({ severity: "error", code: "unsupported_balance_timing", field: "balanceTiming", message: "only a balance due on shipment is supported" });
    }
    const dateFromDoc = verified(f.shipmentDate) ? String(f.shipmentDate.value) : null;
    const dateFromWeek = verified(f.shipmentWeek) && Number(f.shipmentWeek.value) >= 1 ? addDays(ctx.asOf, (Number(f.shipmentWeek.value) - 1) * 7) : null;
    if (dateFromDoc && dateFromWeek && dateFromDoc !== dateFromWeek) {
      flags.push({ severity: "warning", code: "shipment_date_week_mismatch", field: "shipmentDate", message: `the stated shipment date ${dateFromDoc} differs from week ${f.shipmentWeek.value} counted from acceptance (${dateFromWeek}); the stated date is used` });
    }
    const balanceDate = dateFromDoc ?? dateFromWeek;
    if (!balanceDate) flags.push({ severity: "error", code: "missing_shipment_timing", field: "shipmentDate", message: "no shipment date or week found, so the balance date cannot be resolved" });

    // Cross-check: deposit percent of the total plus the balance equals the total.
    if (total !== null && balance !== null && bps !== null) {
      const deposit = multiplyRatio(money(total, cur), { num: BigInt(bps), den: 10000n }, "half-up").amountMinor;
      if (deposit + balance !== total) {
        flags.push({
          severity: "error", code: "inconsistent_totals", field: "balanceAmount",
          message: `deposit ${bps / 100}% of ${formatMoney(money(total, cur), 2)} is ${formatMoney(money(deposit, cur), 2)}; with the stated balance ${formatMoney(money(balance, cur), 2)} that is ${formatMoney(money(deposit + balance, cur), 2)}, not the total`,
        });
      } else if (depositDate && balanceDate && total > 0n) {
        const weeks = diffDays(ctx.asOf, balanceDate) / 7 + 1;
        derived = {
          currency: cur, totalMinor: total.toString(), depositBps: bps, depositDate, balanceDate, weekNumber: Math.round(weeks),
          supplierName: String(f.supplierName.value), quoteReference: String(f.quoteReference.value),
        };
      }
    }
  }
  return finish("supplier_quote", text, ctx.asOf, fields, derived, flags, raw.suspiciousInstructions);
}

export function validateExtraction(kind: DocKind, text: string, raw: unknown, ctx: { asOf: string }): Outcome {
  return kind === "purchase_order" ? validatePurchaseOrder(text, raw as PoOutput, ctx) : validateSupplierQuote(text, raw as QuoteOutput, ctx);
}

/** An outcome for a document that could not be read at all (model call failed). The deterministic scan still runs. */
export function failedOutcome(kind: DocKind, text: string, asOf: string, message: string): Outcome {
  const flags: Flag[] = [{ severity: "error", code: "extraction_failed", message }];
  return finish(kind, text, asOf, {}, null, flags, []);
}
