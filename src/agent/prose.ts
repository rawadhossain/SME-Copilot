// Deterministic check of the model prose: every currency amount and percentage in a sentence must appear in the computed
// fields or in tool results. A sentence with an unmatched or unverifiable number is removed and the plan is flagged.
// Model prose never supplies numbers to the owner (CLAUDE.md).
import { parseDecimalToMinor } from "@/lib/money";

/** Collects every integer and digit-only string in a value, as non-negative digit strings. */
export function collectNumbers(value: unknown, into: Set<string>): void {
  if (typeof value === "number") {
    if (Number.isInteger(value)) into.add(String(Math.abs(value)));
  } else if (typeof value === "string") {
    if (/^-?\d+$/.test(value)) into.add(value.replace("-", ""));
  } else if (typeof value === "bigint") {
    into.add((value < 0n ? -value : value).toString());
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectNumbers(v, into);
  }
}

const AMOUNT = /(?:[£$€]\s?(\d[\d,]*(?:\.\d+)?)(\s?[kKmM]\b)?)|(?:(\d[\d,]*(?:\.\d+)?)\s?(?:GBP|USD|EUR|CNY|HKD|JPY)\b)/g;
const PERCENT = /(\d+(?:\.\d+)?)\s?%/g;

export interface NumberClaims {
  amountsMinor: string[];
  unverifiable: string[];
  percentsBps: string[];
}

export function claimsIn(text: string): NumberClaims {
  const out: NumberClaims = { amountsMinor: [], unverifiable: [], percentsBps: [] };
  for (const m of text.matchAll(AMOUNT)) {
    const raw = m[1] ?? m[3];
    if (m[2]) {
      out.unverifiable.push(m[0]);
      continue;
    }
    try {
      out.amountsMinor.push(parseDecimalToMinor(raw, 2).toString());
    } catch {
      out.unverifiable.push(m[0]);
    }
  }
  for (const m of text.matchAll(PERCENT)) {
    try {
      out.percentsBps.push(parseDecimalToMinor(m[1], 2).toString());
    } catch {
      out.unverifiable.push(m[0]);
    }
  }
  return out;
}

export interface ProseResult {
  text: string;
  removed: string[];
}

export function checkProse(text: string, allowed: Set<string>): ProseResult {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "");
  const kept: string[] = [];
  const removed: string[] = [];
  for (const s of sentences) {
    const c = claimsIn(s);
    const bad = c.unverifiable.length > 0 || c.amountsMinor.some((a) => !allowed.has(a.replace("-", ""))) || c.percentsBps.some((p) => !allowed.has(p));
    (bad ? removed : kept).push(s);
  }
  return { text: kept.join(" "), removed };
}
