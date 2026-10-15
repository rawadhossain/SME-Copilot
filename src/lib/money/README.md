# lib/money

Integer-minor-unit money (bigint) with explicit currency: create, add, subtract, multiply by a ratio with explicit rounding, compare, format.

## Postgres note

Money columns are `bigint`, but `SUM(bigint)` returns `numeric` in Postgres. Drivers return `numeric` as a string, so never let it become a JS number. Parse it with `BigInt(row.total)` (or cast in SQL: `SUM(amount_minor)::bigint`, which errors on overflow rather than losing precision). Group by `currency` before summing: never add across currencies.

## Boundaries and parsing

- JSON/API: money travels as `{ amountMinor: string, currency: string }` (`moneyJsonSchema`, `moneyToJson`, `moneyFromJson`). Never put a `bigint` through `JSON.stringify`.
- Text input: `parseDecimalToMinor(text, exponent)` turns "1,234.56" or "-45.00" into minor units without floating point. "." is the only decimal separator, "," only groups thousands in threes, and more decimals than the currency's exponent are rejected. Anything else throws `MoneyParseError`. The exponent comes from the `currencies` table.
- Output: `formatMoney(m, exponent)` for display, `formatDecimal(minor, exponent)` for plain CSV values.
