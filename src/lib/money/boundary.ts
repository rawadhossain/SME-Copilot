// Money at JSON / API boundaries: { amountMinor: string, currency: string }. bigint never goes through JSON.
import { z } from "zod";
import { money, type Money } from "./index";

const BIGINT_MAX = 9223372036854775807n; // Postgres bigint

export const moneyJsonSchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/, "amountMinor must be an integer string"),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter code"),
});

export type MoneyJson = z.infer<typeof moneyJsonSchema>;

export function moneyToJson(m: Money): MoneyJson {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}

/** Validates untrusted input and returns bigint-based money. Throws a ZodError on bad input. */
export function moneyFromJson(input: unknown): Money {
  const parsed = moneyJsonSchema.parse(input);
  const amount = BigInt(parsed.amountMinor);
  if (amount > BIGINT_MAX || amount < -BIGINT_MAX - 1n) throw new RangeError("amountMinor is outside the bigint range");
  return money(amount, parsed.currency);
}
