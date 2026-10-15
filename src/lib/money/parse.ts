// Decimal string -> minor units. Integer/string arithmetic only; no floating point.

export class MoneyParseError extends Error {}

const WITH_GROUPS = /^\d{1,3}(,\d{3})+$/;
const PLAIN = /^\d+$/;

/**
 * Parse "1,234.56", "-45.00", "+12" into minor units for a currency with `exponent` decimals.
 *
 * Rules (anything else is rejected, never guessed):
 * - optional leading "-" or "+"; no parentheses, currency symbols or trailing signs
 * - "." is the only decimal separator; "," is only a thousands separator in groups of exactly three
 * - at least one digit before the decimal point
 * - at most `exponent` fractional digits (so "12.5" is rejected for JPY, "1.234" for GBP)
 */
export function parseDecimalToMinor(input: string, exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new MoneyParseError(`Invalid exponent: ${exponent}`);
  const raw = input.trim();
  if (raw === "") throw new MoneyParseError("Amount is empty");
  const m = /^([+-]?)([0-9,]+)(?:\.([0-9]*))?$/.exec(raw);
  if (!m) throw new MoneyParseError(`Malformed amount: "${input}"`);
  const [, sign, intPart, fracPart = ""] = m;
  if (!PLAIN.test(intPart) && !WITH_GROUPS.test(intPart)) {
    throw new MoneyParseError(`Ambiguous or malformed thousands separators: "${input}"`);
  }
  if (raw.includes(".") && fracPart === "") throw new MoneyParseError(`Missing digits after decimal point: "${input}"`);
  if (fracPart.length > exponent) {
    throw new MoneyParseError(`Too many decimal places (${fracPart.length}) for a ${exponent}-decimal currency: "${input}"`);
  }
  const digits = intPart.replaceAll(",", "") + fracPart.padEnd(exponent, "0");
  const value = BigInt(digits);
  return sign === "-" ? -value : value;
}
