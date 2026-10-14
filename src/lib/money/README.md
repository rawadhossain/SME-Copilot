# lib/money

Integer-minor-unit money (bigint) with explicit currency: create, add, subtract, multiply by a ratio with explicit rounding, compare, format.

## Postgres note

Money columns are `bigint`, but `SUM(bigint)` returns `numeric` in Postgres. Drivers return `numeric` as a string, so never let it become a JS number. Parse it with `BigInt(row.total)` (or cast in SQL: `SUM(amount_minor)::bigint`, which errors on overflow rather than losing precision). Group by `currency` before summing: never add across currencies.
