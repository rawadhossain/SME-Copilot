// Integer-minor-unit money with explicit currency. Amounts are bigint: no floats, no overflow.

/** ISO 4217 code, e.g. "GBP". Valid codes and their minor-unit exponents live in the `currencies` table. */
export type Currency = string;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export type Rounding = "floor" | "ceil" | "half-up" | "half-even" | "toward-zero";

export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export function money(amountMinor: bigint, currency: Currency): Money {
  if (typeof amountMinor !== "bigint") throw new TypeError("amountMinor must be a bigint");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid currency code: ${currency}`);
  return { amountMinor, currency };
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Integer division of n by d (d > 0) with explicit rounding. */
function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  const neg = n < 0n;
  const away = neg ? q - 1n : q + 1n;
  switch (mode) {
    case "toward-zero":
      return q;
    case "floor":
      return neg ? away : q;
    case "ceil":
      return neg ? q : away;
    case "half-up":
    case "half-even": {
      const twice = (neg ? -r : r) * 2n;
      if (twice > d) return away;
      if (twice < d) return q;
      if (mode === "half-up") return away; // ties away from zero
      return q % 2n === 0n ? q : away; // ties to even
    }
  }
}

/** Multiply by a ratio (e.g. 3/200 for 1.5%). Rounding is mandatory so it is never implicit. */
export function multiplyRatio(m: Money, ratio: Ratio, rounding: Rounding): Money {
  if (ratio.den <= 0n) throw new Error("Ratio denominator must be positive");
  return money(divRound(m.amountMinor * ratio.num, ratio.den, rounding), m.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

/** `exp` = minor-unit exponent for m.currency, from the currencies table (2 for GBP, 0 for JPY). */
export function formatMoney(m: Money, exp: number): string {
  const neg = m.amountMinor < 0n;
  const abs = neg ? -m.amountMinor : m.amountMinor;
  const scale = 10n ** BigInt(exp);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = exp > 0 ? "." + (abs % scale).toString().padStart(exp, "0") : "";
  return `${neg ? "-" : ""}${whole}${frac} ${m.currency}`;
}

export { parseDecimalToMinor, MoneyParseError } from "./parse";
export { moneyJsonSchema, moneyToJson, moneyFromJson, type MoneyJson } from "./boundary";

/** Plain decimal string for CSV/export, e.g. -123456 with exp 2 -> "-1234.56". No grouping, no currency. */
export function formatDecimal(amountMinor: bigint, exp: number): string {
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  if (exp === 0) return `${neg ? "-" : ""}${abs}`;
  const scale = 10n ** BigInt(exp);
  return `${neg ? "-" : ""}${abs / scale}.${(abs % scale).toString().padStart(exp, "0")}`;
}
